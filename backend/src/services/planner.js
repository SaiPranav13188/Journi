// Orchestrates itinerary generation and conversational refinement:
// weather + exchange rate -> Gemini (strict JSON) -> deterministic assembly of
// dated days, weather warnings and a recomputed budget.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { addDays, daysBetweenInclusive, isValidIsoDate, toIsoDate, todayIso } from '../lib/dates.js';
import { generateJson } from './gemini.js';
import { getTripWeather, weatherForPrompt } from './weather.js';
import { getInrRate } from './currency.js';
import { findImage } from './images.js';
import { resolvePlaceByText } from './places.js';
import { currencyForCountry } from '../data/countryCurrency.js';
import { buildSuggestions, suggestionToActivity } from './suggestions.js';
import { lookupPlaceActivity } from './placeLookup.js';

export const MAX_TRIP_DAYS = 30;

// ---------------------------------------------------------------------------
// AI output schemas (lenient where harmless, strict where the app depends on it)
// ---------------------------------------------------------------------------

const money = z.coerce.number().min(0).transform((n) => Math.round(n));

export const ActivitySchema = z.object({
  time_of_day: z
    .string()
    .transform((s) => s.toLowerCase().trim())
    .pipe(z.enum(['morning', 'afternoon', 'evening'])),
  title: z.string().min(2),
  description: z.string().default(''),
  place_name: z.string().nullish().transform((v) => v || null),
  area: z.string().nullish().transform((v) => v || null),
  estimated_cost_inr: money.default(0),
  duration_hours: z.coerce.number().min(0).max(24).nullish().transform((v) => v ?? null),
  indoor: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(false),
  category: z.string().nullish().transform((v) => v || 'sightseeing'),
});

export const MealSchema = z.object({
  dish: z.string().min(2),
  where: z.string().nullish().transform((v) => v || null),
  description: z.string().default(''),
  estimated_cost_inr: money.default(0),
});

export const DaySchema = z.object({
  day_number: z.coerce.number().int().min(1),
  theme: z.string().min(2),
  activities: z.array(ActivitySchema).min(1).max(20),
  meal_suggestion: MealSchema,
});

export const BudgetInputsSchema = z.object({
  flights_round_trip_inr: money.default(0),
  flight_note: z.string().nullish().transform((v) => v || ''),
  accommodation_per_night_inr: money,
  food_per_day_inr: money,
  local_transport_per_day_inr: money,
  notes: z.string().default(''),
});

const daysSchema = (exactCount) => {
  const base = z.array(DaySchema).min(1).max(MAX_TRIP_DAYS);
  return exactCount ? base.length(exactCount, `Expected exactly ${exactCount} days`) : base;
};

export const GenerateOutputSchema = (numDays) =>
  z.object({
    reply: z.string().min(1),
    days: daysSchema(numDays),
    budget: BudgetInputsSchema,
  });

const SuggestionItemSchema = z.object({
  name: z.string().min(2),
  area: z.string().nullish().transform((v) => v || null),
  description: z.string().default(''),
  category: z.string().nullish().transform((v) => v || 'places'),
  time_of_day: z
    .string()
    .transform((s) => s.toLowerCase().trim())
    .pipe(z.enum(['morning', 'afternoon', 'evening']))
    .catch('afternoon'),
  estimated_cost_inr: money.default(0),
  rating_estimate: z.coerce.number().min(0).max(5).nullish().catch(null).transform((v) => v ?? null),
  image_hint: z.string().nullish().transform((v) => v || null),
});

export const SuggestionRequestSchema = z.object({
  day_number: z.coerce.number().int().min(1).nullish().catch(null),
  category: z.string().min(2).default('places'),
  search_query: z.string().min(3),
  items: z.array(SuggestionItemSchema).min(5, 'Give at least 5 suggestions').max(10),
});

const RefineOutputSchema = z
  .object({
  mode: z.enum(['update', 'suggest', 'answer']).catch('update').default('update'),
  reply: z.string().min(1),
  suggestion_request: SuggestionRequestSchema.nullish(),
  trip_changes: z
    .object({
      new_destination: z.string().nullish().transform((v) => v || null),
      new_start_date: z.string().nullish().transform((v) => v || null),
      new_origin: z.string().nullish().transform((v) => v || null),
    })
    .nullish()
    .transform((v) => v || { new_destination: null, new_start_date: null, new_origin: null }),
  days: daysSchema(null).nullish(),
  budget: BudgetInputsSchema.nullish(),
})
  .superRefine((v, ctx) => {
    if (v.mode === 'update' && (!v.days || !v.budget)) {
      ctx.addIssue({ code: 'custom', message: 'mode "update" requires the full "days" array and "budget"' });
    }
    if (v.mode === 'suggest' && !v.suggestion_request) {
      ctx.addIssue({ code: 'custom', message: 'mode "suggest" requires "suggestion_request" with at least 5 items' });
    }
  });

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are Journi, a warm, knowledgeable travel planner. Your users are travellers from India, so all cost estimates are in Indian Rupees (INR).

