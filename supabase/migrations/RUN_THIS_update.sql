-- Journi — ALL database updates in one file (002 flights, 003 chat suggestions,
-- 004 dashboard, 005 booking tickets). Run it in Supabase → SQL Editor → New query
-- → paste everything → Run. Safe to run more than once.

alter table public.trips                 add column if not exists origin_city text;
alter table public.trip_budget           add column if not exists flights_estimate numeric(12, 2) not null default 0;
alter table public.trip_budget           add column if not exists flight_note text;
alter table public.conversation_messages add column if not exists metadata jsonb;

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
