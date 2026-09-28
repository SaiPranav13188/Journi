import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import { isValidIsoDate } from '../lib/dates.js';
import { parseDestination } from '../services/planner.js';
import {
  deleteTrip,
  getTrip,
  listTrips,
  saveTripPlan,
  updateTripFields,
  updateAccommodationNote,
} from '../services/tripStore.js';
import { isWeatherStale, refreshTripWeather } from '../jobs/weatherRefresh.js';

export const tripsRouter = Router();

const DaySchema = z
  .object({
    day_number: z.number().int().min(1),
    date: z.string().refine(isValidIsoDate),
    theme: z.string(),
    activities: z.array(z.record(z.string(), z.any())),
    meal_suggestion: z.record(z.string(), z.any()).nullish(),
    accommodation_note: z.string().max(500).nullish(),
    weather_summary: z.record(z.string(), z.any()).nullish(),
    weather_warning: z.string().nullish(),
  })
  .passthrough();

const PlanBody = z.object({
  trip: z
    .object({
      destination: z.record(z.string(), z.any()),
      start_date: z.string().refine(isValidIsoDate),
      end_date: z.string().refine(isValidIsoDate),
      status: z.enum(['planning', 'finalized']).default('planning'),
    })
    .passthrough(),
  days: z.array(DaySchema).min(1).max(30),
  budget: z.record(z.string(), z.any()).nullish(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
        created_at: z.string().optional(),
        metadata: z.any().optional(),
      }),
    )
    .default([]),
});

function parsePlan(body) {
  const parsed = PlanBody.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Invalid trip data', parsed.error.issues);
  const plan = parsed.data;
  plan.trip.destination = parseDestination(plan.trip.destination);
  return plan;
}

const uuidParam = (id) => {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'Trip not found');
  return id;
};

tripsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ trips: await listTrips(req.user.id) });
  }),
);

// Save a new trip (itinerary + budget + full conversation history).
tripsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const plan = parsePlan(req.body);
    const id = await saveTripPlan(req.user.id, null, plan, plan.messages);
    res.status(201).json(await getTrip(req.user.id, id));
  }),
);

tripsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id);
    let full = await getTrip(req.user.id, id);

    // Forecasts sharpen as the trip nears: refresh stale weather on open.
    if (isWeatherStale(full.trip, full.days)) {
      try {
        const tripRow = {
          id,
          user_id: req.user.id,
          destination_name: full.trip.destination.name,
          latitude: full.trip.destination.latitude,
          longitude: full.trip.destination.longitude,
          start_date: full.trip.start_date,
          end_date: full.trip.end_date,
        };
        await refreshTripWeather(tripRow, full.days);
        full = await getTrip(req.user.id, id);
      } catch (err) {
        console.warn('[trips] weather refresh on open failed:', err.message);
      }
    }
    res.json(full);
  }),
);

// Save the current state of an already-saved trip (e.g. accommodation notes).
tripsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id);
    const plan = parsePlan(req.body);
    await saveTripPlan(req.user.id, id, plan, []);
    res.json(await getTrip(req.user.id, id));
  }),
);

// Finalize / reopen a plan, and/or set your own budget limit.
tripsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id);
    const body = z
      .object({
        status: z.enum(['planning', 'finalized']).optional(),
        budget_limit_inr: z.coerce.number().min(0).max(100_000_000).nullable().optional(),
      })
      .refine((b) => b.status !== undefined || b.budget_limit_inr !== undefined, 'Nothing to update')
      .safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Invalid trip update');
    await updateTripFields(req.user.id, id, body.data);
    res.json(await getTrip(req.user.id, id));
  }),
);

tripsRouter.patch(
  '/:id/days/:dayNumber',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id);
    const dayNumber = Number(req.params.dayNumber);
    const body = z.object({ accommodation_note: z.string().max(500).nullable() }).safeParse(req.body);
    if (!Number.isInteger(dayNumber) || !body.success) throw new HttpError(400, 'Invalid accommodation note');
    await updateAccommodationNote(req.user.id, id, dayNumber, body.data.accommodation_note);
    res.json({ ok: true });
  }),
);

tripsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id);
    await deleteTrip(req.user.id, id);
    res.status(204).end();
  }),
);

