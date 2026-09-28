// Finds a representative photo for a destination or an activity location.
// Google Place Photos when available for a Google place id, otherwise the
// lead image of the best-matching Wikipedia article (free, no key).

import { config } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { getPlaceDetails } from './places.js';

const cache = new TtlCache({ ttlMs: config.cacheTtlMs.images, maxEntries: 5000 });

const BAD_IMAGE_PATTERNS = [/\.svg/i, /flag_of/i, /locator/i, /location_map/i, /\bmap\b/i, /coat_of_arms/i, /logo/i, /seal_of/i];

function isUsablePhoto(url) {
  return url && !BAD_IMAGE_PATTERNS.some((re) => re.test(url));
}

async function wikipediaImage(query, width) {
  const url = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '5',
    prop: 'pageimages',
    piprop: 'thumbnail',
    pithumbsize: String(width),
    pilicense: 'any',
    redirects: '1',
  })}`;
  const body = await fetchJson(url, { timeoutMs: 8000 });
  const pages = Object.values(body?.query?.pages || {}).sort((a, b) => a.index - b.index);
  const match = pages.find((p) => isUsablePhoto(p.thumbnail?.source));
  if (!match) return null;
  return {
    url: match.thumbnail.source,
    width: match.thumbnail.width,
    height: match.thumbnail.height,
    source: 'wikipedia',
    attribution: `Wikipedia: ${match.title}`,
  };
}

async function googlePhoto(placeId, width) {
  const details = await getPlaceDetails(placeId);
  if (!details.google_photo_name) return null;
  const body = await fetchJson(
    `https://places.googleapis.com/v1/${details.google_photo_name}/media?maxWidthPx=${width}&skipHttpRedirect=true`,
    { headers: { 'X-Goog-Api-Key': config.googlePlacesApiKey } },
  );
  // photoUri is a signed googleusercontent URL that does not expose our key.
  return body?.photoUri ? { url: body.photoUri, source: 'google', attribution: 'Google Maps' } : null;
}

export async function findImage({ query, placeId, width = 1000 }) {
  const key = `${placeId || ''}|${(query || '').toLowerCase()}|${width}`;
  try {
    // Errors are thrown out of wrap() so transient failures are not cached.
    return await cache.wrap(key, async () => {
      if (placeId?.startsWith('google:') && config.googlePlacesApiKey) {
        const photo = await googlePhoto(placeId, width);
        if (photo) return photo;
      }
      return query ? wikipediaImage(query, width) : null;
    });
  } catch (err) {
    console.warn('[images] lookup failed', query, err.message);
    return null;
  }
}
