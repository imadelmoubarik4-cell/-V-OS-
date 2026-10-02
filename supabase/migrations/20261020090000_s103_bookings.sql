-- S99 Alcedo Bookings — first-release reservation module (staff workspace + one
-- authoritative availability/reservation service), per docs/design/Alcedo_Bookings_First_Release.md.
--
-- Scope of THIS migration (step 2, DB layer): areas, tables, permitted table
-- combinations, per-venue availability rules (a single settings row), reservations
-- with an internal table allocation, an append-only status history, expiring holds,
-- and the SECURITY DEFINER gateway RPCs that staff use to configure the room, read a
-- day, compute availability, and create/assign/move/cancel bookings under a single
-- atomic check-and-reserve. The website form + verified provider sync are LATER steps.
--
-- This is a SINGLE-VENUE app (VÁ Bar): there is no venue_id column anywhere. Rows are
-- keyed to their own identity; isolation is by role, not by tenant.
--
-- Security model = the S92/S94/S98 private gateway pattern (Pattern A): every table
-- lives in atlas_private with RLS on and a service-role-only policy; the browser holds
-- no grant and never reaches these tables. The public.atlas_bookings_* RPCs are
-- SECURITY DEFINER, granted to service_role only, and each re-checks the actor the
-- atlas-bookings Edge Function resolved (never a browser-sent id/role). Guest contact
-- details and staff notes never leave these RPCs to a public caller.
--
-- Concurrency (design §4): a confirmed booking always reserves a specific table (or the
-- member tables of a permitted combination). atlas_bookings_create takes a FOR UPDATE
-- lock on the candidate table rows, re-reads the current active allocations + live holds
-- for the requested window (including the turnaround buffer), and only then inserts the
-- allocation — so two concurrent attempts for the same table+time cannot both confirm.
-- Time zone: VÁ is Atlantic/Reykjavik (UTC year-round, no DST), so all instants are
-- stored as timestamptz in UTC and compared directly.
--
-- NO production data is written here: the module ships dormant. Areas, tables and real
-- availability rules are owner-supplied before any pilot (design §15); only a single
-- default settings row (all values are safe defaults, to be tuned by the owner) is seeded.
--
-- Re-runnable: create table/index if not exists, drop-then-create policies/triggers,
-- create or replace functions, insert ... on conflict for the settings row.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. Tables (atlas_private) -------------------------------------------------------

