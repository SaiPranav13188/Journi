// Internal evaluation for the agents (POST /v2/eval/run). Runs a fixed set of
// refinement requests against a real trip (the tested Vietnam trip by
// default) through the v2 Planner (+ Budget where relevant) and the v1
// /itinerary/refine logic, on throw-away copies — nothing is saved to the trip.
// Per case it reports the tool sequence, the itinerary/budget diff for both
// versions, and automatic checks for wasted tool calls, missed weather checks
// and step-limit hits. Use it to iterate on prompts and tool descriptions.

import { refineItinerary } from '../services/planner.js';
import { runPlannerRefine, PLANNER_STEP_LIMIT } from './planner.js';
import { runBudgetAgent } from './budget.js';

/**
 * expect:   tools that should be called
 * avoid:    tools that would be wasted (or dangerous) for this request
 * weatherBefore: a tool that must be preceded by get_weather (outdoor additions)
 * mode:     expected planner mode
 * budget:   also run the Budget agent afterwards
 */
export const VIETNAM_CASES = [
  { id: 'rename-theme', message: "Rename Day 1's theme to 'Old Quarter wanderings'", mode: 'update', avoid: ['get_weather', 'get_currency_rate', 'search_places', 'fill_slot'] },
  { id: 'outdoor-hike', message: 'Add a morning hike in Ba Vi National Park on day 2', mode: 'update', expect: ['get_weather'], weatherBefore: ['add_activity', 'fill_slot', 'save_itinerary_state'], budget: true },
  { id: 'remove-last', message: 'Remove the last activity on day 1, it looks too packed', mode: 'update', expect: ['remove_activity'], avoid: ['get_weather', 'get_currency_rate', 'search_places'], budget: true },
  { id: 'indoor-puppets', message: 'Swap the evening of day 2 for a water puppet show', mode: 'update', avoid: ['get_currency_rate'], budget: true },
  { id: 'outdoor-cruise', message: 'Add a sunset boat cruise to the evening of day 3', mode: 'update', expect: ['get_weather'], weatherBefore: ['add_activity', 'fill_slot', 'save_itinerary_state'], budget: true },
  { id: 'suggest-coffee', message: 'Show me famous coffee shops near my day 1 plan', mode: 'suggest', avoid: ['save_itinerary_state', 'add_activity', 'remove_activity', 'change_dates', 'change_destination', 'get_currency_rate'] },
  { id: 'weather-question', message: 'What will the weather be like on day 2?', mode: 'answer', expect: ['get_weather'], avoid: ['save_itinerary_state', 'add_activity', 'remove_activity'] },
  { id: 'shift-dates', message: 'Push the whole trip two days later', mode: 'update', expect: ['change_dates'], avoid: ['change_destination'], budget: true },
  { id: 'shorter-trip', message: 'Make the trip one day shorter', mode: 'update', expect: ['change_dates'], budget: true },
  { id: 'named-place', message: 'Add Cong Caphe to the afternoon of day 1', mode: 'update', avoid: ['get_currency_rate', 'change_dates'], budget: true },
  { id: 'relaxed-day', message: 'Make day 2 more relaxed with fewer activities', mode: 'update', expect: ['save_itinerary_state'], avoid: ['get_currency_rate', 'change_dates'], budget: true },
  { id: 'cycling-tour', message: 'Add a countryside cycling tour on the morning of day 3', mode: 'update', expect: ['get_weather'], weatherBefore: ['add_activity', 'fill_slot', 'save_itinerary_state'], budget: true },
  { id: 'cost-question', message: 'How much will this whole trip cost in Vietnamese dong?', mode: 'answer', avoid: ['save_itinerary_state', 'add_activity', 'get_weather'], budgetQuestion: true },
  { id: 'destination-switch', message: 'Actually, change the destination to Hoi An', mode: 'update', expect: ['change_destination', 'save_itinerary_state'], budget: true },
];

function dayContent(d) {
  return JSON.stringify([d.date, d.theme, (d.activities || []).filter((a) => !a.placeholder).map((a) => a.title), d.meal_suggestion?.dish ?? null]);
}

function diffPlans(before, after) {
  const prev = new Map(before.days.map((d) => [d.day_number, d]));
  const changed = after.days.filter((d) => !prev.has(d.day_number) || dayContent(prev.get(d.day_number)) !== dayContent(d));
  return {
    changed_days: changed.map((d) => d.day_number),
    removed_days: before.days.filter((d) => !after.days.some((x) => x.day_number === d.day_number)).map((d) => d.day_number),
    days: changed.map((d) => {
      const old = prev.get(d.day_number);
      const titles = (x) => (x?.activities || []).filter((a) => !a.placeholder).map((a) => a.title);
      return {
        day: d.day_number,
        theme: old?.theme !== d.theme ? { before: old?.theme ?? null, after: d.theme } : undefined,
        added: titles(d).filter((t) => !titles(old).includes(t)),
        removed: titles(old).filter((t) => !titles(d).includes(t)),
      };
    }),
    destination: before.trip.destination?.name !== after.trip.destination?.name ? { before: before.trip.destination?.name, after: after.trip.destination?.name } : undefined,
    dates: before.trip.start_date !== after.trip.start_date || before.days.length !== after.days.length
      ? { before: `${before.trip.start_date} (${before.days.length}d)`, after: `${after.trip.start_date} (${after.days.length}d)` }
      : undefined,
    budget: { before: before.budget?.total_inr ?? null, after: after.budget?.total_inr ?? null },
  };
}

