import type { Session, User } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { supabase } from '@/lib/supabase';

WebBrowser.maybeCompleteAuthSession();

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  initializing: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  /** Resolves to true when the user must confirm their email before signing in. */
  signUpWithEmail: (name: string, email: string, password: string) => Promise<boolean>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Reads tokens/code from the OAuth redirect URL (query or hash fragment).
function paramsFromUrl(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const hashStart = url.indexOf('#');
  const beforeHash = hashStart >= 0 ? url.slice(0, hashStart) : url;
  const queryStart = beforeHash.indexOf('?');
  const query = queryStart >= 0 ? beforeHash.slice(queryStart + 1) : '';
  const hash = hashStart >= 0 ? url.slice(hashStart + 1) : '';
  for (const part of [query, hash]) {
    new URLSearchParams(part).forEach((value, key) => {
      params[key] = value;
    });
  }
  return params;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitializing(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    initializing,

    async signInWithEmail(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    },

    async signUpWithEmail(name, email, password) {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: name.trim() } },
      });
      if (error) throw error;
      return !data.session;
    },

    async signInWithGoogle() {
      const redirectTo = makeRedirectUri({ scheme: 'journi', path: 'auth/callback' });
      // This exact URL must be listed in Supabase → Authentication → URL Configuration → Redirect URLs.
      if (__DEV__) console.log('[auth] Google redirect URL:', redirectTo);
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
      });
      if (error) throw error;

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success') return; // user cancelled

      const params = paramsFromUrl(result.url);
      if (params.error_description || params.error) {
        throw new Error(params.error_description || params.error);
      }
      if (params.code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(params.code);
        if (exchangeError) throw exchangeError;
      } else if (params.access_token && params.refresh_token) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: params.access_token,
          refresh_token: params.refresh_token,
        });
        if (sessionError) throw sessionError;
      } else {
        throw new Error('Google sign-in did not return a session. Please try again.');
      }
    },

    async signOut() {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function displayName(user: User | null): string {
  const meta = user?.user_metadata ?? {};
  const full: string | undefined = meta.full_name || meta.name;
  if (full) return full.split(' ')[0];
  return user?.email?.split('@')[0] ?? 'traveller';
}
