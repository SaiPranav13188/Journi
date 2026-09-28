// AGENT 3 — Ticket. Reads a ticket with the existing Gemini extractor, then
// judges each field's confidence itself: clear bookings for a matching trip
// are saved straight away; anything doubtful is flagged and handed back to the
// app for the traveller to confirm. save_booking refuses a booking with an
// unconfirmed flagged field — the guardrail is enforced in code, not only in
// the prompt.

import { tool } from 'ai';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { addDays, toIsoDate } from '../lib/dates.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { runAgent, summarizeTrace } from '../lib/agents/runAgent.js';
import { readTicket, toInr } from '../services/ticketExtract.js';

export const TICKET_STEP_LIMIT = 4;

const TYPES = ['flight', 'hotel', 'train', 'bus', 'activity', 'car', 'other'];
const FIELDS = ['type', 'title', 'provider', 'confirmation_code', 'start_local', 'end_local', 'location', 'cost', 'trip'];
const BOOKING_FIELDS =
  'id, trip_id, type, title, provider, confirmation_code, start_at, end_at, location, cost_inr, status, notes, ticket_path, ticket_name, created_at';

const SYSTEM = `You are Journi's ticket agent. You turn an uploaded ticket, boarding pass or booking confirmation into saved bookings — carefully.

Steps:
1. Call extract_fields_from_image to read the document (you can also see it yourself to judge legibility).
2. For EVERY booking segment, evaluate each field's confidence before saving: ambiguous dates (e.g. 03/04 could be 3 April or 4 March), unclear currency symbols ($ could be USD/SGD/AUD, ¥ JPY/CNY), a total that may cover several segments, illegible or cut-off text, times that don't match the route, or a trip you can't match.
   - For each doubtful field call flag_low_confidence_field. A booking with any flagged field is NOT saved — the traveller confirms it in the app.
3. For bookings with no doubts: find_matching_trip with the booking dates (and destination if known), convert_currency if the cost isn't in INR, then save_booking. A round trip or multi-leg ticket is several bookings — save each segment separately (the total goes on the first segment only).
Independent calls (e.g. find_matching_trip + convert_currency for different segments, or several save_booking calls) can be made in the same step — you have very few steps.

Finish with ONLY this JSON: { "summary": "1-2 friendly sentences: what was saved and what needs the traveller's check" }`;

const TicketOutput = z.object({ summary: z.string().min(1) });

