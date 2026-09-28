// ORCHESTRATOR — sits in front of chat (POST /v2/chat). Gemini decides which
// specialist agent(s) a message needs — Planner, Budget, Price-Check — or
// answers simple factual questions itself with get_weather, then writes one
// conversational reply. Sub-agents are invoked as tools; each logs its own
// tool calls under its own agent name.

import { tool } from 'ai';
import { z } from 'zod';
import { runAgent, summarizeTrace } from '../lib/agents/runAgent.js';
import { logToolCall } from '../lib/agents/toolLog.js';
import { formatInr } from '../lib/money.js';
import { makeMessage } from '../services/planner.js';
import { saveTripPlan } from '../services/tripStore.js';
import { getWeatherTool } from './tools/research.js';
import { overLimit, raiseBudgetConcern } from './tools/budget.js';
import { runPlannerRefine, historyToMessages } from './planner.js';
import { runBudgetAgent } from './budget.js';
import { runPriceCheckAgent } from './priceCheck.js';

export const ORCHESTRATOR_STEP_LIMIT = 4;
const AGENT = 'orchestrator';

const SYSTEM = `You are Journi, a warm, travel-savvy assistant for travellers from India, coordinating specialist agents for one trip.

Decide what the traveller's message needs:
- Simple factual questions you can answer yourself (e.g. "will it rain on day 2?", "what's the weather in Hanoi next week?") — use get_weather directly; do NOT invoke a sub-agent.
- Anything that changes the itinerary (add/remove/swap places, change dates, length or destination) or asks for suggestions of places — invoke_planner_agent with the traveller's request (pass their words, plus any context from the conversation it needs).
- After a planner change that could affect cost (activities, dates, length, destination), invoke_budget_agent. Also invoke it when the traveller asks about the budget or costs. Skip it for purely cosmetic changes and for suggestions.
- A photo is attached AND they ask about prices/whether something is fair — invoke_price_check_agent.
- General chit-chat or travel questions you know well — just answer.

Then write ONE clear, conversational reply (1-4 sentences) that tells the traveller what was done, based on what the sub-agents returned. Include the budget change line (e.g. "💰 Budget +₹800 → ₹23,350") if the budget agent returned one, and any clarifying question the planner asked. Never claim a change the planner didn't make. Plain text only — no JSON, no markdown headings.`;

/**
 * @param ctx { userId, tripId, persist, state: {trip, days, budget}, history }
 * @param opts { message, focusDay, image: {base64, mimeType} | null }
 * @returns PlanResponse (v1 refine shape) + updated_days, budget_delta, budget_concern, price_check, agent
 */
