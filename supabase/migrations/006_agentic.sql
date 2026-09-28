-- Journi migration 006 — Agentic AI (v2): tool-call logs + alert metadata.
-- Run once in Supabase → SQL Editor → New query → paste everything → Run.
-- Safe to run more than once.

-- Every tool call made by any agent (planner, budget, ticket, price_check,
-- weather_watcher, orchestrator), written by the backend before it responds.
create table if not exists public.agent_tool_logs (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid,                      -- groups the calls of one agent run
  agent_name   text not null,
  trip_id      uuid references public.trips (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete cascade,
  tool_name    text not null,
  arguments    jsonb not null default '{}'::jsonb,
  result       jsonb,
  is_error     boolean not null default false,
  duration_ms  int,
  step         int,                       -- model step the call was made in
  created_at   timestamptz not null default now()
);
create index if not exists agent_tool_logs_trip_idx on public.agent_tool_logs (trip_id, created_at desc);
create index if not exists agent_tool_logs_user_idx on public.agent_tool_logs (user_id, created_at desc);
create index if not exists agent_tool_logs_agent_idx on public.agent_tool_logs (agent_name, created_at desc);
create index if not exists agent_tool_logs_run_idx on public.agent_tool_logs (run_id);

alter table public.agent_tool_logs enable row level security;

-- Read-only for travellers: logs tied to their own trips (joined through
-- trips.user_id), or their own trip-less runs (e.g. a new-trip plan). Only the
-- backend (service role, which bypasses RLS) writes.
drop policy if exists "own agent logs" on public.agent_tool_logs;
create policy "own agent logs" on public.agent_tool_logs
  for select to authenticated
  using (
    (trip_id is not null and exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())))
    or (trip_id is null and user_id = (select auth.uid()))
  );
grant select on public.agent_tool_logs to authenticated;

-- Alerts can carry data: the Weather Watcher attaches a rework preview
-- ({ preview: { reply, days }, reason, severity }) that the traveller can
-- Swap in or Keep; the Budget agent attaches its totals.
alter table public.trip_alerts add column if not exists metadata jsonb;
