-- Checkpoint K experimental-path replay scaffold.
--
-- The original intelligence_* experiment was replaced by the canonical
-- brain_* model and is removed by the guarded consolidation migration at
-- 20260805125412. A clean branch replay still needs the historical relation
-- names so the intervening open-check migration can run deterministically.
-- No operational data is seeded here.

create schema if not exists atlas_private;
revoke all on schema atlas_private from public, anon, authenticated;
grant usage on schema atlas_private to service_role;

create table if not exists atlas_private.intelligence_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  run_type text not null default 'operational',
  status text not null default 'pending',
  requested_by uuid,
  requested_by_label text,
  requested_by_role text,
  source_cutoff_at timestamptz,
  source_snapshot jsonb not null default '{}'::jsonb,
  algorithm_version text not null default 'experimental-k/0.1.0',
  evaluation_started_at timestamptz,
  evaluation_finished_at timestamptz,
  recommendation_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(source_snapshot)='object'),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.intelligence_recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references atlas_private.intelligence_runs(id) on delete cascade,
  recommendation_key text not null,
  recommendation_type text,
  state text not null default 'proposed',
  title text,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,recommendation_key),
  check (jsonb_typeof(payload)='object')
);

create table if not exists atlas_private.intelligence_evidence (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid references atlas_private.intelligence_recommendations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

create table if not exists atlas_private.intelligence_decisions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid references atlas_private.intelligence_recommendations(id) on delete cascade,
  decision text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

create table if not exists atlas_private.intelligence_outcomes (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid references atlas_private.intelligence_recommendations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

create table if not exists atlas_private.intelligence_recommendation_events (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid references atlas_private.intelligence_recommendations(id) on delete cascade,
  event_type text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

create table if not exists atlas_private.intelligence_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references atlas_private.intelligence_runs(id) on delete cascade,
  event_type text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);

do $experimental_tables$
declare
  table_name text;
begin
  foreach table_name in array array[
    'intelligence_runs','intelligence_recommendations','intelligence_evidence',
    'intelligence_decisions','intelligence_outcomes',
    'intelligence_recommendation_events','intelligence_events'
  ]
  loop
    execute format('alter table atlas_private.%I enable row level security',table_name);
    execute format('revoke all on atlas_private.%I from public, anon, authenticated',table_name);
    execute format('grant all on atlas_private.%I to service_role',table_name);
    execute format('drop policy if exists %I on atlas_private.%I',table_name || '_service_only',table_name);
    execute format(
      'create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      table_name || '_service_only',table_name
    );
  end loop;
end
$experimental_tables$;

create or replace function atlas_private.intelligence_begin_run(
  p_run_key text,
  p_run_type text,
  p_source_cutoff_at timestamptz,
  p_source_snapshot jsonb,
  p_algorithm_version text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $function$
declare
  run_row atlas_private.intelligence_runs;
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can start intelligence runs';
  end if;
  insert into atlas_private.intelligence_runs(
    run_key,run_type,status,requested_by,requested_by_label,requested_by_role,
    source_cutoff_at,source_snapshot,algorithm_version,evaluation_started_at
  ) values (
    trim(p_run_key),coalesce(nullif(trim(p_run_type),''),'operational'),'running',
    p_actor_id,p_actor_label,p_actor_role,p_source_cutoff_at,
    coalesce(p_source_snapshot,'{}'::jsonb),
    coalesce(nullif(trim(p_algorithm_version),''),'experimental-k/0.1.0'),now()
  )
  on conflict (run_key) do update
  set status='running',source_cutoff_at=excluded.source_cutoff_at,
      source_snapshot=excluded.source_snapshot,algorithm_version=excluded.algorithm_version,
      evaluation_started_at=now(),evaluation_finished_at=null,error_message=null,updated_at=now()
  returning * into run_row;
  return to_jsonb(run_row);
end;
$function$;

create or replace function public.atlas_intelligence_begin_run(
  text,text,timestamptz,jsonb,text,uuid,text,text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.intelligence_begin_run($1,$2,$3,$4,$5,$6,$7,$8);
$function$;

revoke all on function atlas_private.intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text)
  from public,anon,authenticated;
grant execute on function atlas_private.intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text)
  to service_role;
revoke all on function public.atlas_intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.atlas_intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text)
  to service_role;

notify pgrst, 'reload schema';
