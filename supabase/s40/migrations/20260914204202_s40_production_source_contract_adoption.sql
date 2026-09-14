-- Atlas S40 compatibility replacement for the unapplied S39 source-contract step.
--
-- Production already contains the public onboarding and published-shift tables.
-- This migration validates and adopts those relations without changing their
-- columns or rows, adds only missing indexes, and creates the missing private
-- report-events contract. It is intentionally safe to retry transactionally.

set lock_timeout = '5s';
set statement_timeout = '2min';

do $preflight$
declare
  contract record;
  actual_type text;
  required_policy record;
  relation_name text;
begin
  if to_regprocedure('private.is_active_staff()') is null
     or to_regprocedure('private.is_manager_or_admin()') is null
     or to_regprocedure('private.is_self_or_manager(uuid)') is null then
    raise exception 'S40 source-contract adoption requires the applied Phase 1 authorization baseline';
  end if;

  if to_regnamespace('atlas_private') is null then
    raise exception 'S40 source-contract adoption requires the applied S33 runtime schema';
  end if;

  foreach relation_name in array array[
    'public.onboarding_tasks',
    'public.onboarding_progress',
    'public.shifts'
  ] loop
    if to_regclass(relation_name) is null then
      raise exception 'S40 cannot adopt missing production relation: %', relation_name;
    end if;
  end loop;

  for contract in
    select * from (values
      ('public', 'onboarding_tasks', 'id', 'uuid'),
      ('public', 'onboarding_tasks', 'title', 'text'),
      ('public', 'onboarding_tasks', 'description', 'text'),
      ('public', 'onboarding_tasks', 'category', 'text'),
      ('public', 'onboarding_tasks', 'sort_order', 'integer'),
      ('public', 'onboarding_tasks', 'required', 'boolean'),
      ('public', 'onboarding_tasks', 'active', 'boolean'),
      ('public', 'onboarding_progress', 'id', 'uuid'),
      ('public', 'onboarding_progress', 'task_id', 'uuid'),
      ('public', 'onboarding_progress', 'user_id', 'uuid'),
      ('public', 'onboarding_progress', 'completed_at', 'timestamp with time zone'),
      ('public', 'onboarding_progress', 'completed_by', 'uuid'),
      ('public', 'onboarding_progress', 'note', 'text'),
      ('public', 'shifts', 'id', 'uuid'),
      ('public', 'shifts', 'user_id', 'uuid'),
      ('public', 'shifts', 'role_name', 'text'),
      ('public', 'shifts', 'starts_at', 'timestamp with time zone'),
      ('public', 'shifts', 'ends_at', 'timestamp with time zone'),
      ('public', 'shifts', 'status', 'text'),
      ('public', 'shifts', 'note', 'text'),
      ('public', 'shifts', 'created_at', 'timestamp with time zone'),
      ('public', 'shifts', 'updated_at', 'timestamp with time zone')
    ) as required_columns(schema_name, table_name, column_name, expected_type)
  loop
    select pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod)
      into actual_type
    from pg_catalog.pg_attribute as attribute_row
    join pg_catalog.pg_class as class_row on class_row.oid = attribute_row.attrelid
    join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = contract.schema_name
      and class_row.relname = contract.table_name
      and attribute_row.attname = contract.column_name
      and attribute_row.attnum > 0
      and not attribute_row.attisdropped;

    if actual_type is distinct from contract.expected_type then
      raise exception 'S40 source-contract mismatch for %.%.%: expected %, found %',
        contract.schema_name, contract.table_name, contract.column_name,
        contract.expected_type, coalesce(actual_type, 'missing');
    end if;
  end loop;

  foreach relation_name in array array[
    'public.onboarding_tasks',
    'public.onboarding_progress',
    'public.shifts'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid = to_regclass(relation_name)
        and constraint_row.contype = 'p'
    ) then
      raise exception 'S40 source-contract adoption requires a primary key on %', relation_name;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_class as class_row
      where class_row.oid = to_regclass(relation_name)
        and class_row.relrowsecurity is true
    ) then
      raise exception 'S40 source-contract adoption requires RLS on %', relation_name;
    end if;

    if not has_table_privilege('authenticated', relation_name, 'select')
       or not has_table_privilege('authenticated', relation_name, 'insert')
       or not has_table_privilege('authenticated', relation_name, 'update')
       or not has_table_privilege('authenticated', relation_name, 'delete') then
      raise exception 'S40 source-contract adoption found incomplete authenticated grants on %', relation_name;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.onboarding_progress'::regclass
      and constraint_row.contype = 'u'
      and (
        select array_agg(attribute_row.attname order by key_row.ordinality)
        from unnest(constraint_row.conkey) with ordinality as key_row(attnum, ordinality)
        join pg_catalog.pg_attribute as attribute_row
          on attribute_row.attrelid = constraint_row.conrelid
         and attribute_row.attnum = key_row.attnum
      ) = array['task_id', 'user_id']::name[]
  ) then
    raise exception 'S40 source-contract adoption requires onboarding_progress(task_id,user_id) uniqueness';
  end if;

  for required_policy in
    select * from (values
      ('onboarding_tasks', 'active staff read onboarding tasks', 'r'),
      ('onboarding_tasks', 'active managers add onboarding tasks', 'a'),
      ('onboarding_tasks', 'active managers update onboarding tasks', 'w'),
      ('onboarding_tasks', 'active managers delete onboarding tasks', 'd'),
      ('onboarding_progress', 'staff read own onboarding progress', 'r'),
      ('onboarding_progress', 'staff add own onboarding progress', 'a'),
      ('onboarding_progress', 'staff update own onboarding progress', 'w'),
      ('onboarding_progress', 'active managers delete onboarding progress', 'd'),
      ('shifts', 'active staff read shifts', 'r'),
      ('shifts', 'active managers add shifts', 'a'),
      ('shifts', 'active managers update shifts', 'w'),
      ('shifts', 'active managers delete shifts', 'd')
    ) as policies(table_name, policy_name, command_code)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_policy as policy_row
      where policy_row.polrelid = to_regclass(format('public.%I', required_policy.table_name))
        and policy_row.polname = required_policy.policy_name
        and policy_row.polcmd = required_policy.command_code
        and 'authenticated'::regrole::oid = any(policy_row.polroles)
    ) then
      raise exception 'S40 source-contract adoption requires policy % on public.%',
        required_policy.policy_name, required_policy.table_name;
    end if;
  end loop;
