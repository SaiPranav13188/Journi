// Reads an uploaded ticket / confirmation (photo or PDF) with Gemini and turns
// it into booking(s) ready to save: type, name, provider, PNR, times, place,
// cost in INR. One file can hold several bookings (e.g. outbound + return).

import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { addDays, toIsoDate } from '../lib/dates.js';
import { getInrRate } from './currency.js';
import { generateJson } from './gemini.js';

export const TICKET_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const TYPES = ['flight', 'hotel', 'train', 'bus', 'activity', 'car', 'other'];

const localDateTime = z
  .string()
  .nullish()
  .transform((v) => {
    if (!v) return null;
    const m = String(v).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    return m ? `${m[1]}T${m[2] || '00:00'}` : null;
  });

const ExtractSchema = z.object({
  is_booking_document: z.boolean(),
  reason: z.string().nullish(),
  bookings: z
    .array(
      z.object({
        type: z
          .string()
          .transform((s) => s.toLowerCase().trim())
          .pipe(z.enum(TYPES))
          .catch('other'),
        title: z.string().min(1),
        provider: z.string().nullish().transform((v) => v || null),
        confirmation_code: z.string().nullish().transform((v) => v || null),
        start_local: localDateTime,
        end_local: localDateTime,
        location: z.string().nullish().transform((v) => v || null),
        cost_amount: z.coerce.number().min(0).nullish().catch(null),
        cost_currency: z
          .string()
          .nullish()
          .transform((v) => (v && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null)),
        travellers: z.string().nullish().transform((v) => v || null),
        notes: z.string().nullish().transform((v) => v || null),
      }),
    )
    .default([]),
});

const PROMPT = (typeHint) => `This file is a travel ticket, boarding pass, reservation or booking confirmation${
  typeHint && typeHint !== 'other' ? ` (the traveller says it is a ${typeHint} booking)` : ''
}. Extract every booking it contains.

Rules:
- One entry per segment: a round-trip or multi-leg flight → one entry per flight; a hotel stay → one entry; a train/bus journey → one per leg.
- type: flight | hotel | train | bus | activity | car | other.
- title: short and clear. Flight: "HYD → HAN · VJ 942" (IATA codes, flight number). Hotel: the hotel name. Train/bus: "From → To · train/bus number". Activity: the activity or tour name. Car: "Car rental · <company>".
- provider: airline, hotel brand/booking site, rail/bus operator, or tour company.
- confirmation_code: the PNR / booking reference / confirmation number (not the ticket or invoice number if a PNR exists).
- start_local / end_local: local date and time exactly as printed, format "YYYY-MM-DDTHH:mm". Flight: departure → arrival. Hotel: check-in → check-out (use 14:00 / 11:00 if no time is printed). Unknown → null.
- location: departure airport/station/terminal, the hotel address, or the meeting point.
- cost_amount + cost_currency (ISO code like INR, USD, EUR): the total paid for that booking. If one payment covers several segments, put the total on the FIRST segment only and 0 on the others.
- travellers: passenger/guest names if printed.
- notes: useful extras in one short line — seat, class, baggage, room type, gate, platform, coach/berth.
- If the file is not a booking document, set is_booking_document=false, give a short reason and return an empty bookings array.
- Never guess values that are not in the document; use null instead.

Return JSON only:
{
  "is_booking_document": boolean,
  "reason": "string or null",
  "bookings": [
    { "type": "...", "title": "...", "provider": "...", "confirmation_code": "...", "start_local": "...", "end_local": "...",
      "location": "...", "cost_amount": number, "cost_currency": "...", "travellers": "...", "notes": "..." }
  ]
}`;

/** Picks the saved trip whose dates cover the booking (±3 days). */
export function matchTrip(trips, startLocal) {
  if (!startLocal || !trips?.length) return null;
  const day = startLocal.slice(0, 10);
  const hit = trips.find((t) => day >= toIsoDate(addDays(t.start_date, -3)) && day <= toIsoDate(addDays(t.end_date, 3)));
  return hit?.id ?? null;
}

export async function toInr(amount, currency) {
  if (amount == null) return { cost_inr: 0, note: null };
  if (!currency || currency === 'INR') return { cost_inr: Math.round(amount), note: null };
  const rate = await getInrRate(currency); // units of `currency` per 1 INR
  if (!rate?.rate) return { cost_inr: 0, note: `Paid ${currency} ${amount} (couldn’t convert to ₹)` };
  return { cost_inr: Math.round(amount / rate.rate), note: `Paid ${currency} ${amount.toLocaleString('en-US')}` };
}

/**
 * @returns [{ trip_id, type, title, provider, confirmation_code, start_local, end_local, location, cost_inr, status, notes }]
 */
export async function extractBookingsFromTicket({ base64, mimeType, typeHint, trips }) {
  let ai;
  try {
    ai = await readTicket({ base64, mimeType, typeHint });
  } catch (err) {
    // 400 from Gemini = it couldn't open the file (corrupt, password-protected, unsupported).
    if (err instanceof HttpError && err.status === 400) {
      throw new HttpError(422, 'We couldn’t read this file. Try a clearer photo or the original PDF (not password-protected).');
    }
    throw err;
  }
  return finish(ai, trips);
}

export function readTicket({ base64, mimeType, typeHint }) {
  return generateJson({
    system: 'You extract structured booking data from travel documents accurately. Respond with a single JSON object only.',
    contents: [
      {
        role: 'user',
        parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT(typeHint) }],
      },
    ],
    schema: ExtractSchema,
    temperature: 0.1,
  });
}

async function finish(ai, trips) {
  if (!ai.is_booking_document || ai.bookings.length === 0) {
    throw new HttpError(
      422,
      ai.reason
        ? `This doesn’t look like a booking: ${ai.reason}`
        : 'We couldn’t find booking details in this file. Try a clearer photo or the PDF confirmation.',
    );
  }

  return Promise.all(
    ai.bookings.slice(0, 8).map(async (b) => {
      const { cost_inr, note } = await toInr(b.cost_amount, b.cost_currency);
      const notes = [b.travellers && `Traveller: ${b.travellers}`, b.notes, note].filter(Boolean).join(' · ') || null;
      return {
        trip_id: matchTrip(trips, b.start_local),
        type: b.type,
        title: b.title.slice(0, 120),
        provider: b.provider,
        confirmation_code: b.confirmation_code?.slice(0, 60) ?? null,
        start_local: b.start_local,
        end_local: b.end_local,
        location: b.location,
        cost_inr,
        status: 'confirmed',
        notes: notes?.slice(0, 1000) ?? null,
      };
    }),
  );
}
