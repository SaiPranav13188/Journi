// Worldwide destination search. Uses Google Places (New) when an API key is
// configured, otherwise OpenStreetMap Nominatim (free, no key).
//
// Place ids are namespaced so we always know which provider to ask for details:
//   google:<placeId>   osm:<N|W|R><osmId>

import { config } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { currencyForCountry } from '../data/countryCurrency.js';

const cache = new TtlCache({ ttlMs: config.cacheTtlMs.places, maxEntries: 2000 });

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const GOOGLE = 'https://places.googleapis.com/v1';

// Nominatim asks for max ~1 request/second. Serialize our calls to it.
let nominatimQueue = Promise.resolve();
function throttledNominatim(url) {
  const run = nominatimQueue.then(async () => {
    const result = await fetchJson(url, { headers: { 'Accept-Language': 'en' } });
    await new Promise((r) => setTimeout(r, 1000));
    return result;
  });
  nominatimQueue = run.catch(() => {});
  return run;
}

const EXCLUDED_OSM_CATEGORIES = new Set(['highway', 'building', 'shop', 'office', 'railway', 'power', 'man_made']);

function osmPlaceId(item) {
  const type = (item.osm_type || '').charAt(0).toUpperCase();
  return `osm:${type}${item.osm_id}`;
}

function normalizeNominatim(item) {
  const address = item.address || {};
  const countryCode = (address.country_code || '').toUpperCase() || null;
  const name = item.name || item.display_name.split(',')[0];
  const subtitle = item.display_name
    .split(',')
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(', ');
  return {
    place_id: osmPlaceId(item),
    name,
    subtitle: subtitle || address.country || '',
    full_name: item.display_name,
    country: address.country || null,
    country_code: countryCode,
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    currency_code: currencyForCountry(countryCode),
    type: item.addresstype || item.type || null,
  };
}

async function searchNominatim(query) {
  const url = `${NOMINATIM}/search?${new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '10',
    dedupe: '1',
    'accept-language': 'en',
  })}`;
  const results = await throttledNominatim(url);
  const seen = new Set();
  return (results || [])
    .filter((r) => !EXCLUDED_OSM_CATEGORIES.has(r.category))
    .map(normalizeNominatim)
    .filter((r) => {
      const key = `${r.name}|${r.subtitle}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

async function detailsNominatim(osmRef) {
  const url = `${NOMINATIM}/lookup?${new URLSearchParams({
    osm_ids: osmRef,
    format: 'jsonv2',
    addressdetails: '1',
    'accept-language': 'en',
  })}`;
  const results = await throttledNominatim(url);
  if (!results?.length) throw new HttpError(404, 'Place not found');
  return normalizeNominatim(results[0]);
}

async function searchGoogle(query) {
  const body = await fetchJson(`${GOOGLE}/places:autocomplete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesApiKey,
    },
    body: JSON.stringify({ input: query, languageCode: 'en' }),
  });
  return (body?.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      place_id: `google:${p.placeId}`,
      name: p.structuredFormat?.mainText?.text || p.text?.text,
      subtitle: p.structuredFormat?.secondaryText?.text || '',
      full_name: p.text?.text,
      country: null,
      country_code: null,
      latitude: null,
      longitude: null,
      currency_code: null,
      type: p.types?.[0] || null,
    }));
}

async function detailsGoogle(googleId) {
  const p = await fetchJson(`${GOOGLE}/places/${encodeURIComponent(googleId)}?languageCode=en`, {
    headers: {
      'X-Goog-Api-Key': config.googlePlacesApiKey,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,addressComponents,photos,types',
    },
  });
  const countryComponent = (p.addressComponents || []).find((c) => c.types?.includes('country'));
  const countryCode = countryComponent?.shortText?.toUpperCase() || null;
  return {
    place_id: `google:${p.id}`,
    name: p.displayName?.text,
    subtitle: p.formattedAddress,
    full_name: p.formattedAddress,
    country: countryComponent?.longText || null,
    country_code: countryCode,
    latitude: p.location?.latitude,
    longitude: p.location?.longitude,
    currency_code: currencyForCountry(countryCode),
    type: p.types?.[0] || null,
    google_photo_name: p.photos?.[0]?.name || null,
  };
}

export async function searchPlaces(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const useGoogle = Boolean(config.googlePlacesApiKey);
  return cache.wrap(`search:${useGoogle ? 'g' : 'o'}:${q.toLowerCase()}`, () =>
    useGoogle ? searchGoogle(q) : searchNominatim(q),
  );
}