-- A named section of the room (Bar, Wine cellar, Ocean, Long table, …). section_colour
-- is a brand-palette token reused on the floor plan and the booking screen.
create table if not exists atlas_private.booking_areas (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  section_colour text not null default 'teal'
    check (section_colour in ('teal','orange','sage','ivory','ink','plum','sky','clay')),
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists booking_areas_order_idx
  on atlas_private.booking_areas (display_order, name);

-- A bookable table / seat. label is the unique visible number ("Bar 6"). A single bar
-- stool is seat_capacity 1, min_party 0. block_online hides it from the web form only.
create table if not exists atlas_private.booking_tables (
  id uuid primary key default gen_random_uuid(),
  area_id uuid references atlas_private.booking_areas(id) on delete set null,
  label text not null unique check (char_length(btrim(label)) between 1 and 40),
  seat_capacity integer not null check (seat_capacity between 1 and 100),
  min_party integer not null default 0 check (min_party between 0 and 100),
  priority integer not null default 0,
  is_bookable boolean not null default true,
  block_online boolean not null default false,
  temporarily_unavailable boolean not null default false,
  unavailable_from timestamptz,
  unavailable_until timestamptz,
  floor_x numeric(6,2),
  floor_y numeric(6,2),
  shape text not null default 'circle' check (shape in ('circle','square','rect','stool')),
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_tables_min_le_cap check (min_party <= seat_capacity),
  constraint booking_tables_unavailable_window
    check (unavailable_until is null or unavailable_from is null or unavailable_until >= unavailable_from)
);
create index if not exists booking_tables_area_idx
  on atlas_private.booking_tables (area_id, priority, seat_capacity);

-- A permitted joining of tables for a larger party. Only listed combinations may be
-- auto-assigned; member_table_ids are the physical tables that get allocated together.
create table if not exists atlas_private.booking_table_combinations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  member_table_ids uuid[] not null check (array_length(member_table_ids, 1) between 2 and 16),
  combined_capacity integer not null check (combined_capacity between 2 and 200),
  is_permitted boolean not null default true,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Availability rules live in one settings row (design §3: rules are configuration, not
-- per-row data). id is a fixed boolean so only a single row can ever exist. Every value
-- is a safe DEFAULT to be confirmed/tuned by the owner before a pilot (design §15).
create table if not exists atlas_private.booking_settings (
  id boolean primary key default true check (id = true),
  slot_interval_minutes integer not null default 15 check (slot_interval_minutes between 5 and 240),
  default_duration_minutes integer not null default 90 check (default_duration_minutes between 15 and 1440),
  duration_by_party jsonb not null default '{}'::jsonb check (jsonb_typeof(duration_by_party) = 'object'),
  turnaround_minutes integer not null default 15 check (turnaround_minutes between 0 and 240),
  last_start_offset_minutes integer not null default 0 check (last_start_offset_minutes between 0 and 1440),
  advance_days integer not null default 90 check (advance_days between 1 and 400),
  max_party_online integer not null default 8 check (max_party_online between 1 and 100),
  approval_party_threshold integer not null default 7 check (approval_party_threshold between 1 and 100),
  auto_confirm boolean not null default false,
  -- hours: {"mon":[["17:00","23:00"]], …} local venue time; empty means closed that day.
  hours jsonb not null default '{}'::jsonb check (jsonb_typeof(hours) = 'object'),
  holiday_exceptions jsonb not null default '[]'::jsonb check (jsonb_typeof(holiday_exceptions) = 'array'),
  version integer not null default 1 check (version > 0),
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A reservation. Guest contact + staff notes are restricted (never returned to a public
-- caller). booking_reference is the public, human-facing code. idempotency_key collapses
-- repeated web/provider submissions onto the original booking (design §4). start_at/end_at
-- are the guest-facing service window in UTC; the turnaround buffer is applied on top when
-- checking table occupancy.
create table if not exists atlas_private.reservations (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'phone'
    check (source in ('web','phone','walk_in','dineout','other')),
  status text not null default 'requested'
    check (status in ('requested','confirmed','arrived','seated','completed','cancelled','no_show')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  party_size integer not null check (party_size between 1 and 500),
  guest_name text check (guest_name is null or char_length(guest_name) <= 160),
  guest_phone text check (guest_phone is null or char_length(guest_phone) <= 40),
  guest_email text check (guest_email is null or char_length(guest_email) <= 200),
  guest_requests text check (guest_requests is null or char_length(guest_requests) <= 2000),
  staff_notes text check (staff_notes is null or char_length(staff_notes) <= 2000),
  booking_reference text not null unique,
  provider_ref text,
  idempotency_key text unique,
  created_by uuid,
  created_by_label text,
  created_by_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservations_window check (end_at > start_at)
);
create index if not exists reservations_window_idx
  on atlas_private.reservations (start_at, end_at);
create index if not exists reservations_status_idx
  on atlas_private.reservations (status, start_at);

-- The internal allocation: which physical table a reservation holds, for which window.
-- start_at/end_at are denormalised from the reservation (kept in sync on move) so overlap
-- checks and released rows are self-contained. combination_id marks member rows of a join.
-- released_at set when the allocation is freed (cancel / no_show / move).
create table if not exists atlas_private.reservation_tables (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references atlas_private.reservations(id) on delete cascade,
  table_id uuid not null references atlas_private.booking_tables(id) on delete restrict,
  combination_id uuid references atlas_private.booking_table_combinations(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reservation_tables_window check (end_at > start_at)
);
-- Only one live allocation per (reservation, table).
create unique index if not exists reservation_tables_active_uniq
  on atlas_private.reservation_tables (reservation_id, table_id) where released_at is null;
create index if not exists reservation_tables_table_active_idx
  on atlas_private.reservation_tables (table_id, start_at, end_at) where released_at is null;

-- Who changed a reservation's status, when. Append-only (design §5/§6).
-- reservation_id is ON DELETE SET NULL (not CASCADE) because this table is append-only
-- (S96 guard): a hard delete of a reservation nulls the column here (a permitted update)
-- rather than deleting the history row, which the guard would block. Reservations are
-- cancelled, not deleted, in normal operation, so this only matters for a hard purge.
create table if not exists atlas_private.reservation_status_history (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references atlas_private.reservations(id) on delete set null,
  from_status text,
  to_status text not null,
  note text check (note is null or char_length(note) <= 500),
  changed_by uuid,
  changed_by_label text,
  changed_by_role text,
  changed_at timestamptz not null default now()
);
create index if not exists reservation_status_history_res_idx
  on atlas_private.reservation_status_history (reservation_id, changed_at);

-- Explicit, short-lived holds so a request awaiting approval (or an in-flight web
-- request) never silently blocks a table beyond its expiry (design §4).
create table if not exists atlas_private.booking_holds (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references atlas_private.booking_tables(id) on delete cascade,
  reservation_id uuid references atlas_private.reservations(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text not null default 'staff' check (reason in ('staff','web_pending','approval')),
  expires_at timestamptz not null,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  constraint booking_holds_window check (end_at > start_at)
);
create index if not exists booking_holds_live_idx
  on atlas_private.booking_holds (table_id, expires_at, start_at, end_at);

-- Append-only audit for consequential booking actions (S96 pattern).
create table if not exists atlas_private.booking_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'area_saved','table_saved','combination_saved','settings_saved',
    'reservation_created','reservation_assigned','reservation_moved',
    'status_changed','hold_created','hold_released'
  )),
  reservation_id uuid references atlas_private.reservations(id) on delete set null,
  table_id uuid references atlas_private.booking_tables(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists booking_events_res_idx
  on atlas_private.booking_events (reservation_id, created_at desc) where reservation_id is not null;
create index if not exists booking_events_created_idx
  on atlas_private.booking_events (created_at desc);

-- 2. RLS, grants, timestamp + append-only triggers -------------------------------

do $grants$
declare t text;
begin
  foreach t in array array[
    'booking_areas','booking_tables','booking_table_combinations','booking_settings',
    'reservations','reservation_tables','reservation_status_history','booking_holds','booking_events'
  ] loop
    execute format('alter table atlas_private.%I enable row level security', t);
    execute format('drop policy if exists %I on atlas_private.%I', 'service role manages ' || replace(t, '_', ' '), t);
    execute format('create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      'service role manages ' || replace(t, '_', ' '), t);
    execute format('revoke all on atlas_private.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on atlas_private.%I to service_role', t);
    execute format('revoke truncate, references, trigger on atlas_private.%I from service_role', t);
  end loop;
end
$grants$;

drop trigger if exists booking_areas_touch on atlas_private.booking_areas;
create trigger booking_areas_touch before update on atlas_private.booking_areas
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists booking_tables_touch on atlas_private.booking_tables;
create trigger booking_tables_touch before update on atlas_private.booking_tables
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists booking_table_combinations_touch on atlas_private.booking_table_combinations;
create trigger booking_table_combinations_touch before update on atlas_private.booking_table_combinations
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists booking_settings_touch on atlas_private.booking_settings;
create trigger booking_settings_touch before update on atlas_private.booking_settings
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists reservations_touch on atlas_private.reservations;
create trigger reservations_touch before update on atlas_private.reservations
  for each row execute function atlas_private.touch_updated_at();

-- reservation_status_history + booking_events are append-only (S96 pattern).
revoke update, delete, truncate on atlas_private.reservation_status_history from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.reservation_status_history;
create trigger s96_append_only before update or delete on atlas_private.reservation_status_history
  for each row execute function private.audit_append_only('reservation_id');
drop trigger if exists s96_append_only_no_truncate on atlas_private.reservation_status_history;
create trigger s96_append_only_no_truncate before truncate on atlas_private.reservation_status_history
  for each statement execute function private.audit_append_only();

revoke update, delete, truncate on atlas_private.booking_events from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.booking_events;
create trigger s96_append_only before update or delete on atlas_private.booking_events
  for each row execute function private.audit_append_only('reservation_id', 'table_id');
drop trigger if exists s96_append_only_no_truncate on atlas_private.booking_events;
create trigger s96_append_only_no_truncate before truncate on atlas_private.booking_events
  for each statement execute function private.audit_append_only();

-- Seed the single settings row (defaults only; owner tunes before pilot).
insert into atlas_private.booking_settings (id) values (true)
on conflict (id) do nothing;

-- 3. Helpers (atlas_private) ------------------------------------------------------

-- A staff label safe to store: display name, never an email (S87 rule).
create or replace function atlas_private.booking_safe_label(p_name text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_name is null or pg_catalog.btrim(p_name) = '' or pg_catalog.strpos(p_name, '@') > 0 then 'Team member'
    else pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(p_name), '\s+', ' ', 'g'), 120) end;
$function$;
revoke all on function atlas_private.booking_safe_label(text) from public, anon, authenticated;

-- The actor the gateway passes must be an active profile with the claimed role.
-- Returns the safe label. Trusted-server authorization re-check.
create or replace function atlas_private.booking_require_actor(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare actor record;
begin
  if p_actor_id is null then
    raise exception 'A signed-in Alcedo profile is required.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select p.id, p.role::text as role, p.active, p.display_name into actor
  from public.profiles p where p.id = p_actor_id;
  if actor.id is null or actor.active is not true
     or actor.role not in ('admin','manager','bartender','viewer')
     or actor.role is distinct from p_actor_role then
    raise exception 'This Alcedo profile cannot access Bookings.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return atlas_private.booking_safe_label(actor.display_name);
end
$function$;
revoke all on function atlas_private.booking_require_actor(uuid, text) from public, anon, authenticated;

-- Mutating reservation actions are staff-only. Viewer is deliberately read-only.
create or replace function atlas_private.booking_require_staff(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare label text;
begin
  label := atlas_private.booking_require_actor(p_actor_id, p_actor_role);
  if p_actor_role not in ('admin','manager','bartender') then
    raise exception 'Changing Bookings is for active staff.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return label;
end
$function$;
revoke all on function atlas_private.booking_require_staff(uuid, text) from public, anon, authenticated;

-- The actor must additionally be a manager or administrator. Returns the label.
create or replace function atlas_private.booking_require_manager(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare label text;
begin
  label := atlas_private.booking_require_actor(p_actor_id, p_actor_role);
  if p_actor_role not in ('admin','manager') then
    raise exception 'Configuring Bookings is for managers and administrators.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  return label;
end
$function$;
revoke all on function atlas_private.booking_require_manager(uuid, text) from public, anon, authenticated;

-- A unique, human-facing booking reference: VA-XXXXXX (Crockford-ish base32, no vowels).
create or replace function atlas_private.booking_new_reference()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  alphabet constant text := '23456789BCDFGHJKLMNPQRSTVWXYZ';
  candidate text;
  i integer;
  tries integer := 0;
begin
  loop
    candidate := 'VA-';
    for i in 1..6 loop
      candidate := candidate || pg_catalog.substr(alphabet, 1 + pg_catalog.floor(pg_catalog.random() * pg_catalog.length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from atlas_private.reservations r where r.booking_reference = candidate);
    tries := tries + 1;
    if tries > 40 then
      raise exception 'Could not allocate a booking reference.' using errcode = 'P0001', hint = 'atlas:unavailable';
    end if;
  end loop;
  return candidate;
end
$function$;
revoke all on function atlas_private.booking_new_reference() from public, anon, authenticated;

-- The service duration (minutes) for a party size: an explicit per-size override in
-- settings, else the default duration.
create or replace function atlas_private.booking_duration_minutes(p_party_size integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select (s.duration_by_party ->> p_party_size::text)::int
       from atlas_private.booking_settings s where s.id = true
       and (s.duration_by_party ? p_party_size::text)),
    (select s.default_duration_minutes from atlas_private.booking_settings s where s.id = true),
    90);
$function$;
revoke all on function atlas_private.booking_duration_minutes(integer) from public, anon, authenticated;

-- Is a table free for [p_start, p_end) + turnaround buffer? Considers live allocations of
-- occupying reservations and unexpired holds. p_ignore_reservation excludes a booking's
-- own rows (used on move/confirm). Assumes the caller has locked the table row.
create or replace function atlas_private.booking_table_free(
  p_table_id uuid, p_start timestamptz, p_end timestamptz, p_ignore_reservation uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  buffer interval;
  win tstzrange;
begin
  select pg_catalog.make_interval(mins => s.turnaround_minutes) into buffer
  from atlas_private.booking_settings s where s.id = true;
  buffer := coalesce(buffer, pg_catalog.make_interval(mins => 15));
  win := pg_catalog.tstzrange(p_start, p_end + buffer, '[)');

  if exists (
    select 1 from atlas_private.reservation_tables rt
    join atlas_private.reservations r on r.id = rt.reservation_id
    where rt.table_id = p_table_id
      and rt.released_at is null
      and (p_ignore_reservation is null or rt.reservation_id <> p_ignore_reservation)
      and r.status in ('confirmed','arrived','seated')
      and pg_catalog.tstzrange(rt.start_at, rt.end_at + buffer, '[)') && win
  ) then
    return false;
  end if;

  if exists (
    select 1 from atlas_private.booking_holds h
    where h.table_id = p_table_id
      and h.expires_at > pg_catalog.now()
      and (p_ignore_reservation is null or h.reservation_id is distinct from p_ignore_reservation)
      and pg_catalog.tstzrange(h.start_at, h.end_at + buffer, '[)') && win
  ) then
    return false;
  end if;

  return true;
end
$function$;
revoke all on function atlas_private.booking_table_free(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;

-- 4. JSON builders ----------------------------------------------------------------

create or replace function atlas_private.booking_table_json(p_table_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when t.id is null then null else pg_catalog.jsonb_build_object(
    'id', t.id, 'area_id', t.area_id, 'label', t.label,
    'seat_capacity', t.seat_capacity, 'min_party', t.min_party, 'priority', t.priority,
    'is_bookable', t.is_bookable, 'block_online', t.block_online,
    'temporarily_unavailable', t.temporarily_unavailable,
    'unavailable_from', t.unavailable_from, 'unavailable_until', t.unavailable_until,
    'floor_x', t.floor_x, 'floor_y', t.floor_y, 'shape', t.shape
  ) end
  from atlas_private.booking_tables t where t.id = p_table_id;
$function$;
revoke all on function atlas_private.booking_table_json(uuid) from public, anon, authenticated;

-- A reservation for STAFF eyes (includes guest contact + staff notes + allocation).
create or replace function atlas_private.booking_reservation_json(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when r.id is null then null else pg_catalog.jsonb_build_object(
    'id', r.id, 'source', r.source, 'status', r.status,
    'start_at', r.start_at, 'end_at', r.end_at, 'party_size', r.party_size,
    'guest_name', r.guest_name, 'guest_phone', r.guest_phone, 'guest_email', r.guest_email,
    'guest_requests', r.guest_requests, 'staff_notes', r.staff_notes,
    'booking_reference', r.booking_reference, 'provider_ref', r.provider_ref,
    'created_by_label', r.created_by_label, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'tables', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table_id', rt.table_id, 'label', bt.label, 'combination_id', rt.combination_id)
        order by bt.label)
      from atlas_private.reservation_tables rt
      join atlas_private.booking_tables bt on bt.id = rt.table_id
      where rt.reservation_id = r.id and rt.released_at is null), '[]'::jsonb)
  ) end
  from atlas_private.reservations r where r.id = p_reservation_id;
$function$;
revoke all on function atlas_private.booking_reservation_json(uuid) from public, anon, authenticated;

-- 5. Gateway RPCs (public.atlas_bookings_*, SECURITY DEFINER, service_role only) ---

-- Staff workspace: the room (areas + tables), the day's reservations + live holds, and
-- the caller's permissions. p_date is a calendar date in the venue zone (UTC == local).
create or replace function public.atlas_bookings_snapshot(
  p_actor_id uuid, p_actor_role text, p_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  the_day date := coalesce(p_date, (pg_catalog.now())::date);
  day_start timestamptz := the_day::timestamptz;
  day_end timestamptz := (the_day + 1)::timestamptz;
begin
  perform atlas_private.booking_require_actor(p_actor_id, p_actor_role);
  return pg_catalog.jsonb_build_object(
    'date', the_day,
    'areas', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'name', a.name, 'section_colour', a.section_colour,
        'display_order', a.display_order, 'is_active', a.is_active)
        order by a.display_order, a.name)
      from atlas_private.booking_areas a where a.is_active), '[]'::jsonb),
    'tables', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.booking_table_json(t.id) order by t.priority, t.label)
      from atlas_private.booking_tables t), '[]'::jsonb),
    'reservations', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.booking_reservation_json(r.id) order by r.start_at)
      from atlas_private.reservations r
      where r.start_at < day_end and r.end_at > day_start
        and r.status <> 'cancelled'), '[]'::jsonb),
    'holds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'table_id', h.table_id, 'start_at', h.start_at, 'end_at', h.end_at,
        'reason', h.reason, 'expires_at', h.expires_at) order by h.start_at)
      from atlas_private.booking_holds h
      where h.expires_at > pg_catalog.now() and h.start_at < day_end and h.end_at > day_start), '[]'::jsonb),
    'permissions', pg_catalog.jsonb_build_object(
      'can_configure', is_manager,
      'can_manage_reservations', p_actor_role in ('admin','manager','bartender')
    ),
    'actor_role', p_actor_role
  );