Planning rules:
- Recommend only real places, neighbourhoods, landmarks and dishes that actually exist at the destination. Never invent venues.
- Group each day's activities geographically so travel time is realistic; respect typical opening hours.
- Each day has a short evocative theme, 3 to 5 activities ordered by time of day (morning -> afternoon -> evening), and exactly one meal/food suggestion (a local dish plus a real area or well-known eatery to try it).
- Use the weather forecast you are given. On days with rain, storms, extreme heat/cold or high winds, favour indoor or sheltered activities and mark them "indoor": true. When you adapt a day to the weather, say so briefly in your reply (e.g. "I've kept Day 3 mostly indoors since heavy rain is forecast").
- Costs are realistic per-person, mid-range estimates in INR. Use 0 for free activities. Entry fees/tickets go in each activity's estimated_cost_inr.
- If "Travelling from" is "not specified", set flights_round_trip_inr to 0 and flight_note to "".
- Otherwise the budget includes a realistic RETURN (up and down) economy flight fare per person from the traveller's departure city to the destination's nearest major airport and back, for the trip dates, in INR, plus a short flight_note with the route (e.g. "Hyderabad ⇄ Hanoi (HAN), 1 stop, ~7h each way"). If there is no sensible flight (e.g. a short road trip), use the cheapest return train/bus fare instead and say so in flight_note. If the departure city is the destination itself, use 0.
- The budget object gives per-night accommodation (mid-range hotel, per person sharing a double room), per-day food and per-day local transport, all in INR.
- Keep descriptions concise (under 30 words). place_name must be the specific landmark/venue name as it would appear on a map or Wikipedia (or null if the activity has no single place).
- Your "reply" is a short, friendly conversational message (1-3 sentences) — like a travel-savvy friend, not a report.
- Respond with a single JSON object only. No markdown, no code fences, no commentary.`;

export const DAY_FORMAT = `{
      "day_number": 1,
      "theme": "string",
      "activities": [
        {
          "time_of_day": "morning" | "afternoon" | "evening",
          "title": "string",
          "description": "string",
          "place_name": "string or null",
          "area": "neighbourhood and city, e.g. Hoan Kiem, Hanoi",
          "estimated_cost_inr": number,
          "duration_hours": number,
          "indoor": boolean,
          "category": "sightseeing" | "culture" | "nature" | "food" | "shopping" | "adventure" | "relaxation" | "nightlife" | "transport"
        }
      ],
      "meal_suggestion": { "dish": "string", "where": "string", "description": "string", "estimated_cost_inr": number }
    }`;

export const BUDGET_FORMAT = `{
    "flights_round_trip_inr": number,
    "flight_note": "string",
    "accommodation_per_night_inr": number,
    "food_per_day_inr": number,
    "local_transport_per_day_inr": number,
    "notes": "one short sentence on budget assumptions"
  }`;

export function destinationLabel(d) {
  return [d.name, d.country].filter(Boolean).join(', ');
}

export function formatDateRange(start, numDays) {
  const end = toIsoDate(addDays(start, numDays - 1));
  const fmt = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function buildGeneratePrompt({ destination, origin, startDate, numDays, weatherDays }) {
  return `Plan a ${numDays}-day trip.

Travelling from: ${origin || 'not specified'}
Destination: ${destinationLabel(destination)}${destination.full_name ? ` (${destination.full_name})` : ''}
Dates: ${startDate} to ${toIsoDate(addDays(startDate, numDays - 1))} (${numDays} days)

Weather forecast:
${weatherForPrompt(weatherDays)}

Return JSON in exactly this shape, with exactly ${numDays} entries in "days" (day_number 1..${numDays}):
{
  "reply": "string",
  "days": [
    ${DAY_FORMAT}
  ],
  "budget": ${BUDGET_FORMAT}
}`;
}

export function compactStateForPrompt(days) {
  return days.map((d) => ({
    day_number: d.day_number,
    date: d.date,
    theme: d.theme,
    activities: d.activities
      .filter((a) => !a.placeholder)
      .map(({ id, image_url, maps_url, source_suggestion_id, lat, lng, status, ...a }) => a),
    meal_suggestion: d.meal_suggestion,
  }));
}

function buildRefinePrompt({ destination, origin, startDate, numDays, days, weatherDays, message, focusDay }) {
  return `CURRENT TRIP
