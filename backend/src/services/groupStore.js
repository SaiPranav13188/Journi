// Group trips: members & join codes, preferences, polls and shared expenses.
// Uses the service-role client, so every function checks membership itself.

import { randomInt } from 'node:crypto';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { HttpError } from '../lib/http.js';
import { accessibleTripRow } from './tripStore.js';

export const MAX_GROUP_MEMBERS = 20;
const MAX_OPEN_POLLS = 3;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function fail(error, message) {
  if (!error) return;
  console.error('[groups]', message, error);
  if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code)) {
    throw new HttpError(500, 'The database needs an update. Run supabase/migrations/007_groups.sql in the Supabase SQL Editor.');
  }
  throw new HttpError(500, message);
}

export function displayNameFor(user) {
  const m = user?.user_metadata || {};
  const name = (m.full_name || m.name || '').trim() || (user?.email || 'Traveller').split('@')[0];
  return name.slice(0, 60);
}

function newJoinCode() {
  let code = 'JRN-';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// ----- Serialise AI runs per trip ----------------------------------------------
// Two members chatting at once must not both edit a stale copy of the plan.
// One Render instance → an in-process queue per trip is enough.
const tripQueues = new Map();

export function withTripLock(tripId, fn) {
  const previous = tripQueues.get(tripId) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tripQueues.set(tripId, tail);
  tail.then(() => {
    if (tripQueues.get(tripId) === tail) tripQueues.delete(tripId);
  });
  return run;
}

// ----- Membership ----------------------------------------------------------------

/** The group trip row if the user is a member (or owner); 404 otherwise, 400 if it isn't a group. */
export async function groupTripRow(userId, tripId) {
  const row = await accessibleTripRow(userId, tripId);
  if (!row.is_group) throw new HttpError(400, 'This trip isn’t shared with a group yet.');
  return row;
}

export async function listMembers(tripId) {
  const { data, error } = await db
    .from('trip_members')
    .select('user_id, role, display_name, preferences, joined_at')
    .eq('trip_id', tripId)
    .order('joined_at');
  fail(error, 'Could not load group members');
  return data.map((m) => ({ ...m, preferences: m.preferences || {} }));
}

/** Turns one of the owner's trips into a group trip with a join code. */
export async function createGroup(user, tripId) {
  const row = await accessibleTripRow(user.id, tripId);
  if (row.user_id !== user.id) throw new HttpError(403, 'Only the trip’s owner can share it with a group.');

  if (!row.is_group || !row.join_code) {
    let saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const { error } = await db.from('trips').update({ is_group: true, join_code: newJoinCode() }).eq('id', tripId);
      if (!error) saved = true;
      else if (error.code !== '23505') fail(error, 'Could not create the group'); // 23505 = code clash → retry
    }
    if (!saved) throw new HttpError(500, 'Could not create a join code. Please try again.');
  }
  const { error } = await db
    .from('trip_members')
    .upsert({ trip_id: tripId, user_id: user.id, role: 'owner', display_name: displayNameFor(user) }, { onConflict: 'trip_id,user_id', ignoreDuplicates: true });
  fail(error, 'Could not add you to the group');
  return getGroup(user.id, tripId);
}

export async function joinGroup(user, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase().replace(/\s+/g, '');
  const normalized = code.startsWith('JRN-') ? code : `JRN-${code.replace(/^JRN/, '')}`;
  const { data: trip, error } = await db.from('trips').select('id, user_id, is_group, destination_name').eq('join_code', normalized).maybeSingle();
  fail(error, 'Could not look up that code');
  if (!trip?.is_group) throw new HttpError(404, 'No group trip found for that code. Check it and try again.');

  const members = await listMembers(trip.id);
  if (trip.user_id === user.id || members.some((m) => m.user_id === user.id)) {
    return { trip_id: trip.id, destination_name: trip.destination_name, already_member: true };
  }
  if (members.length >= MAX_GROUP_MEMBERS) throw new HttpError(409, `This group is full (${MAX_GROUP_MEMBERS} people).`);

  const { error: insertError } = await db
    .from('trip_members')
    .insert({ trip_id: trip.id, user_id: user.id, role: 'member', display_name: displayNameFor(user) });
  fail(insertError, 'Could not join the group');
  return { trip_id: trip.id, destination_name: trip.destination_name, already_member: false };
}

