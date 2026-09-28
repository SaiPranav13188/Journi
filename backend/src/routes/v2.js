// Agentic (v2) routes. They run alongside the v1 routes — nothing in v1 is
// changed — so the app can switch per user with its feature flag and cost,
// latency and quality can be compared before a full switch.

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { summarizeTrace } from '../lib/agents/runAgent.js';
import { getTrip, listTrips, saveTripPlan } from '../services/tripStore.js';
import { TICKET_MIME_TYPES } from '../services/ticketExtract.js';
import { runOrchestrator } from '../agents/orchestrator.js';
import { runPlannerGenerate, runPlannerRefine } from '../agents/planner.js';
import { runBudgetAgent } from '../agents/budget.js';
import { runTicketAgent } from '../agents/ticket.js';
import { runPriceCheckAgent } from '../agents/priceCheck.js';
import { runEval, VIETNAM_CASES } from '../agents/eval.js';

export const v2Router = Router();
export const v2EvalRouter = Router();

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const normalizeMime = (m) => (m.toLowerCase() === 'image/jpg' ? 'image/jpeg' : m.toLowerCase());

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  created_at: z.string().optional(),
  metadata: z.any().optional(),
});

const StateSchema = z.object({
  trip: z.object({ destination: z.record(z.string(), z.any()), start_date: z.string() }).passthrough(),
  days: z.array(z.record(z.string(), z.any())).min(1),
  budget: z.record(z.string(), z.any()).nullish(),
});

const ChatBody = z.object({
  trip_id: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(1000),
  // Required for unsaved drafts; ignored for saved trips (the DB is authoritative).
  state: StateSchema.nullish(),
  history: z.array(MessageSchema).max(200).default([]),
  focus_day: z.coerce.number().int().min(1).nullish(),
  image: z
    .object({ base64: z.string().min(100), mime_type: z.string().transform(normalizeMime) })
    .nullish(),
});

/** Saved trip from the DB (not finalized) or the draft sent by the app — same rules as v1 /itinerary/refine. */
async function loadChatContext(req, data) {
  if (data.trip_id) {
    const saved = await getTrip(req.user.id, data.trip_id);
    if (saved.trip.status === 'finalized') {
      throw new HttpError(409, 'This plan is finalized. Reopen it for editing to keep refining.');
    }
    return { userId: req.user.id, tripId: data.trip_id, persist: true, state: { trip: saved.trip, days: saved.days, budget: saved.budget }, history: saved.messages };
  }
  if (!data.state) throw new HttpError(400, 'state is required for unsaved trips');
  return { userId: req.user.id, tripId: null, persist: false, state: data.state, history: data.history };
}

function checkImage(image) {
  if (!IMAGE_TYPES.includes(image.mime_type)) throw new HttpError(415, 'Please use a photo (JPG, PNG, WEBP or HEIC)');
  if (Buffer.byteLength(image.base64, 'base64') > MAX_IMAGE_BYTES) throw new HttpError(413, 'That photo is too large');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

// POST /v2/chat — the agentic replacement for chat inside /itinerary/refine.
v2Router.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid chat request', parsed.error.issues);
    if (parsed.data.image) checkImage(parsed.data.image);
    const ctx = await loadChatContext(req, parsed.data);
    const result = await runOrchestrator(ctx, {
      message: parsed.data.message,
      focusDay: parsed.data.focus_day ?? null,
      image: parsed.data.image ? { base64: parsed.data.image.base64, mimeType: parsed.data.image.mime_type } : null,
    });
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

const GenerateBody = z.object({
  destination: z.record(z.string(), z.any()),
  origin_city: z.string().trim().max(80).nullish(),
  start_date: z.string(),
  end_date: z.string(),
});

v2Router.post(
  '/itinerary/generate',
  asyncHandler(async (req, res) => {
    const body = GenerateBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'destination, start_date and end_date are required');
    res.json(
      await runPlannerGenerate({
        userId: req.user.id,
        destination: body.data.destination,
        origin: body.data.origin_city ?? null,
        startDate: body.data.start_date,
        endDate: body.data.end_date,
      }),
    );
  }),
);

