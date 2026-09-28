// Unsaved trip drafts live on-device so a plan in progress (itinerary + chat)
// survives the app being closed before the user taps "Save Trip". Once saved,
// Supabase becomes the source of truth.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TripPlan } from './types';

const KEY = 'journi:draft:v1';

export async function loadDraft(): Promise<TripPlan | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TripPlan) : null;
  } catch {
    return null;
  }
}

export async function saveDraft(plan: TripPlan): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(plan));
  } catch (err) {
    console.warn('Could not store draft', err);
  }
}

export async function clearDraft(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => {});
}
