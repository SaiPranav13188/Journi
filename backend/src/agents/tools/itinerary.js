// Itinerary tools for the Planner agent. They edit a working copy of the trip
// using the existing planner functions (add / remove / fill slot / budget
// recompute), and save_itinerary_state commits it through the same atomic
// save_trip_plan RPC the v1 routes use. Drafts (unsaved trips) are never
// written to the database — the updated plan is returned to the app instead.
//
// The trip being edited is bound server-side from the authenticated request;
// the model never chooses which trip id it writes to.

import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { addDays, toIsoDate } from '../../lib/dates.js';
import {
  DaySchema,
  MANUAL_FLIGHT_NOTE,
  MAX_TRIP_DAYS,
  addSuggestionToDay,
  assembleDays,
  computeBudget,
  currentBudgetInputs,
  destinationLabel,
  fillEmptySlot,
  isManualFlight,
  parseDestination,
  recomputeBudget,
  removeActivityFromDay,
  validateTripDates,
} from '../../services/planner.js';
import { getTripWeather } from '../../services/weather.js';
import { getInrRate } from '../../services/currency.js';
import { resolvePlaceByText } from '../../services/places.js';
import { findImage } from '../../services/images.js';
import { lookupPlaceActivity } from '../../services/placeLookup.js';
import { saveTripPlan } from '../../services/tripStore.js';

const TIME_SLOT = z.enum(['morning', 'afternoon', 'evening']);
const CATEGORY = z.enum(['sightseeing', 'culture', 'nature', 'food', 'shopping', 'adventure', 'relaxation', 'nightlife', 'transport']);
// Fields the app adds to places (photo, rating, map link…) that the model never echoes back.
const EXTRA_FIELDS = ['image_url', 'rating', 'rating_count', 'rating_source', 'maps_url', 'address', 'source_suggestion_id', 'added_by_user', 'lat', 'lng', 'status'];

/**
 * Mutable working copy of a trip for one planner run.
 * @param state { trip, days, budget }
 */
export function createWorkingState({ userId, tripId, persist, state }) {
  const copy = structuredClone({ trip: state.trip, days: state.days, budget: state.budget ?? null });
  return {
    userId,
    tripId,
    persist: Boolean(persist && tripId),
    state: copy,
    original: structuredClone(copy),
    dirty: false,
    committed: false,
    destinationChanged: false,
    needsFullReplan: false,
    pendingDays: new Set(), // days added by change_dates that still need content
  };
}

// ----- Compact views for the model -------------------------------------------

export function compactDay(d) {
  const w = d.weather_summary;
  return {
    day_number: d.day_number,
    date: d.date,
    theme: d.theme,
    activities: (d.activities || []).map((a) =>
      a.placeholder
        ? { id: a.id, time_of_day: a.time_of_day, empty_slot: true }
        : { id: a.id, time_of_day: a.time_of_day, title: a.title, category: a.category, indoor: Boolean(a.indoor), estimated_cost_inr: a.estimated_cost_inr ?? 0 },
    ),
    meal: d.meal_suggestion?.dish ?? null,
    ...(w?.available === false || !w ? {} : { stored_forecast: w.condition }),
  };
}

export const compactItinerary = (days) => days.map(compactDay);

/** Fingerprint of a day's plan content, to report which days changed ("Updated" badge). */
function dayFingerprint(d) {
  return JSON.stringify([d.date, d.theme, (d.activities || []).map((a) => (a.placeholder ? '' : a.title)), d.meal_suggestion?.dish ?? null]);
}

export function changedDayNumbers(originalDays, days) {
  const before = new Map(originalDays.map((d) => [d.day_number, dayFingerprint(d)]));
  return days.filter((d) => before.get(d.day_number) !== dayFingerprint(d)).map((d) => d.day_number);
}

// ----- Helpers ---------------------------------------------------------------

function findDay(ws, dayNumber) {
  const day = ws.state.days.find((d) => d.day_number === dayNumber);
  if (!day) throw new Error(`Day ${dayNumber} does not exist (trip has ${ws.state.days.length} days)`);
  return day;
}