end
$preflight$;

create index if not exists onboarding_tasks_active_order_idx
  on public.onboarding_tasks (active, sort_order, title);
create index if not exists onboarding_progress_user_idx
  on public.onboarding_progress (user_id, completed_at desc);
create index if not exists shifts_starts_at_idx
  on public.shifts (starts_at);
create index if not exists shifts_user_starts_at_idx
  on public.shifts (user_id, starts_at);

create table if not exists atlas_private.report_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (length(trim(event_type)) between 1 and 80),
  saved_view_id uuid,
  report_key text,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_label text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists report_events_created_at_idx
  on atlas_private.report_events (created_at desc);

alter table atlas_private.report_events enable row level security;
revoke all on table atlas_private.report_events from public, anon, authenticated, service_role;
grant select, insert on table atlas_private.report_events to service_role;

do $report_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'atlas_private.report_events'::regclass
      and polname = 'service role reads report events'
  ) then
    create policy "service role reads report events"
      on atlas_private.report_events for select to service_role using (true);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'atlas_private.report_events'::regclass
      and polname = 'service role inserts report events'
  ) then
    create policy "service role inserts report events"
      on atlas_private.report_events for insert to service_role with check (true);
  end if;
end
$report_policies$;

comment on table atlas_private.report_events is
  'Private Reports audit source consumed by the Atlas System timeline; adopted or initialized by S40.';

do $postflight$
declare
  contract record;
  actual_type text;
begin
  for contract in
    select * from (values
      ('id', 'uuid'),
      ('event_type', 'text'),
      ('saved_view_id', 'uuid'),
      ('report_key', 'text'),
      ('actor_id', 'uuid'),
      ('actor_label', 'text'),
      ('payload', 'jsonb'),
      ('created_at', 'timestamp with time zone')
    ) as required_columns(column_name, expected_type)
  loop
    select pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod)
      into actual_type
    from pg_catalog.pg_attribute as attribute_row
    where attribute_row.attrelid = 'atlas_private.report_events'::regclass
      and attribute_row.attname = contract.column_name
      and attribute_row.attnum > 0
      and not attribute_row.attisdropped;

    if actual_type is distinct from contract.expected_type then
      raise exception 'S40 report-events mismatch for %: expected %, found %',
        contract.column_name, contract.expected_type, coalesce(actual_type, 'missing');
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'atlas_private.report_events'::regclass
      and relrowsecurity is true
  ) then
    raise exception 'S40 report-events contract must have RLS enabled';
  end if;

  if has_table_privilege('anon', 'atlas_private.report_events', 'select')
     or has_table_privilege('authenticated', 'atlas_private.report_events', 'select')
     or not has_table_privilege('service_role', 'atlas_private.report_events', 'select')
     or not has_table_privilege('service_role', 'atlas_private.report_events', 'insert') then
    raise exception 'S40 report-events grants do not match the private service-role contract';
  end if;
end
$postflight$;

reset statement_timeout;
reset lock_timeout;