/** The owner removes someone, or a member leaves. The owner can't leave their own trip. */
export async function removeMember(actorId, tripId, targetId) {
  const row = await groupTripRow(actorId, tripId);
  const isOwner = row.user_id === actorId;
  if (targetId === row.user_id) throw new HttpError(400, 'The trip’s owner can’t leave the group. Delete the trip instead.');
  if (!isOwner && targetId !== actorId) throw new HttpError(403, 'Only the trip’s owner can remove other people.');
  const { error } = await db.from('trip_members').delete().eq('trip_id', tripId).eq('user_id', targetId);
  fail(error, 'Could not remove member');
}

const PACES = ['relaxed', 'balanced', 'packed'];

export function cleanPreferences(p = {}) {
  const out = {};
  if (Array.isArray(p.interests)) {
    out.interests = [...new Set(p.interests.map((i) => String(i).trim().toLowerCase()).filter(Boolean))].slice(0, 12).map((i) => i.slice(0, 40));
  }
  if (p.budget_per_person_inr != null) {
    const n = Math.round(Number(p.budget_per_person_inr));
    out.budget_per_person_inr = Number.isFinite(n) && n > 0 ? Math.min(n, 100_000_000) : null;
  }
  if (p.pace != null) out.pace = PACES.includes(p.pace) ? p.pace : null;
  if (p.dietary != null) out.dietary = String(p.dietary).trim().slice(0, 120) || null;
  if (p.notes != null) out.notes = String(p.notes).trim().slice(0, 300) || null;
  return out;
}

export async function updatePreferences(userId, tripId, prefs) {
  await groupTripRow(userId, tripId);
  const { data: current, error } = await db.from('trip_members').select('preferences').eq('trip_id', tripId).eq('user_id', userId).maybeSingle();
  fail(error, 'Could not load your preferences');
  if (!current) throw new HttpError(404, 'You’re not a member of this group');
  const merged = { ...(current.preferences || {}), ...cleanPreferences(prefs) };
  const { error: updateError } = await db.from('trip_members').update({ preferences: merged }).eq('trip_id', tripId).eq('user_id', userId);
  fail(updateError, 'Could not save your preferences');
  // Nudge everyone's app to refresh.
  await db.from('trips').update({ updated_at: new Date().toISOString() }).eq('id', tripId);
  return merged;
}

// ----- Polls ---------------------------------------------------------------------

function pollResult(poll, votes) {
  const counts = Object.fromEntries(poll.options.map((o) => [o.id, 0]));
  for (const v of votes) if (v.option_id in counts) counts[v.option_id]++;
  const max = Math.max(0, ...Object.values(counts));
  const leaders = poll.options.filter((o) => counts[o.id] === max && max > 0);
  return {
    counts,
    total_votes: votes.length,
    tie: leaders.length > 1,
    winner_option_id: leaders.length === 1 ? leaders[0].id : null,
    winner_label: leaders.length === 1 ? leaders[0].label : null,
    leaders: leaders.map((o) => o.label),
  };
}

export async function listPolls(tripId) {
  const [{ data: polls, error }, { data: votes, error: vErr }] = await Promise.all([
    db.from('group_polls').select('*').eq('trip_id', tripId).order('created_at', { ascending: false }).limit(20),
    db.from('group_poll_votes').select('poll_id, user_id, option_id').eq('trip_id', tripId),
  ]);
  fail(error || vErr, 'Could not load polls');
  return polls.map((p) => {
    const pv = votes.filter((v) => v.poll_id === p.id);
    return { ...p, votes: pv.map(({ user_id, option_id }) => ({ user_id, option_id })), live: pollResult(p, pv) };
  });
}

