-- Phase 2 connection-stability repair.
--
-- Checkpoint I's unified System audit timeline reads Reports events alongside
-- Operations, Team, Knowledge, Marketing and Brain events. The historical
-- combined Reports deployment created this relation in the hosted branch, but
-- its replayable source migration did not retain the table definition. A clean
-- preview reset therefore left atlas_private.system_snapshot referencing a
-- relation that did not exist.
--
-- This migration restores the missing private append-only audit relation. It
-- contains no operational source rows and grants no browser access.

create table if not exists atlas_private.report_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (char_length(event_type) between 1 and 120),
  report_key text,
  saved_view_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists report_events_created_idx
  on atlas_private.report_events(created_at desc);
create index if not exists report_events_report_idx
  on atlas_private.report_events(report_key,created_at desc)
  where report_key is not null;
create index if not exists report_events_saved_view_idx
  on atlas_private.report_events(saved_view_id,created_at desc)
  where saved_view_id is not null;

alter table atlas_private.report_events enable row level security;

revoke all on atlas_private.report_events from public, anon, authenticated;
revoke all on atlas_private.report_events from service_role;
grant select, insert on atlas_private.report_events to service_role;

drop policy if exists report_events_service_select on atlas_private.report_events;
create policy report_events_service_select
  on atlas_private.report_events
  for select
  to service_role
  using (true);

drop policy if exists report_events_service_insert on atlas_private.report_events;
create policy report_events_service_insert
  on atlas_private.report_events
  for insert
  to service_role
  with check (true);

comment on table atlas_private.report_events is
  'Append-only private Reports audit evidence consumed by the System timeline. Browser roles have no direct access.';
