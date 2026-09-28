-- Journi migration 004 — dashboard features: budget limit, saved places, bookings.
-- Run once in Supabase → SQL Editor → New query → paste everything → Run.
-- Safe to run more than once.

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
