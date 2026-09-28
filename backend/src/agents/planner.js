// AGENT 1 — Planner. Gemini decides what research a request needs (weather,
// place searches, exchange rates) and which itinerary tools to use, instead of
// the fixed "always weather → always currency → one Gemini call" sequence of
// services/planner.js. The deterministic parts (dating days, attaching the
// forecast, budget arithmetic, persistence) are reused unchanged.

import { z } from 'zod';
import { addDays, toIsoDate } from '../lib/dates.js';
import { runAgent, summarizeTrace } from '../lib/agents/runAgent.js';
import { logToolCall } from '../lib/agents/toolLog.js';
import {
  BUDGET_FORMAT,
  DAY_FORMAT,
  GenerateOutputSchema,
  SYSTEM_PROMPT,
  SuggestionRequestSchema,
  assembleDays,
  computeBudget,
  destinationLabel,
  formatDateRange,
  makeMessage,
  parseDestination,
  parseOrigin,
  validateTripDates,
} from '../services/planner.js';
import { getTripWeather } from '../services/weather.js';
import { getInrRate } from '../services/currency.js';
import { findImage } from '../services/images.js';
import { buildSuggestions } from '../services/suggestions.js';
import { getCurrencyRateTool, getPlaceDetailsTool, getWeatherTool, searchPlacesTool } from './tools/research.js';
import { changedDayNumbers, commitWorkingState, compactItinerary, createItineraryTools, createWorkingState } from './tools/itinerary.js';

export const PLANNER_STEP_LIMIT = 8;
const HISTORY_LIMIT = 16;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const AGENT_RULES_GENERATE = `
You are working as an agent with tools. Before writing the itinerary, decide what research THIS trip needs:
- Call get_weather for the trip's date range (use the destination coordinates given) so you can plan around rain, storms or heat. Dates beyond the forecast range come back unavailable — then assume typical seasonal weather.
- Use search_places when you are unsure a venue exists or need options for a specific area — decide how many searches are worth it from the trip length and how well you know the destination. Do not search for famous landmarks you already know. Several independent searches can be made in the same step.
- Use get_currency_rate only if it helps you judge local prices.
When you have enough, stop calling tools and answer with the JSON only.`;

const AGENT_RULES_REFINE = `
You are working as an agent with tools on the traveller's CURRENT itinerary. Only call the tools this specific request needs:
- Cosmetic edits (renaming a day's theme, rewording, reordering) need no weather, currency or place research — just save_itinerary_state with the changed day(s).
- Before adding or suggesting an OUTDOOR activity, call get_weather for that date. If bad weather is forecast, prefer an indoor alternative or say so in your reply.
- Indoor additions, removals and questions about costs do not need weather.
- Small edits: use add_activity / remove_activity / fill_slot (fill_slot for a specific named place you are not sure about). Bigger rewrites of a day: save_itinerary_state with updatedDays.
- Moving or resizing the trip: change_dates. A new destination: change_destination, then research it and send every day plus budgetInputs to save_itinerary_state.
- Every plan change must end with ONE save_itinerary_state call (with no updatedDays if the granular tools already made the edits). Do not call it for suggestions or answers.
- Activity ids are in the itinerary JSON. Keep places the traveller added themselves unless they ask to remove them.
- If you cannot finish confidently (the request is ambiguous, or a place can't be found), save what you completed and ask ONE specific clarifying_question instead of guessing.

Choose the MODE of your final answer:
- "update": you changed the plan (with the tools above).
- "suggest": the traveller wants to SEE options (e.g. "show me coffee shops near day 1") — do not change the plan; return suggestion_request with 6 REAL, well-known places near that day's activities, each { "name", "area", "description" (max 20 words), "category", "time_of_day", "estimated_cost_inr", "rating_estimate", "image_hint" (a Wikipedia article title showing it) }, plus "search_query" (Google Maps style, anchored on that day's area) and "category" (short plural noun).
- "answer": a question or chit-chat that needs no plan change.

When done, respond with ONLY this JSON (no markdown):
{
  "mode": "update" | "suggest" | "answer",
  "reply": "1-3 friendly sentences describing what you did or answering the question",
  "clarifying_question": "string or null",
  "suggestion_request": { "day_number": number, "category": "string", "search_query": "string", "items": [ ... ] } or null
}`;

const REFINE_WRAP_UP = `You have used all your tool steps. Do not call any more tools.
Respond now with the final JSON. If the change is not complete, say in "reply" what you finished and put ONE specific question for the traveller in "clarifying_question" (e.g. which day they mean) — do not guess to fill the gaps.`;

const GENERATE_WRAP_UP = `You have used all your research steps. Do not call any more tools.
Write the complete itinerary JSON now from what you found plus your own knowledge. If something important is still unclear, add ONE specific question in "clarifying_question".`;

