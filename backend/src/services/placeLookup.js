// Resolves a place name the user typed ("Artjuna cafe") into a full itinerary
// activity near their destination. Sources, best first:
//   1. Google Places (real rating, photo, address) — if a key is configured
//   2. Gemini + Google Search grounding — if the Gemini plan allows it
//   3. OpenStreetMap (confirms the place exists, gives the area)
// Gemini then writes the description/cost/category from those facts, and a
// photo comes from Google or Wikipedia.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { generateJson, webSearchText } from './gemini.js';
import { findPlaceOnMap, searchPlacesWithRatings } from './places.js';
import { photoForAiItem, toActivityCategory } from './suggestions.js';

const money = z.coerce.number().min(0).transform((n) => Math.round(n));

const LookupSchema = z.object({
  found: z.boolean(),
  name: z.string().nullish().transform((v) => v || ''),
  area: z.string().nullish().transform((v) => v || null),
  description: z.string().nullish().transform((v) => v || ''),
  category: z.string().nullish().transform((v) => v || 'sightseeing'),
  estimated_cost_inr: money.default(0),
  duration_hours: z.coerce.number().min(0).max(24).nullish().catch(null).transform((v) => v ?? null),
  indoor: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(false),
  rating_estimate: z.coerce.number().min(0).max(5).nullish().catch(null).transform((v) => v ?? null),
  image_hint: z.string().nullish().transform((v) => v || null),
  reason: z.string().nullish().transform((v) => v || null),
});

function mapsUrl(name, city) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${city}`)}`;
}

/**
 * @returns activity object (without id/time_of_day overrides) ready for a day
 */
export async function lookupPlaceActivity({ query, destination, day, timeOfDay }) {
  const city = [destination.name, destination.country].filter(Boolean).join(', ');

  const [googleHits, onMap, webFacts] = await Promise.all([
    searchPlacesWithRatings(`${query}, ${destination.name}`, destination, 1).catch(() => []),
    findPlaceOnMap(query, destination),
    webSearchText(
      `Search the web for "${query}" in or near ${city}. In 4-6 short lines give: the exact name, what it is, the area/neighbourhood, typical price per person, opening hours, and its public rating if known. If it doesn't exist near ${city}, say so.`,
    ),
  ]);
  const google = googleHits[0] || null;

  const facts = [
    google &&
      `Google Maps: ${google.name} — ${google.address ?? ''}; rating ${google.rating ?? 'n/a'} (${google.rating_count ?? 0} reviews); type: ${google.type_label ?? 'n/a'}; ${google.summary ?? ''}`,
    onMap && `OpenStreetMap: ${onMap.name} — ${onMap.address} (${onMap.osm_category})`,
    webFacts && `Web search:\n${webFacts}`,
  ]
    .filter(Boolean)
    .join('\n');

  const ai = await generateJson({
    system:
      'You identify real places for a travel itinerary. Use the facts provided plus your own knowledge. Never invent a place: if you cannot identify a real place matching the request near the destination, set found=false. Respond with a single JSON object only.',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Destination: ${city}
The traveller wants to add this to Day ${day.day_number} (${day.theme}), in the ${timeOfDay}: "${query}"

Facts found:
${facts || '(no search results — rely on your knowledge)'}

Return JSON:
{
  "found": boolean,
  "name": "official place name",
  "area": "neighbourhood/area",
  "description": "max 25 words, what it is and why go",
  "category": "sightseeing" | "culture" | "nature" | "food" | "shopping" | "adventure" | "relaxation" | "nightlife",
  "estimated_cost_inr": number (per person, entry/food; 0 if free),
  "duration_hours": number,
  "indoor": boolean,
  "rating_estimate": number (typical public rating out of 5, or null),
  "image_hint": "a Wikipedia article title that shows this place or its signature item",
  "reason": "if found=false, a short explanation"
}`,
          },
        ],
      },
    ],
    schema: LookupSchema,
    temperature: 0.2,
  });

  if (!ai.found || !ai.name) {
    throw new HttpError(
      404,
      ai.reason || `Couldn't find “${query}” near ${destination.name}. Try the full name or add the area, e.g. “${query}, ${destination.name}”.`,
    );
  }

  const name = google?.name || ai.name;
  const VALID = ['sightseeing', 'culture', 'nature', 'food', 'shopping', 'adventure', 'relaxation', 'nightlife'];
  const category = VALID.includes(ai.category) ? ai.category : toActivityCategory(`${ai.category} ${google?.type_label ?? ''} ${name}`);
  const imageUrl = google?.image_url || (await photoForAiItem({ name, image_hint: ai.image_hint }, destination.name));

  return {
    id: randomUUID(),
    time_of_day: timeOfDay,
    title: name,
    description: ai.description || google?.summary || '',
    place_name: name,
    estimated_cost_inr: ai.estimated_cost_inr,
    duration_hours: ai.duration_hours ?? 1.5,
    indoor: ai.indoor,
    category,
    image_url: imageUrl,
    rating: google?.rating ?? ai.rating_estimate,
    rating_count: google?.rating_count ?? null,
    rating_source: google ? 'google' : ai.rating_estimate != null ? 'ai_estimate' : null,
    maps_url: google?.maps_url || mapsUrl(name, destination.name),
    address: google?.address || [ai.area || onMap?.area, destination.name].filter(Boolean).join(', '),
    added_by_user: true,
  };
}
