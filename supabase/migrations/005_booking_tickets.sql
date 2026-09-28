-- Journi migration 005 — upload a ticket to a booking (auto-fill + keep the file).
-- Safe to run more than once.

alter table public.bookings add column if not exists ticket_path text;   -- path in the private "tickets" storage bucket
alter table public.bookings add column if not exists ticket_name text;   -- original file name

-- Private bucket for ticket files. Only the backend (service role) reads/writes it;
-- the app gets short-lived signed links to view a ticket.
insert into storage.buckets (id, name, public, file_size_limit)
values ('tickets', 'tickets', false, 15728640)
on conflict (id) do nothing;
