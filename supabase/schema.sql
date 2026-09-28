-- Journi — Supabase schema (initial version)
-- Run this whole file in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Users are handled by Supabase Auth (Google + email/password) — see README.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.trips (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  destination_name      text not null,
  destination_place_id  text,
  country               text,
  country_code          text,          -- ISO 3166-1 alpha-2 (used for currency lookup)
  latitude              double precision not null,
  longitude             double precision not null,
  cover_image_url       text,          -- thumbnail for the trips list
  origin_city           text,          -- where the traveller flies from (for flight estimates)
  start_date            date not null,
  end_date              date not null,
  status                text not null default 'planning' check (status in ('planning', 'finalized')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint trips_dates_valid check (end_date >= start_date)
);
create index if not exists trips_user_id_idx on public.trips (user_id, start_date desc);

create table if not exists public.itinerary_days (
  id                  uuid primary key default gen_random_uuid(),
  trip_id             uuid not null references public.trips (id) on delete cascade,
  day_number          int  not null check (day_number >= 1),
  date                date not null,
  theme               text not null,
  -- [{ id, time_of_day, title, description, place_name, estimated_cost_inr,
  --    duration_hours, indoor, category }]
  activities          jsonb not null default '[]'::jsonb,
  -- { dish, where, description, estimated_cost_inr }
  meal_suggestion     jsonb,
  accommodation_note  text,            -- optional, user-entered
  weather_summary     jsonb,
  weather_warning     text,
  unique (trip_id, day_number)
);

create table if not exists public.trip_budget (
  id                       uuid primary key default gen_random_uuid(),
  trip_id                  uuid not null unique references public.trips (id) on delete cascade,
  flights_estimate         numeric(12, 2) not null default 0,  -- INR, return (up + down) flights
  flight_note              text,                               -- e.g. "Hyderabad ⇄ Hanoi (HAN), 1 stop"
  accommodation_estimate   numeric(12, 2) not null default 0,  -- INR
  food_estimate            numeric(12, 2) not null default 0,  -- INR
  transport_estimate       numeric(12, 2) not null default 0,  -- INR
  activities_estimate      numeric(12, 2) not null default 0,  -- INR
  total_inr                numeric(12, 2) not null default 0,
  total_local_currency     numeric(14, 2),
  local_currency_code      text not null default 'INR',
  exchange_rate_used       numeric(18, 8),                     -- local units per 1 INR
  exchange_rate_timestamp  timestamptz
);

create table if not exists public.conversation_messages (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  -- Rich content, e.g. { type: 'suggestions', day_number, category, items: [...] }
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists conversation_messages_trip_idx on public.conversation_messages (trip_id, created_at);

-- In-app notifications, e.g. a new weather warning found by the daily refresh job.
create table if not exists public.trip_alerts (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  day_number  int,
  kind        text not null default 'weather_warning',
  message     text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists trip_alerts_user_idx on public.trip_alerts (user_id, read, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at before update on public.trips
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security: each user can only read/write their own data
-- ---------------------------------------------------------------------------

alter table public.trips                 enable row level security;
alter table public.itinerary_days        enable row level security;
alter table public.trip_budget           enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.trip_alerts           enable row level security;

drop policy if exists "own trips" on public.trips;
create policy "own trips" on public.trips
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own itinerary days" on public.itinerary_days;
create policy "own itinerary days" on public.itinerary_days
  for all to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())));

drop policy if exists "own budgets" on public.trip_budget;
create policy "own budgets" on public.trip_budget
  for all to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())));

drop policy if exists "own messages" on public.conversation_messages;
create policy "own messages" on public.conversation_messages
  for all to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.trips t where t.id = trip_id and t.user_id = (select auth.uid())));

drop policy if exists "own alerts" on public.trip_alerts;
create policy "own alerts" on public.trip_alerts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on
  public.trips, public.itinerary_days, public.trip_budget, public.conversation_messages, public.trip_alerts
  to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic save used by the backend (service role only).
