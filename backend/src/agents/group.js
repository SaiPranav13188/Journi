// GROUP AGENT — coordinates a trip planned by several people (agentic only;
// group trips have no v1 path). It knows every member's preferences, finds
// compromises when wishes conflict, runs polls when the group should decide,
// tracks shared spending, and delegates plan edits to the Planner and cost
// questions to the Budget agent.

import { tool } from 'ai';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { runAgent, summarizeTrace } from '../lib/agents/runAgent.js';
import { logToolCall } from '../lib/agents/toolLog.js';
import { formatInr } from '../lib/money.js';
import { makeMessage } from '../services/planner.js';
import { getTrip, saveTripPlan } from '../services/tripStore.js';
import {
  addExpense,
  cleanPreferences,
  closePoll,
  computeBalances,
  createPoll,
  listExpenses,
  listMembers,
  listPolls,
  updatePreferences,
  withTripLock,
} from '../services/groupStore.js';
import { getWeatherTool } from './tools/research.js';
import { overLimit, raiseBudgetConcern } from './tools/budget.js';
import { historyToMessages, runPlannerRefine } from './planner.js';
import { runBudgetAgent } from './budget.js';

export const GROUP_STEP_LIMIT = 6;
const AGENT = 'group';

const SYSTEM = `You are Journi, coordinating ONE trip that a group of friends/family is planning together in a shared chat. Several people talk to you; each message says who wrote it. All costs are per person in Indian Rupees (INR).

Your job is to keep the WHOLE group happy, not just whoever is speaking:
- Before changing the plan in a way that affects everyone (swapping a day's main activity, pace, budget level, destination, dates), check get_member_preferences / find_compromise. Small, clearly harmless edits (adding a café someone asked for, fixing a typo) don't need it.
- If the request fits the group, invoke_planner_agent with the request PLUS the group context it needs (e.g. "Priya is vegetarian; Arjun prefers a relaxed pace").
- If it clashes with other members' stated preferences, either (a) propose a compromise and apply it through the planner (e.g. beach in the morning, museum in the afternoon), or (b) for a genuine either/or choice, create_poll with 2-4 clear options instead of deciding for them. Don't change the plan and create a poll for the same question.
- When a poll has closed (you'll be told), apply the winning option through the planner; on a tie, propose a compromise or ask who breaks the tie.
- After a plan change that affects cost, invoke_budget_agent. Mention if the per-person total goes above any member's budget.
- When someone says they paid for something ("I paid ₹3000 for the hotel", "Rahul paid for dinner, split between me and him"), record_expense. For "who owes whom" / "how much did I spend", get_balances.
- When the speaker tells you their own preferences ("I'm vegetarian", "I want a slower pace", "my budget is 40k"), update_member_preferences.
- Simple factual questions (weather, general tips) — answer directly (get_weather if needed).

Reply in 1-4 friendly sentences addressed to the group, naming people where it helps ("Priya, I kept dinner vegetarian"). Mention any poll you created so people know to vote. Plain text only — no JSON, no markdown headings.`;

/** Case-insensitive name → member (exact, then first-name / prefix match). */
function matchMember(members, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return (
    members.find((m) => m.display_name.toLowerCase() === n) ||
    members.find((m) => m.display_name.toLowerCase().split(/\s+/)[0] === n) ||
    members.find((m) => m.display_name.toLowerCase().startsWith(n)) ||
    null
  );
}

