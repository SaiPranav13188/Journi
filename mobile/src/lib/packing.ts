import AsyncStorage from '@react-native-async-storage/async-storage';

import type { PackingList } from './types';

// Packing lists live on the phone (they're personal and work offline).
export interface PackingState {
  list: PackingList;
  checked: Record<string, boolean>;
  custom: { id: string; name: string }[];
}

const key = (tripId: string) => `journi:packing:${tripId}`;

export async function loadPacking(tripId: string): Promise<PackingState | null> {
  try {
    const raw = await AsyncStorage.getItem(key(tripId));
    return raw ? (JSON.parse(raw) as PackingState) : null;
  } catch {
    return null;
  }
}

export async function savePacking(tripId: string, state: PackingState): Promise<void> {
  await AsyncStorage.setItem(key(tripId), JSON.stringify(state)).catch(() => {});
}
