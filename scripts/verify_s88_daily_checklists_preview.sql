-- S88 preview-only shared daily checklist acceptance. Rolled back.
--
-- Covers: the seeded opening/closing templates (9 + 9 items, no invented
-- times), idempotent instance creation, no daily-checklist alerts, audited
-- ticks with who/when, the database-side writer check (bartender and manager
-- allowed; viewer, deactivated and unknown profiles refused), the closed-day
-- guard, and that browsers (anon/authenticated) cannot call the RPCs.

begin;

create temporary table s88_checklists (test_name text primary key, passed boolean not null) on commit drop;
grant all on table s88_checklists to anon, authenticated, service_role;

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088201','authenticated','authenticated','s88-check-mgr@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088202','authenticated','authenticated','s88-check-bar@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088203','authenticated','authenticated','s88-check-view@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now()),
  ((select id from auth.instances limit 1),'00000000-0000-4000-8000-000000088204','authenticated','authenticated','s88-check-off@example.invalid','',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.profiles (id,email,display_name,role,active) values
  ('00000000-0000-4000-8000-000000088201','s88-check-mgr@example.invalid','S88 manager','manager',true),
  ('00000000-0000-4000-8000-000000088202','s88-check-bar@example.invalid','S88 bartender','bartender',true),
  ('00000000-0000-4000-8000-000000088203','s88-check-view@example.invalid','S88 viewer','viewer',true),
  ('00000000-0000-4000-8000-000000088204','s88-check-off@example.invalid','S88 former manager','manager',false)
on conflict (id) do update set role=excluded.role, active=excluded.active, display_name=excluded.display_name;

delete from atlas_private.settings_business_hours;

insert into s88_checklists values ('opening and closing templates are seeded as daily business-date routines', (
  select count(*) = 2
  from atlas_private.routine_templates template
  where template.template_key in ('daily-opening-checklist','daily-closing-checklist')
    and template.routine_type in ('opening','closing') and template.recurrence='daily'
    and template.days_of_week = array[0,1,2,3,4,5,6]::smallint[]
    and template.date_basis='business' and template.active));
insert into s88_checklists values ('no due or availability time is invented', not exists (
  select 1 from atlas_private.routine_templates template
  where template.template_key in ('daily-opening-checklist','daily-closing-checklist')
    and (template.due_time is not null or template.available_from is not null)));
insert into s88_checklists values ('each checklist has nine required items with the S87 ids', (
  select count(*) filter (where template.template_key='daily-opening-checklist') = 9
     and count(*) filter (where template.template_key='daily-closing-checklist') = 9
     and bool_and(item.required and item.active)
     and count(*) filter (where item.item_key in ('cash-pos','tablet','cash-close','shift-report')) = 4
  from atlas_private.routine_template_items item
  join atlas_private.routine_templates template on template.id=item.template_id
  where template.template_key in ('daily-opening-checklist','daily-closing-checklist')));

set role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $probe$
declare
  today date := public.atlas_operations_business_date();
  first_read jsonb;
  second_read jsonb;
  snapshot jsonb;
  opening_id uuid;
  opening_item uuid;
  closing_id uuid;
  closing_item uuid;
  old_read jsonb;
  old_instance uuid;
  old_item uuid;
  failed boolean;
  sqlstate_value text;
begin
  first_read := public.atlas_operations_daily_checklists(null);
  second_read := public.atlas_operations_daily_checklists(today);
  insert into s88_checklists values ('default date is the current business date',
    (first_read->>'business_date')::date = today and (first_read->>'current_business_date')::date = today);
  insert into s88_checklists values ('both checklists are returned and configured',
    (first_read->>'configured')::boolean and first_read->'opening'->>'routine_type' = 'opening'
    and first_read->'closing'->>'routine_type' = 'closing'
    and jsonb_array_length(first_read->'opening'->'items') = 9);
  insert into s88_checklists values ('instances are created once per business date', (
    select count(*) = 2 from atlas_private.routine_instances instance
    join atlas_private.routine_templates template on template.id=instance.template_id
    where instance.scheduled_date=today and template.routine_type in ('opening','closing'))
    and first_read->'opening'->>'id' = second_read->'opening'->>'id');

  snapshot := public.atlas_operations_today(today);
  insert into s88_checklists values ('operations snapshot exposes the business date',
    (snapshot->>'business_date')::date = today and snapshot ? 'timezone');
  insert into s88_checklists values ('daily checklists never raise alerts', not exists (
    select 1 from jsonb_array_elements(snapshot->'alerts') alert
    where alert->>'routine_id' in (first_read->'opening'->>'id', first_read->'closing'->>'id')));

  opening_id := (first_read->'opening'->>'id')::uuid;
  opening_item := (first_read->'opening'->'items'->0->>'id')::uuid;
  closing_id := (first_read->'closing'->>'id')::uuid;
  closing_item := (first_read->'closing'->'items'->0->>'id')::uuid;

  perform public.atlas_operations_set_item(opening_id, opening_item, true, null,
    '{"source":"device_checklist_import_s88"}'::jsonb,
    '00000000-0000-4000-8000-000000088202','S88 bartender');
  second_read := public.atlas_operations_daily_checklists(today);
  insert into s88_checklists values ('a bartender tick is shared with who and when',
    (second_read->'opening'->'items'->0->>'completed')::boolean
    and second_read->'opening'->'items'->0->>'completed_by_label' = 'S88 bartender'
    and second_read->'opening'->'items'->0->>'completed_at' is not null
    and second_read->'opening'->>'status' = 'in_progress');
  insert into s88_checklists values ('the tick stores the actor and an audit event', exists (
    select 1 from atlas_private.routine_item_results result
    where result.instance_id=opening_id and result.template_item_id=opening_item
      and result.completed and result.completed_by='00000000-0000-4000-8000-000000088202')
    and exists (
    select 1 from atlas_private.operations_events event
    where event.entity_id=opening_id and event.event_type='routine_item_updated'
      and event.actor_id='00000000-0000-4000-8000-000000088202'
      and event.payload->>'item_key' = 'cash-pos'
      and event.payload->>'evidence_source' = 'device_checklist_import_s88'));

  perform public.atlas_operations_set_item(opening_id, opening_item, false, null, '{}'::jsonb,
    '00000000-0000-4000-8000-000000088201','S88 manager');
  insert into s88_checklists values ('a manager can untick and the untick is audited',
    not exists (select 1 from atlas_private.routine_item_results result
      where result.instance_id=opening_id and result.template_item_id=opening_item and result.completed)
    and (select count(*) from atlas_private.operations_events event
      where event.entity_id=opening_id and event.event_type='routine_item_updated') = 2);

  failed := false;
  begin
    perform public.atlas_operations_set_item(closing_id, closing_item, true, null, '{}'::jsonb,
      '00000000-0000-4000-8000-000000088203','S88 viewer');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_checklists values ('a viewer cannot tick', failed and sqlstate_value = '42501');

  failed := false;
  begin
    perform public.atlas_operations_set_item(closing_id, closing_item, true, null, '{}'::jsonb,
      '00000000-0000-4000-8000-000000088204','S88 former manager');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_checklists values ('a deactivated manager cannot tick', failed and sqlstate_value = '42501');

  failed := false;
  begin
    perform public.atlas_operations_set_item(closing_id, closing_item, true, null, '{}'::jsonb,
      '00000000-0000-4000-8000-000000088299','Unknown');
  exception when others then failed := true; sqlstate_value := sqlstate;
  end;
  insert into s88_checklists values ('an unknown actor cannot tick', failed and sqlstate_value = '42501');
  insert into s88_checklists values ('refused ticks leave no result', not exists (
    select 1 from atlas_private.routine_item_results result where result.instance_id=closing_id));

  old_read := public.atlas_operations_daily_checklists(today - 2);
  insert into s88_checklists values ('an older business day is read-only', (old_read->>'editable')::boolean = false
    and (public.atlas_operations_daily_checklists(today - 1)->>'editable')::boolean);
  old_instance := (old_read->'closing'->>'id')::uuid;
  old_item := (old_read->'closing'->'items'->0->>'id')::uuid;
  failed := false;
  begin
    perform public.atlas_operations_set_item(old_instance, old_item, true, null, '{}'::jsonb,
      '00000000-0000-4000-8000-000000088201','S88 manager');
  exception when others then failed := true;
  end;
  insert into s88_checklists values ('ticks on a closed checklist day are refused', failed);

  failed := false;
  begin
    perform public.atlas_operations_daily_checklists(today + 5);
  exception when others then failed := true;
  end;
  insert into s88_checklists values ('checklists far in the future are refused', failed);
end
$probe$;

reset role;

set role anon;
do $probe$
declare denied boolean := false;
begin
  begin
    perform public.atlas_operations_daily_checklists(null);
  exception when insufficient_privilege then denied := true;
  end;
  insert into s88_checklists values ('anon cannot read the checklists RPC', denied);
end
$probe$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000088201',true);
do $probe$
declare denied boolean := false;
begin
  begin
    perform public.atlas_operations_set_item(gen_random_uuid(), gen_random_uuid(), true, null, '{}'::jsonb,
      '00000000-0000-4000-8000-000000088201','S88 manager');
  exception when insufficient_privilege then denied := true;
  end;
  insert into s88_checklists values ('an authenticated browser cannot write a tick directly', denied);
end
$probe$;
reset role;

insert into s88_checklists values ('no public.atlas_operations_* function is executable by anon or authenticated', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'atlas\_operations\_%'
    and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))));

select jsonb_build_object(
  's88_daily_checklists', case when bool_and(passed) then 'passed' else 'failed' end,
  'passed_count', count(*) filter (where passed),
  'failed_count', count(*) filter (where not passed),
  'tests', jsonb_agg(jsonb_build_object('test', test_name, 'passed', passed) order by test_name)
) from s88_checklists;

rollback;
