// AGENT 2 — Budget. Decides whether an itinerary change actually affects cost,
// revises per-unit estimates when needed, and warns when the traveller's
// limit is exceeded by more than 15%. That warning is also enforced in code:
// if the model doesn't raise it, the guardrail below does (and logs it).

import { z } from 'zod';
import { runAgent, summarizeTrace } from '../lib/agents/runAgent.js';
import { logToolCall } from '../lib/agents/toolLog.js';
import { formatInr } from '../lib/money.js';
import { BUDGET_CONCERN_THRESHOLD, budgetDeltaLine, createBudgetTools, overLimit, raiseBudgetConcern } from './tools/budget.js';

export const BUDGET_STEP_LIMIT = 5;

const SYSTEM = `You are Journi's budget agent for travellers from India. All amounts are in Indian Rupees (INR).

You keep a trip's budget accurate after itinerary changes and answer budget questions. Decide what THIS request needs:
- First decide whether the change can affect cost. Pure informational edits (a stay note, renaming a day's theme, rewording) do NOT — skip recalculation and just say the budget is unchanged.
- Always recalculate (update_budget_breakdown) after activities were added/removed/swapped, dates or trip length changed, or the destination changed. For a new destination or a different trip style, revise the per-unit estimates (hotel per night, food per day, local transport per day) with realistic mid-range values; otherwise pass empty categories to recalculate as-is.
- Never replace a flight cost the traveller entered themselves (get_flight_cost tells you). Only estimate flights when the origin or destination changed and the flight cost was not entered by the traveller.
- Use get_currency_rate only when the traveller asks about local-currency amounts; get_bookings_total only for "how much have I paid/booked" questions.
- If the traveller has a budget limit and the new total is more than ${BUDGET_CONCERN_THRESHOLD * 100}% over it, call flag_budget_concern with a short message. Do not call it for smaller overruns.
- Never do arithmetic on totals yourself — use the numbers the tools return.

When done, respond with ONLY this JSON (no markdown):
{ "recalculated": boolean, "reason": "why you did or didn't recalculate (one short sentence)", "summary": "1-2 friendly sentences for the traveller" }`;

const BudgetOutput = z.object({
  recalculated: z.boolean().catch(false),
  reason: z.string().default(''),
  summary: z.string().min(1),
});

/**
 * @param ctx { userId, tripId, persist, state: {trip, days, budget} }
 * @param opts.change        what just changed (from the Planner), or null
 * @param opts.question      the traveller's budget question, or null
 * @param opts.baselineTotal total before this whole request (for the delta line)
 * @returns { state, summary, delta, concern, recalculated, run }
 */
export async function runBudgetAgent(ctx, { change = null, question = null, baselineTotal = null, agentName = 'budget' } = {}) {
  const bctx = { ...ctx, concern: null, updated: false };
  const before = baselineTotal ?? ctx.state.budget?.total_inr ?? null;

  const run = await runAgent({
    agentName,
    userId: ctx.userId,
    tripId: ctx.tripId,
    stepLimit: BUDGET_STEP_LIMIT,
    systemPrompt: SYSTEM,
    tools: createBudgetTools(bctx),
    messages: [
      {
        role: 'user',
        content: [
          change ? `WHAT JUST CHANGED IN THE ITINERARY\n${change}` : null,
          question ? `TRAVELLER'S QUESTION\n"""${question}"""` : null,
          !change && !question ? 'Check that this trip\'s budget is up to date.' : null,
          `Current total: ${bctx.state.budget ? formatInr(bctx.state.budget.total_inr) : 'not calculated'}${bctx.state.trip.budget_limit_inr ? ` · traveller's limit ${formatInr(bctx.state.trip.budget_limit_inr)}` : ' · no limit set'}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    outputSchema: BudgetOutput,
  });

  // Guardrail: the concern MUST fire when the total is >15% over the limit.
  const check = overLimit(bctx.state.budget?.total_inr, bctx.state.trip.budget_limit_inr);
  if (check?.crosses_threshold && !bctx.concern) {
    const message = `Your ${bctx.state.trip.destination?.name ?? 'trip'} plan is now ${formatInr(check.total)} — ${check.over_pct}% over your ${formatInr(check.limit)} limit. Consider a cheaper stay or dropping a paid activity.`;
    let result;
    try {
      result = await raiseBudgetConcern(bctx, message);
    } catch (err) {
      result = { error: err.message };
    }
    await logToolCall({
      runId: run.runId,
      agentName,
      tripId: ctx.tripId,
      userId: ctx.userId,
      toolName: 'flag_budget_concern',
      args: { message, forced_by_guardrail: true },
      result,
      isError: Boolean(result.error),
    });
    run.toolCalls.push({ step: run.steps, tool: 'flag_budget_concern', args: { forced_by_guardrail: true }, result, is_error: Boolean(result.error), duration_ms: 0 });
  }

  const after = bctx.state.budget?.total_inr ?? null;
  const deltaLine = budgetDeltaLine(before, after);
  return {
    state: bctx.state,
    recalculated: run.output.recalculated || bctx.updated,
    reason: run.output.reason,
    summary: run.output.summary,
    delta: { before, after, message: deltaLine ? `💰 ${deltaLine}` : null },
    concern: bctx.concern,
    run,
    trace: summarizeTrace(agentName, run),
  };
}