export async function createPoll(tripId, createdBy, { question, options, dayNumber = null }) {
  const labels = [...new Set(options.map((o) => String(o).trim()).filter(Boolean))].slice(0, 4);
  if (labels.length < 2) throw new HttpError(400, 'A poll needs at least 2 different options');
  const { count } = await db.from('group_polls').select('id', { count: 'exact', head: true }).eq('trip_id', tripId).eq('status', 'open');
  if ((count ?? 0) >= MAX_OPEN_POLLS) throw new HttpError(409, `There are already ${MAX_OPEN_POLLS} open polls — close one first.`);
  const { data, error } = await db
    .from('group_polls')
    .insert({
      trip_id: tripId,
      question: String(question).trim().slice(0, 200),
      options: labels.map((label, i) => ({ id: `o${i + 1}`, label: label.slice(0, 80) })),
      day_number: dayNumber,
      created_by: createdBy,
    })
    .select('*')
    .single();
  fail(error, 'Could not create the poll');
  return data;
}

/** Records a vote. Returns { poll, allVoted }. */
export async function vote(userId, tripId, pollId, optionId) {
  await groupTripRow(userId, tripId);
  const { data: poll, error } = await db.from('group_polls').select('*').eq('id', pollId).eq('trip_id', tripId).maybeSingle();
  fail(error, 'Could not load the poll');
  if (!poll) throw new HttpError(404, 'Poll not found');
  if (poll.status !== 'open') throw new HttpError(409, 'This poll has closed');
  if (!poll.options.some((o) => o.id === optionId)) throw new HttpError(400, 'Unknown option');

  const { error: voteError } = await db
    .from('group_poll_votes')
    .upsert({ poll_id: pollId, trip_id: tripId, user_id: userId, option_id: optionId, voted_at: new Date().toISOString() }, { onConflict: 'poll_id,user_id' });
  fail(voteError, 'Could not save your vote');

  const [members, { data: votes }] = await Promise.all([listMembers(tripId), db.from('group_poll_votes').select('user_id').eq('poll_id', pollId)]);
  const voted = new Set((votes || []).map((v) => v.user_id));
  return { poll, allVoted: members.every((m) => voted.has(m.user_id)) };
}

/** Closes a poll and stores the result (winner, or a tie). Idempotent. */
export async function closePoll(tripId, pollId) {
  const { data: poll, error } = await db.from('group_polls').select('*').eq('id', pollId).eq('trip_id', tripId).maybeSingle();
  fail(error, 'Could not load the poll');
  if (!poll) throw new HttpError(404, 'Poll not found');
  if (poll.status === 'closed') return poll;
  const { data: votes } = await db.from('group_poll_votes').select('user_id, option_id').eq('poll_id', pollId);
  const result = pollResult(poll, votes || []);
  const { data, error: updateError } = await db
    .from('group_polls')
    .update({ status: 'closed', result, closed_at: new Date().toISOString() })
    .eq('id', pollId)
    .eq('status', 'open')
    .select('*')
    .maybeSingle();
  fail(updateError, 'Could not close the poll');
  return data || { ...poll, status: 'closed', result };
}

// ----- Expenses & balances ---------------------------------------------------------

export async function listExpenses(tripId) {
  const { data, error } = await db.from('group_expenses').select('*').eq('trip_id', tripId).order('created_at', { ascending: false });
  fail(error, 'Could not load expenses');
  return data.map((e) => ({ ...e, amount_inr: Number(e.amount_inr) }));
}