function tripFactsBlock(trip, numDays) {
  const d = trip.destination;
  return `Travelling from: ${trip.origin_city || 'not specified'}
Destination: ${destinationLabel(d)} (lat ${d.latitude}, lng ${d.longitude}; local currency ${d.currency_code || 'INR'})
Dates: ${trip.start_date} to ${toIsoDate(addDays(trip.start_date, numDays - 1))} (${numDays} days)
Today: ${toIsoDate(new Date())}`;
}

function budgetBlock(trip, budget) {
  if (!budget) return 'Budget: not calculated yet';
  return `Budget: total ₹${Math.round(budget.total_inr ?? 0)} (flights ₹${Math.round(budget.flights_estimate ?? 0)}${budget.flight_note ? `, ${budget.flight_note}` : ''}; hotel ₹${budget.accommodation_per_night_inr ?? '?'}/night; food ₹${budget.food_per_day_inr ?? '?'}/day; local transport ₹${budget.local_transport_per_day_inr ?? '?'}/day)${trip.budget_limit_inr ? ` — traveller's limit ₹${trip.budget_limit_inr}` : ''}`;
}

/** Stored chat history → AI SDK messages (alternating roles, starting with the user). */
export function historyToMessages(history = []) {
  const messages = [];
  for (const m of history.slice(-HISTORY_LIMIT)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    // Keep suggested places in context so "add the second one" works.
    const items = m.metadata?.type === 'suggestions' ? m.metadata.items || [] : [];
    const text = items.length ? `${m.content}\n[Suggested for Day ${m.metadata.day_number}: ${items.map((i) => i.name).join('; ')}]` : m.content;
    const last = messages.at(-1);
    if (last && last.role === role) last.content += `\n\n${text}`;
    else messages.push({ role, content: text });
  }
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: 'Help me plan a trip.' });
  return messages;
}

// ---------------------------------------------------------------------------
// New trip
// ---------------------------------------------------------------------------

export async function runPlannerGenerate({ userId, destination: rawDestination, origin: rawOrigin, startDate, endDate, agentName = 'planner' }) {
  const destination = parseDestination(rawDestination);
  const origin = parseOrigin(rawOrigin);
  const numDays = validateTripDates(startDate, endDate);
  const trip = { destination, origin_city: origin, start_date: startDate };

  const run = await runAgent({
    agentName,
    userId,
    stepLimit: PLANNER_STEP_LIMIT,
    systemPrompt: `${SYSTEM_PROMPT}\n${AGENT_RULES_GENERATE}`,
    tools: {
      get_weather: getWeatherTool(),
      get_currency_rate: getCurrencyRateTool(),
      search_places: searchPlacesTool(),
      get_place_details: getPlaceDetailsTool(),
    },
    messages: [
      {
        role: 'user',
        content: `Plan a ${numDays}-day trip.

${tripFactsBlock(trip, numDays)}

When your research is done, return JSON in exactly this shape, with exactly ${numDays} entries in "days" (day_number 1..${numDays}):
{
  "reply": "string",
  "clarifying_question": "string or null",
  "days": [
    ${DAY_FORMAT}
  ],
  "budget": ${BUDGET_FORMAT}
}`,
      },
    ],
    outputSchema: GenerateOutputSchema(numDays).extend({ clarifying_question: z.string().nullish().transform((v) => v || null) }),
    wrapUpPrompt: GENERATE_WRAP_UP,
    temperature: 0.7,
  });
  const ai = run.output;

  // Same deterministic assembly as v1 (forecast comes from the cache the agent's get_weather warmed).
  const [weatherDays, rateInfo, image] = await Promise.all([
    getTripWeather(destination.latitude, destination.longitude, startDate, numDays),
    getInrRate(destination.currency_code),
    destination.image_url ? Promise.resolve({ url: destination.image_url }) : findImage({ query: destinationLabel(destination), placeId: destination.place_id, width: 1200 }),
  ]);
  const days = assembleDays({ aiDays: ai.days, startDate, weatherDays });
  const inputs = origin ? ai.budget : { ...ai.budget, flights_round_trip_inr: 0, flight_note: '' };
  const budget = computeBudget({ days, inputs, destination, rateInfo, origin });
  const reply = ai.clarifying_question ? `${ai.reply}\n\n${ai.clarifying_question}` : ai.reply;

  return {
    trip: {
      id: null,
      status: 'planning',
      destination: { ...destination, image_url: image?.url || null },
      origin_city: origin,
      start_date: startDate,
      end_date: toIsoDate(addDays(startDate, numDays - 1)),
      num_days: numDays,
    },
    days,
    budget,
    reply,
    needs_clarification: ai.clarifying_question,
    step_limit_reached: run.stepLimitReached,
    messages: [
      makeMessage('user', `Plan a ${numDays}-day trip ${origin ? `from ${origin} ` : ''}to ${destinationLabel(destination)} (${formatDateRange(startDate, numDays)}).`),
      makeMessage('assistant', reply),
    ],
    agent: { runs: [summarizeTrace(agentName, run)] },
  };
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

const RefineAgentOutput = z
  .object({
    mode: z.enum(['update', 'suggest', 'answer']).catch('answer').default('answer'),
    reply: z.string().min(1),
    clarifying_question: z.string().nullish().transform((v) => v || null),
    suggestion_request: SuggestionRequestSchema.nullish().catch(null),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'suggest' && !v.suggestion_request) {
      ctx.addIssue({ code: 'custom', message: 'mode "suggest" requires "suggestion_request" with at least 5 items' });
    }
  });