export async function getPlaceDetails(placeId) {
  return cache.wrap(`details:${placeId}`, async () => {
    if (placeId.startsWith('google:')) {
      if (!config.googlePlacesApiKey) throw new HttpError(400, 'Google Places is not configured');
      return detailsGoogle(placeId.slice('google:'.length));
    }
    if (placeId.startsWith('osm:')) {
      return detailsNominatim(placeId.slice('osm:'.length));
    }
    throw new HttpError(400, 'Unknown place id format');
  });
}

// Resolves free text (e.g. a destination the AI switched to mid-conversation)
// to the best matching place with coordinates.
export async function resolvePlaceByText(text) {
  const results = await searchPlaces(text);
  if (!results.length) return null;
  const top = results[0];
  if (top.latitude != null && top.country_code) return top;
  return getPlaceDetails(top.place_id);
}

// ---------------------------------------------------------------------------
// Nearby place suggestions with real ratings & photos (Google Places only).
// ---------------------------------------------------------------------------

const TEXT_SEARCH_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.googleMapsUri',
  'places.priceLevel',
  'places.primaryTypeDisplayName',
  'places.editorialSummary',
  'places.businessStatus',
].join(',');

async function googlePhotoUri(photoName, width = 800) {
  if (!photoName) return null;
  try {
    const body = await fetchJson(`${GOOGLE}/${photoName}/media?maxWidthPx=${width}&skipHttpRedirect=true`, {
      headers: { 'X-Goog-Api-Key': config.googlePlacesApiKey },
      timeoutMs: 8000,
    });
    return body?.photoUri || null;
  } catch {
    return null;
  }
}

/**
 * Google Places Text Search, e.g. "best coffee shops near Hoan Kiem Lake, Hanoi".
 * Returns well-rated, open places ranked by rating weighted by review count.
 */
export async function searchPlacesWithRatings(query, { latitude, longitude } = {}, limit = 6) {
  if (!config.googlePlacesApiKey) return [];
  return cache.wrap(`text:${query.toLowerCase()}:${limit}`, async () => {
    const body = await fetchJson(`${GOOGLE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googlePlacesApiKey,
        'X-Goog-FieldMask': TEXT_SEARCH_FIELDS,
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'en',
        maxResultCount: 15,
        ...(latitude != null && longitude != null
          ? { locationBias: { circle: { center: { latitude, longitude }, radius: 30000 } } }
          : {}),
      }),
    });

    const ranked = (body?.places || [])
      .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY' && p.displayName?.text)
      .map((p) => ({ p, score: (p.rating || 0) * Math.log10((p.userRatingCount || 0) + 10) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ p }) => p);

    return Promise.all(
      ranked.map(async (p) => ({
        google_place_id: p.id,
        name: p.displayName.text,
        address: p.formattedAddress || null,
        rating: p.rating ?? null,
        rating_count: p.userRatingCount ?? null,
        price_level: p.priceLevel || null,
        type_label: p.primaryTypeDisplayName?.text || null,
        summary: p.editorialSummary?.text || null,
        maps_url: p.googleMapsUri || null,
        image_url: await googlePhotoUri(p.photos?.[0]?.name),
      })),
    );
  });
}

/**
 * Looks a free-text place up on OpenStreetMap near a destination (free).
 * Used to confirm a user-typed place exists and get its area/address.
 */
export async function findPlaceOnMap(query, destination) {
  const params = new URLSearchParams({
    q: `${query}, ${destination.name}`,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '3',
    'accept-language': 'en',
  });
  if (destination.country_code) params.set('countrycodes', destination.country_code.toLowerCase());
  try {
    const results = await cache.wrap(`map:${params}`, () => throttledNominatim(`${NOMINATIM}/search?${params}`));
    const hit = results?.[0];
    if (!hit) return null;
    const a = hit.address || {};
    return {
      name: hit.name || hit.display_name.split(',')[0],
      address: hit.display_name.split(',').slice(0, 4).join(',').trim(),
      area: a.suburb || a.neighbourhood || a.city_district || a.village || a.town || a.city || null,
      osm_category: `${hit.category}/${hit.type}`,
      latitude: Number(hit.lat),
      longitude: Number(hit.lon),
    };
  } catch (err) {
    console.warn('[places] map lookup failed:', err.message);
    return null;
  }
}