function checkCase(testCase, sequence, plannerMode, stepLimitReached) {
  const issues = [];
  const called = new Set(sequence);
  for (const t of testCase.expect || []) if (!called.has(t)) issues.push({ kind: 'missed_tool', tool: t });
  for (const t of testCase.avoid || []) if (called.has(t)) issues.push({ kind: 'unnecessary_tool', tool: t });
  for (const t of testCase.weatherBefore || []) {
    const at = sequence.indexOf(t);
    if (at !== -1 && !sequence.slice(0, at).includes('get_weather')) issues.push({ kind: 'missed_weather_check', before: t });
  }
  // Same tool with the same purpose many times usually means a wasted loop.
  const counts = sequence.reduce((acc, t) => ({ ...acc, [t]: (acc[t] || 0) + 1 }), {});
  for (const [t, n] of Object.entries(counts)) if (n >= 4) issues.push({ kind: 'repeated_tool', tool: t, count: n });
  if (testCase.mode && plannerMode && testCase.mode !== plannerMode) issues.push({ kind: 'unexpected_mode', expected: testCase.mode, got: plannerMode });
  if (stepLimitReached) issues.push({ kind: 'step_limit_hit', limit: PLANNER_STEP_LIMIT });
  return issues;
}

/**
 * @param opts { userId, tripId, state: {trip, days, budget}, cases?, compareV1 = true }
 */
export async function runEval({ userId, tripId, state, cases = VIETNAM_CASES, compareV1 = true }) {
  const results = [];
  for (const testCase of cases) {
    const started = Date.now();
    const base = structuredClone({ trip: state.trip, days: state.days, budget: state.budget });
    const ctx = { userId, tripId, persist: false, state: base, history: [] };
    const out = { id: testCase.id, message: testCase.message };

    try {
      let v2State = base;
      let sequence = [];
      let mode = null;
      let stepLimit = false;
      const runs = [];

      if (!testCase.budgetQuestion) {
        const { result, run } = await runPlannerRefine({ ctx, message: testCase.message, agentName: 'eval/planner' });
        v2State = { trip: result.trip, days: result.days, budget: result.budget };
        sequence = run.toolCalls.map((c) => c.tool);
        mode = result.mode;
        stepLimit = run.stepLimitReached;
        runs.push({ agent: 'planner', tool_calls: run.toolCalls.map((c) => ({ step: c.step, tool: c.tool, args: c.args, ok: !c.is_error })), steps: run.steps, model_calls: run.usage.modelCalls, reply: result.reply, clarifying_question: result.needs_clarification });
        out.v2_updated_days = result.updated_days;
      }

      if (testCase.budget || testCase.budgetQuestion) {
        const res = await runBudgetAgent(
          { ...ctx, state: v2State },
          testCase.budgetQuestion ? { question: testCase.message, agentName: 'eval/budget' } : { change: testCase.message, baselineTotal: base.budget?.total_inr, agentName: 'eval/budget' },
        );
        v2State = res.state;
        runs.push({ agent: 'budget', tool_calls: res.run.toolCalls.map((c) => ({ step: c.step, tool: c.tool, args: c.args, ok: !c.is_error })), recalculated: res.recalculated, reason: res.reason, summary: res.summary, delta: res.delta.message, concern: res.concern?.message ?? null });
        if (testCase.budgetQuestion) sequence = res.run.toolCalls.map((c) => c.tool);
      }

      out.v2 = { tool_sequence: sequence, runs, diff: diffPlans(base, v2State) };
      out.checks = checkCase(testCase, sequence, testCase.budgetQuestion ? null : mode, stepLimit);
    } catch (err) {
      out.v2 = { error: err.message };
      out.checks = [{ kind: 'error', message: err.message }];
    }

    if (compareV1) {
      try {
        const v1 = await refineItinerary({ state: structuredClone(base), history: [], message: testCase.message });
        out.v1 = { mode: v1.unchanged ? (v1.messages.at(-1)?.metadata ? 'suggest' : 'answer') : 'update', reply: v1.reply, diff: diffPlans(base, v1) };
      } catch (err) {
        out.v1 = { error: err.message };
      }
      // Flag for a human look when v1 and v2 disagree on what changed.
      const a = out.v2?.diff;
      const b = out.v1?.diff;
      out.manual_review = !a || !b
        ? 'one side failed'
        : JSON.stringify([a.changed_days, a.removed_days, a.destination?.after, a.dates?.after]) !== JSON.stringify([b.changed_days, b.removed_days, b.destination?.after, b.dates?.after])
          ? 'v1 and v2 changed different things — compare manually'
          : null;
    }
    out.duration_ms = Date.now() - started;
    results.push(out);
  }

  const all = results.flatMap((r) => r.checks || []);
  return {
    trip_id: tripId,
    cases: results.length,
    summary: {
      passed: results.filter((r) => !(r.checks || []).length).length,
      unnecessary_tool_calls: all.filter((c) => c.kind === 'unnecessary_tool').length,
      missed_weather_checks: all.filter((c) => c.kind === 'missed_weather_check').length,
      missed_tools: all.filter((c) => c.kind === 'missed_tool').length,
      step_limit_hits: all.filter((c) => c.kind === 'step_limit_hit').length,
      errors: all.filter((c) => c.kind === 'error').length,
      needs_manual_review: results.filter((r) => r.manual_review).map((r) => r.id),
    },
    results,
  };
}