Travelling from: ${origin}
Destination: ${destinationLabel(destination)}
Dates: ${startDate} to ${toIsoDate(addDays(startDate, numDays - 1))} (${numDays} days)

Weather forecast for the current dates:
${weatherForPrompt(weatherDays)}

Current itinerary (JSON):
${JSON.stringify(compactStateForPrompt(days))}

${focusDay ? `The user is currently looking at Day ${focusDay} (they tapped "Add to Day ${focusDay}"), so "this day"/"here" means Day ${focusDay}.\n\n` : ''}USER'S LATEST MESSAGE
"""${message}"""

First choose the MODE:
- "suggest": the user wants to SEE options or recommendations (e.g. "show me famous coffee shops near my day 1 plan", "best restaurants near day 2", "any treks nearby?") instead of changing the plan. Return "suggestion_request" with:
  - day_number: the day they mean (${focusDay ? `default ${focusDay}` : 'null if unclear'}),
  - category: short plural noun, e.g. "coffee shops",
  - search_query: a Google Maps style search anchored on that day's main locations, e.g. "best coffee shops near Hoan Kiem Lake, Hanoi",
  - items: 6 REAL, well-known, currently operating places near that day's activities — each { "name", "area", "description" (max 20 words, why it's special), "category", "time_of_day", "estimated_cost_inr" (per person), "rating_estimate" (its typical public rating out of 5), "image_hint" (a Wikipedia article title that shows this place or its signature item, e.g. "Egg coffee") }.
  Do NOT return "days" or "budget" in this mode. The reply introduces the options in one sentence.
- "answer": a question or chit-chat that needs no plan change. Reply only; do NOT return "days" or "budget".
- "update": the user wants the itinerary changed (including "add <place> to day 2"). Follow the rules below and return full "days" and "budget".

Rules for "update":
- Return the FULL updated itinerary (every day, not just changed ones). Keep days the user didn't ask to change as they are.
- If the user wants more or fewer days, return that many days (max ${MAX_TRIP_DAYS}), numbered from 1 consecutively.
- If the user wants to move the trip to different dates, set trip_changes.new_start_date (YYYY-MM-DD); otherwise null.
- If the user wants to change the destination entirely, set trip_changes.new_destination to the new place name (e.g. "Lisbon, Portugal") and re-plan for it; otherwise null.
- If the user says they are travelling from a different city, set trip_changes.new_origin to that city and re-estimate the flights; otherwise null.
- Keep any activities the user added themselves unless they ask to remove them.
- Always return an up-to-date budget reflecting the changes.

