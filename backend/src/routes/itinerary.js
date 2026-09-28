import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import {
  addSuggestionToDay,
  fillEmptySlot,
  generateItinerary,
  refineItinerary,
  parseDestination,
  removeActivityFromDay,
  setActivityStatus,
  setManualFlightCost,
  previewDayRework,
  applyReworkedDays,
} from '../services/planner.js';
import { buildPackingList } from '../services/tools.js';
import { geocodeDays } from '../services/geocode.js';
import { getTrip, saveTripPlan } from '../services/tripStore.js';

export const itineraryRouter = Router();

const GenerateBody = z.object({
  destination: z.record(z.string(), z.any()),
  origin_city: z.string().trim().max(80).nullish(),
  start_date: z.string(),
  end_date: z.string(),
});

itineraryRouter.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const body = GenerateBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'destination, start_date and end_date are required');
    const plan = await generateItinerary({
      destination: body.data.destination,
      origin: body.data.origin_city ?? null,
      startDate: body.data.start_date,
      endDate: body.data.end_date,
    });
    res.json(plan);
  }),
);

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  created_at: z.string().optional(),
  metadata: z.any().optional(),
});

const RefineBody = z.object({
  trip_id: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(1000),
  // Required for unsaved drafts; ignored for saved trips (the DB is authoritative).
  state: z
    .object({
      trip: z.object({ destination: z.record(z.string(), z.any()), start_date: z.string() }).passthrough(),
      days: z.array(z.record(z.string(), z.any())).min(1),
      budget: z.record(z.string(), z.any()).nullish(),
    })
    .nullish(),
  history: z.array(MessageSchema).max(200).default([]),
  // Day the user is adding to (tapped "Add to Day N"), if any.
  focus_day: z.coerce.number().int().min(1).nullish(),
});

itineraryRouter.post(
  '/refine',
  asyncHandler(async (req, res) => {
    const parsed = RefineBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid refine request', parsed.error.issues);
    const { trip_id, message } = parsed.data;

    let state;
    let history;
    if (trip_id) {
      const saved = await getTrip(req.user.id, trip_id);
      if (saved.trip.status === 'finalized') {
        throw new HttpError(409, 'This plan is finalized. Reopen it for editing to keep refining.');
      }
      state = saved;
      history = saved.messages;
    } else {
      if (!parsed.data.state) throw new HttpError(400, 'state is required for unsaved trips');
      state = parsed.data.state;
      history = parsed.data.history;
    }

    const result = await refineItinerary({ state, history, message, focusDay: parsed.data.focus_day ?? null });

    if (trip_id) {
      // Suggestions/answers don't change the plan — only store the messages.
      const toSave = result.unchanged ? { trip: result.trip, days: null, budget: null } : result;
      await saveTripPlan(req.user.id, trip_id, toSave, result.messages);
      result.trip.id = trip_id;
    }
    res.json(result);
  }),
);

const StateSchema = z
  .object({
    trip: z.object({ destination: z.record(z.string(), z.any()) }).passthrough(),
    days: z.array(z.record(z.string(), z.any())).min(1),
    budget: z.record(z.string(), z.any()).nullish(),
  })
  .nullish();

const DayEditBase = {
  trip_id: z.string().uuid().nullish(),
  day_number: z.coerce.number().int().min(1),
  state: StateSchema,
};

/** Loads the trip being edited: from the DB for saved trips, from the request for drafts. */
async function loadEditableState(req, data) {
  if (data.trip_id) {
    const state = await getTrip(req.user.id, data.trip_id);
    if (state.trip.status === 'finalized') {
      throw new HttpError(409, 'This plan is finalized. Reopen it for editing to change it.');
    }
    return state;
  }
  if (!data.state) throw new HttpError(400, 'state is required for unsaved trips');
  return data.state;
}

/** Shared handler: validate, load, apply the edit, persist saved trips. */
function dayEditRoute(schema, apply) {
  return asyncHandler(async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request', parsed.error.issues);
    const state = await loadEditableState(req, parsed.data);
    const result = await apply(state, parsed.data);
    if (parsed.data.trip_id) {
      await saveTripPlan(req.user.id, parsed.data.trip_id, { trip: state.trip, days: result.days, budget: result.budget }, []);
    }
    res.json(result);
  });
}

// Adds a suggested place (from a chat suggestion card) to a day.
itineraryRouter.post(
  '/add-activity',
  dayEditRoute(
    z.object({
      ...DayEditBase,
      suggestion: z.object({ id: z.string().optional(), name: z.string().min(1) }).passthrough(),
      time_of_day: z.enum(['morning', 'afternoon', 'evening']).nullish(),
    }),
    (state, d) => addSuggestionToDay({ state, dayNumber: d.day_number, suggestion: d.suggestion, timeOfDay: d.time_of_day ?? null }),
  ),
);

