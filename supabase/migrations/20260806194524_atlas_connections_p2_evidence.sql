create table if not exists atlas_private.connection_capability_grants (
  connection_key text not null references atlas_private.integration_connections(provider_key) on delete cascade,
  capability_key text not null,
  capability_kind text not null
    check (capability_kind in ('read','write','publish','admin')),
  grant_state text not null default 'not_requested'
    check (grant_state in (
      'not_requested','verification_required','read_only','granted',
      'denied','blocked','not_supported'
    )),
  risk_level text not null default 'low'
    check (risk_level in ('low','medium','high','critical')),
  manager_approval_required boolean not null default false,
  automatic_execution_allowed boolean not null default false
    check (automatic_execution_allowed is false),
  reviewed_at timestamptz,
  reviewed_by uuid,
  reviewed_by_label text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_key,capability_key),
  check (capability_key ~ '^[a-z][a-z0-9._-]{2,119}$')
);

create table if not exists atlas_private.connection_health_checks (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  connection_key text not null references atlas_private.integration_connections(provider_key) on delete cascade,
  check_kind text not null
    check (check_kind in ('automated','manual','synthetic','configuration')),
  trigger_source text not null
    check (trigger_source in ('manager','scheduled','system','startup','api')),
  status text not null default 'running'
    check (status in ('running','passed','failed','skipped')),
  state_before text not null,
  state_after text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 120000),
  error_code text,
  summary text,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence)='object'),
  actor_id uuid,
  actor_label text,
  actor_role text,
  created_at timestamptz not null default now(),
  unique (connection_key,request_id),
  check (error_code is null or error_code ~ '^[A-Z0-9_]{3,80}$'),
  check (state_before in (
    'not_configured','authorization_required','verifying','healthy',
    'degraded','expired','blocked','intentionally_disabled'
  )),
  check (state_after is null or state_after in (
    'not_configured','authorization_required','verifying','healthy',
    'degraded','expired','blocked','intentionally_disabled'
  ))
);

create table if not exists atlas_private.connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_key text not null references atlas_private.integration_connections(provider_key) on delete cascade,
  health_check_id uuid references atlas_private.connection_health_checks(id) on delete set null,
  event_type text not null
    check (event_type in (
      'registry_initialized','check_started','check_completed','state_changed',
      'capability_changed','manual_note','configuration_changed'
    )),
  previous_state text,
  new_state text,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.connection_dependencies (
  connection_key text not null references atlas_private.integration_connections(provider_key) on delete cascade,
  module_key text not null,
  requirement_level text not null default 'required'
    check (requirement_level in ('required','optional','future')),
  required_capabilities text[] not null default '{}'::text[],
  safety_boundary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_key,module_key),
  check (module_key ~ '^[a-z][a-z0-9._-]{1,79}$')
);

create index if not exists connection_checks_connection_started_idx
  on atlas_private.connection_health_checks(connection_key,started_at desc);
create index if not exists connection_checks_status_started_idx
  on atlas_private.connection_health_checks(status,started_at desc);
create index if not exists connection_events_connection_created_idx
  on atlas_private.connection_events(connection_key,created_at desc);
create index if not exists connection_events_type_created_idx
  on atlas_private.connection_events(event_type,created_at desc);
create index if not exists connection_capabilities_state_idx
  on atlas_private.connection_capability_grants(grant_state,risk_level);

alter table atlas_private.connection_capability_grants enable row level security;
alter table atlas_private.connection_health_checks enable row level security;
alter table atlas_private.connection_events enable row level security;
alter table atlas_private.connection_dependencies enable row level security;

do $connection_private_grants$
declare
  table_name text;
begin
  foreach table_name in array array[
    'connection_capability_grants','connection_health_checks',
    'connection_events','connection_dependencies'
  ]
  loop
    execute format('revoke all on atlas_private.%I from public,anon,authenticated',table_name);
    execute format('grant all on atlas_private.%I to service_role',table_name);
    execute format('drop policy if exists %I on atlas_private.%I',table_name || '_service_only',table_name);
    execute format(
      'create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      table_name || '_service_only',table_name
    );
  end loop;
end
$connection_private_grants$;

create or replace function atlas_private.connection_events_append_only()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  raise exception 'Connection event history is append-only'
    using errcode='42501';
end;
$function$;

revoke all on function atlas_private.connection_events_append_only()
  from public,anon,authenticated;
grant execute on function atlas_private.connection_events_append_only()
  to service_role;

drop trigger if exists connection_events_append_only
  on atlas_private.connection_events;
create trigger connection_events_append_only
before update or delete on atlas_private.connection_events
for each row execute function atlas_private.connection_events_append_only();

create or replace function atlas_private.connection_checks_immutable_after_finish()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  if tg_op='DELETE' then
    raise exception 'Connection health-check history cannot be deleted'
      using errcode='42501';
  end if;
  if old.status <> 'running' then
    raise exception 'Completed connection health checks are immutable'
      using errcode='42501';
  end if;
  return new;
end;
$function$;

revoke all on function atlas_private.connection_checks_immutable_after_finish()
  from public,anon,authenticated;
grant execute on function atlas_private.connection_checks_immutable_after_finish()
  to service_role;

drop trigger if exists connection_checks_immutable_after_finish
  on atlas_private.connection_health_checks;
create trigger connection_checks_immutable_after_finish
before update or delete on atlas_private.connection_health_checks
for each row execute function atlas_private.connection_checks_immutable_after_finish();

create or replace function atlas_private.connection_capability_guard()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  new.automatic_execution_allowed := false;
  if new.grant_state='granted'
     and (new.capability_kind in ('write','publish','admin')
          or new.risk_level in ('high','critical'))
     and coalesce(current_setting('atlas.allow_high_risk_capability_grant',true),'') <> 'on' then
    raise exception 'High-risk capability grants require the controlled administrator workflow'
      using errcode='42501';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function atlas_private.connection_capability_guard()
  from public,anon,authenticated;
grant execute on function atlas_private.connection_capability_guard()
  to service_role;

-- Seed rows are installed before this guard. All later capability changes must
-- pass the controlled function below, and automatic execution stays hard-off.
drop trigger if exists connection_capability_guard
  on atlas_private.connection_capability_grants;
create trigger connection_capability_guard
before insert or update on atlas_private.connection_capability_grants
for each row execute function atlas_private.connection_capability_guard();
