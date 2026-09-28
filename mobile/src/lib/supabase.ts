import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { authStorage } from './auth-storage';
import './crypto-polyfill';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
// The publishable (anon) key is designed to ship in apps; RLS protects the data.
const supabaseKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    'Supabase env vars missing. Copy mobile/.env.example to mobile/.env and fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
  );
}

export const supabase = createClient(supabaseUrl ?? 'https://placeholder.supabase.co', supabaseKey ?? 'placeholder', {
  auth: {
    storage: authStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// Only refresh tokens while the app is in the foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
