// Read-only research tools shared by several agents. Each one wraps an
// existing service unchanged; the in-memory TTL caches inside those services
// sit underneath, so repeated calls within (or across) agent loops are cheap.

import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';
import { daysBetweenInclusive, isValidIsoDate } from '../../lib/dates.js';
import { getTripWeather } from '../../services/weather.js';
import { getInrRate } from '../../services/currency.js';
import { getPlaceDetails, searchPlaces, searchPlacesWithRatings } from '../../services/places.js';
import { MAX_TRIP_DAYS } from '../../services/planner.js';

const isoDate = z.string().describe('Date as YYYY-MM-DD');

/** Compact per-day forecast for the model (drops fields it doesn't need). */
export function compactWeather(w) {
  if (!w.available) {
    return { date: w.date, available: false, reason: w.reason === 'beyond_forecast_range' ? 'too far ahead — assume typical seasonal weather' : w.reason };
  }
  return {
    date: w.date,
    available: true,
    condition: w.condition,
    temp_min_c: Math.round(w.temp_min),
    temp_max_c: Math.round(w.temp_max),
    rain_chance_pct: w.precipitation_probability ?? 0,
    rain_mm: w.precipitation_mm ?? 0,
    wind_max_kmh: Math.round(w.wind_speed_max ?? 0),
    warning: w.warning ? w.warning.replace(/\n/g, ' ') : null,
  };
}

export async function fetchWeatherRange({ lat, lng, startDate, endDate }) {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate) || endDate < startDate) {
    throw new Error('startDate and endDate must be YYYY-MM-DD with endDate on or after startDate');
  }
  const numDays = daysBetweenInclusive(startDate, endDate);
  if (numDays > MAX_TRIP_DAYS) throw new Error(`At most ${MAX_TRIP_DAYS} days per request`);
  return getTripWeather(lat, lng, startDate, numDays);
}

export const getWeatherTool = () =>
  tool({
    description:
      'Daily weather forecast (condition, temperatures, rain chance/amount, wind, and a warning for heavy rain, storms, extreme heat/cold or high winds) for a location and date range. ' +
      'Forecasts exist only ~15 days ahead; later dates come back as unavailable. Use it before planning or adding OUTDOOR activities, or to answer weather questions. ' +
      'Not needed for purely cosmetic edits (renaming a theme), indoor-only changes or cost questions.',
    inputSchema: z.object({
      lat: z.number().min(-90).max(90).describe('Latitude of the destination'),
      lng: z.number().min(-180).max(180).describe('Longitude of the destination'),
      startDate: isoDate,
      endDate: isoDate,
    }),
    execute: async (input) => ({ days: (await fetchWeatherRange(input)).map(compactWeather) }),
  });

/** Units of `to` per 1 unit of `from`, via the existing INR-based rate service. */
export async function currencyRate(from, to) {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { from: f, to: t, rate: 1 };
  const [fromInfo, toInfo] = await Promise.all([f === 'INR' ? null : getInrRate(f), t === 'INR' ? null : getInrRate(t)]);
  const perInr = (code, info) => (code === 'INR' ? 1 : info?.rate ?? null); // units of code per 1 INR
  const fromPerInr = perInr(f, fromInfo);
  const toPerInr = perInr(t, toInfo);
  if (!fromPerInr || !toPerInr) throw new Error(`No exchange rate available for ${!fromPerInr ? f : t}`);
  const info = toInfo || fromInfo;
  return {
    from: f,
    to: t,
    rate: Math.round((toPerInr / fromPerInr) * 1e6) / 1e6,
    provider: info?.provider ?? null,
    timestamp: info?.timestamp ?? null,
  };
}

export const getCurrencyRateTool = () =>
  tool({
    description:
      'Live exchange rate between two currencies (ISO codes like INR, VND, USD, EUR). Returns how many units of toCurrency equal 1 unit of fromCurrency. ' +
      'Use when a cost must be shown in another currency or a foreign price must be understood in rupees. All itinerary costs are already in INR, so plain itinerary edits do not need it.',
    inputSchema: z.object({
      fromCurrency: z.string().length(3).describe('ISO 4217 code, e.g. INR'),
      toCurrency: z.string().length(3).describe('ISO 4217 code, e.g. VND'),
    }),
    execute: ({ fromCurrency, toCurrency }) => currencyRate(fromCurrency, toCurrency),
  });

export const searchPlacesTool = () =>
  tool({
    description:
      'Searches real places (attractions, restaurants, cafés, neighbourhoods) near a location. With Google Places configured it returns ratings, review counts and addresses; otherwise map results from OpenStreetMap. ' +
      'Use it to confirm a place exists, to find options you are unsure about, or to anchor a day geographically. Famous landmarks you already know well do not need a search.',
    inputSchema: z.object({
      query: z.string().min(2).describe('What to look for, e.g. "water puppet theatre" or "best pho"'),
      near: z.string().min(2).describe('City or area, e.g. "Hoan Kiem, Hanoi, Vietnam"'),
    }),
    execute: async ({ query, near }) => {
      if (config.googlePlacesApiKey) {
        const places = await searchPlacesWithRatings(`${query} in ${near}`, {}, 6);
        return {
          source: 'google',
          results: places.map((p) => ({
            place_id: `google:${p.google_place_id}`,
            name: p.name,
            address: p.address,
            rating: p.rating,
            rating_count: p.rating_count,
            type: p.type_label,
            summary: p.summary,
          })),
        };
      }
      const results = await searchPlaces(`${query}, ${near}`);
      return {
        source: 'openstreetmap',
        results: results.map((r) => ({ place_id: r.place_id, name: r.name, area: r.subtitle, type: r.type })),
        note: results.length ? undefined : 'No map results — rely on your own knowledge of well-known places.',
      };
    },
  });

export const getPlaceDetailsTool = () =>
  tool({
    description:
      'Full details for a place_id returned by search_places (name, address, country, coordinates, local currency). Use only when you need coordinates or the exact address of a specific result.',
    inputSchema: z.object({ placeId: z.string().min(4).describe('place_id from search_places, e.g. "osm:N123" or "google:ChIJ…"') }),
    execute: async ({ placeId }) => {
      const p = await getPlaceDetails(placeId);
      return {
        place_id: p.place_id,
        name: p.name,
        address: p.full_name || p.subtitle,
        country: p.country,
        latitude: p.latitude,
        longitude: p.longitude,
        currency_code: p.currency_code,
      };
    },
  });