v2Router.post(
  '/itinerary/refine',
  asyncHandler(async (req, res) => {
    const parsed = ChatBody.omit({ image: true }).safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid refine request', parsed.error.issues);
    const ctx = await loadChatContext(req, parsed.data);
    const { result, run } = await runPlannerRefine({ ctx, message: parsed.data.message, focusDay: parsed.data.focus_day ?? null });
    if (ctx.persist) {
      // The plan was already committed by save_itinerary_state; store the chat turn.
      await saveTripPlan(req.user.id, ctx.tripId, { trip: result.trip, days: null, budget: null }, result.messages);
    }
    res.json({ ...result, agent: { runs: [summarizeTrace('planner', run)] } });
  }),
);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

v2Router.post(
  '/budget/reconcile',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        trip_id: z.string().uuid().nullish(),
        state: StateSchema.nullish(),
        change: z.string().trim().max(600).nullish(),
        question: z.string().trim().max(600).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid budget request', parsed.error.issues);
    const { trip_id, state } = parsed.data;
    // Budget updates are allowed on finalized trips too (like v1 /itinerary/flight-cost).
    const ctx = trip_id
      ? { userId: req.user.id, tripId: trip_id, persist: true, state: await getTrip(req.user.id, trip_id) }
      : { userId: req.user.id, tripId: null, persist: false, state };
    if (!ctx.state) throw new HttpError(400, 'state is required for unsaved trips');
    ctx.state = { trip: ctx.state.trip, days: ctx.state.days, budget: ctx.state.budget };

    const result = await runBudgetAgent(ctx, { change: parsed.data.change ?? null, question: parsed.data.question ?? null });
    res.json({
      budget: result.state.budget,
      recalculated: result.recalculated,
      reason: result.reason,
      reply: result.summary,
      budget_delta: result.delta,
      budget_concern: result.concern,
      agent: { runs: [result.trace] },
    });
  }),
);

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

const TICKETS_BUCKET = 'tickets';

v2Router.post(
  '/bookings/extract',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        file_base64: z.string().min(100),
        mime_type: z.string().transform(normalizeMime),
        file_name: z.string().max(200).nullish(),
        type_hint: z.enum(['flight', 'hotel', 'train', 'bus', 'activity', 'car', 'other']).nullish(),
        // Device UTC offset (JS getTimezoneOffset()), used to store printed local times like the app does.
        tz_offset_minutes: z.coerce.number().int().min(-840).max(840).default(-330),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please choose a photo or PDF of your ticket');
    const { file_base64, file_name, type_hint, mime_type: mimeType } = parsed.data;
    if (!TICKET_MIME_TYPES.includes(mimeType)) throw new HttpError(415, 'Please upload a PDF or a photo (JPG, PNG, WEBP or HEIC)');
    const bytes = Buffer.from(file_base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'That file is larger than 10 MB — try a photo or a smaller PDF');

    // Store the file first so bookings the agent saves can have it attached.
    const [trips, ticket] = await Promise.all([
      listTrips(req.user.id),
      (async () => {
        const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1].replace('jpeg', 'jpg');
        const ticketPath = `${req.user.id}/${randomUUID()}.${ext}`;
        const { error } = await db.storage.from(TICKETS_BUCKET).upload(ticketPath, bytes, { contentType: mimeType });
        if (error) {
          console.warn('[v2/bookings] ticket not stored:', error.message);
          return null;
        }
        return { ticket_path: ticketPath, ticket_name: file_name || `ticket.${ext}` };
      })(),
    ]);

    const result = await runTicketAgent({
      userId: req.user.id,
      file: { base64: file_base64, mimeType },
      typeHint: type_hint ?? null,
      trips,
      ticket,
      tzOffsetMinutes: parsed.data.tz_offset_minutes,
    });
    res.json({
      summary: result.summary,
      saved: result.saved,
      needs_confirmation: result.needs_confirmation,
      // v1-compatible: the drafts still to be confirmed, ready to fill the booking form.
      bookings: result.needs_confirmation.map((n) => n.booking),
      ticket,
      agent: result.agent,
    });
  }),
);

