// Supabase persistence for trips. Uses the service-role client, so every
// query filters by user id explicitly.

import { supabaseAdmin as db } from '../lib/supabase.js';
import { HttpError } from '../lib/http.js';
import { daysBetweenInclusive } from '../lib/dates.js';
import { currencyForCountry } from '../data/countryCurrency.js';
import { activityCosts, budgetInputsFromStored } from './planner.js';

function check(error, message = 'Database error') {
  // 42703 = undefined column: the Supabase schema is behind the code.
  if (error?.code === '42703' || error?.code === 'PGRST204') {
    console.error('[db] schema out of date:', error.message);
    throw new HttpError(500, 'The database needs an update. Run the newest file in supabase/migrations (004_dashboard.sql) in the Supabase SQL Editor.');
  }
  if (error) {
    console.error('[db]', message, error);
    throw new HttpError(500, message);
  }
}

// ----- Row <-> API shape ----------------------------------------------------

function tripRowToApi(row) {
  return {
    id: row.id,
    status: row.status,
    destination: {
      place_id: row.destination_place_id,
      name: row.destination_name,
      country: row.country,
      country_code: row.country_code,
      latitude: row.latitude,
      longitude: row.longitude,
      currency_code: currencyForCountry(row.country_code),
      image_url: row.cover_image_url,
    },
    origin_city: row.origin_city,
    budget_limit_inr: row.budget_limit_inr != null ? Number(row.budget_limit_inr) : null,
    start_date: row.start_date,
    end_date: row.end_date,
    num_days: daysBetweenInclusive(row.start_date, row.end_date),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tripApiToRow(trip) {
  const d = trip.destination;
  return {
    destination_name: d.name,
    destination_place_id: d.place_id,
    country: d.country,
    country_code: d.country_code,
    latitude: d.latitude,
    longitude: d.longitude,
    cover_image_url: d.image_url || null,
    origin_city: trip.origin_city || null,
    start_date: trip.start_date,
    end_date: trip.end_date,
    status: trip.status,
  };
}

function budgetRowToApi(row, numDays, days = []) {
  if (!row) return null;
  const num = (v) => (v == null ? null : Number(v));
  const flights = num(row.flights_estimate) ?? 0;
  const budget = {
    flights_estimate: flights,
    flight_note: row.flight_note,
    accommodation_estimate: num(row.accommodation_estimate),
    food_estimate: num(row.food_estimate),
    transport_estimate: num(row.transport_estimate),
    activities_estimate: num(row.activities_estimate),
    total_inr: num(row.total_inr),
    total_local_currency: num(row.total_local_currency),
    local_currency_code: row.local_currency_code,
    exchange_rate_used: num(row.exchange_rate_used),
    exchange_rate_timestamp: row.exchange_rate_timestamp,
    is_international: row.local_currency_code !== 'INR',
    on_ground_inr: num(row.total_inr) - flights,
    nights: Math.max(numDays - 1, 0),
    num_days: numDays,
  };
  const inputs = budgetInputsFromStored(budget, numDays, days);
  const foodSpots = Math.max(0, Math.round(budget.food_estimate - inputs.food_per_day_inr * numDays));
  return { ...budget, ...inputs, food_spots_inr: activityCosts(days).food ? foodSpots : 0 };
}

function dayRowToApi(row) {
  return {
    id: row.id,
    day_number: row.day_number,
    date: row.date,
    theme: row.theme,
    activities: row.activities || [],
    meal_suggestion: row.meal_suggestion,
    accommodation_note: row.accommodation_note,
    weather_summary: row.weather_summary,
    weather_warning: row.weather_warning,
  };
}

function budgetForRpc(budget) {
  if (!budget) return null;
  const {
    flights_estimate,
    flight_note,
    accommodation_estimate,
    food_estimate,
    transport_estimate,
    activities_estimate,
    total_inr,
    total_local_currency,
    local_currency_code,
    exchange_rate_used,
    exchange_rate_timestamp,
  } = budget;
  return {
    flights_estimate,
    flight_note,
    accommodation_estimate,
    food_estimate,
    transport_estimate,
    activities_estimate,
    total_inr,
    total_local_currency,
    local_currency_code,
    exchange_rate_used,
    exchange_rate_timestamp,
  };
}

// ----- Queries ---------------------------------------------------------------

export async function listTrips(userId) {
  const { data, error } = await db
    .from('trips')
    .select('*, trip_budget(total_inr, total_local_currency, local_currency_code), itinerary_days(theme, day_number, weather_warning)')
    .eq('user_id', userId)
    .order('start_date', { ascending: true });
  check(error, 'Could not load trips');

  return data.map((row) => {
    const days = [...(row.itinerary_days || [])].sort((a, b) => a.day_number - b.day_number);
    const budget = Array.isArray(row.trip_budget) ? row.trip_budget[0] : row.trip_budget;
    return {
      ...tripRowToApi(row),
      summary: days
        .slice(0, 3)
        .map((d) => d.theme)
        .join(' · '),
      warning_count: days.filter((d) => d.weather_warning).length,
      total_inr: budget ? Number(budget.total_inr) : null,
      total_local_currency: budget?.total_local_currency != null ? Number(budget.total_local_currency) : null,
      local_currency_code: budget?.local_currency_code || 'INR',
    };
  });
}

export async function getTrip(userId, tripId) {
  const { data: row, error } = await db.from('trips').select('*').eq('id', tripId).eq('user_id', userId).maybeSingle();
  check(error, 'Could not load trip');
  if (!row) throw new HttpError(404, 'Trip not found');

  const [days, budget, messages] = await Promise.all([
    db.from('itinerary_days').select('*').eq('trip_id', tripId).order('day_number'),
    db.from('trip_budget').select('*').eq('trip_id', tripId).maybeSingle(),
    db.from('conversation_messages').select('id, role, content, metadata, created_at').eq('trip_id', tripId).order('created_at'),
  ]);
  check(days.error || budget.error || messages.error, 'Could not load trip details');

  const trip = tripRowToApi(row);
  return {
    trip,
    days: days.data.map(dayRowToApi),
    budget: budgetRowToApi(budget.data, trip.num_days, days.data),
    messages: messages.data,
  };
}

/** Creates (tripId = null) or updates a trip with its full plan state. */
export async function saveTripPlan(userId, tripId, { trip, days, budget }, newMessages = []) {
  const { data, error } = await db.rpc('save_trip_plan', {
    p_user_id: userId,
    p_trip_id: tripId,
    p_trip: tripApiToRow(trip),
    p_days: days,
    p_budget: budgetForRpc(budget),
    p_messages: newMessages.map(({ role, content, created_at, metadata }) => ({ role, content, created_at, metadata: metadata ?? null })),
  });
  if (error?.code === 'P0002') throw new HttpError(404, 'Trip not found');
  check(error, 'Could not save trip');
  return data; // trip id
}

export async function assertTripOwner(userId, tripId) {
  const { data, error } = await db.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  check(error);
  if (!data) throw new HttpError(404, 'Trip not found');
}

export async function updateTripFields(userId, tripId, fields) {
  const { data, error } = await db
    .from('trips')
    .update(fields)
    .eq('id', tripId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();
  check(error, 'Could not update trip');
  if (!data) throw new HttpError(404, 'Trip not found');
}

export async function updateAccommodationNote(userId, tripId, dayNumber, note) {
  await assertTripOwner(userId, tripId);
  const { data, error } = await db
    .from('itinerary_days')
    .update({ accommodation_note: note?.trim() || null })
    .eq('trip_id', tripId)
    .eq('day_number', dayNumber)
    .select('id')
    .maybeSingle();
  check(error, 'Could not save accommodation note');
  if (!data) throw new HttpError(404, 'Day not found');
  await db.from('trips').update({ updated_at: new Date().toISOString() }).eq('id', tripId);
}

export async function deleteTrip(userId, tripId) {
  const { error, count } = await db
    .from('trips')
    .delete({ count: 'exact' })
    .eq('id', tripId)
    .eq('user_id', userId);
  check(error, 'Could not delete trip');
  if (!count) throw new HttpError(404, 'Trip not found');
}

// ----- Alerts ----------------------------------------------------------------

export async function listAlerts(userId, { unreadOnly = false } = {}) {
  const run = (fields) => {
    let query = db
      .from('trip_alerts')
      .select(`${fields}, trips(destination_name)`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (unreadOnly) query = query.eq('read', false);
    return query;
  };
  const BASE = 'id, trip_id, day_number, kind, message, read, created_at';
  // metadata (rework previews from the Weather Watcher) arrives with migration 006.
  let { data, error } = await run(`${BASE}, metadata`);
  if (error?.code === '42703') ({ data, error } = await run(BASE));
  check(error, 'Could not load alerts');
  return data.map(({ trips, ...a }) => ({ ...a, destination_name: trips?.destination_name || null }));
}

export async function markAlertsRead(userId, ids) {
  let query = db.from('trip_alerts').update({ read: true }).eq('user_id', userId);
  if (ids?.length) query = query.in('id', ids);
  const { error } = await query;
  check(error, 'Could not update alerts');
}