end
$function$;
revoke all on function public.atlas_bookings_snapshot(uuid, text, date) from public, anon, authenticated;
grant execute on function public.atlas_bookings_snapshot(uuid, text, date) to service_role;

-- Manager: the full configuration (areas, tables, combinations, availability rules).
create or replace function public.atlas_bookings_config(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  return pg_catalog.jsonb_build_object(
    'areas', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'name', a.name, 'section_colour', a.section_colour,
        'display_order', a.display_order, 'is_active', a.is_active)
        order by a.display_order, a.name)
      from atlas_private.booking_areas a), '[]'::jsonb),
    'tables', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.booking_table_json(t.id) order by t.priority, t.label)
      from atlas_private.booking_tables t), '[]'::jsonb),
    'combinations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'name', c.name, 'member_table_ids', pg_catalog.to_jsonb(c.member_table_ids),
        'combined_capacity', c.combined_capacity, 'is_permitted', c.is_permitted)
        order by c.name)
      from atlas_private.booking_table_combinations c), '[]'::jsonb),
    'settings', (
      select pg_catalog.jsonb_build_object(
        'slot_interval_minutes', s.slot_interval_minutes,
        'default_duration_minutes', s.default_duration_minutes,
        'duration_by_party', s.duration_by_party,
        'turnaround_minutes', s.turnaround_minutes,
        'last_start_offset_minutes', s.last_start_offset_minutes,
        'advance_days', s.advance_days,
        'max_party_online', s.max_party_online,
        'approval_party_threshold', s.approval_party_threshold,
        'auto_confirm', s.auto_confirm,
        'hours', s.hours, 'holiday_exceptions', s.holiday_exceptions,
        'version', s.version)
      from atlas_private.booking_settings s where s.id = true)
  );