// ---------------------------------------------------------------------------
// Price check
// ---------------------------------------------------------------------------

v2Router.post(
  '/tools/price-check',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        image_base64: z.string().min(100),
        mime_type: z.string().transform(normalizeMime),
        place: z.string().trim().min(2).max(120),
        country_code: z.string().length(2).nullish(),
        note: z.string().trim().max(200).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please add a photo and the city you’re in');
    checkImage({ base64: parsed.data.image_base64, mime_type: parsed.data.mime_type });
    res.json(
      await runPriceCheckAgent({
        userId: req.user.id,
        tripId: null,
        base64: parsed.data.image_base64,
        mimeType: parsed.data.mime_type,
        place: parsed.data.place,
        countryCode: parsed.data.country_code ?? null,
        note: parsed.data.note ?? null,
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Transparency: what the agents did for this traveller
// ---------------------------------------------------------------------------

v2Router.get(
  '/agent-logs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    let query = db
      .from('agent_tool_logs')
      .select('id, run_id, agent_name, trip_id, tool_name, arguments, result, is_error, duration_ms, step, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (req.query.trip_id) query = query.eq('trip_id', String(req.query.trip_id));
    if (req.query.run_id) query = query.eq('run_id', String(req.query.run_id));
    const { data, error } = await query;
    if (error) throw new HttpError(500, 'Could not load agent logs');
    res.json({ logs: data });
  }),
);

// ---------------------------------------------------------------------------
// Evaluation (internal only — x-eval-secret header)
// ---------------------------------------------------------------------------

v2EvalRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    if (!config.evalSecret || req.get('x-eval-secret') !== config.evalSecret) throw new HttpError(401, 'Unauthorized');
    const parsed = z
      .object({
        trip_id: z.string().uuid().nullish(),
        state: StateSchema.nullish(),
        case_ids: z.array(z.string()).optional(),
        cases: z
          .array(
            z.object({
              id: z.string().min(1),
              message: z.string().min(1).max(1000),
              mode: z.enum(['update', 'suggest', 'answer']).optional(),
              expect: z.array(z.string()).optional(),
              avoid: z.array(z.string()).optional(),
              weatherBefore: z.array(z.string()).optional(),
              budget: z.boolean().optional(),
              budgetQuestion: z.boolean().optional(),
            }),
          )
          .max(30)
          .optional(),
        compare_v1: z.boolean().default(true),
      })
      .safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, 'Invalid eval request', parsed.error.issues);
    const { trip_id, state, case_ids, compare_v1 } = parsed.data;

    let userId = null;
    let evalState = state;
    if (trip_id) {
      const { data: row, error } = await db.from('trips').select('user_id').eq('id', trip_id).maybeSingle();
      if (error || !row) throw new HttpError(404, 'Trip not found');
      userId = row.user_id;
      const saved = await getTrip(userId, trip_id);
      evalState = { trip: saved.trip, days: saved.days, budget: saved.budget };
    }
    if (!evalState) throw new HttpError(400, 'Send trip_id (your tested Vietnam trip) or a full state');

    let cases = parsed.data.cases ?? VIETNAM_CASES;
    if (case_ids?.length) cases = cases.filter((c) => case_ids.includes(c.id));
    if (!cases.length) throw new HttpError(400, `No matching cases. Known ids: ${VIETNAM_CASES.map((c) => c.id).join(', ')}`);

    res.json(await runEval({ userId, tripId: trip_id ?? null, state: evalState, cases, compareV1: compare_v1 }));
  }),
);