// Removes a place (leaving an empty slot), or deletes an empty slot.
itineraryRouter.post(
  '/remove-activity',
  dayEditRoute(z.object({ ...DayEditBase, activity_id: z.string().min(1) }), (state, d) =>
    removeActivityFromDay({ state, dayNumber: d.day_number, activityId: d.activity_id }),
  ),
);

// Fills an empty slot with a place the user typed (looked up on the web/maps).
itineraryRouter.post(
  '/fill-slot',
  dayEditRoute(
    z.object({ ...DayEditBase, activity_id: z.string().min(1), query: z.string().trim().min(2).max(120) }),
    (state, d) => fillEmptySlot({ state, dayNumber: d.day_number, activityId: d.activity_id, query: d.query }),
  ),
);

// Marks a place as confirmed (booked) or planned.
itineraryRouter.post(
  '/activity-status',
  dayEditRoute(
    z.object({ ...DayEditBase, activity_id: z.string().min(1), status: z.enum(['planned', 'confirmed']) }),
    (state, d) => setActivityStatus({ state, dayNumber: d.day_number, activityId: d.activity_id, status: d.status }),
  ),
);

// Adds map coordinates to itinerary places (for the Map tab).
itineraryRouter.post(
  '/geocode',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ trip_id: z.string().uuid().nullish(), state: StateSchema }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request');
    const state = parsed.data.trip_id ? await getTrip(req.user.id, parsed.data.trip_id) : parsed.data.state;
    if (!state) throw new HttpError(400, 'state is required for unsaved trips');

    const destination = parseDestination(state.trip.destination);
    const { days, changed } = await geocodeDays(state.days, destination);
    // Remember coordinates on saved trips (finalized ones too — it's not a plan change).
    if (changed && parsed.data.trip_id) {
      await saveTripPlan(req.user.id, parsed.data.trip_id, { trip: state.trip, days, budget: null }, []);
    }
    res.json({ days });
  }),
);

// Flight cost typed in by the traveller (Budget tab). Allowed on finalized trips too —
// it only updates the budget, not the plan.
itineraryRouter.post(
  '/flight-cost',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ trip_id: z.string().uuid().nullish(), state: StateSchema, amount_inr: z.coerce.number().min(0).max(100_000_000).nullable() })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please enter a valid amount');
    const state = parsed.data.trip_id ? await getTrip(req.user.id, parsed.data.trip_id) : parsed.data.state;
    if (!state) throw new HttpError(400, 'state is required for unsaved trips');
    const result = await setManualFlightCost({ state, amountInr: parsed.data.amount_inr });
    if (parsed.data.trip_id) {
      await saveTripPlan(req.user.id, parsed.data.trip_id, { trip: state.trip, days: null, budget: result.budget }, []);
    }
    res.json(result);
  }),
);

/** Loads a trip for tools that may also run on finalized trips (rain swap, packing, arrival). */
async function loadAnyState(req, data) {
  if (data.trip_id) return getTrip(req.user.id, data.trip_id);
  if (!data.state) throw new HttpError(400, 'state is required for unsaved trips');
  return data.state;
}

// Preview a reworked day (rain swap / arrival-aware / departure-aware). Nothing is saved.
itineraryRouter.post(
  '/rework-preview',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        trip_id: z.string().uuid().nullish(),
        state: StateSchema,
        targets: z.array(z.object({ day_number: z.coerce.number().int().min(1), instruction: z.string().trim().min(5).max(600) })).min(1).max(3),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request', parsed.error.issues);
    const state = await loadAnyState(req, parsed.data);
    res.json(await previewDayRework({ state, targets: parsed.data.targets }));
  }),
);

// Apply previewed days ("Swap plan").
itineraryRouter.post(
  '/apply-days',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        trip_id: z.string().uuid().nullish(),
        state: StateSchema,
        days: z.array(z.object({ day_number: z.coerce.number().int().min(1), theme: z.string(), activities: z.array(z.record(z.string(), z.any())), meal_suggestion: z.any() }).passthrough()).min(1).max(5),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request', parsed.error.issues);
    const state = await loadAnyState(req, parsed.data);
    const result = await applyReworkedDays({ state, days: parsed.data.days });
    if (parsed.data.trip_id) {
      await saveTripPlan(req.user.id, parsed.data.trip_id, { trip: state.trip, days: result.days, budget: result.budget }, []);
    }
    res.json(result);
  }),
);

// Smart packing list from the trip's forecast + activities.
itineraryRouter.post(
  '/packing-list',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ trip_id: z.string().uuid().nullish(), state: StateSchema }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request');
    const state = await loadAnyState(req, parsed.data);
    res.json(await buildPackingList(state));
  }),
);
