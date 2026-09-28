import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { SavedPlace } from '@/lib/types';

// One shared list for every screen, so a ❤️ tapped on Explore shows up on Home.
let places: SavedPlace[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function refresh() {
  loading ??= api
    .savedPlaces()
    .then((list) => {
      places = list;
      emit();
    })
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
  return loading;
}

const keyOf = (p: { name: string; country_code?: string | null }) => `${p.name.toLowerCase()}|${(p.country_code || '').toUpperCase()}`;

export function useSavedPlaces() {
  const [, force] = useState(0);

  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    if (places === null) refresh();
    return () => {
      listeners.delete(l);
    };
  }, []);

  const isSaved = useCallback((p: { name: string; country_code?: string | null }) => (places ?? []).some((s) => keyOf(s) === keyOf(p)), []);

  /** Saves the place, or removes it if it's already saved. Returns the new saved state. */
  const toggle = useCallback(async (p: Partial<SavedPlace> & { name: string }) => {
    const existing = (places ?? []).find((s) => keyOf(s) === keyOf(p));
    if (existing) {
      places = (places ?? []).filter((s) => s.id !== existing.id);
      emit();
      try {
        await api.removeSavedPlace(existing.id);
      } catch (err) {
        places = [existing, ...(places ?? [])];
        emit();
        throw err;
      }
      return false;
    }
    const saved = await api.savePlace(p);
    places = [saved, ...(places ?? []).filter((s) => s.id !== saved.id)];
    emit();
    return true;
  }, []);

  return { places: places ?? [], loaded: places !== null, isSaved, toggle, refresh };
}