end
$function$;
revoke all on function public.atlas_bookings_config(uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_bookings_config(uuid, text) to service_role;

-- Manager: upsert an area.
create or replace function public.atlas_bookings_save_area(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_id uuid := (nullif(p->>'id',''))::uuid;
  v_colour text := coalesce(nullif(p->>'section_colour',''), 'teal');
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' or nullif(pg_catalog.btrim(coalesce(p->>'name','')),'') is null then
    raise exception 'An area needs a name.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into atlas_private.booking_areas (id, name, section_colour, display_order, is_active, created_by, created_by_label)
    values (v_id, pg_catalog.left(pg_catalog.btrim(p->>'name'), 80), v_colour,
      coalesce((p->>'display_order')::int, 0), coalesce((p->>'is_active')::boolean, true), p_actor_id, label);
  else
    update atlas_private.booking_areas set
      name = pg_catalog.left(pg_catalog.btrim(p->>'name'), 80),
      section_colour = v_colour,
      display_order = coalesce((p->>'display_order')::int, display_order),
      is_active = coalesce((p->>'is_active')::boolean, is_active)
    where id = v_id;
    if not found then raise exception 'Area not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  end if;
  insert into atlas_private.booking_events (event_type, actor_id, actor_label, actor_role, payload)
  values ('area_saved', p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('area_id', v_id));
  return pg_catalog.jsonb_build_object('id', v_id);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid area.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_save_area(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_save_area(uuid, text, jsonb) to service_role;

-- Manager: upsert a table.
create or replace function public.atlas_bookings_save_table(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_id uuid := (nullif(p->>'id',''))::uuid;
  v_label text := pg_catalog.left(pg_catalog.btrim(coalesce(p->>'label','')), 40);
  v_cap integer := (p->>'seat_capacity')::int;
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' or v_label = '' or v_cap is null then
    raise exception 'A table needs a label and seat capacity.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into atlas_private.booking_tables (
      id, area_id, label, seat_capacity, min_party, priority, is_bookable, block_online,
      temporarily_unavailable, unavailable_from, unavailable_until, floor_x, floor_y, shape,
      created_by, created_by_label)
    values (v_id, (nullif(p->>'area_id',''))::uuid, v_label, v_cap,
      coalesce((p->>'min_party')::int, 0), coalesce((p->>'priority')::int, 0),
      coalesce((p->>'is_bookable')::boolean, true), coalesce((p->>'block_online')::boolean, false),
      coalesce((p->>'temporarily_unavailable')::boolean, false),
      (nullif(p->>'unavailable_from',''))::timestamptz, (nullif(p->>'unavailable_until',''))::timestamptz,
      (nullif(p->>'floor_x',''))::numeric, (nullif(p->>'floor_y',''))::numeric,
      coalesce(nullif(p->>'shape',''), 'circle'), p_actor_id, label);
  else
    update atlas_private.booking_tables set
      area_id = (nullif(p->>'area_id',''))::uuid,
      label = v_label, seat_capacity = v_cap,
      min_party = coalesce((p->>'min_party')::int, min_party),
      priority = coalesce((p->>'priority')::int, priority),
      is_bookable = coalesce((p->>'is_bookable')::boolean, is_bookable),
      block_online = coalesce((p->>'block_online')::boolean, block_online),
      temporarily_unavailable = coalesce((p->>'temporarily_unavailable')::boolean, temporarily_unavailable),
      unavailable_from = (nullif(p->>'unavailable_from',''))::timestamptz,
      unavailable_until = (nullif(p->>'unavailable_until',''))::timestamptz,
      floor_x = coalesce((nullif(p->>'floor_x',''))::numeric, floor_x),
      floor_y = coalesce((nullif(p->>'floor_y',''))::numeric, floor_y),
      shape = coalesce(nullif(p->>'shape',''), shape)
    where id = v_id;
    if not found then raise exception 'Table not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  end if;
  insert into atlas_private.booking_events (event_type, table_id, actor_id, actor_label, actor_role, payload)
  values ('table_saved', v_id, p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('label', v_label));
  return pg_catalog.jsonb_build_object('id', v_id);
exception
  when unique_violation then
    raise exception 'Another table already uses that label.' using errcode = '23505', hint = 'atlas:conflict';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid table.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_save_table(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_save_table(uuid, text, jsonb) to service_role;

-- Manager: upsert a permitted table combination.
create or replace function public.atlas_bookings_save_combination(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_id uuid := (nullif(p->>'id',''))::uuid;
  v_members uuid[];
  v_cap integer := (p->>'combined_capacity')::int;
begin
  if pg_catalog.jsonb_typeof(p->'member_table_ids') <> 'array' then
    raise exception 'A combination needs member tables.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select pg_catalog.array_agg((value #>> '{}')::uuid) into v_members
  from pg_catalog.jsonb_array_elements(p->'member_table_ids') value;
  if v_members is null or pg_catalog.array_length(v_members, 1) < 2 or v_cap is null then
    raise exception 'A combination needs at least two tables and a combined capacity.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if exists (select 1 from pg_catalog.unnest(v_members) m
             where not exists (select 1 from atlas_private.booking_tables t where t.id = m)) then
    raise exception 'A combination member table does not exist.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into atlas_private.booking_table_combinations (id, name, member_table_ids, combined_capacity, is_permitted, created_by, created_by_label)
    values (v_id, pg_catalog.left(pg_catalog.btrim(coalesce(p->>'name','Combination')), 80), v_members, v_cap,
      coalesce((p->>'is_permitted')::boolean, true), p_actor_id, label);
  else
    update atlas_private.booking_table_combinations set
      name = pg_catalog.left(pg_catalog.btrim(coalesce(p->>'name', name)), 80),
      member_table_ids = v_members, combined_capacity = v_cap,
      is_permitted = coalesce((p->>'is_permitted')::boolean, is_permitted)
    where id = v_id;
    if not found then raise exception 'Combination not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  end if;
  insert into atlas_private.booking_events (event_type, actor_id, actor_label, actor_role, payload)
  values ('combination_saved', p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('combination_id', v_id));
  return pg_catalog.jsonb_build_object('id', v_id);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid combination.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_save_combination(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_save_combination(uuid, text, jsonb) to service_role;

-- Manager: update availability rules, optimistic-concurrency by version.
create or replace function public.atlas_bookings_save_settings(
  p_actor_id uuid, p_actor_role text, p_payload jsonb, p_expected_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  cur atlas_private.booking_settings;
begin
  select * into cur from atlas_private.booking_settings where id = true for update;
  if p_expected_version is not null and cur.version <> p_expected_version then
    raise exception 'These rules changed since you opened them.' using errcode = '23505', hint = 'atlas:conflict';
  end if;
  update atlas_private.booking_settings set
    slot_interval_minutes = coalesce((p->>'slot_interval_minutes')::int, slot_interval_minutes),
    default_duration_minutes = coalesce((p->>'default_duration_minutes')::int, default_duration_minutes),
    duration_by_party = case when pg_catalog.jsonb_typeof(p->'duration_by_party') = 'object' then p->'duration_by_party' else duration_by_party end,
    turnaround_minutes = coalesce((p->>'turnaround_minutes')::int, turnaround_minutes),
    last_start_offset_minutes = coalesce((p->>'last_start_offset_minutes')::int, last_start_offset_minutes),
    advance_days = coalesce((p->>'advance_days')::int, advance_days),
    max_party_online = coalesce((p->>'max_party_online')::int, max_party_online),
    approval_party_threshold = coalesce((p->>'approval_party_threshold')::int, approval_party_threshold),
    auto_confirm = coalesce((p->>'auto_confirm')::boolean, auto_confirm),
    hours = case when pg_catalog.jsonb_typeof(p->'hours') = 'object' then p->'hours' else hours end,
    holiday_exceptions = case when pg_catalog.jsonb_typeof(p->'holiday_exceptions') = 'array' then p->'holiday_exceptions' else holiday_exceptions end,
    version = version + 1, updated_by = p_actor_id, updated_by_label = label
  where id = true;
  insert into atlas_private.booking_events (event_type, actor_id, actor_label, actor_role)
  values ('settings_saved', p_actor_id, label, p_actor_role);
  return (select pg_catalog.jsonb_build_object('version', s.version) from atlas_private.booking_settings s where s.id = true);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid rules.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_save_settings(uuid, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.atlas_bookings_save_settings(uuid, text, jsonb, integer) to service_role;

-- Availability: for a date + party size, the bookable start instants that still have at
-- least one suitable free table. Returns instants only — never table numbers or guest data.
create or replace function public.atlas_bookings_availability(
  p_actor_id uuid, p_actor_role text, p_from timestamptz, p_to timestamptz, p_party_size integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  s atlas_private.booking_settings;
  dur interval;
  step interval;
  slot timestamptz;
  slots jsonb := '[]'::jsonb;
  free_table uuid;
begin
  perform atlas_private.booking_require_actor(p_actor_id, p_actor_role);
  if p_from is null or p_to is null or p_to <= p_from or coalesce(p_party_size, 0) < 1 then
    raise exception 'A date range and party size are required.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if p_to - p_from > interval '31 days' then
    raise exception 'That range is too wide.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select * into s from atlas_private.booking_settings where id = true;
  dur := pg_catalog.make_interval(mins => atlas_private.booking_duration_minutes(p_party_size));
  step := pg_catalog.make_interval(mins => coalesce(s.slot_interval_minutes, 15));

  slot := p_from;
  while slot < p_to loop
    select t.id into free_table
    from atlas_private.booking_tables t
    where t.is_bookable and not t.temporarily_unavailable
      and t.seat_capacity >= p_party_size and t.min_party <= p_party_size
      and (t.unavailable_from is null or t.unavailable_until is null
           or not (t.unavailable_from < slot + dur and t.unavailable_until > slot))
      and atlas_private.booking_table_free(t.id, slot, slot + dur, null)
    order by t.seat_capacity, t.priority
    limit 1;
    if free_table is not null then
      slots := slots || pg_catalog.to_jsonb(slot);
    end if;
    slot := slot + step;
  end loop;

  return pg_catalog.jsonb_build_object('party_size', p_party_size, 'duration_minutes',
    extract(epoch from dur)::int / 60, 'slots', slots);
end
$function$;
revoke all on function public.atlas_bookings_availability(uuid, text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.atlas_bookings_availability(uuid, text, timestamptz, timestamptz, integer) to service_role;

-- Staff create (phone / walk-in): the atomic check-and-reserve. Locks the candidate
-- table(s), re-reads live allocations + holds for the window, then inserts the reservation
-- and its allocation in one transaction. Explicit p_table_ids, else the smallest suitable
-- free table is auto-assigned. Large parties (>= approval threshold) with no explicit
-- staff allocation are recorded as 'requested' with a short hold instead of a confirmation.
-- Idempotent on p_payload->>'idempotency_key'.
create or replace function public.atlas_bookings_create(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  s atlas_private.booking_settings;
  v_party integer := (p->>'party_size')::int;
  v_start timestamptz := (p->>'start_at')::timestamptz;
  v_dur interval;
  v_end timestamptz;
  v_source text := coalesce(nullif(p->>'source',''), 'phone');
  v_idem text := nullif(p->>'idempotency_key','');
  v_force_status text := nullif(p->>'status','');
  v_ref text;
  v_res_id uuid := gen_random_uuid();
  v_status text;
  v_table_ids uuid[];
  v_auto uuid;
  existing atlas_private.reservations;
  tid uuid;
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' or v_party is null or v_party < 1 or v_start is null then
    raise exception 'A booking needs a party size and a start time.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_source not in ('web','phone','walk_in','dineout','other') then
    raise exception 'Unknown booking source.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  -- Idempotent replay: same key returns the original booking.
  if v_idem is not null then
    select * into existing from atlas_private.reservations where idempotency_key = v_idem;
    if existing.id is not null then
      return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(existing.id), 'replayed', true);
    end if;
  end if;

  select * into s from atlas_private.booking_settings where id = true;
  v_dur := pg_catalog.make_interval(mins => atlas_private.booking_duration_minutes(v_party));
  v_end := v_start + v_dur;

  -- Candidate tables: explicit list from staff, else nothing (auto-assign below).
  if pg_catalog.jsonb_typeof(p->'table_ids') = 'array' then
    select pg_catalog.array_agg((value #>> '{}')::uuid) into v_table_ids
    from pg_catalog.jsonb_array_elements(p->'table_ids') value;
  end if;

  -- Decide the status. Staff may explicitly confirm/request a staff-entered booking.
  -- Otherwise website/guest-originated bookings stay requested while auto_confirm is off
  -- (VÁ default: staff approval). The threshold remains available if a manager later
  -- chooses to enable auto-confirm.
  if v_force_status in ('confirmed','requested') then
    v_status := v_force_status;
  elsif v_table_ids is null and v_party >= coalesce(s.approval_party_threshold, 7) then
    v_status := 'requested';
  elsif coalesce(s.auto_confirm, true) then
    v_status := 'confirmed';
  else
    v_status := 'requested';
  end if;

  -- Lock candidate rows up front so concurrent creates serialise on them.
  if v_table_ids is not null then
    perform 1 from atlas_private.booking_tables t where t.id = any(v_table_ids) order by t.id for update;
    if (select pg_catalog.count(*) from atlas_private.booking_tables t where t.id = any(v_table_ids)) <> pg_catalog.array_length(v_table_ids, 1) then
      raise exception 'A chosen table does not exist.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;

  v_ref := atlas_private.booking_new_reference();
  insert into atlas_private.reservations (
    id, source, status, start_at, end_at, party_size, guest_name, guest_phone, guest_email,
    guest_requests, staff_notes, booking_reference, provider_ref, idempotency_key,
    created_by, created_by_label, created_by_role)
  values (v_res_id, v_source, v_status, v_start, v_end, v_party,
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_name','')), 160), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_phone','')), 40), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_email','')), 200), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_requests','')), 2000), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'staff_notes','')), 2000), ''),
    v_ref, nullif(p->>'provider_ref',''), v_idem, p_actor_id, label, p_actor_role);

  -- Allocate tables only for a confirmed booking. A 'requested' booking holds nothing
  -- beyond an optional expiring hold (created by staff explicitly, later).
  if v_status = 'confirmed' then
    if v_table_ids is null then
      -- Auto-assign the smallest suitable free table.
      select t.id into v_auto
      from atlas_private.booking_tables t
      where t.is_bookable and not t.temporarily_unavailable
        and t.seat_capacity >= v_party and t.min_party <= v_party
        and atlas_private.booking_table_free(t.id, v_start, v_end, null)
      order by t.seat_capacity, t.priority
      limit 1
      for update;
      if v_auto is null then
        raise exception 'No free table for that time and party.' using errcode = '23505', hint = 'atlas:conflict';
      end if;
      v_table_ids := array[v_auto];
    end if;

    foreach tid in array v_table_ids loop
      if not atlas_private.booking_table_free(tid, v_start, v_end, null) then
        raise exception 'That table is no longer free for the requested time.' using errcode = '23505', hint = 'atlas:conflict';
      end if;
      insert into atlas_private.reservation_tables (reservation_id, table_id, start_at, end_at)
      values (v_res_id, tid, v_start, v_end);
    end loop;
  end if;

  insert into atlas_private.reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_label, changed_by_role, note)
  values (v_res_id, null, v_status, p_actor_id, label, p_actor_role, 'created');
  insert into atlas_private.booking_events (event_type, reservation_id, actor_id, actor_label, actor_role, payload)
  values ('reservation_created', v_res_id, p_actor_id, label, p_actor_role,
    pg_catalog.jsonb_build_object('status', v_status, 'source', v_source, 'party_size', v_party));

  return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(v_res_id), 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid booking.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_create(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_create(uuid, text, jsonb) to service_role;

-- Staff: assign or move a reservation's tables. Releases current live allocations and
-- takes the new ones under the same free-check (locking the target rows). A 'requested'
-- booking that gets a valid allocation becomes 'confirmed'.
create or replace function public.atlas_bookings_assign(
  p_actor_id uuid, p_actor_role text, p_reservation_id uuid, p_table_ids jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
  r atlas_private.reservations;
  v_table_ids uuid[];
  was_requested boolean;
  tid uuid;
begin
  select * into r from atlas_private.reservations where id = p_reservation_id;
  if r.id is null then raise exception 'Booking not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if r.status in ('cancelled','no_show','completed') then
    raise exception 'This booking can no longer be moved.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if pg_catalog.jsonb_typeof(p_table_ids) <> 'array' then
    raise exception 'Choose at least one table.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  select pg_catalog.array_agg((value #>> '{}')::uuid) into v_table_ids
  from pg_catalog.jsonb_array_elements(p_table_ids) value;
  if v_table_ids is null or pg_catalog.array_length(v_table_ids, 1) < 1 then
    raise exception 'Choose at least one table.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  perform 1 from atlas_private.booking_tables t where t.id = any(v_table_ids) order by t.id for update;
  foreach tid in array v_table_ids loop
    if not exists (select 1 from atlas_private.booking_tables t where t.id = tid) then
      raise exception 'A chosen table does not exist.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if not atlas_private.booking_table_free(tid, r.start_at, r.end_at, r.id) then
      raise exception 'That table is not free for this booking''s time.' using errcode = '23505', hint = 'atlas:conflict';
    end if;
  end loop;

  update atlas_private.reservation_tables set released_at = pg_catalog.now()
  where reservation_id = r.id and released_at is null;
  foreach tid in array v_table_ids loop
    insert into atlas_private.reservation_tables (reservation_id, table_id, start_at, end_at)
    values (r.id, tid, r.start_at, r.end_at);
  end loop;

  was_requested := r.status = 'requested';
  if was_requested then
    update atlas_private.reservations set status = 'confirmed' where id = r.id;
    insert into atlas_private.reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_label, changed_by_role, note)
    values (r.id, 'requested', 'confirmed', p_actor_id, label, p_actor_role, 'assigned tables');
  end if;
  insert into atlas_private.booking_events (event_type, reservation_id, actor_id, actor_label, actor_role, payload)
  values ('reservation_assigned', r.id, p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('tables', pg_catalog.to_jsonb(v_table_ids)));
  return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(r.id));
