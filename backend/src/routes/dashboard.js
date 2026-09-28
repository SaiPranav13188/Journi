import { Router } from 'express';
import { asyncHandler, HttpError } from '../lib/http.js';
import { todayIso } from '../lib/dates.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { getTrip, listTrips } from '../services/tripStore.js';
import { getCurrentWeather } from '../services/weather.js';

export const dashboardRouter = Router();
export const weatherRouter = Router();

// GET /weather?lat=..&lon=.. — current conditions + 5-day outlook
weatherRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, 'lat and lon are required');
    res.json({ weather: await getCurrentWeather(lat, lon) });
  }),
);

// Optional tables (migration 004) — degrade gracefully if not created yet.
async function optionalQuery(promise, fallback) {
  const { data, error } = await promise;
  if (error) {
    if (error.code !== '42P01' && error.code !== 'PGRST205') console.warn('[dashboard]', error.message);
    return fallback;
  }
  return data;
}

/**
 * GET /dashboard — everything the home screen needs in one request:
 * stats, the next trip (itinerary, budget, weather, bookings), upcoming trips
 * and saved places.
 */
dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const today = todayIso();

    const [trips, savedPlaces, bookings] = await Promise.all([
      listTrips(userId),
      optionalQuery(
        db.from('saved_places').select('id, place_id, name, country, country_code, latitude, longitude, image_url, note, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
        [],
      ),
      optionalQuery(db.from('bookings').select('trip_id, cost_inr, status').eq('user_id', userId), []),
    ]);

    const upcoming = trips.filter((t) => t.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const past = trips.filter((t) => t.end_date < today);
    const countries = new Set(past.map((t) => t.destination.country_code).filter(Boolean));

    const nextSummary = upcoming[0] || null;
    let nextTrip = null;
    if (nextSummary) {
      const [full, weather] = await Promise.all([
        getTrip(userId, nextSummary.id),
        getCurrentWeather(nextSummary.destination.latitude, nextSummary.destination.longitude).catch(() => null),
      ]);
      const booked = bookings
        .filter((b) => b.trip_id === nextSummary.id && b.status !== 'cancelled')
        .reduce((sum, b) => sum + Number(b.cost_inr || 0), 0);
      nextTrip = { ...full, weather, booked_inr: Math.round(booked) };
    }

    res.json({
      stats: {
        upcoming_trips: upcoming.length,
        countries_visited: countries.size,
        saved_places: savedPlaces.length,
        total_trips: trips.length,
      },
      next_trip: nextTrip,
      upcoming_trips: upcoming.slice(0, 5),
      saved_places: savedPlaces.slice(0, 12),
    });
  }),
);
