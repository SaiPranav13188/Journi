import type { User } from '@supabase/supabase-js';

// Profile preferences live in Supabase Auth user metadata — no extra table.

/** City the traveller usually flies from (pre-fills "Flying from"). */
export function homeCity(user: User | null): string {
  return (user?.user_metadata?.home_city as string | undefined)?.trim() || '';
}

/** Whether weather-alert notifications are shown in the app (default on). */
export function weatherAlertsEnabled(user: User | null): boolean {
  return user?.user_metadata?.weather_alerts !== false;
}

/**
 * Agentic AI (v2) feature flag: chat, planning, ticket reading and price checks
 * go through the backend's /v2 agent routes instead of the v1 single-call ones.
 * Per user (profile toggle); EXPO_PUBLIC_AGENTIC_AI=true turns it on by default.
 */
export function agenticAiEnabled(user: User | null): boolean {
  const pref = user?.user_metadata?.agentic_ai;
  if (typeof pref === 'boolean') return pref;
  return process.env.EXPO_PUBLIC_AGENTIC_AI === 'true';
}