Return JSON in exactly this shape (omit "days"/"budget" unless mode is "update", omit "suggestion_request" unless mode is "suggest"):
{
  "mode": "update" | "suggest" | "answer",
  "reply": "string (conversational)",
  "suggestion_request": { "day_number": number, "category": "string", "search_query": "string", "items": [ ... ] },
  "trip_changes": { "new_destination": "string or null", "new_start_date": "YYYY-MM-DD or null", "new_origin": "string or null" },
  "days": [
    ${DAY_FORMAT}
  ],
  "budget": ${BUDGET_FORMAT}
}`;
}

// Converts stored chat history to Gemini "contents" (user/model turns, merged
// so roles alternate, starting with a user turn).
function historyToContents(history) {
  const contents = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    // Keep suggested places in context so "add the second one" works.
    const items = m.metadata?.type === 'suggestions' ? m.metadata.items || [] : [];
    const text = items.length
      ? `${m.content}\n[Suggested for Day ${m.metadata.day_number}: ${items.map((i) => i.name).join('; ')}]`
      : m.content;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: 'Help me plan a trip.' }] });
  return contents;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Sums activity costs, split into food places (cafés, restaurants…) and everything else. */
export function activityCosts(days) {
  let food = 0;
  let other = 0;
  for (const d of days || []) {
    for (const a of d.activities || []) {
      if (a.placeholder) continue;
      const cost = Number(a.estimated_cost_inr) || 0;
      if (a.category === 'food') food += cost;
      else other += cost;
    }
  }
  return { food: Math.round(food), other: Math.round(other) };
}

export function computeBudget({ days, inputs, destination, rateInfo, origin }) {
  const numDays = days.length;
  const nights = Math.max(numDays - 1, 0);
  // Every place in the itinerary counts: food places go under Food & drinks,
  // everything else under Activities & entry fees.
  const { food: foodSpots, other: activitiesTotal } = activityCosts(days);

  const accommodation = Math.round(inputs.accommodation_per_night_inr * nights);
  const food = Math.round(inputs.food_per_day_inr * numDays) + foodSpots;
  const transport = Math.round(inputs.local_transport_per_day_inr * numDays);
  const flights = Math.round(inputs.flights_round_trip_inr || 0);
  const onGround = accommodation + food + transport + activitiesTotal;
  const totalInr = flights + onGround;

  const localCode = destination.currency_code || currencyForCountry(destination.country_code) || 'INR';
  const isInternational = localCode !== 'INR';
  const rate = isInternational ? rateInfo?.rate ?? null : 1;

  return {
    flights_estimate: flights,
    flight_note: inputs.flight_note || null,
    accommodation_estimate: accommodation,
    food_estimate: food,
    transport_estimate: transport,
    activities_estimate: activitiesTotal,
    total_inr: totalInr,
    local_currency_code: localCode,
    total_local_currency: rate != null ? Math.round(totalInr * rate * 100) / 100 : null,
    exchange_rate_used: isInternational ? rate : 1,
    exchange_rate_timestamp: isInternational ? rateInfo?.timestamp ?? null : null,
    // Response-only extras (not persisted as columns):
    is_international: isInternational,
    on_ground_inr: onGround,
    food_spots_inr: foodSpots,
    origin_city: origin || null,
    exchange_rate_provider: isInternational ? rateInfo?.provider ?? null : null,
    nights,
    num_days: numDays,
    accommodation_per_night_inr: inputs.accommodation_per_night_inr,
    food_per_day_inr: inputs.food_per_day_inr,
    local_transport_per_day_inr: inputs.local_transport_per_day_inr,
    notes: inputs.notes || null,
  };
}

export function assembleDays({ aiDays, startDate, weatherDays, previousDays, previousStartDate }) {
  const sorted = [...aiDays].sort((a, b) => a.day_number - b.day_number);
  const sameStart = previousStartDate && previousStartDate === startDate;

  // Places the user added carry a photo/rating/map link the AI doesn't echo
  // back — restore them when the AI keeps the same place.
  const EXTRA_FIELDS = ['image_url', 'rating', 'rating_count', 'rating_source', 'maps_url', 'address', 'source_suggestion_id', 'added_by_user', 'lat', 'lng', 'status'];
  const previousByTitle = new Map();
  for (const d of previousDays || []) {
    for (const a of d.activities || []) {
      if (!a.placeholder && a.title) previousByTitle.set(a.title.toLowerCase(), a);
    }
  }
  const withExtras = (a) => {
    const prev = previousByTitle.get(a.title.toLowerCase());
    if (!prev) return a;
    const extras = Object.fromEntries(EXTRA_FIELDS.filter((k) => prev[k] != null).map((k) => [k, prev[k]]));
    return { ...a, ...extras };
  };

  return sorted.map((day, i) => {
    const date = toIsoDate(addDays(startDate, i));
    const weather = weatherDays[i] || { date, available: false, reason: 'fetch_failed', warning: null };
    const { warning, ...weatherSummary } = weather;

    // Accommodation notes are user-entered — carry them across AI edits.
    const prev = (previousDays || []).find((p) => (sameStart ? p.date === date : p.day_number === i + 1));

    return {
      day_number: i + 1,
      date,
      theme: day.theme,
      activities: day.activities.map((a) => ({ id: randomUUID(), ...withExtras(a) })),
      meal_suggestion: day.meal_suggestion,
      accommodation_note: prev?.accommodation_note || null,
      weather_summary: weatherSummary,
      weather_warning: warning || null,
    };
  });
}

// Inverse of computeBudget for trips loaded from the DB (which only store the
// totals): recovers the per-unit inputs needed to recompute after edits.
export function budgetInputsFromStored(budget, numDays, days = null) {
  if (!budget) {
    return { flights_round_trip_inr: 0, flight_note: '', accommodation_per_night_inr: 0, food_per_day_inr: 0, local_transport_per_day_inr: 0, notes: '' };
  }
  const nights = Math.max(numDays - 1, 0);
  // The stored food total includes food places in the plan (budgets saved before
  // that change don't) — derive which case applies from the stored numbers.
  let foodSpotsStored = 0;
  if (days) {
    const costs = activityCosts(days);
    foodSpotsStored = Math.max(0, Math.min(costs.food, costs.food + costs.other - (budget.activities_estimate || 0)));
  }
  return {
    flights_round_trip_inr: Math.round(budget.flights_estimate || 0),
    flight_note: budget.flight_note || '',
    accommodation_per_night_inr: nights ? Math.round(budget.accommodation_estimate / nights) : 0,
    food_per_day_inr: numDays ? Math.round(Math.max(0, budget.food_estimate - foodSpotsStored) / numDays) : 0,
    local_transport_per_day_inr: numDays ? Math.round(budget.transport_estimate / numDays) : 0,
    notes: budget.notes || '',
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const DestinationSchema = z.object({
  place_id: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().nullish(),
  country: z.string().nullish(),
  country_code: z.string().length(2).nullish(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  currency_code: z.string().length(3).nullish(),
  image_url: z.string().url().nullish(),
});

export function parseDestination(input) {
  const result = DestinationSchema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'Invalid destination', result.error.issues);
  const d = result.data;
  return {
    ...d,
    country_code: d.country_code?.toUpperCase() || null,
    currency_code: d.currency_code || currencyForCountry(d.country_code),
  };
}

export function validateTripDates(startDate, endDate) {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    throw new HttpError(400, 'Dates must be in YYYY-MM-DD format');
  }
  if (startDate < todayIso()) throw new HttpError(400, 'Start date cannot be in the past');
  if (endDate <= startDate) throw new HttpError(400, 'End date must be after the start date');
  const numDays = daysBetweenInclusive(startDate, endDate);
  if (numDays > MAX_TRIP_DAYS) throw new HttpError(400, `Trips can be at most ${MAX_TRIP_DAYS} days long`);
  return numDays;
}

/** Departure city, or null when the traveller skipped it (no flight estimate then). */
export function parseOrigin(value) {
  const origin = typeof value === 'string' ? value.trim() : '';
  if (!origin) return null;
  if (origin.length < 2 || origin.length > 80) throw new HttpError(400, 'Please enter a valid departure city');
  return origin;
}

/** Marks a flight cost the traveller typed in — the AI never overwrites it. */
export const MANUAL_FLIGHT_NOTE = 'Entered by you';
export const isManualFlight = (budget) => budget?.flight_note === MANUAL_FLIGHT_NOTE;

export function makeMessage(role, content, metadata = null) {
  return { role, content, created_at: new Date().toISOString(), ...(metadata ? { metadata } : {}) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateItinerary({ destination: rawDestination, origin: rawOrigin, startDate, endDate }) {
  const destination = parseDestination(rawDestination);
  const origin = parseOrigin(rawOrigin);
  const numDays = validateTripDates(startDate, endDate);

  const [weatherDays, rateInfo, image] = await Promise.all([
    getTripWeather(destination.latitude, destination.longitude, startDate, numDays),
    getInrRate(destination.currency_code),
    destination.image_url
      ? Promise.resolve({ url: destination.image_url })
      : findImage({ query: destinationLabel(destination), placeId: destination.place_id, width: 1200 }),
  ]);

  const ai = await generateJson({
    system: SYSTEM_PROMPT,
    contents: [{ role: 'user', parts: [{ text: buildGeneratePrompt({ destination, origin, startDate, numDays, weatherDays }) }] }],
    schema: GenerateOutputSchema(numDays),
  });

  const days = assembleDays({ aiDays: ai.days, startDate, weatherDays });
  // No departure city → no flights in the budget (the traveller can add a cost later).
  const inputs = origin ? ai.budget : { ...ai.budget, flights_round_trip_inr: 0, flight_note: '' };
  const budget = computeBudget({ days, inputs, destination, rateInfo, origin });

  const userMessage = makeMessage(
    'user',
    `Plan a ${numDays}-day trip ${origin ? `from ${origin} ` : ''}to ${destinationLabel(destination)} (${formatDateRange(startDate, numDays)}).`,
  );
  const assistantMessage = makeMessage('assistant', ai.reply);

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
    reply: ai.reply,
    messages: [userMessage, assistantMessage],
  };
}

/**
 * @param state   { trip: {destination, start_date, ...}, days, budget }
 * @param history prior messages [{role, content}]
 */
export async function refineItinerary({ state, history, message, focusDay = null }) {
  let destination = parseDestination(state.trip.destination);
  // Trips saved before flights were added have no origin; the AI is told so.
  let origin = state.trip.origin_city || 'not specified (ask the traveller)';
  const currentStart = state.trip.start_date;
  const currentDays = state.days;
  const currentNumDays = currentDays.length;

  const weatherDays = await getTripWeather(destination.latitude, destination.longitude, currentStart, currentNumDays);

  const ai = await generateJson({
    system: SYSTEM_PROMPT,
    contents: [
      ...historyToContents(history),
      {
        role: 'user',
        parts: [
          {
            text: buildRefinePrompt({
              destination,
              origin,
              startDate: currentStart,
              numDays: currentNumDays,
              days: currentDays,
              weatherDays,
              message,
              focusDay: focusDay && focusDay <= currentNumDays ? focusDay : null,
            }),
          },
        ],
      },
    ],
    schema: RefineOutputSchema,
  });

  // --- Suggestions / plain answers leave the plan untouched ----------------
  if (ai.mode !== 'update') {
    let metadata = null;
    if (ai.mode === 'suggest') {
      const req = ai.suggestion_request;
      const dayNumber = Math.min(Math.max(req.day_number || focusDay || 1, 1), currentNumDays);
      const items = await buildSuggestions({ request: req, destination });
      metadata = { type: 'suggestions', day_number: dayNumber, category: req.category, search_query: req.search_query, items };
    }
    return {
      trip: state.trip,
      days: currentDays,
      budget: state.budget,
      reply: ai.reply,
      unchanged: true,
      messages: [makeMessage('user', message), makeMessage('assistant', ai.reply, metadata)],
    };
  }

  // --- Apply structural changes the AI decided on -------------------------
  let reply = ai.reply;
  let destinationChanged = false;
  if (ai.trip_changes.new_destination) {
    const resolved = await resolvePlaceByText(ai.trip_changes.new_destination).catch(() => null);
    if (resolved && resolved.place_id !== destination.place_id) {
      const image = await findImage({ query: destinationLabel(resolved), placeId: resolved.place_id, width: 1200 });
      destination = parseDestination({ ...resolved, image_url: image?.url || null });
      destinationChanged = true;
    } else if (!resolved) {
      reply += `\n\n(I couldn't find "${ai.trip_changes.new_destination}" on the map, so the destination is unchanged.)`;
    }
  }

  if (ai.trip_changes.new_origin) origin = ai.trip_changes.new_origin.trim().slice(0, 80);

  let startDate = currentStart;
  const proposedStart = ai.trip_changes.new_start_date;
  if (proposedStart && isValidIsoDate(proposedStart) && proposedStart !== currentStart) {
    if (proposedStart >= todayIso()) startDate = proposedStart;
    else reply += '\n\n(I kept your original dates because the new start date would be in the past.)';
  }

  const numDays = Math.min(ai.days.length, MAX_TRIP_DAYS);
  const aiDays = ai.days.slice(0, numDays);

  // Re-fetch weather only if the date range/location actually changed (cached otherwise).
  const needsNewWeather = destinationChanged || startDate !== currentStart || numDays !== currentNumDays;
  const finalWeather = needsNewWeather
    ? await getTripWeather(destination.latitude, destination.longitude, startDate, numDays)
    : weatherDays;

  const rateInfo = await getInrRate(destination.currency_code);
  const days = assembleDays({
    aiDays,
    startDate,
    weatherDays: finalWeather,
    previousDays: destinationChanged ? [] : currentDays,
    previousStartDate: currentStart,
  });
  const knownOrigin = state.trip.origin_city || ai.trip_changes.new_origin ? origin : null; // (a || b) ? origin : null
  let refineInputs = ai.budget;
  if (isManualFlight(state.budget)) {
    refineInputs = { ...ai.budget, flights_round_trip_inr: state.budget.flights_estimate || 0, flight_note: MANUAL_FLIGHT_NOTE };
  } else if (!knownOrigin) {
    refineInputs = { ...ai.budget, flights_round_trip_inr: 0, flight_note: '' };
  }
  const budget = computeBudget({ days, inputs: refineInputs, destination, rateInfo, origin: knownOrigin });

  return {
    trip: {
      ...state.trip,
      destination,
      origin_city: knownOrigin,
      start_date: startDate,
      end_date: toIsoDate(addDays(startDate, numDays - 1)),
      num_days: numDays,
    },
    days,
    budget,
    reply,
    messages: [makeMessage('user', message), makeMessage('assistant', reply)],
  };
}