-- Creates or updates a trip, replaces its itinerary days, upserts its budget
-- and appends new conversation messages — all in one transaction.
-- ---------------------------------------------------------------------------

create or replace function public.save_trip_plan(
  p_user_id  uuid,
  p_trip_id  uuid,      -- null to create a new trip
  p_trip     jsonb,
  p_days     jsonb,
  p_budget   jsonb,
  p_messages jsonb      -- messages to append: [{ role, content, created_at }]
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_trip_id uuid := p_trip_id;
begin
  if v_trip_id is null then
    insert into trips (user_id, destination_name, destination_place_id, country, country_code,
                       latitude, longitude, cover_image_url, origin_city, start_date, end_date, status)
    values (p_user_id, p_trip->>'destination_name', p_trip->>'destination_place_id', p_trip->>'country',
            p_trip->>'country_code', (p_trip->>'latitude')::float8, (p_trip->>'longitude')::float8,
            p_trip->>'cover_image_url', p_trip->>'origin_city', (p_trip->>'start_date')::date, (p_trip->>'end_date')::date,
            coalesce(p_trip->>'status', 'planning'))
    returning id into v_trip_id;
  else
    update trips set
      destination_name     = p_trip->>'destination_name',
      destination_place_id = p_trip->>'destination_place_id',
      country              = p_trip->>'country',
      country_code         = p_trip->>'country_code',
      latitude             = (p_trip->>'latitude')::float8,
      longitude            = (p_trip->>'longitude')::float8,
      cover_image_url      = coalesce(p_trip->>'cover_image_url', cover_image_url),
      origin_city          = coalesce(p_trip->>'origin_city', origin_city),
      start_date           = (p_trip->>'start_date')::date,
      end_date             = (p_trip->>'end_date')::date,
      status               = coalesce(p_trip->>'status', status)
    where id = v_trip_id and user_id = p_user_id;
    if not found then
      raise exception 'trip not found' using errcode = 'P0002';
    end if;
  end if;

  if p_days is not null then
    delete from itinerary_days where trip_id = v_trip_id;
    insert into itinerary_days (trip_id, day_number, date, theme, activities, meal_suggestion,
                                accommodation_note, weather_summary, weather_warning)
    select v_trip_id, (d->>'day_number')::int, (d->>'date')::date, d->>'theme',
           coalesce(d->'activities', '[]'::jsonb), d->'meal_suggestion',
           nullif(d->>'accommodation_note', ''), d->'weather_summary', d->>'weather_warning'
    from jsonb_array_elements(p_days) as d;
  end if;

  if p_budget is not null then
    insert into trip_budget (trip_id, flights_estimate, flight_note, accommodation_estimate, food_estimate,
                             transport_estimate, activities_estimate, total_inr, total_local_currency,
                             local_currency_code, exchange_rate_used, exchange_rate_timestamp)
    values (v_trip_id, coalesce((p_budget->>'flights_estimate')::numeric, 0), p_budget->>'flight_note',
            (p_budget->>'accommodation_estimate')::numeric, (p_budget->>'food_estimate')::numeric,
            (p_budget->>'transport_estimate')::numeric, (p_budget->>'activities_estimate')::numeric,
            (p_budget->>'total_inr')::numeric, (p_budget->>'total_local_currency')::numeric,
            coalesce(p_budget->>'local_currency_code', 'INR'), (p_budget->>'exchange_rate_used')::numeric,
            (p_budget->>'exchange_rate_timestamp')::timestamptz)
    on conflict (trip_id) do update set
      flights_estimate        = excluded.flights_estimate,
      flight_note             = excluded.flight_note,
      accommodation_estimate  = excluded.accommodation_estimate,
      food_estimate           = excluded.food_estimate,
      transport_estimate      = excluded.transport_estimate,
      activities_estimate     = excluded.activities_estimate,
      total_inr               = excluded.total_inr,
      total_local_currency    = excluded.total_local_currency,
      local_currency_code     = excluded.local_currency_code,
      exchange_rate_used      = excluded.exchange_rate_used,
      exchange_rate_timestamp = excluded.exchange_rate_timestamp;
  end if;

  if p_messages is not null then
    insert into conversation_messages (trip_id, role, content, metadata, created_at)
    select v_trip_id, m->>'role', m->>'content', nullif(m->'metadata', 'null'::jsonb),
           coalesce((m->>'created_at')::timestamptz, now())
    from jsonb_array_elements(p_messages) as m;
  end if;

  -- Touch updated_at even when only child rows changed.
  update trips set updated_at = now() where id = v_trip_id;

  return v_trip_id;
end $$;

-- Only the backend (service role) may call this — it trusts p_user_id.
revoke all on function public.save_trip_plan(uuid, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_trip_plan(uuid, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Dashboard features (same as migrations/004_dashboard.sql)
-- ---------------------------------------------------------------------------
-- Your own spending limit for a trip (shown against the estimate).
alter table public.trips add column if not exists budget_limit_inr numeric(12, 2);

-- Bucket list: destinations the user has saved (hearted).
create table if not exists public.saved_places (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  place_id      text,
  name          text not null,
  country       text,
  country_code  text,
  latitude      double precision,
  longitude     double precision,
  image_url     text,
  note          text,
  created_at    timestamptz not null default now()
);
create unique index if not exists saved_places_user_place_idx on public.saved_places (user_id, lower(name), coalesce(country_code, ''));

-- Bookings the user records for a trip (flights, hotels, trains, activities…).
create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  trip_id            uuid not null references public.trips (id) on delete cascade,
  type               text not null default 'other'
                       check (type in ('flight', 'hotel', 'train', 'bus', 'activity', 'car', 'other')),
  title              text not null,
  provider           text,
  confirmation_code  text,
  start_at           timestamptz,
  end_at             timestamptz,
  location           text,
  cost_inr           numeric(12, 2) not null default 0,
  status             text not null default 'confirmed' check (status in ('confirmed', 'pending', 'cancelled')),
  notes              text,
  created_at         timestamptz not null default now()
);
create index if not exists bookings_user_trip_idx on public.bookings (user_id, trip_id, start_at);

alter table public.saved_places enable row level security;
alter table public.bookings     enable row level security;

drop policy if exists "own saved places" on public.saved_places;
create policy "own saved places" on public.saved_places
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own bookings" on public.bookings;
create policy "own bookings" on public.bookings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.saved_places, public.bookings to authenticated;

alter table public.bookings add column if not exists ticket_path text;   -- path in the private "tickets" storage bucket
alter table public.bookings add column if not exists ticket_name text;   -- original file name

-- Private bucket for ticket files. Only the backend (service role) reads/writes it;
-- the app gets short-lived signed links to view a ticket.
insert into storage.buckets (id, name, public, file_size_limit)
values ('tickets', 'tickets', false, 15728640)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Agentic AI (same as migrations/006_agentic.sql)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Group trips (same as migrations/007_groups.sql)
-- ---------------------------------------------------------------------------
alter table public.trips add column if not exists is_group  boolean not null default false;
alter table public.trips add column if not exists join_code text;
create unique index if not exists trips_join_code_idx on public.trips (join_code) where join_code is not null;

-- Everyone on a group trip. The trip's user_id stays the owner.
create table if not exists public.trip_members (
  trip_id       uuid not null references public.trips (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'member')),
  display_name  text not null,
  -- { interests: text[], budget_per_person_inr: number, pace: 'relaxed'|'balanced'|'packed', dietary: text, notes: text }
  preferences   jsonb not null default '{}'::jsonb,
  joined_at     timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index if not exists trip_members_user_idx on public.trip_members (user_id);

-- Chat messages in a group show who wrote them.
alter table public.conversation_messages add column if not exists user_id     uuid references auth.users (id) on delete set null;
alter table public.conversation_messages add column if not exists author_name text;

-- Polls the group agent creates when members disagree.
create table if not exists public.group_polls (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  question    text not null,
  options     jsonb not null,               -- [{ id, label }]
  day_number  int,
  status      text not null default 'open' check (status in ('open', 'closed')),
  result      jsonb,                        -- { winner_option_id, winner_label, counts, tie }
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index if not exists group_polls_trip_idx on public.group_polls (trip_id, created_at desc);

create table if not exists public.group_poll_votes (
  poll_id    uuid not null references public.group_polls (id) on delete cascade,
  trip_id    uuid not null references public.trips (id) on delete cascade,   -- for live-update filters
  user_id    uuid not null references auth.users (id) on delete cascade,
  option_id  text not null,
  voted_at   timestamptz not null default now(),
  primary key (poll_id, user_id)
);

-- Shared spending (who paid what, split among whom) — Splitwise-style.
create table if not exists public.group_expenses (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  description  text not null,
  amount_inr   numeric(12, 2) not null check (amount_inr > 0),
  paid_by      uuid not null references auth.users (id) on delete cascade,
  split_among  uuid[] not null,              -- members sharing this cost (equal split)
  category     text not null default 'other',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists group_expenses_trip_idx on public.group_expenses (trip_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security: members can READ a group trip (needed for live updates);
-- all writes go through the backend (service role).
-- ---------------------------------------------------------------------------

-- security definer so policies can check membership without recursing into RLS.
create or replace function public.is_trip_member(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from trips t where t.id = p_trip_id and t.user_id = auth.uid())
      or exists (select 1 from trip_members m where m.trip_id = p_trip_id and m.user_id = auth.uid());
$$;
grant execute on function public.is_trip_member(uuid) to authenticated;

alter table public.trip_members     enable row level security;
alter table public.group_polls      enable row level security;
alter table public.group_poll_votes enable row level security;
alter table public.group_expenses   enable row level security;

drop policy if exists "members read trips" on public.trips;
create policy "members read trips" on public.trips
  for select to authenticated using (public.is_trip_member(id));

drop policy if exists "members read days" on public.itinerary_days;
create policy "members read days" on public.itinerary_days
  for select to authenticated using (public.is_trip_member(trip_id));

drop policy if exists "members read budget" on public.trip_budget;
create policy "members read budget" on public.trip_budget
  for select to authenticated using (public.is_trip_member(trip_id));

drop policy if exists "members read messages" on public.conversation_messages;
create policy "members read messages" on public.conversation_messages
  for select to authenticated using (public.is_trip_member(trip_id));

drop policy if exists "members read members" on public.trip_members;
create policy "members read members" on public.trip_members
  for select to authenticated using (public.is_trip_member(trip_id));

drop policy if exists "members read polls" on public.group_polls;
create policy "members read polls" on public.group_polls
  for select to authenticated using (public.is_trip_member(trip_id));

drop policy if exists "members read votes" on public.group_poll_votes;
create policy "members read votes" on public.group_poll_votes
  for select to authenticated using (public.is_trip_member(trip_id));

drop policy if exists "members read expenses" on public.group_expenses;
create policy "members read expenses" on public.group_expenses
  for select to authenticated using (public.is_trip_member(trip_id));

grant select on public.trip_members, public.group_polls, public.group_poll_votes, public.group_expenses to authenticated;

-- ---------------------------------------------------------------------------
-- Chat messages keep their author (save_trip_plan now stores user_id / author_name)
-- ---------------------------------------------------------------------------
create or replace function public.save_trip_plan(
  p_user_id  uuid,
  p_trip_id  uuid,      -- null to create a new trip
  p_trip     jsonb,
  p_days     jsonb,
  p_budget   jsonb,
  p_messages jsonb      -- messages to append: [{ role, content, created_at, metadata, user_id, author_name }]
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_trip_id uuid := p_trip_id;
begin
  if v_trip_id is null then
    insert into trips (user_id, destination_name, destination_place_id, country, country_code,
                       latitude, longitude, cover_image_url, origin_city, start_date, end_date, status)
    values (p_user_id, p_trip->>'destination_name', p_trip->>'destination_place_id', p_trip->>'country',
            p_trip->>'country_code', (p_trip->>'latitude')::float8, (p_trip->>'longitude')::float8,
            p_trip->>'cover_image_url', p_trip->>'origin_city', (p_trip->>'start_date')::date, (p_trip->>'end_date')::date,
            coalesce(p_trip->>'status', 'planning'))
    returning id into v_trip_id;
  else
    update trips set
      destination_name     = p_trip->>'destination_name',
      destination_place_id = p_trip->>'destination_place_id',
      country              = p_trip->>'country',
      country_code         = p_trip->>'country_code',
      latitude             = (p_trip->>'latitude')::float8,
      longitude            = (p_trip->>'longitude')::float8,
      cover_image_url      = coalesce(p_trip->>'cover_image_url', cover_image_url),
      origin_city          = coalesce(p_trip->>'origin_city', origin_city),
      start_date           = (p_trip->>'start_date')::date,
      end_date             = (p_trip->>'end_date')::date,
      status               = coalesce(p_trip->>'status', status)
    where id = v_trip_id and user_id = p_user_id;
    if not found then
      raise exception 'trip not found' using errcode = 'P0002';
    end if;
  end if;

  if p_days is not null then
    delete from itinerary_days where trip_id = v_trip_id;
    insert into itinerary_days (trip_id, day_number, date, theme, activities, meal_suggestion,
                                accommodation_note, weather_summary, weather_warning)
    select v_trip_id, (d->>'day_number')::int, (d->>'date')::date, d->>'theme',
           coalesce(d->'activities', '[]'::jsonb), d->'meal_suggestion',
           nullif(d->>'accommodation_note', ''), d->'weather_summary', d->>'weather_warning'
    from jsonb_array_elements(p_days) as d;
  end if;

  if p_budget is not null then
    insert into trip_budget (trip_id, flights_estimate, flight_note, accommodation_estimate, food_estimate,
                             transport_estimate, activities_estimate, total_inr, total_local_currency,
                             local_currency_code, exchange_rate_used, exchange_rate_timestamp)
    values (v_trip_id, coalesce((p_budget->>'flights_estimate')::numeric, 0), p_budget->>'flight_note',
            (p_budget->>'accommodation_estimate')::numeric, (p_budget->>'food_estimate')::numeric,
            (p_budget->>'transport_estimate')::numeric, (p_budget->>'activities_estimate')::numeric,
            (p_budget->>'total_inr')::numeric, (p_budget->>'total_local_currency')::numeric,
            coalesce(p_budget->>'local_currency_code', 'INR'), (p_budget->>'exchange_rate_used')::numeric,
            (p_budget->>'exchange_rate_timestamp')::timestamptz)
    on conflict (trip_id) do update set
      flights_estimate        = excluded.flights_estimate,
      flight_note             = excluded.flight_note,
      accommodation_estimate  = excluded.accommodation_estimate,
      food_estimate           = excluded.food_estimate,
      transport_estimate      = excluded.transport_estimate,
      activities_estimate     = excluded.activities_estimate,
      total_inr               = excluded.total_inr,
      total_local_currency    = excluded.total_local_currency,
      local_currency_code     = excluded.local_currency_code,
      exchange_rate_used      = excluded.exchange_rate_used,
      exchange_rate_timestamp = excluded.exchange_rate_timestamp;
  end if;

  if p_messages is not null then
    insert into conversation_messages (trip_id, role, content, metadata, created_at, user_id, author_name)
    select v_trip_id, m->>'role', m->>'content', nullif(m->'metadata', 'null'::jsonb),
           coalesce((m->>'created_at')::timestamptz, now()),
           nullif(m->>'user_id', '')::uuid, nullif(m->>'author_name', '')
    from jsonb_array_elements(p_messages) as m;
  end if;

  -- Touch updated_at even when only child rows changed (group members' apps listen for this).
  update trips set updated_at = now() where id = v_trip_id;

  return v_trip_id;
end $$;

revoke all on function public.save_trip_plan(uuid, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_trip_plan(uuid, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Live updates (Supabase Realtime) for group trips
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['trips', 'conversation_messages', 'trip_members', 'group_polls', 'group_poll_votes', 'group_expenses'] loop
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
