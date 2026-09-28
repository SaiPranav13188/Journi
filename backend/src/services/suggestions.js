// Turns an AI "suggestion request" (e.g. coffee shops near Day 1) into
// display-ready place cards with photos and ratings. Google Places supplies
// real ratings/photos when configured; otherwise the AI's own picks are used,
// with their ratings clearly marked as estimates.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { findImage } from './images.js';
import { searchPlacesWithRatings } from './places.js';

const MIN_SUGGESTIONS = 5;
const MAX_SUGGESTIONS = 8;

const PRICE_TO_INR = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 350,
  PRICE_LEVEL_MODERATE: 900,
  PRICE_LEVEL_EXPENSIVE: 2200,
  PRICE_LEVEL_VERY_EXPENSIVE: 4500,
};
const PRICE_LABEL = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '₹',
  PRICE_LEVEL_MODERATE: '₹₹',
  PRICE_LEVEL_EXPENSIVE: '₹₹₹',
  PRICE_LEVEL_VERY_EXPENSIVE: '₹₹₹₹',
};

/** Maps free-text categories onto the itinerary's activity categories (used for icons). */
export function toActivityCategory(text = '') {
  const t = text.toLowerCase();
  if (/caf|coffee|tea|restaurant|food|eat|dining|bakery|street|dessert|brunch/.test(t)) return 'food';
  if (/bar|pub|club|night|rooftop/.test(t)) return 'nightlife';
  if (/shop|market|mall|boutique|souvenir/.test(t)) return 'shopping';
  if (/trek|hik|trail|adventure|kayak|climb|dive|rafting/.test(t)) return 'adventure';
  if (/park|garden|lake|beach|nature|waterfall|mountain|view/.test(t)) return 'nature';
  if (/museum|temple|pagoda|church|gallery|heritage|palace|fort|culture/.test(t)) return 'culture';
  if (/spa|massage|relax|wellness/.test(t)) return 'relaxation';
  return 'sightseeing';
}

function defaultTimeOfDay(category) {
  if (category === 'nightlife') return 'evening';
  if (category === 'food') return 'afternoon';
  return 'afternoon';
}

function mapsSearchUrl(name, city) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${city}`)}`;
}

const significantWords = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);

// Only accept a Wikipedia photo whose article clearly matches the place;
// otherwise use the AI's hint (e.g. "Egg coffee") so the photo is relevant.
export async function photoForAiItem(item, city) {
  const nameWords = significantWords(item.name).filter((w) => !significantWords(city).includes(w));
  const direct = await findImage({ query: `${item.name} ${city}`, width: 800 });
  const title = direct?.attribution?.replace(/^Wikipedia:\s*/, '') || '';
  if (direct && nameWords.some((w) => significantWords(title).includes(w))) return direct.url;
  if (item.image_hint) {
    const hinted = await findImage({ query: item.image_hint, width: 800 });
    if (hinted) return hinted.url;
  }
  return null;
}

async function fromAiItem(item, destination) {
  const category = toActivityCategory(`${item.category} ${item.name}`);
  return {
    id: randomUUID(),
    name: item.name,
    description: item.description,
    category,
    category_label: item.category || null,
    address: [item.area, destination.name].filter(Boolean).join(', '),
    rating: item.rating_estimate,
    rating_count: null,
    rating_source: 'ai_estimate',
    price_label: null,
    image_url: await photoForAiItem(item, destination.name),
    maps_url: mapsSearchUrl(item.name, destination.name),
    estimated_cost_inr: item.estimated_cost_inr,
    time_of_day: item.time_of_day || defaultTimeOfDay(category),
  };
}

function fromGooglePlace(place, request, destination) {
  // Reuse the AI's cost/time guess when it suggested the same place.
  const aiMatch = request.items.find((i) => {
    const a = significantWords(i.name);
    return significantWords(place.name).some((w) => a.includes(w));
  });
  const category = toActivityCategory(`${request.category} ${place.type_label || ''} ${place.name}`);
  return {
    id: randomUUID(),
    name: place.name,
    description: place.summary || aiMatch?.description || place.type_label || '',
    category,
    category_label: place.type_label || request.category,
    address: place.address,
    rating: place.rating,
    rating_count: place.rating_count,
    rating_source: 'google',
    price_label: PRICE_LABEL[place.price_level] || null,
    image_url: place.image_url,
    maps_url: place.maps_url || mapsSearchUrl(place.name, destination.name),
    estimated_cost_inr: aiMatch?.estimated_cost_inr ?? PRICE_TO_INR[place.price_level] ?? 0,
    time_of_day: aiMatch?.time_of_day || defaultTimeOfDay(category),
  };
}

/**
 * @param request { category, search_query, items: [{ name, area, description, category,
 *                  time_of_day, estimated_cost_inr, rating_estimate, image_hint }] }
 */
export async function buildSuggestions({ request, destination }) {
  let suggestions = [];

  if (config.googlePlacesApiKey) {
    try {
      const places = await searchPlacesWithRatings(request.search_query, destination, MAX_SUGGESTIONS);
      suggestions = places.map((p) => fromGooglePlace(p, request, destination));
    } catch (err) {
      console.warn('[suggestions] Google Places search failed:', err.message);
    }
  }

  // Top up with the AI's own picks so there are always at least 5.
  if (suggestions.length < MIN_SUGGESTIONS) {
    const taken = new Set(suggestions.map((s) => s.name.toLowerCase()));
    const extra = request.items.filter((i) => !taken.has(i.name.toLowerCase()));
    const aiCards = await Promise.all(extra.map((i) => fromAiItem(i, destination)));
    suggestions = [...suggestions, ...aiCards];
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/** Converts a suggestion card into an itinerary activity. */
export function suggestionToActivity(s) {
  const indoorCategories = new Set(['food', 'shopping', 'culture', 'relaxation', 'nightlife']);
  return {
    id: randomUUID(),
    time_of_day: ['morning', 'afternoon', 'evening'].includes(s.time_of_day) ? s.time_of_day : 'afternoon',
    title: s.name,
    description: s.description || '',
    place_name: s.name,
    estimated_cost_inr: Math.max(0, Math.round(Number(s.estimated_cost_inr) || 0)),
    duration_hours: s.category === 'food' ? 1 : 1.5,
    indoor: indoorCategories.has(s.category),
    category: s.category || 'sightseeing',
    image_url: s.image_url || null,
    rating: s.rating ?? null,
    rating_count: s.rating_count ?? null,
    rating_source: s.rating_source || null,
    maps_url: s.maps_url || null,
    address: s.address || null,
    source_suggestion_id: s.id || null,
    added_by_user: true,
  };
}