exception
  when invalid_text_representation then
    raise exception 'Invalid table selection.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_assign(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_assign(uuid, text, uuid, jsonb) to service_role;

-- Staff: change a reservation's arrival status. Enforces the allowed transitions and
-- releases the table allocation when the booking ends (cancelled / no_show / completed).
create or replace function public.atlas_bookings_set_status(
  p_actor_id uuid, p_actor_role text, p_reservation_id uuid, p_to_status text, p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
  r atlas_private.reservations;
  allowed text[];
begin
  select * into r from atlas_private.reservations where id = p_reservation_id for update;
  if r.id is null then raise exception 'Booking not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if p_to_status not in ('requested','confirmed','arrived','seated','completed','cancelled','no_show') then
    raise exception 'Unknown status.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  allowed := case r.status
    when 'requested' then array['confirmed','cancelled','no_show']
    when 'confirmed' then array['arrived','seated','completed','cancelled','no_show']
    when 'arrived'   then array['seated','completed','cancelled','no_show']
    when 'seated'    then array['completed','cancelled']
    else array[]::text[] end;
  if p_to_status = r.status then
    return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(r.id), 'unchanged', true);
  end if;
  if not (p_to_status = any(allowed)) then
    raise exception 'That status change is not allowed.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  -- Confirming a requested booking requires a table; route through assign instead.
  if r.status = 'requested' and p_to_status = 'confirmed'
     and not exists (select 1 from atlas_private.reservation_tables rt where rt.reservation_id = r.id and rt.released_at is null) then
    raise exception 'Assign a table before confirming this booking.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  update atlas_private.reservations set status = p_to_status where id = r.id;
  if p_to_status in ('cancelled','no_show','completed') then
    update atlas_private.reservation_tables set released_at = pg_catalog.now()
    where reservation_id = r.id and released_at is null;
    update atlas_private.booking_holds set expires_at = pg_catalog.now()
    where reservation_id = r.id and expires_at > pg_catalog.now();
  end if;

  insert into atlas_private.reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_label, changed_by_role, note)
  values (r.id, r.status, p_to_status, p_actor_id, label, p_actor_role,
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_note,'')), 500), ''));
  insert into atlas_private.booking_events (event_type, reservation_id, actor_id, actor_label, actor_role, payload)
  values ('status_changed', r.id, p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('from', r.status, 'to', p_to_status));
  return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(r.id), 'unchanged', false);
