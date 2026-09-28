// Writes every agent tool call to agent_tool_logs. Callers await this before
// responding, so no tool call is ever silent. If the insert itself fails, the
// full entry goes to the server log instead of being dropped.

import { supabaseAdmin as db } from '../supabase.js';

const MAX_STRING = 2000;
const MAX_ARRAY = 40;
const MAX_JSON_BYTES = 60_000;

/** Keeps logs readable and small: long strings (base64 images!) and huge arrays are truncated. */
export function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, 200)}… [${value.length} chars truncated]` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 8) return '[depth limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items]`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, depth + 1)]));
}

function capSize(value) {
  const json = JSON.stringify(value ?? null);
  if (json.length <= MAX_JSON_BYTES) return value ?? null;
  return { truncated: true, bytes: json.length, preview: json.slice(0, 4000) };
}

let tableMissingWarned = false;

/**
 * @param entry { runId, agentName, tripId, userId, toolName, args, result, isError, durationMs, step }
 */
export async function logToolCall(entry) {
  const row = {
    run_id: entry.runId,
    agent_name: entry.agentName,
    trip_id: entry.tripId || null,
    user_id: entry.userId || null,
    tool_name: entry.toolName,
    arguments: capSize(redact(entry.args ?? {})),
    result: capSize(redact(entry.result)),
    is_error: Boolean(entry.isError),
    duration_ms: entry.durationMs ?? null,
    step: entry.step ?? null,
  };
  try {
    const { error } = await db.from('agent_tool_logs').insert(row);
    if (!error) return;
    if (['42P01', 'PGRST205'].includes(error.code)) {
      if (!tableMissingWarned) {
        tableMissingWarned = true;
        console.error('[agent-log] agent_tool_logs table is missing — run supabase/migrations/006_agentic.sql. Logging to stdout meanwhile.');
      }
    } else {
      console.error('[agent-log] insert failed:', error.message);
    }
  } catch (err) {
    console.error('[agent-log] insert failed:', err.message);
  }
  // Never drop a tool call: fall back to the server log.
  console.log('[agent-log]', JSON.stringify(row));
}