export async function runOrchestrator(ctx, { message, focusDay = null, image = null }) {
  const baselineTotal = ctx.state.budget?.total_inr ?? null;
  const originalState = ctx.state;
  const outcome = { planner: null, budget: null, price: null, runs: [] };

  const tools = {
    invoke_planner_agent: tool({
      description:
        'Runs the Planner agent on this trip: it researches (weather, places) as needed and changes the itinerary, or returns place suggestions, or answers itinerary questions. Returns what it did, which days changed, and any clarifying question.',
      inputSchema: z.object({ userMessage: z.string().min(1).max(1500).describe("The traveller's request for the planner") }),
      execute: async ({ userMessage }) => {
        if (outcome.planner) throw new Error('The planner already ran for this message — use its result.');
        const { result, run } = await runPlannerRefine({ ctx: { ...ctx, history: ctx.history }, message: userMessage, focusDay });
        outcome.planner = result;
        outcome.runs.push(summarizeTrace('planner', run));
        if (!result.unchanged) ctx.state = { trip: result.trip, days: result.days, budget: result.budget };
        return {
          mode: result.mode,
          reply: result.reply,
          changed_plan: !result.unchanged,
          updated_days: result.updated_days,
          clarifying_question: result.needs_clarification,
          suggestions_shown: result.messages.at(-1)?.metadata?.items?.map((i) => i.name) ?? [],
          step_limit_reached: result.step_limit_reached,
          budget_total_inr: result.budget?.total_inr ?? null,
        };
      },
    }),

    invoke_budget_agent: tool({
      description:
        "Runs the Budget agent: checks whether the latest change affects cost, recalculates and saves the budget if so (never overriding a flight cost the traveller entered), and warns when the traveller's limit is exceeded by more than 15%. Also answers budget questions.",
      inputSchema: z.object({
        reason: z.string().min(3).max(600).describe('What changed in the plan, or the budget question to answer'),
      }),
      execute: async ({ reason }) => {
        if (outcome.budget) throw new Error('The budget agent already ran for this message — use its result.');
        const change = outcome.planner && !outcome.planner.unchanged
          ? `${reason}\nPlanner changed day(s) ${outcome.planner.updated_days.join(', ') || '(none reported)'}: ${outcome.planner.reply}`
          : null;
        const res = await runBudgetAgent(ctx, { change, question: change ? null : reason, baselineTotal });
        outcome.budget = res;
        outcome.runs.push(res.trace);
        ctx.state = res.state;
        return { recalculated: res.recalculated, reason: res.reason, summary: res.summary, delta: res.delta.message, concern: res.concern?.message ?? null };
      },
    }),

    invoke_price_check_agent: tool({
      description: 'Runs the Price-Check agent on the photo the traveller attached (menu, price tag, taxi quote…) and returns fair/high verdicts in rupees. Only works when a photo is attached.',
      inputSchema: z.object({ note: z.string().max(200).optional().describe("Anything the traveller said about the photo, e.g. 'tuk-tuk to the old town'") }),
      execute: async ({ note }) => {
        if (!image) throw new Error('No photo is attached to this message — ask the traveller to attach one.');
        if (outcome.price) throw new Error('The price check already ran for this photo — use its result.');
        const d = ctx.state.trip.destination;
        const res = await runPriceCheckAgent({
          userId: ctx.userId,
          tripId: ctx.tripId,
          base64: image.base64,
          mimeType: image.mimeType,
          place: [d.name, d.country].filter(Boolean).join(', '),
          countryCode: d.country_code ?? null,
          note: note ?? null,
        });
        outcome.price = res;
        outcome.runs.push(...res.agent.runs);
        return { what: res.what, summary: res.summary, tip: res.tip, items: res.items.map((i) => ({ name: i.name, price: `${res.currency} ${i.price}`, price_inr: i.price_inr, verdict: i.verdict })) };
      },
    }),

    get_weather: getWeatherTool(),
  };

  const t = ctx.state.trip;
  const d = t.destination;
  const run = await runAgent({
    agentName: AGENT,
    userId: ctx.userId,
    tripId: ctx.tripId,
    stepLimit: ORCHESTRATOR_STEP_LIMIT,
    systemPrompt: SYSTEM,
    tools,
    messages: [
      ...historyToMessages(ctx.history),
      {
        role: 'user',
        content: `TRIP: ${d.name}${d.country ? `, ${d.country}` : ''} (lat ${d.latitude}, lng ${d.longitude}) · ${t.start_date} to ${t.end_date} · ${ctx.state.days.length} days${t.origin_city ? ` · from ${t.origin_city}` : ''}
Days: ${ctx.state.days.map((x) => `Day ${x.day_number} (${x.date}) ${x.theme}`).join('; ')}
Budget: ${ctx.state.budget ? formatInr(ctx.state.budget.total_inr) : 'not calculated'}${t.budget_limit_inr ? ` (limit ${formatInr(t.budget_limit_inr)})` : ''}
${focusDay ? `The traveller is looking at Day ${focusDay}.\n` : ''}${image ? 'A PHOTO IS ATTACHED to this message.\n' : ''}
TRAVELLER'S MESSAGE
"""${message}"""`,
      },
    ],
    wrapUpPrompt: 'You have used all your steps. Do not call any more tools. Write the final reply to the traveller now from what the agents returned.',
    temperature: 0.5,
  });
  outcome.runs.unshift(summarizeTrace(AGENT, run));

  // Guardrail: a plan change that pushes the total >15% over the limit must raise
  // a concern even if the orchestrator skipped the budget agent.
  const changed = outcome.planner && !outcome.planner.unchanged;
  if (changed && !outcome.budget) {
    const check = overLimit(ctx.state.budget?.total_inr, ctx.state.trip.budget_limit_inr);
    if (check?.crosses_threshold) {
      const bctx = { ...ctx, concern: null };
      const msg = `Your ${d.name} plan is now ${formatInr(check.total)} — ${check.over_pct}% over your ${formatInr(check.limit)} limit. Consider a cheaper stay or dropping a paid activity.`;
      let result;
      try {
        result = await raiseBudgetConcern(bctx, msg);
      } catch (err) {
        result = { error: err.message };
      }
      await logToolCall({ runId: run.runId, agentName: 'budget', tripId: ctx.tripId, userId: ctx.userId, toolName: 'flag_budget_concern', args: { message: msg, forced_by_guardrail: true }, result, isError: Boolean(result.error) });
      outcome.budgetConcern = bctx.concern;
    }
  }

  const reply = run.text || outcome.planner?.reply || 'Done!';
  const plannerMeta = outcome.planner?.messages.at(-1)?.metadata ?? null;
  const priceMeta = outcome.price ? { type: 'price_check', result: { ...outcome.price, agent: undefined } } : null;
  const messages = [makeMessage('user', message), makeMessage('assistant', reply, plannerMeta || priceMeta)];

  // Chat messages are saved with the trip, like v1 (the plan itself was already committed by the agents).
  if (ctx.persist && ctx.tripId) {
    await saveTripPlan(ctx.userId, ctx.tripId, { trip: ctx.state.trip, days: null, budget: null }, messages);
  }

  const after = ctx.state.budget?.total_inr ?? null;
  return {
    trip: { ...ctx.state.trip, id: ctx.tripId ?? null },
    days: ctx.state.days,
    budget: ctx.state.budget,
    reply,
    unchanged: ctx.state === originalState,
    updated_days: outcome.planner?.updated_days ?? [],
    needs_clarification: outcome.planner?.needs_clarification ?? null,
    budget_delta: outcome.budget?.delta ?? (baselineTotal !== after ? { before: baselineTotal, after, message: null } : null),
    budget_concern: outcome.budget?.concern ?? outcome.budgetConcern ?? null,
    price_check: outcome.price ? { ...outcome.price, agent: undefined } : null,
    messages,
    agent: { runs: outcome.runs },
  };
}