/** "YYYY-MM-DDTHH:mm" printed local time → ISO with the traveller's UTC offset (as the app does). */
function localToIso(local, tzOffsetMinutes) {
  if (!local) return null;
  const m = String(local).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) return null;
  const sign = tzOffsetMinutes <= 0 ? '+' : '-'; // JS getTimezoneOffset(): IST = -330
  const abs = Math.abs(tzOffsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${m[1]}T${m[2]}:00${offset}`;
}

function draftFrom(b) {
  return {
    type: b.type,
    title: b.title.slice(0, 120),
    provider: b.provider,
    confirmation_code: b.confirmation_code?.slice(0, 60) ?? null,
    start_local: b.start_local,
    end_local: b.end_local,
    location: b.location,
    cost_amount: b.cost_amount,
    cost_currency: b.cost_currency,
    travellers: b.travellers,
    notes: b.notes,
  };
}

/**
 * @param opts { userId, file: {base64, mimeType}, typeHint, trips (listTrips), ticket (stored file or null), tzOffsetMinutes }
 */
export async function runTicketAgent({ userId, file, typeHint = null, trips, ticket = null, tzOffsetMinutes = -330 }) {
  const ctx = { extracted: null, flags: [], saved: new Map(), fatal: null };
  const userTripIds = new Set(trips.map((t) => t.id));

  const tools = {
    extract_fields_from_image: tool({
      description: 'Reads the attached ticket/confirmation (photo or PDF) and returns every booking segment in it with its fields. Call this first, once.',
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.extracted) return { bookings: ctx.extracted.bookings.map((b, index) => ({ index, ...draftFrom(b) })), note: 'Already extracted.' };
        let ai;
        try {
          ai = await readTicket({ base64: file.base64, mimeType: file.mimeType, typeHint });
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) {
            ctx.fatal = new HttpError(422, 'We couldn’t read this file. Try a clearer photo or the original PDF (not password-protected).');
            throw ctx.fatal;
          }
          throw err;
        }
        ctx.extracted = { ...ai, bookings: ai.bookings.slice(0, 8) };
        if (!ai.is_booking_document || !ai.bookings.length) return { is_booking_document: false, reason: ai.reason || 'No booking details found' };
        return { is_booking_document: true, bookings: ctx.extracted.bookings.map((b, index) => ({ index, ...draftFrom(b) })) };
      },
    }),

    find_matching_trip: tool({
      description: "Finds which of the traveller's saved trips a booking belongs to, by date range (±3 days) and optionally destination. Returns the best match or null, with the candidates.",
      inputSchema: z.object({
        startDate: z.string().describe('YYYY-MM-DD'),
        endDate: z.string().optional().describe('YYYY-MM-DD'),
        destination: z.string().optional().describe('City/country of the booking, if known'),
      }),
      execute: async ({ startDate, endDate, destination }) => {
        const start = startDate.slice(0, 10);
        const end = (endDate || startDate).slice(0, 10);
        const candidates = trips.filter((t) => start <= toIsoDate(addDays(t.end_date, 3)) && end >= toIsoDate(addDays(t.start_date, -3)));
        const dest = destination?.toLowerCase();
        const byPlace = dest
          ? candidates.find((t) => [t.destination.name, t.destination.country].filter(Boolean).some((n) => dest.includes(n.toLowerCase()) || n.toLowerCase().includes(dest)))
          : null;
        const match = byPlace || (candidates.length === 1 ? candidates[0] : null);
        const view = (t) => ({ trip_id: t.id, destination: `${t.destination.name}${t.destination.country ? `, ${t.destination.country}` : ''}`, dates: `${t.start_date} to ${t.end_date}` });
        return { match: match ? view(match) : null, candidates: candidates.map(view), ambiguous: !match && candidates.length > 1 };
      },
    }),

    convert_currency: tool({
      description: 'Converts an amount in a given currency (ISO code) to INR at the live rate, with a short note of the original amount.',
      inputSchema: z.object({ amount: z.number().min(0), currencyCode: z.string().length(3) }),
      execute: ({ amount, currencyCode }) => toInr(amount, currencyCode.toUpperCase()),
    }),

    flag_low_confidence_field: tool({
      description: 'Marks one field of one booking as uncertain. That booking will NOT be saved automatically — the traveller confirms it in the app.',
      inputSchema: z.object({
        bookingIndex: z.number().int().min(0),
        fieldName: z.enum(FIELDS),
        extractedValue: z.string().nullable().describe('What you read, or null if missing'),
        reason: z.string().min(3).max(200),
      }),
      execute: async (flag) => {
        if (!ctx.extracted?.bookings[flag.bookingIndex]) throw new Error(`No booking at index ${flag.bookingIndex}`);
        if (ctx.saved.has(flag.bookingIndex)) throw new Error('That booking was already saved');
        ctx.flags.push(flag);
        return { flagged: true, will_not_be_saved_automatically: true };
      },
    }),

    save_booking: tool({
      description: 'Saves one booking segment to a trip. Only for bookings where every field is clear (no flagged fields) and the trip was matched.',
      inputSchema: z.object({
        tripId: z.string().uuid().describe('trip_id from find_matching_trip'),
        bookingIndex: z.number().int().min(0),
        bookingData: z.object({
          type: z.enum(TYPES),
          title: z.string().min(1).max(120),
          provider: z.string().max(120).nullable(),
          confirmation_code: z.string().max(60).nullable(),
          start_local: z.string().nullable().describe('YYYY-MM-DDTHH:mm as printed'),
          end_local: z.string().nullable(),
          location: z.string().max(200).nullable(),
          cost_inr: z.number().min(0).describe('From convert_currency when not paid in INR; 0 if unknown or on a later segment'),
          notes: z.string().max(1000).nullable(),
        }),
      }),
      execute: async ({ tripId, bookingIndex, bookingData }) => {
        // Guardrails: never save a flagged booking, never write to someone else's trip.
        if (!ctx.extracted?.bookings[bookingIndex]) throw new Error(`No booking at index ${bookingIndex}`);
        const flagged = ctx.flags.filter((f) => f.bookingIndex === bookingIndex);
        if (flagged.length) {
          throw new Error(`Refused: booking ${bookingIndex} has unconfirmed field(s) (${flagged.map((f) => f.fieldName).join(', ')}) — the traveller must confirm it in the app.`);
        }
        if (!userTripIds.has(tripId)) throw new Error('Refused: that trip does not belong to this traveller');
        if (ctx.saved.has(bookingIndex)) return { saved: true, booking_id: ctx.saved.get(bookingIndex).id, note: 'Already saved' };

        if (bookingData.confirmation_code) {
          const { data: dupes } = await db
            .from('bookings')
            .select(BOOKING_FIELDS)
            .eq('user_id', userId)
            .eq('trip_id', tripId)
            .eq('confirmation_code', bookingData.confirmation_code)
            .eq('title', bookingData.title)
            .limit(1);
          if (dupes?.length) {
            ctx.saved.set(bookingIndex, { ...dupes[0], cost_inr: Number(dupes[0].cost_inr), duplicate: true });
            return { saved: false, duplicate: true, booking_id: dupes[0].id, note: 'This booking was already saved earlier.' };
          }
        }

        const row = {
          user_id: userId,
          trip_id: tripId,
          type: bookingData.type,
          title: bookingData.title.trim(),
          provider: bookingData.provider,
          confirmation_code: bookingData.confirmation_code,
          start_at: localToIso(bookingData.start_local, tzOffsetMinutes),
          end_at: localToIso(bookingData.end_local, tzOffsetMinutes),
          location: bookingData.location,
          cost_inr: Math.round(bookingData.cost_inr),
          status: 'confirmed',
          notes: bookingData.notes,
          ticket_path: ticket?.ticket_path ?? null,
          ticket_name: ticket?.ticket_name ?? null,
        };
        const { data, error } = await db.from('bookings').insert(row).select(BOOKING_FIELDS).single();
        if (error) throw new Error(`Could not save booking: ${error.message}`);
        ctx.saved.set(bookingIndex, { ...data, cost_inr: Number(data.cost_inr) });
        return { saved: true, booking_id: data.id };
      },
    }),
  };

  const isPdf = file.mimeType === 'application/pdf';
  let run;
  try {
    run = await runAgent({
    agentName: 'ticket',
    userId,
    stepLimit: TICKET_STEP_LIMIT,
    systemPrompt: SYSTEM,
    tools,
    messages: [
      {
        role: 'user',
        content: [
          isPdf
            ? { type: 'file', data: file.base64, mediaType: file.mimeType }
            : { type: 'image', image: file.base64, mediaType: file.mimeType },
          {
            type: 'text',
            text: `Here is my ticket${typeHint && typeHint !== 'other' ? ` (a ${typeHint} booking)` : ''}. Today is ${toIsoDate(new Date())}.
My saved trips: ${trips.length ? trips.map((t) => `${t.destination.name} ${t.start_date}→${t.end_date}`).join('; ') : 'none'}.`,
          },
        ],
      },
    ],
    outputSchema: TicketOutput,
    temperature: 0.1,
    });
  } catch (err) {
    if (ctx.fatal) throw ctx.fatal;
    // The model saw a file Gemini can't open (corrupt / password-protected PDF).
    if (err instanceof HttpError && err.status === 400) throw new HttpError(422, 'We couldn’t read this file. Try a clearer photo or the original PDF (not password-protected).');
    throw err;
  }
  if (ctx.fatal) throw ctx.fatal;

  // The agent never read the file (or it wasn't a booking) → same errors as v1.
  if (!ctx.extracted) throw new HttpError(502, 'We couldn’t read this ticket. Please try again.');
  if (!ctx.extracted.is_booking_document || !ctx.extracted.bookings.length) {
    throw new HttpError(
      422,
      ctx.extracted.reason ? `This doesn’t look like a booking: ${ctx.extracted.reason}` : 'We couldn’t find booking details in this file. Try a clearer photo or the PDF confirmation.',
    );
  }

  // Everything not saved goes back to the app as a pre-filled draft (v1 shape) for the traveller to confirm.
  const needsConfirmation = [];
  for (const [index, b] of ctx.extracted.bookings.entries()) {
    if (ctx.saved.has(index)) continue;
    const { cost_inr, note } = await toInr(b.cost_amount, b.cost_currency);
    const notes = [b.travellers && `Traveller: ${b.travellers}`, b.notes, note].filter(Boolean).join(' · ') || null;
    const start = b.start_local?.slice(0, 10);
    const trip = start ? trips.find((t) => start >= toIsoDate(addDays(t.start_date, -3)) && start <= toIsoDate(addDays(t.end_date, 3))) : null;
    const flags = ctx.flags.filter((f) => f.bookingIndex === index).map(({ fieldName, extractedValue, reason }) => ({ field: fieldName, value: extractedValue, reason }));
    needsConfirmation.push({
      index,
      booking: {
        trip_id: trip?.id ?? null,
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
      },
      flags: flags.length ? flags : [{ field: 'trip', value: null, reason: trip ? 'Not saved automatically — please review.' : 'No matching trip found — choose one.' }],
    });
  }

  return {
    summary: run.output.summary,
    saved: [...ctx.saved.values()],
    needs_confirmation: needsConfirmation,
    agent: { runs: [summarizeTrace('ticket', run)] },
  };
}
