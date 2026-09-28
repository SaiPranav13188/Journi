import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { randomUUID } from 'node:crypto';
import { assertTripAccess, listTrips } from '../services/tripStore.js';
import { extractBookingsFromTicket, TICKET_MIME_TYPES } from '../services/ticketExtract.js';

export const bookingsRouter = Router();

const BOOKING_FIELDS =
  'id, trip_id, type, title, provider, confirmation_code, start_at, end_at, location, cost_inr, status, notes, ticket_path, ticket_name, created_at';
const TICKETS_BUCKET = 'tickets';
const MAX_TICKET_BYTES = 10 * 1024 * 1024;

const BookingSchema = z.object({
  trip_id: z.string().uuid(),
  type: z.enum(['flight', 'hotel', 'train', 'bus', 'activity', 'car', 'other']).default('other'),
  title: z.string().trim().min(1).max(120),
  provider: z.string().trim().max(120).nullish(),
  confirmation_code: z.string().trim().max(60).nullish(),
  start_at: z.string().datetime({ offset: true }).nullish(),
  end_at: z.string().datetime({ offset: true }).nullish(),
  location: z.string().trim().max(200).nullish(),
  cost_inr: z.coerce.number().min(0).max(100_000_000).default(0),
  status: z.enum(['confirmed', 'pending', 'cancelled']).default('confirmed'),
  notes: z.string().trim().max(1000).nullish(),
  ticket_path: z.string().max(300).nullish(),
  ticket_name: z.string().max(200).nullish(),
});

/** Tickets are stored under "<user id>/…" — never accept someone else's path. */
function assertOwnTicket(userId, ticketPath) {
  if (ticketPath && !ticketPath.startsWith(`${userId}/`)) throw new HttpError(403, 'Invalid ticket file');
}

function toApi(row) {
  return { ...row, cost_inr: Number(row.cost_inr) };
}

function fail(error, message) {
  if (!error) return;
  console.error('[bookings]', message, error);
  // 42P01 = table missing: migration 004 hasn't been run yet.
  if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code)) {
    throw new HttpError(500, 'The database needs an update. Run supabase/migrations/RUN_THIS_update.sql in the Supabase SQL Editor.');
  }
  throw new HttpError(500, message);
}

// GET /bookings?trip_id=… (all trips when omitted)
bookingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    let query = db.from('bookings').select(BOOKING_FIELDS).eq('user_id', req.user.id).order('start_at', { ascending: true, nullsFirst: false });
    if (req.query.trip_id) query = query.eq('trip_id', String(req.query.trip_id));
    const { data, error } = await query;
    fail(error, 'Could not load bookings');
    res.json({ bookings: data.map(toApi) });
  }),
);

bookingsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = BookingSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please check the booking details', parsed.error.issues);
    await assertTripAccess(req.user.id, parsed.data.trip_id);
    assertOwnTicket(req.user.id, parsed.data.ticket_path);
    const { data, error } = await db
      .from('bookings')
      .insert({ ...parsed.data, user_id: req.user.id })
      .select(BOOKING_FIELDS)
      .single();
    fail(error, 'Could not save booking');
    res.status(201).json({ booking: toApi(data) });
  }),
);

bookingsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = BookingSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please check the booking details', parsed.error.issues);
    if (parsed.data.trip_id) await assertTripAccess(req.user.id, parsed.data.trip_id);
    assertOwnTicket(req.user.id, parsed.data.ticket_path);
    const { data, error } = await db
      .from('bookings')
      .update(parsed.data)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select(BOOKING_FIELDS)
      .maybeSingle();
    fail(error, 'Could not update booking');
    if (!data) throw new HttpError(404, 'Booking not found');
    res.json({ booking: toApi(data) });
  }),
);

bookingsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data: removed, error } = await db
      .from('bookings')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('ticket_path')
      .maybeSingle();
    fail(error, 'Could not delete booking');
    if (removed?.ticket_path) {
      const { count } = await db.from('bookings').select('id', { count: 'exact', head: true }).eq('ticket_path', removed.ticket_path);
      if (!count) await db.storage.from(TICKETS_BUCKET).remove([removed.ticket_path]).catch(() => {});
    }
    res.status(204).end();
  }),
);

/**
 * POST /bookings/extract — upload a ticket (photo or PDF, base64) and get the
 * booking details back, ready to fill the form. The file is kept privately so
 * it can be attached to the booking(s) and viewed later.
 */
bookingsRouter.post(
  '/extract',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        file_base64: z.string().min(100),
        mime_type: z.string().transform((m) => m.toLowerCase()),
        file_name: z.string().max(200).nullish(),
        type_hint: z.enum(['flight', 'hotel', 'train', 'bus', 'activity', 'car', 'other']).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please choose a photo or PDF of your ticket');
    const { file_base64, file_name, type_hint } = parsed.data;
    const mimeType = parsed.data.mime_type === 'image/jpg' ? 'image/jpeg' : parsed.data.mime_type;
    if (!TICKET_MIME_TYPES.includes(mimeType)) throw new HttpError(415, 'Please upload a PDF or a photo (JPG, PNG, WEBP or HEIC)');

    const bytes = Buffer.from(file_base64, 'base64');
    if (bytes.length > MAX_TICKET_BYTES) throw new HttpError(413, 'That file is larger than 10 MB — try a photo or a smaller PDF');

    const trips = await listTrips(req.user.id);
    const [bookings, stored] = await Promise.all([
      extractBookingsFromTicket({ base64: file_base64, mimeType, typeHint: type_hint, trips }),
      (async () => {
        const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1].replace('jpeg', 'jpg');
        const ticketPath = `${req.user.id}/${randomUUID()}.${ext}`;
        const { error } = await db.storage.from(TICKETS_BUCKET).upload(ticketPath, bytes, { contentType: mimeType });
        if (error) {
          console.warn('[bookings] ticket not stored:', error.message);
          return null; // auto-fill still works; the file just isn't attached
        }
        return { ticket_path: ticketPath, ticket_name: file_name || `ticket.${ext}` };
      })(),
    ]);

    res.json({ bookings, ticket: stored });
  }),
);

// GET /bookings/:id/ticket — short-lived link to view the attached ticket.
bookingsRouter.get(
  '/:id/ticket',
  asyncHandler(async (req, res) => {
    const { data, error } = await db
      .from('bookings')
      .select('ticket_path, ticket_name')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    fail(error, 'Could not load ticket');
    if (!data?.ticket_path) throw new HttpError(404, 'No ticket attached to this booking');
    const { data: signed, error: signError } = await db.storage.from(TICKETS_BUCKET).createSignedUrl(data.ticket_path, 60 * 60);
    if (signError) throw new HttpError(500, 'Could not open the ticket');
    res.json({ url: signed.signedUrl, name: data.ticket_name });
  }),
);
