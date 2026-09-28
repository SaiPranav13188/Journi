import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Service-role client: bypasses RLS, so every query in this backend MUST
// filter by the authenticated user's id explicitly.
export const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
