// Group trips (agentic only). Mounted at /v2/groups behind requireAuth.

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { listTrips } from '../services/tripStore.js';
import {
  addExpense,
  cleanPreferences,
  closePoll,
  createGroup,
  deleteExpense,
  displayNameFor,
  getGroup,
  groupTripRow,
  joinGroup,
  listMembers,
  removeMember,
  updatePreferences,
  vote,
} from '../services/groupStore.js';
import { runGroupChat } from '../agents/group.js';

export const groupsRouter = Router();

const uuid = (id, what = 'Trip') => {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, `${what} not found`);
  return id;
};
const me = (req) => ({ id: req.user.id, name: displayNameFor(req.user) });

// GET /v2/groups — group trips I'm in, with member counts.
groupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const trips = (await listTrips(req.user.id)).filter((t) => t.is_group);
    const ids = trips.map((t) => t.id);
    const { data: members } = ids.length ? await db.from('trip_members').select('trip_id, display_name, user_id').in('trip_id', ids) : { data: [] };
    res.json({
      groups: trips.map((t) => {
        const list = (members || []).filter((m) => m.trip_id === t.id);
        return { ...t, member_count: list.length, member_names: list.map((m) => m.display_name).slice(0, 6), is_owner: t.owner_id === req.user.id };
      }),
    });
  }),
);

// POST /v2/groups { trip_id } — share one of my trips with a group (creates the join code).
groupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z.object({ trip_id: z.string().uuid() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Choose a saved trip to share');
    res.status(201).json(await createGroup(req.user, body.data.trip_id));
  }),
);

// POST /v2/groups/join { code }
groupsRouter.post(
  '/join',
  asyncHandler(async (req, res) => {
    const body = z.object({ code: z.string().trim().min(4).max(20) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Enter the join code, e.g. JRN-4K7Q');
    res.json(await joinGroup(req.user, body.data.code));
  }),
);

// GET /v2/groups/:tripId — members, polls, expenses, balances.
groupsRouter.get(
  '/:tripId',
  asyncHandler(async (req, res) => {
    res.json(await getGroup(req.user.id, uuid(req.params.tripId)));
  }),
);

// POST /v2/groups/:tripId/chat { message } — the group agent.
groupsRouter.post(
  '/:tripId/chat',
  asyncHandler(async (req, res) => {
    const tripId = uuid(req.params.tripId);
    const body = z.object({ message: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Type a message first');
    await groupTripRow(req.user.id, tripId);
    res.json(await runGroupChat({ user: me(req), tripId, message: body.data.message }));
  }),
);

// PUT /v2/groups/:tripId/preferences — my interests, budget, pace, dietary needs.
groupsRouter.put(
  '/:tripId/preferences',
  asyncHandler(async (req, res) => {
    const tripId = uuid(req.params.tripId);
    const body = z
      .object({
        interests: z.array(z.string().max(40)).max(12).optional(),
        budget_per_person_inr: z.coerce.number().min(0).max(100_000_000).nullable().optional(),
        pace: z.enum(['relaxed', 'balanced', 'packed']).nullable().optional(),
        dietary: z.string().max(120).nullable().optional(),
        notes: z.string().max(300).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Please check your preferences');
    res.json({ preferences: await updatePreferences(req.user.id, tripId, cleanPreferences(body.data)) });
  }),
);

// POST /v2/groups/:tripId/polls/:pollId/vote { option_id }
// When everyone has voted, the poll closes and the group agent applies the result
// in the background — members see it arrive live.
groupsRouter.post(
  '/:tripId/polls/:pollId/vote',
  asyncHandler(async (req, res) => {
    const tripId = uuid(req.params.tripId);
    const pollId = uuid(req.params.pollId, 'Poll');
    const body = z.object({ option_id: z.string().min(1).max(10) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Pick an option');
    const { poll, allVoted } = await vote(req.user.id, tripId, pollId, body.data.option_id);

    if (allVoted) {
      const closed = await closePoll(tripId, pollId);
      const r = closed.result || {};
      const outcome = r.tie
        ? `It's a tie between ${r.leaders.join(' and ')}.`
        : `The winner is "${r.winner_label}" (${r.counts?.[r.winner_option_id] ?? 0} of ${r.total_votes} votes).`;
      runGroupChat({
        user: me(req),
        tripId,
        systemEvent: true,
        message: `[Poll closed] Everyone voted on "${poll.question}". ${outcome}${poll.day_number ? ` (about Day ${poll.day_number})` : ''} Apply the group's choice to the plan if it changes anything, then tell the group what you did.`,
      }).catch((err) => console.error(`[groups] poll follow-up for trip ${tripId} failed:`, err.message));
    }
    res.json({ ok: true, closed: allVoted });
  }),
);

// POST /v2/groups/:tripId/polls/:pollId/close — any member can end a poll early.
groupsRouter.post(
  '/:tripId/polls/:pollId/close',
  asyncHandler(async (req, res) => {
    const tripId = uuid(req.params.tripId);
    await groupTripRow(req.user.id, tripId);
    const poll = await closePoll(tripId, uuid(req.params.pollId, 'Poll'));
    const r = poll.result || {};
    runGroupChat({
      user: me(req),
      tripId,
      systemEvent: true,
      message: `[Poll closed early by ${displayNameFor(req.user)}] "${poll.question}": ${r.tie ? `tie between ${r.leaders.join(' and ')}` : r.winner_label ? `winner "${r.winner_label}"` : 'no votes'}. Apply the choice if there is a clear winner; otherwise suggest a compromise.`,
    }).catch((err) => console.error(`[groups] poll follow-up for trip ${tripId} failed:`, err.message));
    res.json({ ok: true, poll });
  }),
);

// POST /v2/groups/:tripId/expenses — add a shared expense by hand.
groupsRouter.post(
  '/:tripId/expenses',
  asyncHandler(async (req, res) => {
    const tripId = uuid(req.params.tripId);
    const body = z
      .object({
        description: z.string().trim().min(2).max(120),
        amount_inr: z.coerce.number().positive().max(100_000_000),
        paid_by: z.string().uuid(),
        split_among: z.array(z.string().uuid()).min(1).max(20).nullish(),
        category: z.enum(['stay', 'food', 'transport', 'activity', 'shopping', 'other']).default('other'),
      })
      .safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Please check the expense');
    await groupTripRow(req.user.id, tripId);
    const expense = await addExpense(tripId, req.user.id, {
      description: body.data.description,
      amountInr: body.data.amount_inr,
      paidBy: body.data.paid_by,
      splitAmong: body.data.split_among ?? null,
      category: body.data.category,
    });
    res.status(201).json({ expense });
  }),
);

groupsRouter.delete(
  '/:tripId/expenses/:expenseId',
  asyncHandler(async (req, res) => {
    await deleteExpense(req.user.id, uuid(req.params.tripId), uuid(req.params.expenseId, 'Expense'));
    res.status(204).end();
  }),
);

// DELETE /v2/groups/:tripId/members/:userId — leave (yourself) or remove (owner).
groupsRouter.delete(
  '/:tripId/members/:userId',
  asyncHandler(async (req, res) => {
    const tripId = uuid(req.params.tripId);
    await removeMember(req.user.id, tripId, uuid(req.params.userId, 'Member'));
    res.json({ members: req.params.userId === req.user.id ? [] : await listMembers(tripId) });
  }),
);