function apply(ws, days, budget) {
  ws.state = { ...ws.state, days, budget };
  ws.dirty = true;
  ws.committed = false;
}

function tripDates(ws, days) {
  const start = ws.state.trip.start_date;
  return { start_date: start, end_date: toIsoDate(addDays(start, days.length - 1)), num_days: days.length };
}

function withIdsAndExtras(activities, previousActivities) {
  const previous = new Map((previousActivities || []).filter((a) => !a.placeholder && a.title).map((a) => [a.title.toLowerCase(), a]));
  return activities.map((a) => {
    const prev = previous.get(a.title.toLowerCase());
    const extras = prev ? Object.fromEntries(EXTRA_FIELDS.filter((k) => prev[k] != null).map((k) => [k, prev[k]])) : {};
    return { id: prev?.id ?? randomUUID(), ...a, ...extras };
  });
}

const BudgetInputsInput = z
  .object({
    flights_round_trip_inr: z.number().min(0).optional().describe('Return economy fare per person from the origin city; ignored if the traveller entered their own flight cost'),
    flight_note: z.string().optional().describe('Route summary, e.g. "Hyderabad ⇄ Hanoi (HAN), 1 stop"'),
    accommodation_per_night_inr: z.number().min(0).optional(),
    food_per_day_inr: z.number().min(0).optional(),
    local_transport_per_day_inr: z.number().min(0).optional(),
    notes: z.string().optional().describe('One short sentence on budget assumptions'),
  })
  .describe('Per-unit budget estimates in INR. Only include values that should change; required after a destination change.');

/** Budget from per-unit inputs, never overwriting a flight cost the traveller typed in. */
async function budgetFromInputs(ws, days, overrides) {
  const destination = parseDestination(ws.state.trip.destination);
  const inputs = { ...currentBudgetInputs(ws.state), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)) };
  for (const k of ['flights_round_trip_inr', 'accommodation_per_night_inr', 'food_per_day_inr', 'local_transport_per_day_inr']) {
    inputs[k] = Math.max(0, Math.round(Number(inputs[k]) || 0));
  }
  const origin = ws.state.trip.origin_city || null;
  if (isManualFlight(ws.original.budget)) {
    inputs.flights_round_trip_inr = ws.original.budget.flights_estimate || 0;
    inputs.flight_note = MANUAL_FLIGHT_NOTE;
  } else if (!origin) {
    inputs.flights_round_trip_inr = 0;
    inputs.flight_note = '';
  }
  const rateInfo = await getInrRate(destination.currency_code);
  return computeBudget({ days, inputs, destination, rateInfo, origin });
}

/**
 * Commits the working state (the save_itinerary_state logic). Exported so the
 * planner can auto-commit edits the model made but forgot to save.
 */
