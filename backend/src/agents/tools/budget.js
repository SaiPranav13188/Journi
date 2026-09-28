// Budget tools. Arithmetic stays deterministic (computeBudget from
// services/planner.js); the agent decides whether a change warrants a
// recalculation, which per-unit estimates to revise, and when to warn.

import { tool } from 'ai';
import { z } from 'zod';
import { supabaseAdmin as db } from '../../lib/supabase.js';
import { formatInr } from '../../lib/money.js';
import { MANUAL_FLIGHT_NOTE, computeBudget, currentBudgetInputs, isManualFlight, parseDestination } from '../../services/planner.js';
import { getInrRate } from '../../services/currency.js';
import { saveTripPlan } from '../../services/tripStore.js';
import { getCurrencyRateTool } from './research.js';
import { compactItinerary } from './itinerary.js';

/** Past this share over the traveller's limit, a budget concern must be raised. */
export const BUDGET_CONCERN_THRESHOLD = 0.15;

/** "Budget +₹800 → ₹23,350", or null when the total didn't move. Same format as the app's toasts. */
export function budgetDeltaLine(before, after) {
  const diff = Math.round((after ?? 0) - (before ?? 0));
  if (!diff) return null;
  return `Budget ${diff > 0 ? '+' : '−'}${formatInr(Math.abs(diff))} → ${formatInr(after)}`;
}

export function overLimit(total, limit) {
  if (!limit || limit <= 0 || total == null) return null;
  const overPct = (total - limit) / limit;
  return { limit, total, over_pct: Math.round(overPct * 1000) / 10, crosses_threshold: overPct > BUDGET_CONCERN_THRESHOLD };
}

/**
 * Records a budget concern (in-app alert for saved trips). Shared by the tool
 * and by the guardrail that fires it when the model didn't.
 */
export async function raiseBudgetConcern(ctx, message) {
  const check = overLimit(ctx.state.budget?.total_inr, ctx.state.trip.budget_limit_inr);
  if (!check?.crosses_threshold) {
    throw new Error(
      check
        ? `Not raised: the total ${formatInr(check.total)} is ${check.over_pct}% over the limit — the threshold is ${BUDGET_CONCERN_THRESHOLD * 100}%.`
        : 'Not raised: the traveller has no budget limit set.',
    );
  }
  const text = message.trim().slice(0, 300);
  let alertId = null;
  if (ctx.persist && ctx.tripId) {
    // Don't stack identical unread warnings for the same trip.
    const { data: existing } = await db
      .from('trip_alerts')
      .select('id')
      .eq('trip_id', ctx.tripId)
      .eq('kind', 'budget_concern')
      .eq('read', false)
      .eq('message', text)
      .limit(1);
    if (existing?.length) {
      alertId = existing[0].id;
    } else {
      const { data, error } = await db
        .from('trip_alerts')
        .insert({ trip_id: ctx.tripId, user_id: ctx.userId, kind: 'budget_concern', message: text, metadata: { total_inr: check.total, limit_inr: check.limit, over_pct: check.over_pct } })
        .select('id')
        .single();
      if (error) throw new Error(`Could not save the alert: ${error.message}`);
      alertId = data.id;
    }
  }
  ctx.concern = { message: text, ...check, alert_id: alertId };
  return { raised: true, ...ctx.concern };
}

/**
 * @param ctx { userId, tripId, persist, state: {trip, days, budget}, concern? }
 *            — state is updated in place when the budget is rewritten.
 */
