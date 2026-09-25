-- S88 venue clock: one server-side source for the venue time zone, the venue
-- calendar date, the business date and the saved business hours.
--
-- * The venue time zone is Settings -> venue.timezone when it is a known IANA
--   zone, otherwise the documented default Atlantic/Reykjavik.
-- * The business date is the previous calendar date while the venue is still
--   inside the previous day's after-midnight close (close_next_day). With no
--   hours row it is the venue calendar date. Nothing is invented.
-- * settings_venue_clock is a lightweight read for every active role, so Home,
--   Brain, Shifts and Operations no longer rely on the manager-only Settings
--   snapshot or on hard-coded hours.
-- * Unknown time zones are refused when they are written (venue section and
--   per-user preferences).
--
-- Path B (browser -> Edge Function -> service-role RPC). No table is created
-- and no row is changed.

create or replace function atlas_private.is_valid_time_zone(p_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select p_name is not null
    and pg_catalog.btrim(p_name) = p_name
    and p_name <> ''
    and exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = p_name);
$function$;

create or replace function atlas_private.venue_timezone()
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce((
    select section.settings_value->>'timezone'
    from atlas_private.settings_sections section
    where section.section_key = 'venue'
      and atlas_private.is_valid_time_zone(section.settings_value->>'timezone')
  ), 'Atlantic/Reykjavik');
$function$;

create or replace function atlas_private.venue_date(p_at timestamptz default pg_catalog.now())
returns date
language sql
stable
security invoker
set search_path = ''
as $function$
  select (coalesce(p_at, pg_catalog.now()) at time zone atlas_private.venue_timezone())::date;
$function$;

-- Before the previous day's after-midnight close it is still the previous
-- business day. Weekday 0 = Sunday, matching settings_business_hours.
create or replace function atlas_private.venue_business_date(p_at timestamptz default pg_catalog.now())
returns date
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  local_ts timestamp := coalesce(p_at, pg_catalog.now()) at time zone atlas_private.venue_timezone();
  local_day date := local_ts::date;
  previous_close time without time zone;
begin
  select hours.close_time into previous_close
  from atlas_private.settings_business_hours hours
  where hours.weekday = extract(dow from local_day - 1)::smallint
    and hours.is_open
    and hours.close_next_day
    and hours.close_time is not null;
  if found and local_ts::time < previous_close then
    return local_day - 1;
  end if;
  return local_day;
end;
$function$;

create or replace function atlas_private.settings_venue_clock(p_actor_role text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  zone text;
  rows_count integer;
  configured_zone text;
begin
  -- settings_assert_actor lets a NULL role through (NULL NOT IN (...)).
  if p_actor_role is null then
    raise exception 'An active Atlas role is required';
  end if;
  perform atlas_private.settings_assert_actor(p_actor_role, false, false);
  zone := atlas_private.venue_timezone();
  select section.settings_value->>'timezone' into configured_zone
  from atlas_private.settings_sections section
  where section.section_key = 'venue';
  select count(*) into rows_count from atlas_private.settings_business_hours;

  return jsonb_build_object(
    'timezone', zone,
    'timezone_source', case when atlas_private.is_valid_time_zone(configured_zone) then 'settings' else 'default' end,
    'hours_configured', rows_count = 7,
    'business_hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday', hours.weekday, 'day_label', hours.day_label, 'is_open', hours.is_open,
        'open_time', hours.open_time, 'close_time', hours.close_time,
        'close_next_day', hours.close_next_day,
        'kitchen_close_time', hours.kitchen_close_time,
        'kitchen_close_next_day', hours.kitchen_close_next_day,
        'last_order_time', hours.last_order_time,
        'last_order_next_day', hours.last_order_next_day,
        'updated_at', hours.updated_at
      ) order by hours.weekday)
      from atlas_private.settings_business_hours hours
    ), '[]'::jsonb),
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'offer_key', offer.offer_key, 'name', offer.name, 'days', offer.days,
        'start_time', offer.start_time, 'end_time', offer.end_time,
        'end_next_day', offer.end_next_day
      ) order by offer.start_time, offer.name)
      from atlas_private.settings_offers offer
      where offer.active
    ), '[]'::jsonb),
    'venue_date', atlas_private.venue_date(),
    'business_date', atlas_private.venue_business_date(),
    'venue_local_time', pg_catalog.to_char(pg_catalog.now() at time zone zone, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'generated_at', pg_catalog.now()
  );
end;
$function$;

create or replace function public.atlas_settings_venue_clock(p_actor_role text)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select atlas_private.settings_venue_clock(p_actor_role);
$function$;

create or replace function public.atlas_venue_business_date(p_at timestamptz default pg_catalog.now())
returns date
language sql
stable
set search_path = ''
as $function$
  select atlas_private.venue_business_date(p_at);
$function$;

-- Refuse an unknown IANA zone at write time. settings_save_section stores the
-- venue JSON as given, so the guard sits on the table. A venue row without a
-- timezone key keeps the documented default.
create or replace function atlas_private.settings_venue_timezone_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.section_key = 'venue'
     and new.settings_value ? 'timezone'
     and not atlas_private.is_valid_time_zone(new.settings_value->>'timezone') then
    raise exception 'Unknown time zone %', coalesce(nullif(new.settings_value->>'timezone', ''), '(empty)')
      using errcode = '22023', hint = 'atlas:invalid_time_zone';
  end if;
  return new;
end;
$function$;

drop trigger if exists settings_sections_s88_timezone_guard on atlas_private.settings_sections;
create trigger settings_sections_s88_timezone_guard
  before insert or update on atlas_private.settings_sections
  for each row execute function atlas_private.settings_venue_timezone_guard();

create or replace function atlas_private.settings_preference_timezone_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if not atlas_private.is_valid_time_zone(new.timezone) then
    raise exception 'Unknown time zone %', coalesce(nullif(new.timezone, ''), '(empty)')
      using errcode = '22023', hint = 'atlas:invalid_time_zone';
  end if;
  return new;
end;
$function$;

drop trigger if exists settings_user_preferences_s88_timezone_guard on atlas_private.settings_user_preferences;
create trigger settings_user_preferences_s88_timezone_guard
  before insert or update of timezone on atlas_private.settings_user_preferences
  for each row execute function atlas_private.settings_preference_timezone_guard();

do $s88_venue_clock_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'atlas_private' and p.proname in (
        'is_valid_time_zone', 'venue_timezone', 'venue_date', 'venue_business_date',
        'settings_venue_clock', 'settings_venue_timezone_guard', 'settings_preference_timezone_guard'))
       or (n.nspname = 'public' and p.proname in ('atlas_settings_venue_clock', 'atlas_venue_business_date'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', function_row.signature);
    execute format('grant execute on function %s to service_role', function_row.signature);
  end loop;
end
$s88_venue_clock_grants$;

comment on function public.atlas_settings_venue_clock(text) is
  'S88 service-role-only venue clock (time zone, business hours, offers, venue and business date) for every active Atlas role.';
comment on function atlas_private.venue_business_date(timestamptz) is
  'S88 business date: the previous date while inside the previous day''s after-midnight close; otherwise the venue date.';

notify pgrst, 'reload schema';