export async function commitWorkingState(ws, { updatedDays = null, budgetInputs = null, newOrigin = null } = {}) {
  let days = ws.state.days;

  if (newOrigin?.trim()) {
    ws.state = { ...ws.state, trip: { ...ws.state.trip, origin_city: newOrigin.trim().slice(0, 80) } };
  }

  if (updatedDays?.length) {
    const parsed = z.array(DaySchema).min(1).max(MAX_TRIP_DAYS).safeParse(updatedDays);
    if (!parsed.success) {
      throw new Error(`updatedDays is invalid: ${parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const incoming = parsed.data;
    const numbers = incoming.map((d) => d.day_number);

    if (ws.needsFullReplan) {
      // New destination: every day is re-planned, dated from the trip start with fresh weather.
      const sorted = [...new Set(numbers)].sort((a, b) => a - b);
      if (sorted[0] !== 1 || sorted.at(-1) !== sorted.length) {
        throw new Error('After a destination change send every day, numbered 1..N consecutively');
      }
      const destination = parseDestination(ws.state.trip.destination);
      const weatherDays = await getTripWeather(destination.latitude, destination.longitude, ws.state.trip.start_date, incoming.length);
      days = assembleDays({ aiDays: incoming, startDate: ws.state.trip.start_date, weatherDays, previousDays: [], previousStartDate: ws.state.trip.start_date });
      // Accommodation notes are user-entered — carry them across by day number.
      days = days.map((d) => ({ ...d, accommodation_note: ws.state.days.find((p) => p.day_number === d.day_number)?.accommodation_note ?? null }));
    } else {
      const missing = numbers.filter((n) => !ws.state.days.some((d) => d.day_number === n));
      if (missing.length) {
        throw new Error(`Day(s) ${missing.join(', ')} do not exist. Use change_dates to make the trip longer first.`);
      }
      const byNumber = new Map(incoming.map((d) => [d.day_number, d]));
      days = ws.state.days.map((d) => {
        const nd = byNumber.get(d.day_number);
        if (!nd) return d;
        return { ...d, theme: nd.theme, meal_suggestion: nd.meal_suggestion, activities: withIdsAndExtras(nd.activities, d.activities).slice(0, 20) };
      });
    }
  } else if (ws.needsFullReplan) {
    throw new Error('The destination changed: call save_itinerary_state with the complete new days array (and budgetInputs) for the new destination.');
  }

  const stillEmpty = [...ws.pendingDays].filter((n) => !(days.find((d) => d.day_number === n)?.activities || []).some((a) => !a.placeholder));
  if (stillEmpty.length) {
    throw new Error(`Day(s) ${stillEmpty.join(', ')} were added by change_dates and still have no plan. Include them in updatedDays.`);
  }
  if (ws.needsFullReplan && !budgetInputs) {
    throw new Error('The destination changed: include budgetInputs (accommodation, food, local transport, and flights if the traveller has an origin city).');
  }

  const budget = budgetInputs || ws.state.trip.origin_city !== ws.original.trip.origin_city
    ? await budgetFromInputs(ws, days, budgetInputs || {})
    : await recomputeBudget(ws.state, days);

  ws.state = { ...ws.state, trip: { ...ws.state.trip, ...tripDates(ws, days) }, days, budget };
  if (ws.persist) {
    await saveTripPlan(ws.userId, ws.tripId, { trip: ws.state.trip, days, budget }, []);
  }
  ws.committed = true;
  ws.dirty = false;
  ws.needsFullReplan = false;
  ws.pendingDays.clear();

  return {
    saved: ws.persist ? 'saved to the trip' : 'draft updated (the app keeps it until the traveller saves)',
    updated_days: changedDayNumbers(ws.original.days, days),
    num_days: days.length,
    dates: `${ws.state.trip.start_date} to ${ws.state.trip.end_date}`,
    budget_total_inr: budget.total_inr,
  };
}

// ----- Tools -----------------------------------------------------------------

const ActivityInput = z.object({
  time_of_day: TIME_SLOT,
  title: z.string().min(2),
  description: z.string().describe('Under 30 words'),
  place_name: z.string().nullable().describe('Landmark/venue name as on a map, or null'),
  area: z.string().nullable().describe('Neighbourhood and city'),
  estimated_cost_inr: z.number().min(0).describe('Per person, INR; 0 if free'),
  duration_hours: z.number().min(0).max(24).nullable(),
  indoor: z.boolean(),
  category: CATEGORY,
});

const DayInput = z.object({
  day_number: z.number().int().min(1),
  theme: z.string().min(2),
  activities: z.array(ActivityInput).min(1).max(20).describe('3-5 activities ordered morning → evening'),
  meal_suggestion: z.object({
    dish: z.string().min(2),
    where: z.string().nullable(),
    description: z.string(),
    estimated_cost_inr: z.number().min(0),
  }),
});

/** The Planner's itinerary-editing tools, bound to one working state. */
export function createItineraryTools(ws) {
  return {
    add_activity: tool({
      description:
        'Adds one real place/activity to a day in a time slot (morning/afternoon/evening). Budget is recalculated automatically. ' +
        'For outdoor activities, check get_weather for that date first. Fails if the place is already in that day.',
      inputSchema: z.object({
        day: z.number().int().min(1).describe('Day number'),
        timeSlot: TIME_SLOT,
        place: z.object({
          name: z.string().min(2).describe('Real place or activity name'),
          description: z.string().describe('Under 25 words'),
          category: CATEGORY,
          estimated_cost_inr: z.number().min(0).describe('Per person, INR'),
          indoor: z.boolean(),
          area: z.string().nullable().describe('Neighbourhood, city'),
        }),
      }),
      execute: async ({ day, timeSlot, place }) => {
        findDay(ws, day);
        const res = await addSuggestionToDay({
          state: ws.state,
          dayNumber: day,
          suggestion: { name: place.name, description: place.description, category: place.category, estimated_cost_inr: place.estimated_cost_inr, address: place.area, time_of_day: timeSlot },
          timeOfDay: timeSlot,
        });
        const days = res.days.map((d) =>
          d.day_number === day ? { ...d, activities: d.activities.map((a) => (a.id === res.activity.id ? { ...a, indoor: place.indoor } : a)) } : d,
        );
        apply(ws, days, res.budget);
        return { added: { id: res.activity.id, title: res.activity.title }, day: compactDay(days.find((d) => d.day_number === day)), budget_total_inr: res.budget.total_inr };
      },
    }),

    remove_activity: tool({
      description:
        'Removes an activity from a day by its id (ids are in the current itinerary). It leaves an empty slot in the same time of day; removing an empty slot deletes it. Budget is recalculated automatically.',
      inputSchema: z.object({
        day: z.number().int().min(1),
        activityId: z.string().min(1).describe('Activity id from the itinerary'),
      }),
      execute: async ({ day, activityId }) => {
        findDay(ws, day);
        const res = await removeActivityFromDay({ state: ws.state, dayNumber: day, activityId });
        apply(ws, res.days, res.budget);
        return { removed: activityId, day: compactDay(res.days.find((d) => d.day_number === day)), budget_total_inr: res.budget.total_inr };
      },
    }),

    fill_slot: tool({
      description:
        'Looks up a specific place the traveller named (e.g. "Cong Caphe" or "Temple of Literature") near the destination — confirming it exists, with photo, rating and cost — and puts it into a day\'s time slot (an empty slot there if one exists). Use for named places you are not certain about.',
      inputSchema: z.object({
        day: z.number().int().min(1),
        timeSlot: TIME_SLOT,
        query: z.string().min(2).max(120).describe('The place as the traveller named it'),
      }),
      execute: async ({ day, timeSlot, query }) => {
        const target = findDay(ws, day);
        const slot = target.activities.find((a) => a.placeholder && a.time_of_day === timeSlot);
        let res;
        if (slot) {
          res = await fillEmptySlot({ state: ws.state, dayNumber: day, activityId: slot.id, query });
        } else {
          const destination = parseDestination(ws.state.trip.destination);
          const activity = await lookupPlaceActivity({ query, destination, day: target, timeOfDay: timeSlot });
          if (target.activities.some((a) => !a.placeholder && a.title?.toLowerCase() === activity.title.toLowerCase())) {
            throw new Error(`${activity.title} is already in Day ${day}`);
          }
          const days = ws.state.days.map((d) => (d.day_number === day ? { ...d, activities: [...d.activities, activity] } : d));
          res = { days, budget: await recomputeBudget(ws.state, days), activity };
        }
        apply(ws, res.days, res.budget);
        return { added: { id: res.activity.id, title: res.activity.title, indoor: res.activity.indoor }, day: compactDay(res.days.find((d) => d.day_number === day)), budget_total_inr: res.budget.total_inr };
      },
    }),

    change_dates: tool({
      description:
        'Moves the trip to new dates and/or changes its length. Existing days keep their plans in order and get the forecast for their new date; a shorter trip drops the last days; a longer trip adds empty days that you must then fill via save_itinerary_state. Returns the weather warnings for the new dates.',
      inputSchema: z.object({
        newStartDate: z.string().describe('YYYY-MM-DD, not in the past'),
        newEndDate: z.string().describe('YYYY-MM-DD, after the start date'),
      }),
      execute: async ({ newStartDate, newEndDate }) => {
        const numDays = validateTripDates(newStartDate, newEndDate);
        const destination = parseDestination(ws.state.trip.destination);
        const weather = await getTripWeather(destination.latitude, destination.longitude, newStartDate, numDays);
        const old = ws.state.days;
        const days = weather.map((w, i) => {
          const base = old[i] ?? { day_number: i + 1, theme: 'Day to plan', activities: [], meal_suggestion: null, accommodation_note: null };
          const { warning, ...summary } = w;
          return { ...base, day_number: i + 1, date: w.date, weather_summary: summary, weather_warning: warning || null };
        });
        for (let n = old.length + 1; n <= numDays; n++) ws.pendingDays.add(n);
        for (const n of [...ws.pendingDays]) if (n > numDays) ws.pendingDays.delete(n);
        const budget = await recomputeBudget(ws.state, days);
        ws.state = { ...ws.state, trip: { ...ws.state.trip, start_date: newStartDate, end_date: toIsoDate(addDays(newStartDate, numDays - 1)), num_days: numDays } };
        apply(ws, days, budget);
        return {
          dates: `${newStartDate} to ${ws.state.trip.end_date}`,
          num_days: numDays,
          removed_days: old.length > numDays ? old.slice(numDays).map((d) => d.day_number) : [],
          days_needing_content: [...ws.pendingDays],
          weather_warnings: days.filter((d) => d.weather_warning).map((d) => ({ day: d.day_number, warning: d.weather_warning.replace(/\n/g, ' ') })),
          budget_total_inr: budget.total_inr,
          next_step: ws.pendingDays.size
            ? `Plan day(s) ${[...ws.pendingDays].join(', ')} and send them in save_itinerary_state.updatedDays.`
            : 'Adjust any day affected by the new weather if needed, then call save_itinerary_state.',
        };
      },
    }),

    change_destination: tool({
      description:
        'Switches the whole trip to a different destination (keeps the dates). After this, research the new place (weather, places) and call save_itinerary_state with a complete new plan for every day plus budgetInputs.',
      inputSchema: z.object({ newDestination: z.string().min(2).describe('Place name with country, e.g. "Hoi An, Vietnam"') }),
      execute: async ({ newDestination }) => {
        const resolved = await resolvePlaceByText(newDestination).catch(() => null);
        if (!resolved) throw new Error(`Couldn't find "${newDestination}" on the map — ask the traveller to be more specific.`);
        const current = parseDestination(ws.state.trip.destination);
        if (resolved.place_id === current.place_id) return { unchanged: true, destination: destinationLabel(current) };
        const image = await findImage({ query: destinationLabel(resolved), placeId: resolved.place_id, width: 1200 });
        const destination = parseDestination({ ...resolved, image_url: image?.url || null });
        ws.state = { ...ws.state, trip: { ...ws.state.trip, destination } };
        ws.destinationChanged = true;
        ws.needsFullReplan = true;
        ws.dirty = true;
        ws.committed = false;
        return {
          destination: { name: destination.name, country: destination.country, latitude: destination.latitude, longitude: destination.longitude, currency_code: destination.currency_code },
          dates: `${ws.state.trip.start_date} to ${ws.state.trip.end_date}`,
          num_days: ws.state.days.length,
          next_step: 'Plan every day for the new destination, then call save_itinerary_state with the full updatedDays array and budgetInputs.',
        };
      },
    }),

    save_itinerary_state: tool({
      description:
        'Commits the itinerary. Call it once at the end of any plan change. Pass updatedDays only for days you are rewriting (full day objects: theme, 1-20 activities, meal); days you omit stay as they are, including edits already made with add_activity/remove_activity/fill_slot/change_dates. ' +
        'Pass budgetInputs when per-unit costs change (new destination, different hotel level, new origin city). Pass newOrigin if the traveller says they are travelling from a different city.',
      inputSchema: z.object({
        updatedDays: z.array(DayInput).max(MAX_TRIP_DAYS).optional(),
        budgetInputs: BudgetInputsInput.optional(),
        newOrigin: z.string().max(80).optional().describe('New departure city, only if the traveller changed it'),
      }),
      execute: (input) => commitWorkingState(ws, input),
    }),
  };
}
