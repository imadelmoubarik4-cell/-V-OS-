-- S88 preview-only venue clock acceptance. Rolled back.
--
-- Covers: hours_configured with 0 and 7 rows, the business date across an
-- after-midnight close, the configured venue time zone, time-zone validation
-- on write (venue section and preferences), and the role boundary: every
-- active role reads the clock through the service role, unknown roles are
-- refused, and anon/authenticated browsers cannot call the RPCs directly.

begin;

create temporary table s88_clock (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s88_clock to anon, authenticated, service_role;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088101','authenticated','authenticated','s88-clock-mgr@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select (select id from auth.instances limit 1), v.id, 'authenticated','authenticated', v.email,'',now(),'{}'::jsonb,'{}'::jsonb,now(),now()
from (values
  ('00000000-0000-4000-8000-000000088102'::uuid,'s88-clock-viewer@example.invalid'),
  ('00000000-0000-4000-8000-000000088103'::uuid,'s88-clock-bar@example.invalid'),
  ('00000000-0000-4000-8000-000000088104'::uuid,'s88-clock-admin@example.invalid'),
  ('00000000-0000-4000-8000-000000088105'::uuid,'s88-clock-gone@example.invalid')) v(id,email);
insert into public.profiles (id,email,display_name,role,active)
values ('00000000-0000-4000-8000-000000088101','s88-clock-mgr@example.invalid','S88 clock manager','manager',true),
       ('00000000-0000-4000-8000-000000088102','s88-clock-viewer@example.invalid','S88 clock viewer','viewer',true),
       ('00000000-0000-4000-8000-000000088103','s88-clock-bar@example.invalid','S88 clock bartender','bartender',true),
       ('00000000-0000-4000-8000-000000088104','s88-clock-admin@example.invalid','S88 clock admin','admin',true),
       ('00000000-0000-4000-8000-000000088105','s88-clock-gone@example.invalid','S88 clock former','bartender',false)
on conflict (id) do update set role=excluded.role, active=excluded.active;

-- Production has no hours rows; start from that state.
delete from atlas_private.settings_business_hours;
update atlas_private.settings_sections
set settings_value = jsonb_set(settings_value,'{timezone}','"Atlantic/Reykjavik"'::jsonb,true)
where section_key='venue';

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $probe$
declare
  clock jsonb;
  failed boolean;
begin
  clock := public.atlas_settings_venue_clock('viewer', '00000000-0000-4000-8000-000000088102');
  insert into s88_clock values ('no hours rows: hours_configured is false', (clock->>'hours_configured')::boolean = false);
  insert into s88_clock values ('no hours rows: empty business_hours', clock->'business_hours' = '[]'::jsonb);
  insert into s88_clock values ('clock reports the configured zone from Settings',
    clock->>'timezone' = 'Atlantic/Reykjavik' and clock->>'timezone_source' = 'settings');
  insert into s88_clock values ('no hours rows: business date is the venue date',
    atlas_private.venue_business_date('2026-09-26 01:30+00') = date '2026-09-26');
  insert into s88_clock values ('clock returns venue_date, business_date and local time',
    clock ? 'venue_date' and clock ? 'business_date' and clock ? 'venue_local_time');

  insert into s88_clock values ('bartender can read the clock', public.atlas_settings_venue_clock('bartender', '00000000-0000-4000-8000-000000088103') ? 'timezone');
  insert into s88_clock values ('manager can read the clock', public.atlas_settings_venue_clock('manager', '00000000-0000-4000-8000-000000088101') ? 'timezone');
  insert into s88_clock values ('admin can read the clock', public.atlas_settings_venue_clock('admin', '00000000-0000-4000-8000-000000088104') ? 'timezone');

  failed := false;
  begin
    perform public.atlas_settings_venue_clock('nobody', '00000000-0000-4000-8000-000000088101');
  exception when others then failed := true;
  end;
  insert into s88_clock values ('unknown role is refused', failed);

  failed := false;
  begin
    perform public.atlas_settings_venue_clock(null, '00000000-0000-4000-8000-000000088101');
  exception when others then failed := true;
  end;
  insert into s88_clock values ('missing role is refused', failed);

  -- S88 hardening F7: the claimed role is re-checked against the active profile.
  failed := false;
  begin
    perform public.atlas_settings_venue_clock('admin', '00000000-0000-4000-8000-000000088103');
  exception when insufficient_privilege then failed := true;
  end;
  insert into s88_clock values ('a claimed role that is not the profile role is refused', failed);

  failed := false;
  begin
    perform public.atlas_settings_venue_clock('bartender', '00000000-0000-4000-8000-000000088105');
  exception when insufficient_privilege then failed := true;
  end;
  insert into s88_clock values ('an inactive profile is refused', failed);

  failed := false;
  begin
    perform public.atlas_settings_venue_clock('manager', null);
  exception when insufficient_privilege then failed := true;
  end;
  insert into s88_clock values ('a missing actor id is refused', failed);

  insert into s88_clock values ('the role-only venue clock signature no longer exists',
    to_regprocedure('public.atlas_settings_venue_clock(text)') is null);
end
$probe$;

reset role;
insert into atlas_private.settings_business_hours(weekday,day_label,is_open,open_time,close_time,close_next_day)
values
  (0,'Sunday',true,'15:00','23:00',false),
  (1,'Monday',false,null,null,false),
  (2,'Tuesday',true,'15:00','23:00',false),
  (3,'Wednesday',true,'15:00','23:00',false),
  (4,'Thursday',true,'15:00','00:00',true),
  (5,'Friday',true,'15:00','03:00',true),
  (6,'Saturday',true,'15:00','03:00',true);
set role service_role;

do $probe$
declare clock jsonb;
begin
  clock := public.atlas_settings_venue_clock('viewer', '00000000-0000-4000-8000-000000088102');
  insert into s88_clock values ('seven rows: hours_configured is true', (clock->>'hours_configured')::boolean);
  insert into s88_clock values ('seven rows: business_hours ordered Sunday first',
    jsonb_array_length(clock->'business_hours') = 7 and (clock->'business_hours'->0->>'weekday')::int = 0);
  -- 2026-09-26 is a Saturday. Friday closes 03:00 the next day.
  insert into s88_clock values ('Sat 01:30 after a Fri 03:00 close is still Friday',
    public.atlas_venue_business_date('2026-09-26 01:30+00') = date '2026-09-25');
  insert into s88_clock values ('Sat 03:30 is Saturday',
    public.atlas_venue_business_date('2026-09-26 03:30+00') = date '2026-09-26');
  insert into s88_clock values ('Thursday midnight close ends the business day at 00:00',
    atlas_private.venue_business_date('2026-09-25 00:10+00') = date '2026-09-25');
  -- 2026-09-22 is a Tuesday; Monday is closed, so there is no carry-over.
  insert into s88_clock values ('closed previous day never carries over',
    atlas_private.venue_business_date('2026-09-22 01:00+00') = date '2026-09-22');
end
$probe$;

reset role;
update atlas_private.settings_sections
set settings_value = jsonb_set(settings_value,'{timezone}','"Pacific/Auckland"'::jsonb,true)
where section_key='venue';
set role service_role;

do $probe$
begin
  insert into s88_clock values ('a configured zone moves the venue date',
    atlas_private.venue_timezone() = 'Pacific/Auckland'
    and atlas_private.venue_date('2026-09-26 13:00+00') = date '2026-09-27');
end
$probe$;

reset role;

do $probe$
declare failed boolean := false; sqlstate_value text;
begin
  begin
    update atlas_private.settings_sections
    set settings_value = jsonb_set(settings_value,'{timezone}','"Mars/Base"'::jsonb,true)
    where section_key='venue';
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_clock values ('unknown venue time zone is refused on write', failed and sqlstate_value = '22023');

  failed := false;
  begin
    perform atlas_private.settings_save_section('venue',
      (select jsonb_set(settings_value,'{timezone}','""'::jsonb) from atlas_private.settings_sections where section_key='venue'),
      (select version from atlas_private.settings_sections where section_key='venue'),
      '00000000-0000-4000-8000-000000088101','S88 clock manager','manager');
  exception when others then failed := true;
  end;
  insert into s88_clock values ('empty venue time zone is refused through settings_save_section', failed);

  perform atlas_private.settings_save_section('venue',
    (select jsonb_set(settings_value,'{timezone}','"Europe/London"'::jsonb) from atlas_private.settings_sections where section_key='venue'),
    (select version from atlas_private.settings_sections where section_key='venue'),
    '00000000-0000-4000-8000-000000088101','S88 clock manager','manager');
  insert into s88_clock values ('a valid venue time zone saves through settings_save_section',
    atlas_private.venue_timezone() = 'Europe/London');

  failed := false;
  begin
    perform atlas_private.settings_save_preferences('00000000-0000-4000-8000-000000088101','dark','comfortable','en','briefing',
      'Nowhere/Town',false,false,false,'{}'::jsonb,'00000000-0000-4000-8000-000000088101','S88 clock manager','manager');
  exception when others then failed := true;
  end;
  insert into s88_clock values ('unknown preference time zone is refused', failed);
end
$probe$;

-- A stored invalid zone (for example written before this migration) falls
-- back to the documented default instead of breaking every date.
set local session_replication_role = replica;
update atlas_private.settings_sections
set settings_value = jsonb_set(settings_value,'{timezone}','"Mars/Base"'::jsonb,true)
where section_key='venue';
set local session_replication_role = origin;
insert into s88_clock values ('stored invalid zone falls back to the default',
  atlas_private.venue_timezone() = 'Atlantic/Reykjavik'
  and atlas_private.settings_venue_clock('viewer')->>'timezone_source' = 'default');

set role anon;
do $probe$
declare denied boolean := false;
begin
  begin
    perform public.atlas_settings_venue_clock('viewer', '00000000-0000-4000-8000-000000088102');
  exception when insufficient_privilege then denied := true;
  end;
  insert into s88_clock values ('anon cannot call the venue clock RPC', denied);
end
$probe$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088101',true);
do $probe$
declare denied_clock boolean := false; denied_date boolean := false;
begin
  begin
    perform public.atlas_settings_venue_clock('manager', '00000000-0000-4000-8000-000000088101');
  exception when insufficient_privilege then denied_clock := true;
  end;
  begin
    perform public.atlas_venue_business_date();
  exception when insufficient_privilege then denied_date := true;
  end;
  insert into s88_clock values ('an authenticated manager browser cannot bypass the Edge Function', denied_clock and denied_date);
end
$probe$;

reset role;

insert into s88_clock values ('no S88 clock function is executable by anon or authenticated', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where ((n.nspname='public' and p.proname in ('atlas_settings_venue_clock','atlas_venue_business_date'))
      or (n.nspname='atlas_private' and p.proname in ('venue_timezone','venue_date','venue_business_date','settings_venue_clock','is_valid_time_zone')))
    and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))));

select jsonb_build_object(
  's88_venue_clock', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s88_clock;

rollback;
