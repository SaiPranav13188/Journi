import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { clearDraft, loadDraft, saveDraft } from '@/lib/draft';
import type { BudgetConcern, ChatMessage, ItineraryDay, PlaceSuggestion, ReworkTarget, TimeOfDay, TripPlan, TripStatus } from '@/lib/types';

// A cheap fingerprint of a day's AI-generated content, to highlight days that
// changed after a refinement.
function dayFingerprint(d: ItineraryDay) {
  return JSON.stringify([d.date, d.theme, d.activities.map((a) => a.title), d.meal_suggestion?.dish]);
}

/** Trip total (INR) before and after an edit, for "Budget +₹800 → ₹23,350" messages. */
export interface BudgetChange {
  before: number;
  after: number;
}

export function useTripEditor(routeId: string) {
  const isDraftRoute = routeId === 'draft';
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatedDays, setUpdatedDays] = useState<Set<number>>(new Set());
  const planRef = useRef<TripPlan | null>(null);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  const isSaved = Boolean(plan?.trip.id);
  const isFinalized = plan?.trip.status === 'finalized';

  const fetchPlan = useCallback(async () => {
    const next = isDraftRoute ? await loadDraft() : await api.getTrip(routeId);
    if (!next) throw new Error('This plan is no longer available.');
    return next;
  }, [isDraftRoute, routeId]);

  useEffect(() => {
    let active = true;
    fetchPlan()
      .then((next) => active && setPlan(next))
      .catch((err: Error) => active && setError(err.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [fetchPlan]);

  // Group trips: pull the latest plan when another member changes it (no spinner,
  // and never while this device is waiting on its own AI reply).
  const sendingRef = useRef(false);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);
  const refresh = useCallback(async () => {
    if (isDraftRoute || sendingRef.current) return;
    try {
      const next = await api.getTrip(routeId);
      if (!sendingRef.current) {
        planRef.current = next;
        setPlan(next);
      }
    } catch {
      // Keep showing what we have; the next change will try again.
    }
  }, [isDraftRoute, routeId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await fetchPlan());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchPlan]);

  // Persist drafts on every change so nothing is lost if the app closes.
  const commit = useCallback((next: TripPlan) => {
    // Update the ref immediately so queued actions build on the latest plan.
    planRef.current = next;
    setPlan(next);
    if (!next.trip.id) saveDraft(next);
  }, []);

  const sendMessage = useCallback(
    async (
      text: string,
      retryOf?: ChatMessage,
      focusDay?: number | null,
      image?: { base64: string; mimeType: string } | null,
    ): Promise<{ reply: string; changedDays: Set<number>; suggestions: boolean; budget: BudgetChange; concern: BudgetConcern | null } | null> => {
      const current = planRef.current;
      if (!current || sending) return null;

      const baseMessages = current.messages.filter((m) => m !== retryOf && !m.failed);
      const optimistic: ChatMessage = { role: 'user', content: text, created_at: new Date().toISOString(), pending: true };
      setPlan({ ...current, messages: [...baseMessages, optimistic] });
      setSending(true);

      try {
        // Group trips are always planned by the Group agent (no v1 path).
        const res =
          current.trip.is_group && current.trip.id
            ? await api.groups.chat(current.trip.id, focusDay ? `(About Day ${focusDay}) ${text}` : text)
            : await api.refineItinerary({
                tripId: current.trip.id,
                message: text,
                state: { trip: current.trip, days: current.days, budget: current.budget },
                history: baseMessages,
                focusDay,
                image,
              });

        // The agentic backend reports which days it changed; v1 is diffed here.
        const before = new Map(current.days.map((d) => [d.day_number, dayFingerprint(d)]));
        const changed = res.updated_days
          ? new Set(res.updated_days)
          : new Set(res.days.filter((d) => before.get(d.day_number) !== dayFingerprint(d)).map((d) => d.day_number));

        const next: TripPlan = {
          trip: { ...res.trip, id: current.trip.id, status: current.trip.status },
          days: res.days,
          budget: res.budget,
          messages: [...baseMessages, ...res.messages],
        };
        commit(next);
        setUpdatedDays(changed);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        return {
          reply: res.reply,
          changedDays: changed,
          suggestions: Boolean(res.messages.at(-1)?.metadata),
          budget: { before: current.budget?.total_inr ?? 0, after: res.budget?.total_inr ?? 0 },
          concern: res.budget_concern ?? null,
        };
      } catch (err) {
        setPlan((p) =>
          p ? { ...p, messages: p.messages.map((m) => (m === optimistic ? { ...m, pending: false, failed: true } : m)) } : p,
        );
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        throw err;
      } finally {
        setSending(false);
      }
    },
    [commit, sending],
  );

  /** Save: creates the trip in Supabase (drafts) or saves the current state (saved trips). */
  const save = useCallback(async (): Promise<TripPlan | null> => {
    const current = planRef.current;
    if (!current) return null;
    setSaving(true);
    try {
      const saved = current.trip.id
        ? await api.updateTrip(current.trip.id, current)
        : await api.createTrip({ ...current, messages: current.messages.filter((m) => !m.failed && !m.pending) });
      if (!current.trip.id) await clearDraft();
      setPlan(saved);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return saved;
    } finally {
      setSaving(false);
    }
  }, []);

  const setStatus = useCallback(
    async (status: TripStatus) => {
      let current = planRef.current;
      if (!current) return null;
      setSaving(true);
      try {
        if (!current.trip.id) {
          current = await save();
          if (!current?.trip.id) return null;
        }
        const next = await api.setTripStatus(current.trip.id!, status);
        setPlan(next);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        return next;
      } finally {
        setSaving(false);
      }
    },
    [save],
  );

  // Ids (suggestion or activity) with an edit in progress, for spinners.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const editQueue = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Runs day edits (add / remove / fill) one after another, each on top of the
   * previous result, so several quick taps are all kept.
   */
  const enqueueDayEdit = useCallback(
    (
      busyId: string,
      dayNumber: number,
      call: (current: TripPlan) => Promise<{ days: ItineraryDay[]; budget: TripPlan['budget'] }>,
    ): Promise<BudgetChange | undefined> => {
      setBusyIds((prev) => new Set(prev).add(busyId));
      const run = editQueue.current.then(async () => {
        try {
          const current = planRef.current;
          if (!current) return;
          const res = await call(current);
          commit({ ...current, days: res.days, budget: res.budget });
          setUpdatedDays(new Set([dayNumber]));
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          return { before: current.budget?.total_inr ?? 0, after: res.budget?.total_inr ?? 0 };
        } finally {
          setBusyIds((prev) => {
            const next = new Set(prev);
            next.delete(busyId);
            return next;
          });
        }
      });
      editQueue.current = run.catch(() => {});
      return run;
    },
    [commit],
  );

  const stateOf = (p: TripPlan) => ({ trip: p.trip, days: p.days, budget: p.budget });

  /** Adds a place from a chat suggestion card to a day and time slot. */
  const addSuggestion = useCallback(
    (dayNumber: number, suggestion: PlaceSuggestion, timeOfDay: TimeOfDay) =>
      enqueueDayEdit(suggestion.id, dayNumber, (p) =>
        api.addActivity({ tripId: p.trip.id, dayNumber, suggestion, timeOfDay, state: stateOf(p) }),
      ),
    [enqueueDayEdit],
  );

  /** Removes a place, leaving an empty slot (or deletes an empty slot). */
  const removeActivity = useCallback(
    (dayNumber: number, activityId: string) =>
      enqueueDayEdit(activityId, dayNumber, (p) => api.removeActivity({ tripId: p.trip.id, dayNumber, activityId, state: stateOf(p) })),
    [enqueueDayEdit],
  );

  /** Fills an empty slot with a place the user typed (looked up by the backend). */
  const fillSlot = useCallback(
    (dayNumber: number, activityId: string, query: string) =>
      enqueueDayEdit(activityId, dayNumber, (p) => api.fillSlot({ tripId: p.trip.id, dayNumber, activityId, query, state: stateOf(p) })),
    [enqueueDayEdit],
  );

  /** Marks a place as confirmed (booked) or back to planned. */
  const setActivityStatus = useCallback(
    (dayNumber: number, activityId: string, status: 'planned' | 'confirmed') =>
      enqueueDayEdit(activityId, dayNumber, (p) =>
        api.setActivityStatus({ tripId: p.trip.id, dayNumber, activityId, status, state: stateOf(p) }),
      ),
    [enqueueDayEdit],
  );

  /** Proposes reworked days (rain swap / flight-aware) — nothing changes until applied. */
  const previewRework = useCallback(async (targets: ReworkTarget[]) => {
    const current = planRef.current;
    if (!current) throw new Error('Trip not loaded');
    return api.reworkPreview({ tripId: current.trip.id, targets, state: stateOf(current) });
  }, []);

  /** Applies previewed days ("Swap plan"). */
  const applyDays = useCallback(
    (days: ItineraryDay[]) =>
      enqueueDayEdit('apply-days', days[0]?.day_number ?? 0, (p) => api.applyDays({ tripId: p.trip.id, days, state: stateOf(p) })),
    [enqueueDayEdit],
  );

  /** Flight cost typed in by the traveller; goes straight into the budget. */
  const setFlightCost = useCallback(
    (amountInr: number | null) =>
      enqueueDayEdit('flight-cost', 0, (p) => api.setFlightCost({ tripId: p.trip.id, amountInr, state: stateOf(p) })),
    [enqueueDayEdit],
  );

  /** Sets (or clears) the traveller's own spending limit — saved trips only. */
  const setBudgetLimit = useCallback(
    async (limit: number | null) => {
      const current = planRef.current;
      if (!current?.trip.id) throw new Error('Save your trip first to set a budget limit.');
      const next = await api.setBudgetLimit(current.trip.id, limit);
      commit({ ...current, trip: { ...current.trip, budget_limit_inr: next.trip.budget_limit_inr ?? null } });
    },
    [commit],
  );

  /** Fetches map coordinates for places that don't have them yet. */
  const [locating, setLocating] = useState(false);
  const locatePlaces = useCallback(async () => {
    const current = planRef.current;
    if (!current) return;
    setLocating(true);
    try {
      const res = await api.geocode({ tripId: current.trip.id, state: stateOf(current) });
      const latest = planRef.current ?? current;
      // Merge coordinates by activity id so edits made meanwhile are kept.
      const coords = new Map(res.days.flatMap((d) => d.activities.filter((a) => a.lat != null).map((a) => [a.id, { lat: a.lat, lng: a.lng }] as const)));
      commit({
        ...latest,
        days: latest.days.map((d) => ({
          ...d,
          activities: d.activities.map((a) => (a.lat == null && coords.has(a.id) ? { ...a, ...coords.get(a.id) } : a)),
        })),
      });
    } finally {
      setLocating(false);
    }
  }, [commit]);

  const updateAccommodation = useCallback(
    async (dayNumber: number, note: string | null) => {
      const current = planRef.current;
      if (!current) return;
      const next = {
        ...current,
        days: current.days.map((d) => (d.day_number === dayNumber ? { ...d, accommodation_note: note } : d)),
      };
      commit(next);
      if (current.trip.id) await api.updateAccommodation(current.trip.id, dayNumber, note);
    },
    [commit],
  );

  return {
    plan,
    loading,
    error,
    reload,
    refresh,
    sending,
    saving,
    isSaved,
    isFinalized,
    updatedDays,
    sendMessage,
    save,
    finalize: () => setStatus('finalized'),
    reopen: () => setStatus('planning'),
    updateAccommodation,
    addSuggestion,
    removeActivity,
    fillSlot,
    busyIds,
    setActivityStatus,
    setBudgetLimit,
    setFlightCost,
    previewRework,
    applyDays,
    locatePlaces,
    locating,
  };
}
