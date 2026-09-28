// Travel tools: "Is this price fair?" (photo → verdict) and a smart packing list.

import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { currencyForCountry } from '../data/countryCurrency.js';
import { getInrRate } from './currency.js';
import { generateJson } from './gemini.js';

// ---------------------------------------------------------------------------
// Price check
// ---------------------------------------------------------------------------

const VERDICTS = ['cheap', 'fair', 'high', 'very_high', 'unknown'];

const PriceSchema = z.object({
  is_price_photo: z.boolean(),
  reason: z.string().nullish(),
  currency: z
    .string()
    .nullish()
    .transform((v) => (v && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null)),
  what: z.string().nullish().transform((v) => v || null),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.coerce.number().min(0),
        verdict: z
          .string()
          .transform((s) => s.toLowerCase().trim().replace(/\s+/g, '_'))
          .pipe(z.enum(VERDICTS))
          .catch('unknown'),
        typical_low: z.coerce.number().min(0).nullish().catch(null),
        typical_high: z.coerce.number().min(0).nullish().catch(null),
        note: z.string().nullish().transform((v) => v || null),
      }),
    )
    .default([]),
  summary: z.string().nullish().transform((v) => v || null),
  tip: z.string().nullish().transform((v) => v || null),
});

/**
 * @returns { what, currency, rate, items: [{ name, price, price_inr, verdict, typical_low, typical_high,
 *            typical_low_inr, typical_high_inr, note }], summary, tip }
 */
export async function checkPrices({ base64, mimeType, place, countryCode, note }) {
  const localCurrency = currencyForCountry(countryCode) || null;
  let ai;
  try {
    ai = await generateJson({
      system: 'You are a street-smart local price expert who helps Indian travellers avoid being overcharged. Respond with a single JSON object only.',
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            {
              text: `The traveller is in ${place}${localCurrency ? ` (local currency ${localCurrency})` : ''}${note ? `. They add: "${note}"` : ''}.
This photo shows prices (a menu, price tag, taxi/tuk-tuk quote, shop board, receipt or similar).

For each priced item you can read (max 12):
- name, price (number as shown), verdict vs what locals and savvy tourists typically pay in ${place} RIGHT NOW: "cheap" | "fair" | "high" | "very_high" | "unknown",
- typical_low / typical_high: the normal price range in the same currency,
- note: max 15 words (e.g. "Tourist-area markup; ~40% less two streets away").
Also give: currency (ISO code of the prices shown; if no symbol is visible assume ${localCurrency || 'the local currency'}), what (short description, e.g. "Street-food menu"), summary (one sentence overall verdict), tip (one practical tip, e.g. how to bargain or where it's cheaper).
If the photo has no prices, set is_price_photo=false with a short reason.

JSON: { "is_price_photo": boolean, "reason": "...", "currency": "...", "what": "...", "items": [ { "name": "...", "price": 0, "verdict": "...", "typical_low": 0, "typical_high": 0, "note": "..." } ], "summary": "...", "tip": "..." }`,
            },
          ],
        },
      ],
      schema: PriceSchema,
      temperature: 0.2,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) throw new HttpError(422, 'We couldn’t read this photo. Try a clearer, closer shot of the prices.');
    throw err;
  }

  if (!ai.is_price_photo || !ai.items.length) {
    throw new HttpError(422, ai.reason ? `No prices found: ${ai.reason}` : 'We couldn’t find any prices in this photo. Try a closer shot.');
  }

  const currency = ai.currency || localCurrency || 'INR';
  const rateInfo = currency === 'INR' ? null : await getInrRate(currency);
  const rate = currency === 'INR' ? 1 : rateInfo?.rate ?? null; // units of currency per 1 INR
  const toInr = (v) => (v == null || rate == null ? null : Math.round(v / rate));

  return {
    what: ai.what,
    currency,
    rate,
    items: ai.items.slice(0, 12).map((i) => ({
      ...i,
      price_inr: toInr(i.price),
      typical_low_inr: toInr(i.typical_low),
      typical_high_inr: toInr(i.typical_high),
    })),
    summary: ai.summary,
    tip: ai.tip,
  };
}

// ---------------------------------------------------------------------------
// Packing list
// ---------------------------------------------------------------------------

const PackingSchema = z.object({
  categories: z
    .array(
      z.object({
        name: z.string().min(1),
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              reason: z.string().nullish().transform((v) => v || null),
              essential: z
                .union([z.boolean(), z.string()])
                .transform((v) => v === true || v === 'true')
                .default(false),
            }),
          )
          .min(1),
      }),
    )
    .min(2),
});

/** Builds a packing list from the trip's forecast, activities and destination. */
export async function buildPackingList(state) {
  const { trip, days } = state;
  const d = trip.destination;
  const international = (d.country_code || '').toUpperCase() !== 'IN';
  const dayLines = days
    .map((day) => {
      const w = day.weather_summary;
      const weather = w?.available
        ? `${w.condition}, ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C, rain ${w.precipitation_probability ?? 0}%`
        : 'forecast not available yet (use typical weather for the season)';
      const acts = day.activities
        .filter((a) => !a.placeholder)
        .map((a) => `${a.title}${a.category ? ` [${a.category}${a.indoor ? ', indoor' : ''}]` : ''}`)
        .join('; ');
      return `Day ${day.day_number} (${day.date}): ${weather}${day.weather_warning ? ` — WARNING: ${day.weather_warning.replace(/\n/g, ' ')}` : ''}. Plan: ${acts}`;
    })
    .join('\n');

  const ai = await generateJson({
    system: 'You create practical, personalised packing lists for Indian travellers. Respond with a single JSON object only.',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Trip: ${d.name}${d.country ? `, ${d.country}` : ''} · ${trip.start_date} to ${trip.end_date} (${days.length} days)${trip.origin_city ? ` · flying from ${trip.origin_city}` : ''}${international ? ' · INTERNATIONAL trip from India' : ' · domestic trip within India'}

Day by day:
${dayLines}

Make a packing list tailored to THIS trip: weather each day (rain gear if rain, layers if cold), the activities (hiking shoes for treks, modest clothing for temples/religious sites, swimwear for beaches…), the trip length (sensible quantities), and ${international ? 'international needs (passport, visa printout, forex/international card, universal adapter for this country, travel insurance, international SIM/eSIM)' : 'domestic needs (ID proof, UPI/cash)'}.
Categories (use these that apply): Documents & money, Clothes, Footwear, Toiletries, Health & safety, Electronics, Activity gear, Extras.
Each item: name (with quantity when useful, e.g. "T-shirts ×4"), reason (max 8 words, only when it's trip-specific, e.g. "Rain forecast on Day 3"), essential (true for must-haves).
Aim for 30–45 items total. JSON: { "categories": [ { "name": "...", "items": [ { "name": "...", "reason": "...", "essential": true } ] } ] }`,
          },
        ],
      },
    ],
    schema: PackingSchema,
    temperature: 0.4,
  });

  return {
    generated_at: new Date().toISOString(),
    categories: ai.categories.map((c) => ({
      name: c.name,
      items: c.items.slice(0, 20).map((i, idx) => ({ id: `${c.name}-${idx}-${i.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'), ...i })),
    })),
  };
}