// ---------------------------------------------------------------------------
// Direct day edits (no full re-plan): add, remove, fill an empty slot
// ---------------------------------------------------------------------------

const MAX_ACTIVITIES_PER_DAY = 20;
const realActivities = (day) => day.activities.filter((a) => !a.placeholder);

/** The trip's current per-unit budget inputs (drafts carry them; saved trips are derived from totals). */
export function currentBudgetInputs(state) {
  const stored = budgetInputsFromStored(state.budget, state.days.length, state.days);
  const b = state.budget || {};
  return {
    ...stored,
    // Drafts carry the exact per-unit inputs; saved trips only have totals.
    accommodation_per_night_inr: b.accommodation_per_night_inr ?? stored.accommodation_per_night_inr,
    food_per_day_inr: b.food_per_day_inr ?? stored.food_per_day_inr,
    local_transport_per_day_inr: b.local_transport_per_day_inr ?? stored.local_transport_per_day_inr,
    flights_round_trip_inr: b.flights_estimate ?? stored.flights_round_trip_inr,
    flight_note: b.flight_note ?? stored.flight_note,
    notes: b.notes ?? stored.notes,
  };
}

/** Recomputes the budget for edited days, keeping the trip's per-unit inputs. */
export async function recomputeBudget(state, days) {
  const destination = parseDestination(state.trip.destination);
  const inputs = currentBudgetInputs(state);
  const rateInfo = await getInrRate(destination.currency_code);
  return computeBudget({ days, inputs, destination, rateInfo, origin: state.trip.origin_city });
}

