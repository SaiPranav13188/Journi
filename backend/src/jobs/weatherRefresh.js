// Re-fetches forecasts for saved upcoming trips and records an in-app alert
// whenever a new (or changed) weather warning appears on a day.
//
// The daily job's decisions (what to alert, when to propose a rework) are made
// by the Weather Watcher agent (agents/weatherWatcher.js) unless
// AGENTIC_WEATHER_WATCHER=false; the fixed v1 rules below remain as the
// fallback and for refresh-on-open in GET /trips/:id.

import { config } from '../config.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { addDays, daysBetweenInclusive, toIsoDate, todayIso } from '../lib/dates.js';
import { getTripWeather } from '../services/weather.js';

const FORECAST_WINDOW_DAYS = 15;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Stores the latest forecast on each day (weather_summary / weather_warning —
 * forecast data only, never the plan itself). Returns the days whose warning
 * changed: [{ day, previousWarning, warning }].
 */
export async function applyForecast(trip, days) {
  const numDays = daysBetweenInclusive(trip.start_date, trip.end_date);
  const weather = await getTripWeather(trip.latitude, trip.longitude, trip.start_date, numDays);
  const changes = [];

  for (const day of days) {
    const w = weather.find((x) => x.date === day.date);
    if (!w || (!w.available && day.weather_summary?.available)) continue; // keep last good forecast
    const { warning, ...summary } = w;
    const nextWarning = warning || null;

    const { error } = await db
      .from('itinerary_days')
      .update({ weather_summary: summary, weather_warning: nextWarning })
      .eq('id', day.id);
    if (error) {
      console.error('[weather-job] update failed', error);
      continue;
    }
    if (nextWarning !== (day.weather_warning || null)) {
      changes.push({ day, previousWarning: day.weather_warning || null, warning: nextWarning });
    }
  }
  return changes;
}

/**
 * v1: refreshes weather for one trip and alerts on every new warning.
 * `days` are itinerary_days rows. Returns the number of new warnings raised.
 */
export async function refreshTripWeather(trip, days) {
  const changes = await applyForecast(trip, days);
  let newWarnings = 0;
  for (const { day, warning } of changes) {
    if (!warning) continue;
    newWarnings++;
    await db.from('trip_alerts').insert({
      trip_id: trip.id,
      user_id: trip.user_id,
      day_number: day.day_number,
      kind: 'weather_warning',
      message: `Day ${day.day_number} in ${trip.destination_name}: ${warning.split('\n')[0]}`,
    });
  }
  return newWarnings;
}

export function isWeatherStale(trip, days) {
  const today = todayIso();
  const horizon = toIsoDate(addDays(today, FORECAST_WINDOW_DAYS));
  if (trip.end_date < today || trip.start_date > horizon) return false;
  return days.some((d) => {
    if (d.date < today || d.date > horizon) return false;
    const fetchedAt = d.weather_summary?.fetched_at ? Date.parse(d.weather_summary.fetched_at) : 0;
    return !d.weather_summary?.available || Date.now() - fetchedAt > STALE_AFTER_MS;
  });
}

/** Saved trips within the forecast window, with their days (the watcher's list_upcoming_trips). */
export async function listUpcomingTrips() {
  const today = todayIso();
  const horizon = toIsoDate(addDays(today, FORECAST_WINDOW_DAYS));
  const { data: trips, error } = await db
    .from('trips')
    .select('id, user_id, destination_name, country, latitude, longitude, start_date, end_date, itinerary_days(id, day_number, date, weather_summary, weather_warning)')
    .gte('end_date', today)
    .lte('start_date', horizon);
  if (error) throw error;
  return trips;
}

async function refreshAllUpcomingTripsV1() {
  const trips = await listUpcomingTrips();
  let warnings = 0;
  for (const trip of trips) {
    try {
      warnings += await refreshTripWeather(trip, trip.itinerary_days || []);
    } catch (err) {
      console.error(`[weather-job] trip ${trip.id} failed:`, err.message);
    }
  }
  console.log(`[weather-job] refreshed ${trips.length} trip(s), ${warnings} new warning(s)`);
  return { trips: trips.length, newWarnings: warnings };
}

export async function refreshAllUpcomingTrips() {
  if (!config.agenticWeatherWatcher) return refreshAllUpcomingTripsV1();
  // Imported lazily so the v1 path never loads the agent stack.
  const { runWeatherWatcher } = await import('../agents/weatherWatcher.js');
  return runWeatherWatcher();
}