/**
 * Runs the Planner on a trip. Does NOT save chat messages (callers do).
 *
 * @param ctx { userId, tripId, persist, state: {trip, days, budget}, history }
 * @returns { result, run, ws } — result has the v1 refine response shape plus
 *          updated_days, needs_clarification, step_limit_reached
 */
export async function runPlannerRefine({ ctx, message, focusDay = null, agentName = 'planner' }) {
  const ws = createWorkingState({ userId: ctx.userId, tripId: ctx.tripId, persist: ctx.persist, state: ctx.state });
  const numDays = ws.state.days.length;
  const focus = focusDay && focusDay <= numDays ? focusDay : null;

  const run = await runAgent({
    agentName,
    userId: ctx.userId,
    tripId: ctx.tripId,
    stepLimit: PLANNER_STEP_LIMIT,
    systemPrompt: `${SYSTEM_PROMPT}\n${AGENT_RULES_REFINE}`,
    tools: {
      get_weather: getWeatherTool(),
      get_currency_rate: getCurrencyRateTool(),
      search_places: searchPlacesTool(),
      get_place_details: getPlaceDetailsTool(),
      ...createItineraryTools(ws),
    },
    messages: [
      ...historyToMessages(ctx.history),
      {
        role: 'user',
        content: `CURRENT TRIP
${tripFactsBlock(ws.state.trip, numDays)}
${budgetBlock(ws.state.trip, ws.state.budget)}

Current itinerary (JSON, with activity ids):
${JSON.stringify(compactItinerary(ws.state.days))}

${focus ? `The traveller is looking at Day ${focus} (they tapped "Add to Day ${focus}"), so "this day"/"here" means Day ${focus}.\n\n` : ''}TRAVELLER'S LATEST MESSAGE
"""${message}"""`,
      },
    ],
    outputSchema: RefineAgentOutput,
    wrapUpPrompt: REFINE_WRAP_UP,
  });
  const ai = run.output;

  // Safety net: the model edited the plan with tools but never committed it.
  if (ws.dirty && !ws.committed) {
    let commit;
    try {
      commit = await commitWorkingState(ws);
    } catch (err) {
      commit = { error: err.message };
    }
    await logToolCall({
      runId: run.runId,
      agentName,
      tripId: ctx.tripId,
      userId: ctx.userId,
      toolName: 'save_itinerary_state',
      args: { auto_commit: true, reason: 'model made edits without calling save_itinerary_state' },
      result: commit,
      isError: Boolean(commit.error),
    });
    run.toolCalls.push({ step: run.steps, tool: 'save_itinerary_state', args: { auto_commit: true }, result: commit, is_error: Boolean(commit.error), duration_ms: 0 });
  }

  let metadata = null;
  if (ai.mode === 'suggest' && ai.suggestion_request) {
    const req = ai.suggestion_request;
    const dayNumber = Math.min(Math.max(req.day_number || focus || 1, 1), numDays);
    const items = await buildSuggestions({ request: req, destination: parseDestination(ws.state.trip.destination) });
    metadata = { type: 'suggestions', day_number: dayNumber, category: req.category, search_query: req.search_query, items };
  }

  const updatedDays = ws.committed ? changedDayNumbers(ws.original.days, ws.state.days) : [];
  const unchanged = !ws.committed;
  const reply = ai.clarifying_question ? `${ai.reply}\n\n${ai.clarifying_question}` : ai.reply;

  // Uncommitted edits are discarded: the app keeps the last saved plan.
  const final = ws.committed ? ws.state : ws.original;
  return {
    ws,
    run,
    result: {
      trip: { ...final.trip, id: ctx.tripId ?? final.trip.id ?? null },
      days: final.days,
      budget: final.budget,
      reply,
      unchanged,
      updated_days: updatedDays,
      needs_clarification: ai.clarifying_question,
      step_limit_reached: run.stepLimitReached,
      mode: ai.mode,
      messages: [makeMessage('user', message), makeMessage('assistant', reply, metadata)],
    },
  };
}