function findDay(state, dayNumber) {
  const day = state.days.find((d) => d.day_number === dayNumber);
  if (!day) throw new HttpError(404, `Day ${dayNumber} not found`);
  return day;
}

function replaceDay(state, dayNumber, activities) {
  return state.days.map((d) => (d.day_number === dayNumber ? { ...d, activities } : d));
}

/**
 * Adds a suggested place to a day and recomputes the budget (no AI call).
 * @param state { trip, days, budget }
 */
export async function addSuggestionToDay({ state, dayNumber, suggestion, timeOfDay = null }) {
  const day = findDay(state, dayNumber);
  const name = String(suggestion?.name || '').trim();
  if (!name) throw new HttpError(400, 'Invalid suggestion');
  const duplicate = realActivities(day).some(
    (a) => (suggestion.id && a.source_suggestion_id === suggestion.id) || a.title?.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) throw new HttpError(409, `${name} is already in Day ${dayNumber}`);
  if (realActivities(day).length >= MAX_ACTIVITIES_PER_DAY) {
    throw new HttpError(409, `Day ${dayNumber} is already packed — remove something first`);
  }

  const activity = suggestionToActivity(suggestion);
  // The user picks Morning / Afternoon / Evening when adding.
  if (timeOfDay) activity.time_of_day = timeOfDay;
  const days = replaceDay(state, dayNumber, [...day.activities, activity]);
  return { days, budget: await recomputeBudget(state, days), activity };
}