end
$function$;
revoke all on function public.atlas_bookings_set_status(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.atlas_bookings_set_status(uuid, text, uuid, text, text) to service_role;

-- Staff: place a short expiring hold on a table (e.g. while confirming a phone booking).
create or replace function public.atlas_bookings_hold(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_table uuid := (nullif(p->>'table_id',''))::uuid;
  v_start timestamptz := (p->>'start_at')::timestamptz;
  v_end timestamptz := (p->>'end_at')::timestamptz;
  v_minutes integer := coalesce((p->>'minutes')::int, 10);
  v_id uuid := gen_random_uuid();
begin
  if v_table is null or v_start is null or v_end is null or v_end <= v_start then
    raise exception 'A hold needs a table and a time window.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  v_minutes := least(120, greatest(1, v_minutes));
  perform 1 from atlas_private.booking_tables t where t.id = v_table for update;
  if not atlas_private.booking_table_free(v_table, v_start, v_end, null) then
    raise exception 'That table is not free for that window.' using errcode = '23505', hint = 'atlas:conflict';
  end if;
  insert into atlas_private.booking_holds (id, table_id, reservation_id, start_at, end_at, reason, expires_at, created_by, created_by_label)
  values (v_id, v_table, (nullif(p->>'reservation_id',''))::uuid, v_start, v_end,
    coalesce(nullif(p->>'reason',''),'staff'), pg_catalog.now() + pg_catalog.make_interval(mins => v_minutes), p_actor_id, label);
  insert into atlas_private.booking_events (event_type, reservation_id, table_id, actor_id, actor_label, actor_role)
  values ('hold_created', (nullif(p->>'reservation_id',''))::uuid, v_table, p_actor_id, label, p_actor_role);
  return pg_catalog.jsonb_build_object('id', v_id);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid hold.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_hold(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_hold(uuid, text, jsonb) to service_role;

-- Staff: release a hold early.
create or replace function public.atlas_bookings_release_hold(p_actor_id uuid, p_actor_role text, p_hold_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
begin
  update atlas_private.booking_holds set expires_at = pg_catalog.now()
  where id = p_hold_id and expires_at > pg_catalog.now();
  if not found then raise exception 'Hold not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  insert into atlas_private.booking_events (event_type, actor_id, actor_label, actor_role, payload)
  values ('hold_released', p_actor_id, label, p_actor_role, pg_catalog.jsonb_build_object('hold_id', p_hold_id));
  return pg_catalog.jsonb_build_object('ok', true);
end
$function$;
revoke all on function public.atlas_bookings_release_hold(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.atlas_bookings_release_hold(uuid, text, uuid) to service_role;


-- 6. VÁ production booking model + owner-approved configuration -------------------
-- Bar uses physical single-seat stools. Wine cellar / Ocean view / Long table are
-- pooled-capacity locations: overlapping bookings are allowed while the sum of guests
-- in the location stays <= 30.

alter table atlas_private.booking_areas
  add column if not exists allocation_mode text not null default 'tables'
    check (allocation_mode in ('tables','pooled'));
alter table atlas_private.booking_areas
  add column if not exists guest_capacity integer
    check (guest_capacity is null or guest_capacity between 1 and 500);
alter table atlas_private.booking_areas
  add column if not exists circular_adjacency boolean not null default false;

alter table atlas_private.booking_tables
  add column if not exists position_index integer
    check (position_index is null or position_index between 1 and 500);
create unique index if not exists booking_tables_area_position_uniq
  on atlas_private.booking_tables (area_id, position_index)
  where position_index is not null;

alter table atlas_private.reservations
  add column if not exists area_id uuid references atlas_private.booking_areas(id) on delete set null;
create index if not exists reservations_area_window_idx
  on atlas_private.reservations (area_id, start_at, end_at)
  where area_id is not null;

alter table atlas_private.booking_settings
  add column if not exists last_start_local time not null default '20:30';
alter table atlas_private.booking_settings
  add column if not exists cancellation_cutoff_minutes integer not null default 15
    check (cancellation_cutoff_minutes between 0 and 1440);

-- Owner-approved VÁ rules: 2h maximum/default duration, 15-minute slots, 90-day
-- advance window, 20:30 latest online start, staff approval for guest requests.
update atlas_private.booking_settings
set slot_interval_minutes = 15,
    default_duration_minutes = 120,
    duration_by_party = '{}'::jsonb,
    turnaround_minutes = 0,
    advance_days = 90,
    max_party_online = 30,
    auto_confirm = false,
    last_start_local = '20:30',
    cancellation_cutoff_minutes = 15
where id = true;

-- Real VÁ locations. Deterministic ids keep this seed idempotent.
insert into atlas_private.booking_areas
  (id, name, section_colour, display_order, is_active, allocation_mode, guest_capacity, circular_adjacency)
values
  ('ba000000-0000-4000-8000-000000000001','Bar','teal',1,true,'tables',16,true),
  ('ba000000-0000-4000-8000-000000000002','Wine cellar','plum',2,true,'pooled',30,false),
  ('ba000000-0000-4000-8000-000000000003','Ocean view','sky',3,true,'pooled',30,false),
  ('ba000000-0000-4000-8000-000000000004','Long table','sage',4,true,'pooled',30,false)
on conflict (id) do update set
  name = excluded.name,
  section_colour = excluded.section_colour,
  display_order = excluded.display_order,
  is_active = excluded.is_active,
  allocation_mode = excluded.allocation_mode,
  guest_capacity = excluded.guest_capacity,
  circular_adjacency = excluded.circular_adjacency;

-- Confirmed clockwise floor mapping:
-- Bar 1-8 top left->right; Bar 9-12 right top->bottom; Bar 13-16 left bottom->top.
insert into atlas_private.booking_tables
  (id, area_id, label, seat_capacity, min_party, priority, is_bookable, block_online,
   temporarily_unavailable, floor_x, floor_y, shape, position_index)
values
  ('bb000000-0000-4000-8000-000000000001','ba000000-0000-4000-8000-000000000001','Bar 1',1,0,0,true,false,false,1,1,'stool',1),
  ('bb000000-0000-4000-8000-000000000002','ba000000-0000-4000-8000-000000000001','Bar 2',1,0,0,true,false,false,2,1,'stool',2),
  ('bb000000-0000-4000-8000-000000000003','ba000000-0000-4000-8000-000000000001','Bar 3',1,0,0,true,false,false,3,1,'stool',3),
  ('bb000000-0000-4000-8000-000000000004','ba000000-0000-4000-8000-000000000001','Bar 4',1,0,0,true,false,false,4,1,'stool',4),
  ('bb000000-0000-4000-8000-000000000005','ba000000-0000-4000-8000-000000000001','Bar 5',1,0,0,true,false,false,5,1,'stool',5),
  ('bb000000-0000-4000-8000-000000000006','ba000000-0000-4000-8000-000000000001','Bar 6',1,0,0,true,false,false,6,1,'stool',6),
  ('bb000000-0000-4000-8000-000000000007','ba000000-0000-4000-8000-000000000001','Bar 7',1,0,0,true,false,false,7,1,'stool',7),
  ('bb000000-0000-4000-8000-000000000008','ba000000-0000-4000-8000-000000000001','Bar 8',1,0,0,true,false,false,8,1,'stool',8),
  ('bb000000-0000-4000-8000-000000000009','ba000000-0000-4000-8000-000000000001','Bar 9',1,0,0,true,false,false,8,2,'stool',9),
  ('bb000000-0000-4000-8000-000000000010','ba000000-0000-4000-8000-000000000001','Bar 10',1,0,0,true,false,false,8,3,'stool',10),
  ('bb000000-0000-4000-8000-000000000011','ba000000-0000-4000-8000-000000000001','Bar 11',1,0,0,true,false,false,8,4,'stool',11),
  ('bb000000-0000-4000-8000-000000000012','ba000000-0000-4000-8000-000000000001','Bar 12',1,0,0,true,false,false,8,5,'stool',12),
  ('bb000000-0000-4000-8000-000000000013','ba000000-0000-4000-8000-000000000001','Bar 13',1,0,0,true,false,false,1,5,'stool',13),
  ('bb000000-0000-4000-8000-000000000014','ba000000-0000-4000-8000-000000000001','Bar 14',1,0,0,true,false,false,1,4,'stool',14),
  ('bb000000-0000-4000-8000-000000000015','ba000000-0000-4000-8000-000000000001','Bar 15',1,0,0,true,false,false,1,3,'stool',15),
  ('bb000000-0000-4000-8000-000000000016','ba000000-0000-4000-8000-000000000001','Bar 16',1,0,0,true,false,false,1,2,'stool',16)
on conflict (id) do update set
  area_id = excluded.area_id,
  label = excluded.label,
  seat_capacity = excluded.seat_capacity,
  min_party = excluded.min_party,
  priority = excluded.priority,
  is_bookable = excluded.is_bookable,
  block_online = excluded.block_online,
  temporarily_unavailable = excluded.temporarily_unavailable,
  floor_x = excluded.floor_x,
  floor_y = excluded.floor_y,
  shape = excluded.shape,
  position_index = excluded.position_index;

-- Pooled locations serialize on their area row and count overlapping confirmed guests.
create or replace function atlas_private.booking_pooled_area_has_capacity(
  p_area_id uuid, p_start timestamptz, p_end timestamptz, p_party_size integer,
  p_ignore_reservation uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  cap integer;
  mode text;
  used integer;
begin
  select a.guest_capacity, a.allocation_mode into cap, mode
  from atlas_private.booking_areas a where a.id = p_area_id;
  if mode <> 'pooled' or cap is null then return false; end if;

  select coalesce(pg_catalog.sum(r.party_size),0)::int into used
  from atlas_private.reservations r
  where r.area_id = p_area_id
    and r.status in ('confirmed','arrived','seated')
    and (p_ignore_reservation is null or r.id <> p_ignore_reservation)
    and pg_catalog.tstzrange(r.start_at, r.end_at, '[)') &&
        pg_catalog.tstzrange(p_start, p_end, '[)');

  return used + p_party_size <= cap;
end
$function$;
revoke all on function atlas_private.booking_pooled_area_has_capacity(uuid,timestamptz,timestamptz,integer,uuid)
  from public, anon, authenticated;

-- For table-mode areas with position_index values, find one contiguous free run. The
-- Bar is circular, so adjacency may wrap from Bar 16 back to Bar 1.
create or replace function atlas_private.booking_find_contiguous_tables(
  p_area_id uuid, p_party_size integer, p_start timestamptz, p_end timestamptz,
  p_ignore_reservation uuid default null
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  max_pos integer;
  is_circular boolean;
  start_pos integer;
  offset_i integer;
  target_pos integer;
  tid uuid;
  candidate uuid[];
begin
  select pg_catalog.max(t.position_index), coalesce(a.circular_adjacency,false)
    into max_pos, is_circular
  from atlas_private.booking_tables t
  join atlas_private.booking_areas a on a.id = t.area_id
  where t.area_id = p_area_id and t.is_bookable and not t.temporarily_unavailable
  group by a.circular_adjacency;

  if max_pos is null or p_party_size < 1 or p_party_size > max_pos then return null; end if;

  for start_pos in 1..max_pos loop
    candidate := array[]::uuid[];
    for offset_i in 0..(p_party_size - 1) loop
      target_pos := start_pos + offset_i;
      if target_pos > max_pos then
        if not is_circular then candidate := null; exit; end if;
        target_pos := ((target_pos - 1) % max_pos) + 1;
      end if;

      select t.id into tid
      from atlas_private.booking_tables t
      where t.area_id = p_area_id and t.position_index = target_pos
        and t.is_bookable and not t.temporarily_unavailable
        and atlas_private.booking_table_free(t.id, p_start, p_end, p_ignore_reservation);

      if tid is null then candidate := null; exit; end if;
      candidate := pg_catalog.array_append(candidate, tid);
    end loop;
    if candidate is not null and pg_catalog.array_length(candidate,1) = p_party_size then
      return candidate;
    end if;
  end loop;
  return null;
end
$function$;
revoke all on function atlas_private.booking_find_contiguous_tables(uuid,integer,timestamptz,timestamptz,uuid)
  from public, anon, authenticated;

-- Table payload now includes the confirmed physical perimeter position.
create or replace function atlas_private.booking_table_json(p_table_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when t.id is null then null else pg_catalog.jsonb_build_object(
    'id', t.id, 'area_id', t.area_id, 'label', t.label,
    'seat_capacity', t.seat_capacity, 'min_party', t.min_party, 'priority', t.priority,
    'is_bookable', t.is_bookable, 'block_online', t.block_online,
    'temporarily_unavailable', t.temporarily_unavailable,
    'unavailable_from', t.unavailable_from, 'unavailable_until', t.unavailable_until,
    'floor_x', t.floor_x, 'floor_y', t.floor_y, 'shape', t.shape,
    'position_index', t.position_index
  ) end
  from atlas_private.booking_tables t where t.id = p_table_id;
$function$;
revoke all on function atlas_private.booking_table_json(uuid) from public, anon, authenticated;

-- Include the location in staff reservation payloads.
create or replace function atlas_private.booking_reservation_json(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case when r.id is null then null else pg_catalog.jsonb_build_object(
    'id', r.id, 'source', r.source, 'status', r.status,
    'start_at', r.start_at, 'end_at', r.end_at, 'party_size', r.party_size,
    'area_id', r.area_id, 'location', a.name, 'area_allocation_mode', a.allocation_mode,
    'guest_name', r.guest_name, 'guest_phone', r.guest_phone, 'guest_email', r.guest_email,
    'guest_requests', r.guest_requests, 'staff_notes', r.staff_notes,
    'booking_reference', r.booking_reference, 'provider_ref', r.provider_ref,
    'created_by_label', r.created_by_label, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'tables', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'table_id', rt.table_id, 'label', bt.label, 'combination_id', rt.combination_id)
        order by bt.position_index nulls last, bt.label)
      from atlas_private.reservation_tables rt
      join atlas_private.booking_tables bt on bt.id = rt.table_id
      where rt.reservation_id = r.id and rt.released_at is null), '[]'::jsonb)
  ) end
  from atlas_private.reservations r
  left join atlas_private.booking_areas a on a.id = r.area_id
  where r.id = p_reservation_id;
$function$;
revoke all on function atlas_private.booking_reservation_json(uuid) from public, anon, authenticated;

-- Snapshot with pooled-location metadata.
create or replace function public.atlas_bookings_snapshot(
  p_actor_id uuid, p_actor_role text, p_date date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  the_day date := coalesce(p_date, (pg_catalog.now())::date);
  day_start timestamptz := the_day::timestamptz;
  day_end timestamptz := (the_day + 1)::timestamptz;
begin
  perform atlas_private.booking_require_actor(p_actor_id, p_actor_role);
  return pg_catalog.jsonb_build_object(
    'date', the_day,
    'areas', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'name', a.name, 'section_colour', a.section_colour,
        'display_order', a.display_order, 'is_active', a.is_active,
        'allocation_mode', a.allocation_mode, 'guest_capacity', a.guest_capacity,
        'circular_adjacency', a.circular_adjacency)
        order by a.display_order, a.name)
      from atlas_private.booking_areas a where a.is_active), '[]'::jsonb),
    'tables', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.booking_table_json(t.id)
        order by t.position_index nulls last, t.label)
      from atlas_private.booking_tables t), '[]'::jsonb),
    'reservations', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.booking_reservation_json(r.id) order by r.start_at)
      from atlas_private.reservations r
      where r.start_at < day_end and r.end_at > day_start
        and r.status <> 'cancelled'), '[]'::jsonb),
    'holds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'table_id', h.table_id, 'start_at', h.start_at, 'end_at', h.end_at,
        'reason', h.reason, 'expires_at', h.expires_at) order by h.start_at)
      from atlas_private.booking_holds h
      where h.expires_at > pg_catalog.now() and h.start_at < day_end and h.end_at > day_start), '[]'::jsonb),
    'permissions', pg_catalog.jsonb_build_object(
      'can_configure', is_manager,
      'can_manage_reservations', p_actor_role in ('admin','manager','bartender')
    ),
    'actor_role', p_actor_role
  );
