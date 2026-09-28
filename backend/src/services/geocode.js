// Finds map coordinates for itinerary places so the app can show numbered
// stops on a map. Uses Photon (komoot, OpenStreetMap data — free, no key).
//
// Each day is anchored on its first landmark found, and the rest of that
// day's places are searched near it — so a country-wide trip ("Vietnam")
// still puts a Hanoi café in Hanoi, not in a same-named café elsewhere.

import { TtlCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';

const cache = new TtlCache({ ttlMs: 30 * 24 * 60 * 60 * 1000, maxEntries: 20_000 });

function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

async function photon(query, center) {
  const key = `${query.toLowerCase()}|${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const url = `https://photon.komoot.io/api/?${new URLSearchParams({
    q: query,
    lat: String(center.lat),
    lon: String(center.lng),
    limit: '5',
    lang: 'en',
  })}`;
  const body = await fetchJson(url, { timeoutMs: 8000 });
  const hits = (body?.features || [])
    .map((f) => ({
      lng: f.geometry?.coordinates?.[0],
      lat: f.geometry?.coordinates?.[1],
      countryCode: (f.properties?.countrycode || '').toUpperCase(),
    }))
    .filter((h) => h.lat != null && h.lng != null);
  cache.set(key, hits);
  return hits;
}

/**
 * @param opts.center  point to search around
 * @param opts.maxKm   reject hits further than this from center (null = any distance in the country)
 */
async function locate(queries, { center, maxKm, countryCode }) {
  for (const q of queries) {
    try {
      const hits = await photon(q, center);
      const hit = hits.find(
        (h) =>
          (!countryCode || !h.countryCode || h.countryCode === countryCode) &&
          (maxKm == null || distanceKm(h.lat, h.lng, center.lat, center.lng) <= maxKm),
      );
      if (hit) return { lat: hit.lat, lng: hit.lng };
    } catch (err) {
      console.warn('[geocode] lookup failed:', q, err.message);
    }
  }
  return null;
}

/** Returns a copy of `days` with lat/lng filled in for places that lack them. */
export async function geocodeDays(days, destination) {
  const countryLevel =
    Boolean(destination.country) && destination.name.trim().toLowerCase() === destination.country.trim().toLowerCase();
  const destCenter = { lat: destination.latitude, lng: destination.longitude };
  const countryCode = destination.country_code || null;
  const found = new Map();

  async function geocodeDay(day) {
    const known = day.activities.find((a) => a.lat != null && a.lng != null);
    let anchor = known ? { lat: known.lat, lng: known.lng } : null;

    // Landmarks first (they anchor the day), cafés/restaurants after.
    const todo = day.activities
      .filter((a) => !a.placeholder && a.lat == null && (a.place_name || a.title))
      .sort((a, b) => Number(a.category === 'food') - Number(b.category === 'food'));

    for (const a of todo) {
      const name = a.place_name || a.title;
      const queries = [a.area ? `${name}, ${a.area}` : null, `${name}, ${destination.name}`, name].filter(Boolean);
      const coords = await locate(queries, {
        center: anchor || destCenter,
        // Near the day's anchor; for city trips near the city; country trips: anywhere in the country.
        maxKm: anchor ? 60 : countryLevel ? null : 120,
        countryCode,
      });
      if (coords) {
        found.set(a.id, coords);
        anchor ??= coords;
      }
    }
  }

  // Two days at a time, places within a day in order (polite to the free service).
  for (let i = 0; i < days.length; i += 2) {
    await Promise.all(days.slice(i, i + 2).map(geocodeDay));
  }

  return {
    changed: found.size > 0,
    days: days.map((d) => ({
      ...d,
      activities: (d.activities || []).map((a) => (found.has(a.id) ? { ...a, ...found.get(a.id) } : a)),
    })),
  };
}