/**
 * Removes a place. It leaves an empty slot in the same position so the user
 * can put something else there; removing an empty slot deletes it entirely.
 */
export async function removeActivityFromDay({ state, dayNumber, activityId }) {
  const day = findDay(state, dayNumber);
  const target = day.activities.find((a) => a.id === activityId);
  if (!target) throw new HttpError(404, 'That place is no longer in this day');

  const activities = target.placeholder
    ? day.activities.filter((a) => a.id !== activityId)
    : day.activities.map((a) =>
        a.id === activityId
          ? {
              id: randomUUID(),
              placeholder: true,
              removed_title: a.title,
              time_of_day: a.time_of_day,
              title: '',
              description: '',
              place_name: null,
              estimated_cost_inr: 0,
              duration_hours: null,
              indoor: false,
              category: 'sightseeing',
            }
          : a,
      );
  const days = replaceDay(state, dayNumber, activities);
  return { days, budget: await recomputeBudget(state, days) };
}

/** Looks up the place the user typed and puts it into an empty slot. */
export async function fillEmptySlot({ state, dayNumber, activityId, query }) {
  const day = findDay(state, dayNumber);
  const slot = day.activities.find((a) => a.id === activityId);
  if (!slot || !slot.placeholder) throw new HttpError(404, 'That empty slot is no longer in this day');

  const destination = parseDestination(state.trip.destination);
  const activity = await lookupPlaceActivity({ query, destination, day, timeOfDay: slot.time_of_day });
  if (realActivities(day).some((a) => a.title?.toLowerCase() === activity.title.toLowerCase())) {
    throw new HttpError(409, `${activity.title} is already in Day ${dayNumber}`);
  }

  const days = replaceDay(
    state,
    dayNumber,
    day.activities.map((a) => (a.id === activityId ? activity : a)),
  );
  return { days, budget: await recomputeBudget(state, days), activity };
}

/** Marks a place as booked/confirmed or back to planned. */
export async function setActivityStatus({ state, dayNumber, activityId, status }) {
  const day = findDay(state, dayNumber);
  if (!day.activities.some((a) => a.id === activityId && !a.placeholder)) {
    throw new HttpError(404, 'That place is no longer in this day');
  }
  const days = replaceDay(
    state,
    dayNumber,
    day.activities.map((a) => (a.id === activityId ? { ...a, status } : a)),
  );
  return { days, budget: await recomputeBudget(state, days) };
}

