import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { GroupDetails } from '@/lib/types';

// Tables whose changes should refresh a group trip on every member's phone.
const WATCHED: { table: string; column: string }[] = [
  { table: 'trips', column: 'id' }, // every plan save bumps trips.updated_at
  { table: 'conversation_messages', column: 'trip_id' },
  { table: 'trip_members', column: 'trip_id' },
  { table: 'group_polls', column: 'trip_id' },
  { table: 'group_poll_votes', column: 'trip_id' },
  { table: 'group_expenses', column: 'trip_id' },
];

/**
 * Group trip data (members, polls, expenses, balances) with live updates:
 * when anyone in the group changes something, this reloads and calls
 * `onRemoteChange` so the screen can refresh the plan and chat too.
 */
export function useGroup(tripId: string | null, enabled: boolean, onRemoteChange: () => void) {
  const [group, setGroup] = useState<GroupDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onRemoteChange);
  useEffect(() => {
    onChangeRef.current = onRemoteChange;
  }, [onRemoteChange]);

  const reload = useCallback(async () => {
    if (!tripId) return;
    try {
      setGroup(await api.groups.get(tripId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [tripId]);

  useEffect(() => {
    if (!enabled || !tripId) return;
    let active = true;
    api.groups
      .get(tripId)
      .then((g) => {
        if (!active) return;
        setGroup(g);
        setError(null);
      })
      .catch((err: Error) => active && setError(err.message));

    // Bursts of changes (a plan save touches several tables) → one refresh.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        reload();
        onChangeRef.current();
      }, 700);
    };

    let channel = supabase.channel(`group-trip-${tripId}`);
    for (const w of WATCHED) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: w.table, filter: `${w.column}=eq.${tripId}` }, changed);
    }
    channel.subscribe();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [enabled, tripId, reload]);

  return { group, error, reload, setGroup };
}