/** Deterministic view of where the group agrees and disagrees (the model does the judging). */
export function analyzePreferences(members, perPersonEstimate) {
  const withPrefs = members.filter((m) => Object.keys(m.preferences || {}).length);
  const interestCounts = {};
  for (const m of withPrefs) for (const i of m.preferences.interests || []) interestCounts[i] = (interestCounts[i] || 0) + 1;
  // "Shared" = at least two people and at least half of those who answered.
  const half = Math.max(2, Math.ceil(withPrefs.length / 2));
  const shared = Object.entries(interestCounts).filter(([, c]) => c >= half).sort((a, b) => b[1] - a[1]).map(([i, c]) => `${i} (${c}/${withPrefs.length})`);
  const budgets = withPrefs.filter((m) => m.preferences.budget_per_person_inr).map((m) => ({ name: m.display_name, budget: m.preferences.budget_per_person_inr }));
  const strictest = budgets.sort((a, b) => a.budget - b.budget)[0] || null;
  const paces = withPrefs.map((m) => m.preferences.pace).filter(Boolean);
  const paceCounts = paces.reduce((acc, p) => ({ ...acc, [p]: (acc[p] || 0) + 1 }), {});
  const majorityPace = Object.entries(paceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    members_with_preferences: withPrefs.length,
    members_without_preferences: members.filter((m) => !withPrefs.includes(m)).map((m) => m.display_name),
    shared_interests: shared,
    individual_interests: withPrefs.map((m) => ({
      name: m.display_name,
      only_they_want: (m.preferences.interests || []).filter((i) => interestCounts[i] < half),
    })),
    budget: {
      strictest_per_person_inr: strictest?.budget ?? null,
      strictest_member: strictest?.name ?? null,
      current_estimate_per_person_inr: perPersonEstimate,
      over_budget_for: budgets.filter((b) => perPersonEstimate != null && perPersonEstimate > b.budget).map((b) => `${b.name} (limit ${formatInr(b.budget)})`),
    },
    pace: { counts: paceCounts, conflict: Object.keys(paceCounts).length > 1, majority: majorityPace },
    dietary_needs: withPrefs.filter((m) => m.preferences.dietary).map((m) => `${m.display_name}: ${m.preferences.dietary}`),
    notes: withPrefs.filter((m) => m.preferences.notes).map((m) => `${m.display_name}: ${m.preferences.notes}`),
    guidance:
      'Give each member at least one thing they asked for; always respect every dietary need; keep the per-person total within the strictest budget or say clearly who it exceeds; when two wishes truly exclude each other for the same slot, create_poll.',
  };
}

function groupContextLine(members) {
  const parts = members
    .filter((m) => Object.keys(m.preferences || {}).length)
    .map((m) => {
      const p = m.preferences;
      return `${m.display_name}: ${[
        p.interests?.length ? `likes ${p.interests.join(', ')}` : null,
        p.pace ? `${p.pace} pace` : null,
        p.budget_per_person_inr ? `budget ${formatInr(p.budget_per_person_inr)}` : null,
        p.dietary ? p.dietary : null,
        p.notes ? p.notes : null,
      ]
        .filter(Boolean)
        .join('; ')}`;
    });
  return parts.length ? parts.join(' | ') : 'no preferences set yet';
}

/**
 * One group chat turn (or an automatic follow-up after a poll closes).
 * Runs under a per-trip lock so members' requests never overwrite each other.
 *
 * @param opts { user: {id, name}, tripId, message, systemEvent? }
 */
export function runGroupChat({ user, tripId, message, systemEvent = false }) {
  return withTripLock(tripId, () => groupTurn({ user, tripId, message, systemEvent }));
}