export function createBudgetTools(ctx) {
  return {
    get_current_itinerary: tool({
      description: 'The trip as it is now: destination, dates, origin city, every day\'s activities with costs, the current budget breakdown and per-unit estimates, and the traveller\'s budget limit.',
      inputSchema: z.object({}),
      execute: async () => {
        const { trip, days, budget } = ctx.state;
        return {
          destination: `${trip.destination.name}${trip.destination.country ? `, ${trip.destination.country}` : ''}`,
          local_currency: trip.destination.currency_code || 'INR',
          dates: `${trip.start_date} to ${trip.end_date}`,
          num_days: days.length,
          origin_city: trip.origin_city || null,
          budget_limit_inr: trip.budget_limit_inr ?? null,
          days: compactItinerary(days),
          budget: budget
            ? {
                total_inr: budget.total_inr,
                flights: budget.flights_estimate,
                accommodation: budget.accommodation_estimate,
                food: budget.food_estimate,
                local_transport: budget.transport_estimate,
                activities: budget.activities_estimate,
                per_unit: currentBudgetInputs(ctx.state),
                exchange_rate_timestamp: budget.exchange_rate_timestamp ?? null,
              }
            : null,
        };
      },
    }),

    get_currency_rate: getCurrencyRateTool(),

    get_flight_cost: tool({
      description: 'Current flight cost in the budget and whether the traveller typed it in themselves ("Entered by you") — a traveller-entered cost must never be replaced by an estimate.',
      inputSchema: z.object({}),
      execute: async () => {
        const b = ctx.state.budget || {};
        return {
          flights_estimate_inr: b.flights_estimate ?? 0,
          flight_note: b.flight_note || null,
          entered_by_traveller: isManualFlight(b),
          origin_city: ctx.state.trip.origin_city || null,
        };
      },
    }),

    get_bookings_total: tool({
      description: 'Total already paid in confirmed/pending bookings (flights, hotels, tickets) saved for this trip, in INR. Useful for "how much have I spent vs planned" questions.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctx.tripId) return { total_inr: 0, count: 0, note: 'Unsaved trip — no bookings yet.' };
        const { data, error } = await db.from('bookings').select('type, cost_inr, status').eq('trip_id', ctx.tripId).eq('user_id', ctx.userId);
        if (error) throw new Error('Could not load bookings');
        const active = data.filter((b) => b.status !== 'cancelled');
        return {
          total_inr: Math.round(active.reduce((s, b) => s + Number(b.cost_inr || 0), 0)),
          count: active.length,
          by_type: active.reduce((acc, b) => ({ ...acc, [b.type]: Math.round((acc[b.type] || 0) + Number(b.cost_inr || 0)) }), {}),
        };
      },
    }),

    update_budget_breakdown: tool({
      description:
        'Recalculates and saves the budget. Pass only the per-unit estimates (INR) you want to change in categories; omitted ones keep their current values. ' +
        'Calling it with empty categories recalculates from the current itinerary and a fresh exchange rate. Totals are computed for you — never do the arithmetic yourself. A traveller-entered flight cost is always kept.',
      inputSchema: z.object({
        categories: z.object({
          accommodation_per_night_inr: z.number().min(0).optional(),
          food_per_day_inr: z.number().min(0).optional(),
          local_transport_per_day_inr: z.number().min(0).optional(),
          flights_round_trip_inr: z.number().min(0).optional(),
          flight_note: z.string().max(120).optional(),
          notes: z.string().max(200).optional(),
        }),
      }),
      execute: async ({ categories }) => {
        const { trip, days, budget: before } = ctx.state;
        const destination = parseDestination(trip.destination);
        const inputs = { ...currentBudgetInputs(ctx.state), ...Object.fromEntries(Object.entries(categories).filter(([, v]) => v != null)) };
        let flightKept = false;
        if (isManualFlight(before)) {
          flightKept = categories.flights_round_trip_inr != null && categories.flights_round_trip_inr !== before.flights_estimate;
          inputs.flights_round_trip_inr = before.flights_estimate || 0;
          inputs.flight_note = MANUAL_FLIGHT_NOTE;
        } else if (!trip.origin_city) {
          inputs.flights_round_trip_inr = 0;
          inputs.flight_note = '';
        }
        for (const k of ['flights_round_trip_inr', 'accommodation_per_night_inr', 'food_per_day_inr', 'local_transport_per_day_inr']) {
          inputs[k] = Math.max(0, Math.round(Number(inputs[k]) || 0));
        }
        const rateInfo = await getInrRate(destination.currency_code);
        const budget = computeBudget({ days, inputs, destination, rateInfo, origin: trip.origin_city || null });
        if (ctx.persist && ctx.tripId) {
          await saveTripPlan(ctx.userId, ctx.tripId, { trip, days: null, budget }, []);
        }
        ctx.state = { ...ctx.state, budget };
        ctx.updated = true;
        return {
          saved: true,
          total_before_inr: before?.total_inr ?? null,
          total_after_inr: budget.total_inr,
          delta: budgetDeltaLine(before?.total_inr, budget.total_inr),
          breakdown: { flights: budget.flights_estimate, accommodation: budget.accommodation_estimate, food: budget.food_estimate, local_transport: budget.transport_estimate, activities: budget.activities_estimate },
          total_local_currency: budget.total_local_currency,
          local_currency: budget.local_currency_code,
          ...(flightKept ? { note: 'The traveller entered their own flight cost, so it was kept.' } : {}),
          limit_check: overLimit(budget.total_inr, trip.budget_limit_inr),
        };
      },
    }),

    flag_budget_concern: tool({
      description:
        `Warns the traveller (in-app alert) that the trip total is more than ${BUDGET_CONCERN_THRESHOLD * 100}% over their budget limit. Call it only when that threshold is crossed — not for small overruns or when there is no limit. ` +
        'The message should say how far over it is and suggest one concrete way to bring it down.',
      inputSchema: z.object({ message: z.string().min(10).max(300) }),
      execute: ({ message }) => raiseBudgetConcern(ctx, message),
    }),
  };
}