end
$function$;
revoke all on function public.atlas_bookings_snapshot(uuid, text, date) from public, anon, authenticated;
grant execute on function public.atlas_bookings_snapshot(uuid, text, date) to service_role;

-- Configuration payload includes the owner-approved location model and rules.
create or replace function public.atlas_bookings_config(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform atlas_private.booking_require_manager(p_actor_id, p_actor_role);
  return pg_catalog.jsonb_build_object(
    'areas', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'name', a.name, 'section_colour', a.section_colour,
        'display_order', a.display_order, 'is_active', a.is_active,
        'allocation_mode', a.allocation_mode, 'guest_capacity', a.guest_capacity,
        'circular_adjacency', a.circular_adjacency)
        order by a.display_order, a.name)
      from atlas_private.booking_areas a), '[]'::jsonb),
    'tables', coalesce((
      select pg_catalog.jsonb_agg(atlas_private.booking_table_json(t.id)
        order by t.position_index nulls last, t.label)
      from atlas_private.booking_tables t), '[]'::jsonb),
    'combinations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'name', c.name, 'member_table_ids', pg_catalog.to_jsonb(c.member_table_ids),
        'combined_capacity', c.combined_capacity, 'is_permitted', c.is_permitted)
        order by c.name)
      from atlas_private.booking_table_combinations c), '[]'::jsonb),
    'settings', (
      select pg_catalog.jsonb_build_object(
        'slot_interval_minutes', s.slot_interval_minutes,
        'default_duration_minutes', s.default_duration_minutes,
        'duration_by_party', s.duration_by_party,
        'turnaround_minutes', s.turnaround_minutes,
        'last_start_offset_minutes', s.last_start_offset_minutes,
        'last_start_local', s.last_start_local,
        'cancellation_cutoff_minutes', s.cancellation_cutoff_minutes,
        'advance_days', s.advance_days,
        'max_party_online', s.max_party_online,
        'approval_party_threshold', s.approval_party_threshold,
        'auto_confirm', s.auto_confirm,
        'hours', s.hours, 'holiday_exceptions', s.holiday_exceptions,
        'version', s.version)
      from atlas_private.booking_settings s where s.id = true)
  );