export async function addExpense(tripId, createdBy, { description, amountInr, paidBy, splitAmong = null, category = 'other' }) {
  const members = await listMembers(tripId);
  const ids = new Set(members.map((m) => m.user_id));
  if (!ids.has(paidBy)) throw new HttpError(400, 'The person who paid must be in the group');
  const split = splitAmong?.length ? [...new Set(splitAmong)] : [...ids];
  if (split.some((id) => !ids.has(id))) throw new HttpError(400, 'Everyone sharing the cost must be in the group');
  const amount = Math.round(Number(amountInr) * 100) / 100;
  if (!(amount > 0)) throw new HttpError(400, 'Enter an amount above zero');
  const { data, error } = await db
    .from('group_expenses')
    .insert({ trip_id: tripId, description: String(description).trim().slice(0, 120), amount_inr: amount, paid_by: paidBy, split_among: split, category: String(category || 'other').slice(0, 30), created_by: createdBy })
    .select('*')
    .single();
  fail(error, 'Could not save the expense');
  return { ...data, amount_inr: Number(data.amount_inr) };
}

export async function deleteExpense(userId, tripId, expenseId) {
  await groupTripRow(userId, tripId);
  const { error, count } = await db.from('group_expenses').delete({ count: 'exact' }).eq('id', expenseId).eq('trip_id', tripId);
  fail(error, 'Could not delete the expense');
  if (!count) throw new HttpError(404, 'Expense not found');
}

/**
 * Who paid what, each person's fair share, and the fewest payments that
 * settle everyone up.
 */
export function computeBalances(members, expenses) {
  const name = (id) => members.find((m) => m.user_id === id)?.display_name ?? 'Former member';
  const paid = {};
  const share = {};
  for (const m of members) {
    paid[m.user_id] = 0;
    share[m.user_id] = 0;
  }
  for (const e of expenses) {
    paid[e.paid_by] = (paid[e.paid_by] || 0) + e.amount_inr;
    const each = e.amount_inr / (e.split_among.length || 1);
    for (const id of e.split_among) share[id] = (share[id] || 0) + each;
  }
  const people = Object.keys(paid).map((id) => ({
    user_id: id,
    name: name(id),
    paid_inr: Math.round(paid[id]),
    share_inr: Math.round(share[id] || 0),
    net_inr: Math.round(paid[id] - (share[id] || 0)), // + gets money back, − owes
  }));

  const creditors = people.filter((p) => p.net_inr > 0).map((p) => ({ ...p, left: p.net_inr })).sort((a, b) => b.left - a.left);
  const debtors = people.filter((p) => p.net_inr < 0).map((p) => ({ ...p, left: -p.net_inr })).sort((a, b) => b.left - a.left);
  const settlements = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    if (amount > 0) settlements.push({ from_user_id: debtors[i].user_id, from: debtors[i].name, to_user_id: creditors[j].user_id, to: creditors[j].name, amount_inr: amount });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left <= 0) i++;
    if (creditors[j].left <= 0) j++;
  }
  const total = Math.round(expenses.reduce((s, e) => s + e.amount_inr, 0));
  return { total_spent_inr: total, people, settlements };
}

/** Everything the Group tab shows. */
export async function getGroup(userId, tripId) {
  const row = await groupTripRow(userId, tripId);
  const [members, polls, expenses, budget] = await Promise.all([
    listMembers(tripId),
    listPolls(tripId),
    listExpenses(tripId),
    db.from('trip_budget').select('total_inr').eq('trip_id', tripId).maybeSingle(),
  ]);
  const perPerson = budget.data?.total_inr != null ? Math.round(Number(budget.data.total_inr)) : null;
  return {
    trip_id: tripId,
    join_code: row.join_code,
    owner_id: row.user_id,
    my_user_id: userId,
    members,
    polls,
    expenses,
    balances: computeBalances(members, expenses),
    // The trip budget is a per-traveller estimate.
    estimate: { per_person_inr: perPerson, group_total_inr: perPerson != null ? perPerson * members.length : null, members: members.length },
  };
}