async function groupTurn({ user, tripId, message, systemEvent }) {
  const saved = await getTrip(user.id, tripId);
  if (!saved.trip.is_group) throw new HttpError(400, 'This trip isn’t shared with a group yet.');
  if (saved.trip.status === 'finalized') throw new HttpError(409, 'This plan is finalized. Reopen it for editing to keep planning.');

  let members = await listMembers(tripId);
  const speaker = members.find((m) => m.user_id === user.id);
  const speakerName = systemEvent ? 'Journi (automatic update)' : speaker?.display_name ?? user.name;

  // Chat history with authors, so the model knows who asked for what.
  const history = saved.messages.map((m) => (m.role === 'user' && m.author_name ? { ...m, content: `${m.author_name}: ${m.content}` } : m));
  const ctx = { userId: user.id, tripId, persist: true, state: { trip: saved.trip, days: saved.days, budget: saved.budget }, history };
  const baselineTotal = ctx.state.budget?.total_inr ?? null;
  const originalState = ctx.state;
  const outcome = { planner: null, budget: null, polls: [], expenses: [], runs: [] };

  const tools = {
    get_member_preferences: tool({
      description: "Everyone in the group with their stated interests, per-person budget, pace, dietary needs and notes (empty if they haven't set any).",
      inputSchema: z.object({}),
      execute: async () => ({
        members: members.map((m) => ({ name: m.display_name, role: m.role, is_speaker: m.user_id === user.id, ...m.preferences, has_preferences: Object.keys(m.preferences || {}).length > 0 })),
      }),
    }),

    find_compromise: tool({
      description:
        'Analyses where the group agrees and disagrees: shared interests, interests only one person has, the strictest budget vs the current per-person estimate, pace conflicts and dietary needs. Use before plan changes that affect everyone, or when requests conflict.',
      inputSchema: z.object({}),
      execute: async () => analyzePreferences(members, ctx.state.budget?.total_inr ?? null),
    }),

    invoke_planner_agent: tool({
      description:
        'Runs the Planner agent on the shared itinerary (researches weather/places as needed and edits the plan, or returns place suggestions). Include the group context it needs in userMessage (who wants what, dietary needs, pace).',
      inputSchema: z.object({ userMessage: z.string().min(1).max(2000) }),
      execute: async ({ userMessage }) => {
        if (outcome.planner) throw new Error('The planner already ran for this message — use its result.');
        const { result, run } = await runPlannerRefine({
          ctx,
          message: `${userMessage}\n\n[Group trip — members' preferences: ${groupContextLine(members)}]`,
        });
        outcome.planner = result;
        outcome.runs.push(summarizeTrace('planner', run));
        if (!result.unchanged) ctx.state = { trip: result.trip, days: result.days, budget: result.budget };
        return {
          mode: result.mode,
          reply: result.reply,
          changed_plan: !result.unchanged,
          updated_days: result.updated_days,
          clarifying_question: result.needs_clarification,
          per_person_total_inr: result.budget?.total_inr ?? null,
        };
      },
    }),

    invoke_budget_agent: tool({
      description: 'Runs the Budget agent: recalculates the per-person budget after a plan change (never overriding a flight cost someone entered) and warns if it is >15% over the trip limit. Also answers budget questions.',
      inputSchema: z.object({ reason: z.string().min(3).max(600) }),
      execute: async ({ reason }) => {
        if (outcome.budget) throw new Error('The budget agent already ran for this message — use its result.');
        const change = outcome.planner && !outcome.planner.unchanged ? `${reason}\nPlanner: ${outcome.planner.reply}` : null;
        const res = await runBudgetAgent(ctx, { change, question: change ? null : reason, baselineTotal });
        outcome.budget = res;
        outcome.runs.push(res.trace);
        ctx.state = res.state;
        const over = analyzePreferences(members, res.state.budget?.total_inr ?? null).budget.over_budget_for;
        return { summary: res.summary, delta: res.delta.message, concern: res.concern?.message ?? null, over_members_budget: over };
      },
    }),

    create_poll: tool({
      description: 'Starts a poll in the group chat when members disagree on an either/or choice (e.g. "Day 2 afternoon: beach or museums?"). Everyone votes in the app; when all have voted you will be asked to apply the result.',
      inputSchema: z.object({
        question: z.string().min(5).max(200),
        options: z.array(z.string().min(1).max(80)).min(2).max(4),
        dayNumber: z.number().int().min(1).nullable().describe('Day the poll is about, if any'),
      }),
      execute: async ({ question, options, dayNumber }) => {
        const poll = await createPoll(tripId, user.id, { question, options, dayNumber });
        outcome.polls.push(poll);
        return { poll_id: poll.id, question: poll.question, options: poll.options.map((o) => o.label) };
      },
    }),

    get_poll_results: tool({
      description: 'Open and recent polls with vote counts, and who has not voted yet.',
      inputSchema: z.object({}),
      execute: async () => {
        const polls = await listPolls(tripId);
        return {
          polls: polls.slice(0, 6).map((p) => ({
            poll_id: p.id,
            question: p.question,
            status: p.status,
            results: p.options.map((o) => `${o.label}: ${p.live.counts[o.id] ?? 0}`),
            leader: p.status === 'closed' ? p.result?.winner_label ?? (p.result?.tie ? `tie: ${p.result.leaders.join(' / ')}` : null) : p.live.winner_label,
            not_voted_yet: members.filter((m) => !p.votes.some((v) => v.user_id === m.user_id)).map((m) => m.display_name),
          })),
        };
      },
    }),

    close_poll: tool({
      description: 'Closes an open poll now (e.g. the group says "go with the votes") and returns the result so you can apply it.',
      inputSchema: z.object({ pollId: z.string().uuid() }),
      execute: async ({ pollId }) => {
        const poll = await closePoll(tripId, pollId);
        return { question: poll.question, winner: poll.result?.winner_label ?? null, tie: poll.result?.tie ?? false, leaders: poll.result?.leaders ?? [] };
      },
    }),

    record_expense: tool({
      description: 'Records money someone in the group actually spent, split equally among the people named (everyone if splitAmong is empty). Amount in INR — convert first if they paid in another currency.',
      inputSchema: z.object({
        description: z.string().min(2).max(120),
        amountInr: z.number().positive(),
        paidBy: z.string().min(1).describe("Name of who paid (the speaker's name for 'I paid')"),
        splitAmong: z.array(z.string()).optional().describe('Names sharing the cost; omit for everyone'),
        category: z.enum(['stay', 'food', 'transport', 'activity', 'shopping', 'other']).default('other'),
      }),
      execute: async ({ description, amountInr, paidBy, splitAmong, category }) => {
        const payer = matchMember(members, paidBy);
        if (!payer) throw new Error(`"${paidBy}" isn't in this group. Members: ${members.map((m) => m.display_name).join(', ')}`);
        const split = (splitAmong || []).map((n) => ({ n, m: matchMember(members, n) }));
        const unknown = split.filter((s) => !s.m).map((s) => s.n);
        if (unknown.length) throw new Error(`Not in this group: ${unknown.join(', ')}`);
        const expense = await addExpense(tripId, user.id, {
          description,
          amountInr,
          paidBy: payer.user_id,
          splitAmong: split.length ? split.map((s) => s.m.user_id) : null,
          category,
        });
        outcome.expenses.push(expense);
        return { recorded: true, paid_by: payer.display_name, amount: formatInr(expense.amount_inr), split_between: expense.split_among.length };
      },
    }),

    get_balances: tool({
      description: 'Shared spending so far: what each person paid, their fair share, and the fewest payments to settle up ("Arjun pays Priya ₹1,200"). Also the per-person trip estimate.',
      inputSchema: z.object({}),
      execute: async () => {
        const balances = computeBalances(members, await listExpenses(tripId));
        const perPerson = ctx.state.budget?.total_inr ?? null;
        return { ...balances, estimate_per_person_inr: perPerson, estimate_group_total_inr: perPerson != null ? perPerson * members.length : null };
      },
    }),

    update_member_preferences: tool({
      description: "Saves the SPEAKER's own preferences when they state them (interests, per-person budget in INR, pace, dietary needs, notes). Only for the person speaking.",
      inputSchema: z.object({
        interests: z.array(z.string().max(40)).max(12).optional().describe('Full list of their interests, e.g. ["beaches","street food"]'),
        budgetPerPersonInr: z.number().positive().optional(),
        pace: z.enum(['relaxed', 'balanced', 'packed']).optional(),
        dietary: z.string().max(120).optional(),
        notes: z.string().max(300).optional(),
      }),
      execute: async (p) => {
        if (systemEvent || !speaker) throw new Error('Only a group member can update their own preferences.');
        const saved = await updatePreferences(user.id, tripId, cleanPreferences({
          interests: p.interests,
          budget_per_person_inr: p.budgetPerPersonInr,
          pace: p.pace,
          dietary: p.dietary,
          notes: p.notes,
        }));
        members = await listMembers(tripId);
        return { saved: true, name: speaker.display_name, preferences: saved };
      },
    }),

    get_weather: getWeatherTool(),
  };

  const t = ctx.state.trip;
  const d = t.destination;
  const run = await runAgent({
    agentName: AGENT,
    userId: user.id,
    tripId,
    stepLimit: GROUP_STEP_LIMIT,
    systemPrompt: SYSTEM,
    tools,
    messages: [
      ...historyToMessages(history),
      {
        role: 'user',
        content: `GROUP TRIP: ${d.name}${d.country ? `, ${d.country}` : ''} (lat ${d.latitude}, lng ${d.longitude}) · ${t.start_date} to ${t.end_date} · ${ctx.state.days.length} days
Members (${members.length}): ${members.map((m) => `${m.display_name}${m.role === 'owner' ? ' (organiser)' : ''}`).join(', ')}
Days: ${ctx.state.days.map((x) => `Day ${x.day_number} ${x.theme}`).join('; ')}
Per-person budget estimate: ${ctx.state.budget ? formatInr(ctx.state.budget.total_inr) : 'not calculated'}${t.budget_limit_inr ? ` (trip limit ${formatInr(t.budget_limit_inr)})` : ''}

MESSAGE FROM ${speakerName.toUpperCase()}
"""${message}"""`,
      },
    ],
    wrapUpPrompt: 'You have used all your steps. Do not call any more tools. Reply to the group now from what you found.',
    temperature: 0.5,
  });
  outcome.runs.unshift(summarizeTrace(AGENT, run));

  // Guardrail (same as the solo orchestrator): a plan change >15% over the limit always raises a concern.
  const changed = outcome.planner && !outcome.planner.unchanged;
  let forcedConcern = null;
  if (changed && !outcome.budget) {
    const check = overLimit(ctx.state.budget?.total_inr, t.budget_limit_inr);
    if (check?.crosses_threshold) {
      const bctx = { ...ctx, concern: null };
      const msg = `The ${d.name} plan is now ${formatInr(check.total)} per person — ${check.over_pct}% over the ${formatInr(check.limit)} limit.`;
      let result;
      try {
        result = await raiseBudgetConcern(bctx, msg);
      } catch (err) {
        result = { error: err.message };
      }
      await logToolCall({ runId: run.runId, agentName: 'budget', tripId, userId: user.id, toolName: 'flag_budget_concern', args: { message: msg, forced_by_guardrail: true }, result, isError: Boolean(result.error) });
      forcedConcern = bctx.concern;
    }
  }

  const reply = run.text || outcome.planner?.reply || 'Done!';
  const poll = outcome.polls.at(-1);
  const metadata = outcome.planner?.messages.at(-1)?.metadata ?? (poll ? { type: 'poll', poll_id: poll.id } : null);
  const messages = [
    ...(systemEvent ? [] : [{ ...makeMessage('user', message), user_id: user.id, author_name: speaker?.display_name ?? user.name }]),
    makeMessage('assistant', reply, metadata),
  ];
  await saveTripPlan(user.id, tripId, { trip: ctx.state.trip, days: null, budget: null }, messages);

  const after = ctx.state.budget?.total_inr ?? null;
  return {
    trip: { ...ctx.state.trip, id: tripId },
    days: ctx.state.days,
    budget: ctx.state.budget,
    reply,
    unchanged: ctx.state === originalState,
    updated_days: outcome.planner?.updated_days ?? [],
    needs_clarification: outcome.planner?.needs_clarification ?? null,
    budget_delta: outcome.budget?.delta ?? (baselineTotal !== after ? { before: baselineTotal, after, message: null } : null),
    budget_concern: outcome.budget?.concern ?? forcedConcern,
    messages,
    agent: { runs: outcome.runs },
  };
}