end
$function$;
revoke all on function public.atlas_bookings_config(uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_bookings_config(uuid, text) to service_role;

-- Location-aware atomic create. Pooled areas reserve guest capacity; table-mode areas
-- auto-allocate one contiguous run when no seats are explicitly selected.
create or replace function public.atlas_bookings_create(p_actor_id uuid, p_actor_role text, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
  p jsonb := coalesce(p_payload, '{}'::jsonb);
  s atlas_private.booking_settings;
  v_party integer := (p->>'party_size')::int;
  v_start timestamptz := (p->>'start_at')::timestamptz;
  v_dur interval;
  v_end timestamptz;
  v_source text := coalesce(nullif(p->>'source',''), 'phone');
  v_idem text := nullif(p->>'idempotency_key','');
  v_force_status text := nullif(p->>'status','');
  v_area_id uuid := (nullif(p->>'area_id',''))::uuid;
  v_area atlas_private.booking_areas;
  v_ref text;
  v_res_id uuid := gen_random_uuid();
  v_status text;
  v_table_ids uuid[];
  v_auto uuid;
  existing atlas_private.reservations;
  tid uuid;
  table_area_count integer;
  table_capacity integer;
begin
  if pg_catalog.jsonb_typeof(p) <> 'object' or v_party is null or v_party < 1 or v_start is null then
    raise exception 'A booking needs a party size and a start time.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_source not in ('web','phone','walk_in','dineout','other') then
    raise exception 'Unknown booking source.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  if v_idem is not null then
    select * into existing from atlas_private.reservations where idempotency_key = v_idem;
    if existing.id is not null then
      return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(existing.id), 'replayed', true);
    end if;
  end if;

  select * into s from atlas_private.booking_settings where id = true;
  v_dur := pg_catalog.make_interval(mins => least(120, atlas_private.booking_duration_minutes(v_party)));
  v_end := v_start + v_dur;

  if v_source = 'web' then
    if v_party > coalesce(s.max_party_online,30) then
      raise exception 'That party is too large for online booking.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if v_start > pg_catalog.now() + pg_catalog.make_interval(days => s.advance_days) then
      raise exception 'That date is outside the advance booking window.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    if v_start::time > s.last_start_local then
      raise exception 'That start time is later than the last online booking.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p->'table_ids') = 'array' then
    select pg_catalog.array_agg((value #>> '{}')::uuid) into v_table_ids
    from pg_catalog.jsonb_array_elements(p->'table_ids') value;
  end if;

  -- Derive the location from explicitly chosen seats when the caller omitted area_id.
  if v_area_id is null and v_table_ids is not null then
    select pg_catalog.count(distinct t.area_id), (pg_catalog.array_agg(distinct t.area_id))[1]
      into table_area_count, v_area_id
    from atlas_private.booking_tables t where t.id = any(v_table_ids);
    if table_area_count <> 1 then
      raise exception 'Selected seats must belong to one location.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;
  -- Backward-compatible staff fallback: if there is exactly one table-mode area, use it.
  if v_area_id is null then
    select a.id into v_area_id
    from atlas_private.booking_areas a
    where a.is_active and a.allocation_mode = 'tables'
    order by a.display_order, a.name
    limit 1;
  end if;

  select * into v_area from atlas_private.booking_areas a where a.id = v_area_id for update;
  if v_area.id is null then
    raise exception 'Choose a booking location.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;
  if v_area.guest_capacity is not null and v_party > v_area.guest_capacity then
    raise exception 'That party is larger than this location can hold.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  if v_force_status in ('confirmed','requested') then
    v_status := v_force_status;
  elsif v_source = 'web' and not coalesce(s.auto_confirm,false) then
    v_status := 'requested';
  elsif v_table_ids is null and v_party >= coalesce(s.approval_party_threshold,7) and v_source = 'web' then
    v_status := 'requested';
  elsif coalesce(s.auto_confirm,false) then
    v_status := 'confirmed';
  else
    v_status := case when v_source in ('phone','walk_in') then 'confirmed' else 'requested' end;
  end if;

  if v_status = 'confirmed' and v_area.allocation_mode = 'pooled' then
    if not atlas_private.booking_pooled_area_has_capacity(v_area.id, v_start, v_end, v_party, null) then
      raise exception 'That location does not have enough guest capacity for this time.' using errcode = '23505', hint = 'atlas:conflict';
    end if;
    v_table_ids := null;
  elsif v_status = 'confirmed' then
    if v_table_ids is null then
      v_table_ids := atlas_private.booking_find_contiguous_tables(v_area.id, v_party, v_start, v_end, null);
      -- Compatibility for table-mode areas that do not use position_index.
      if v_table_ids is null then
        select t.id into v_auto
        from atlas_private.booking_tables t
        where t.area_id = v_area.id and t.is_bookable and not t.temporarily_unavailable
          and t.seat_capacity >= v_party and t.min_party <= v_party
          and atlas_private.booking_table_free(t.id, v_start, v_end, null)
        order by t.seat_capacity, t.priority, t.label
        limit 1
        for update;
        if v_auto is not null then v_table_ids := array[v_auto]; end if;
      end if;
      if v_table_ids is null then
        raise exception 'No adjacent seats are free for that time and party.' using errcode = '23505', hint = 'atlas:conflict';
      end if;
    end if;

    perform 1 from atlas_private.booking_tables t where t.id = any(v_table_ids) order by t.id for update;
    if (select pg_catalog.count(*) from atlas_private.booking_tables t
        where t.id = any(v_table_ids) and t.area_id = v_area.id) <> pg_catalog.array_length(v_table_ids,1) then
      raise exception 'Selected seats do not belong to this location.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    select coalesce(pg_catalog.sum(t.seat_capacity),0)::int into table_capacity
    from atlas_private.booking_tables t where t.id = any(v_table_ids);
    if table_capacity < v_party then
      raise exception 'Choose enough seats for this party.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
    foreach tid in array v_table_ids loop
      if not atlas_private.booking_table_free(tid, v_start, v_end, null) then
        raise exception 'A selected seat is no longer free for the requested time.' using errcode = '23505', hint = 'atlas:conflict';
      end if;
    end loop;
  end if;

  v_ref := atlas_private.booking_new_reference();
  insert into atlas_private.reservations (
    id, area_id, source, status, start_at, end_at, party_size, guest_name, guest_phone, guest_email,
    guest_requests, staff_notes, booking_reference, provider_ref, idempotency_key,
    created_by, created_by_label, created_by_role)
  values (v_res_id, v_area.id, v_source, v_status, v_start, v_end, v_party,
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_name','')),160),''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_phone','')),40),''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_email','')),200),''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'guest_requests','')),2000),''),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p->>'staff_notes','')),2000),''),
    v_ref, nullif(p->>'provider_ref',''), v_idem, p_actor_id, label, p_actor_role);

  if v_status = 'confirmed' and v_area.allocation_mode = 'tables' then
    foreach tid in array v_table_ids loop
      insert into atlas_private.reservation_tables (reservation_id, table_id, start_at, end_at)
      values (v_res_id, tid, v_start, v_end);
    end loop;
  end if;

  insert into atlas_private.reservation_status_history
    (reservation_id, from_status, to_status, changed_by, changed_by_label, changed_by_role, note)
  values (v_res_id, null, v_status, p_actor_id, label, p_actor_role, 'created');
  insert into atlas_private.booking_events
    (event_type, reservation_id, actor_id, actor_label, actor_role, payload)
  values ('reservation_created', v_res_id, p_actor_id, label, p_actor_role,
    pg_catalog.jsonb_build_object('status',v_status,'source',v_source,'party_size',v_party,'area_id',v_area.id));

  return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(v_res_id), 'replayed', false);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid booking.' using errcode = '22023', hint = 'atlas:invalid_request';
end
$function$;
revoke all on function public.atlas_bookings_create(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.atlas_bookings_create(uuid, text, jsonb) to service_role;

-- Pooled reservations can be approved without a physical table; table-mode requests
-- still require a seat allocation before confirmation.
create or replace function public.atlas_bookings_set_status(
  p_actor_id uuid, p_actor_role text, p_reservation_id uuid, p_to_status text, p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  label text := atlas_private.booking_require_staff(p_actor_id, p_actor_role);
  r atlas_private.reservations;
  a atlas_private.booking_areas;
  allowed text[];
begin
  select * into r from atlas_private.reservations where id = p_reservation_id for update;
  if r.id is null then raise exception 'Booking not found.' using errcode = 'P0002', hint = 'atlas:not_found'; end if;
  if p_to_status not in ('requested','confirmed','arrived','seated','completed','cancelled','no_show') then
    raise exception 'Unknown status.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  allowed := case r.status
    when 'requested' then array['confirmed','cancelled','no_show']
    when 'confirmed' then array['arrived','seated','completed','cancelled','no_show']
    when 'arrived'   then array['seated','completed','cancelled','no_show']
    when 'seated'    then array['completed','cancelled']
    else array[]::text[] end;
  if p_to_status = r.status then
    return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(r.id), 'unchanged', true);
  end if;
  if not (p_to_status = any(allowed)) then
    raise exception 'That status change is not allowed.' using errcode = '22023', hint = 'atlas:invalid_request';
  end if;

  if r.status = 'requested' and p_to_status = 'confirmed' then
    select * into a from atlas_private.booking_areas where id = r.area_id for update;
    if a.allocation_mode = 'pooled' then
      if not atlas_private.booking_pooled_area_has_capacity(a.id, r.start_at, r.end_at, r.party_size, r.id) then
        raise exception 'That location no longer has enough guest capacity.' using errcode = '23505', hint = 'atlas:conflict';
      end if;
    elsif not exists (
      select 1 from atlas_private.reservation_tables rt
      where rt.reservation_id = r.id and rt.released_at is null
    ) then
      raise exception 'Assign seats before confirming this booking.' using errcode = '22023', hint = 'atlas:invalid_request';
    end if;
  end if;

  update atlas_private.reservations set status = p_to_status where id = r.id;
  if p_to_status in ('cancelled','no_show','completed') then
    update atlas_private.reservation_tables set released_at = pg_catalog.now()
    where reservation_id = r.id and released_at is null;
    update atlas_private.booking_holds set expires_at = pg_catalog.now()
    where reservation_id = r.id and expires_at > pg_catalog.now();
  end if;

  insert into atlas_private.reservation_status_history
    (reservation_id, from_status, to_status, changed_by, changed_by_label, changed_by_role, note)
  values (r.id, r.status, p_to_status, p_actor_id, label, p_actor_role,
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_note,'')),500),''));
  insert into atlas_private.booking_events
    (event_type, reservation_id, actor_id, actor_label, actor_role, payload)
  values ('status_changed', r.id, p_actor_id, label, p_actor_role,
    pg_catalog.jsonb_build_object('from',r.status,'to',p_to_status));
  return pg_catalog.jsonb_build_object('reservation', atlas_private.booking_reservation_json(r.id), 'unchanged', false);
end
$function$;
revoke all on function public.atlas_bookings_set_status(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.atlas_bookings_set_status(uuid, text, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