/** Sets the flight cost the traveller typed in (null/0 clears it) and recomputes the budget. */
export async function setManualFlightCost({ state, amountInr }) {
  const stored = budgetInputsFromStored(state.budget, state.days.length, state.days);
  const b = state.budget || {};
  const amount = Math.max(0, Math.round(Number(amountInr) || 0));
  const inputs = {
    ...stored,
    accommodation_per_night_inr: b.accommodation_per_night_inr ?? stored.accommodation_per_night_inr,
    food_per_day_inr: b.food_per_day_inr ?? stored.food_per_day_inr,
    local_transport_per_day_inr: b.local_transport_per_day_inr ?? stored.local_transport_per_day_inr,
    notes: b.notes ?? stored.notes,
    flights_round_trip_inr: amount,
    flight_note: amount ? MANUAL_FLIGHT_NOTE : '',
  };
  const destination = parseDestination(state.trip.destination);
  const rateInfo = await getInrRate(destination.currency_code);
  return { days: state.days, budget: computeBudget({ days: state.days, inputs, destination, rateInfo, origin: state.trip.origin_city }) };
}

// ---------------------------------------------------------------------------
// Day rework with preview: rain swap & arrival/departure-aware days
// ---------------------------------------------------------------------------

const ReworkOutputSchema = z.object({
  reply: z.string().default(''),
  days: z.array(DaySchema).min(1).max(5),
});

/**
 * Proposes new versions of specific days (nothing is saved).
 * @param targets [{ day_number, instruction }]
 * @returns { reply, days: [full day objects ready to apply] }
 */
export async function previewDayRework({ state, targets }) {
  const destination = parseDestination(state.trip.destination);
  const wanted = targets.filter((t) => state.days.some((d) => d.day_number === t.day_number));
  if (!wanted.length) throw new HttpError(404, 'Those days are no longer in this trip');

  const dayContext = wanted
    .map((t) => {
      const day = state.days.find((d) => d.day_number === t.day_number);
      const w = day.weather_summary;
      const weather = w?.available
        ? `${w.condition}, ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C, rain ${w.precipitation_probability ?? 0}%${day.weather_warning ? ` — WARNING: ${day.weather_warning.replace(/\n/g, ' ')}` : ''}`
        : 'forecast not available';
      return `Day ${day.day_number} (${day.date}) — weather: ${weather}\nWhat to change: ${t.instruction}`;
    })
    .join('\n\n');

  const ai = await generateJson({
    system: SYSTEM_PROMPT,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `TRIP: ${destinationLabel(destination)}, ${state.trip.start_date} to ${state.trip.end_date}

Full current itinerary (JSON, for context — keep the rest of the trip consistent and don't repeat places used on other days):
${JSON.stringify(compactStateForPrompt(state.days))}

Rework ONLY these days:
${dayContext}

Rules: keep each reworked day in the same area of the city, keep any places the traveller added themselves unless they conflict with the change, give each day a fitting theme, 2–5 activities ordered morning → evening, and one meal suggestion. Reply in one friendly sentence explaining the change.

Return JSON: { "reply": "string", "days": [ ${DAY_FORMAT} ] } with day_number matching the days above.`,
          },
        ],
      },
    ],
    schema: ReworkOutputSchema,
  });

  const days = ai.days
    .filter((nd) => wanted.some((t) => t.day_number === nd.day_number))
    .map((nd) => {
      const old = state.days.find((d) => d.day_number === nd.day_number);
      const previous = new Map(old.activities.filter((a) => !a.placeholder).map((a) => [a.title.toLowerCase(), a]));
      return {
        ...old,
        theme: nd.theme,
        meal_suggestion: nd.meal_suggestion,
        activities: nd.activities.map((a) => {
          const prev = previous.get(a.title.toLowerCase());
          const keep = prev
            ? Object.fromEntries(
                ['image_url', 'rating', 'rating_count', 'rating_source', 'maps_url', 'address', 'source_suggestion_id', 'added_by_user', 'lat', 'lng', 'status']
                  .filter((k) => prev[k] != null)
                  .map((k) => [k, prev[k]]),
              )
            : {};
          return { id: randomUUID(), ...a, ...keep };
        }),
      };
    });
  if (!days.length) throw new HttpError(502, 'Couldn’t prepare a new plan for that day. Please try again.');
  return { reply: ai.reply, days };
}

/** Applies previewed days (theme, activities, meal) and recomputes the budget. */
export async function applyReworkedDays({ state, days }) {
  const byNumber = new Map(days.map((d) => [d.day_number, d]));
  const nextDays = state.days.map((d) => {
    const nd = byNumber.get(d.day_number);
    if (!nd) return d;
    return {
      ...d,
      theme: String(nd.theme || d.theme).slice(0, 200),
      meal_suggestion: nd.meal_suggestion ?? d.meal_suggestion,
      activities: (nd.activities || []).slice(0, 20),
    };
  });
  return { days: nextDays, budget: await recomputeBudget(state, nextDays) };
}
