-- Seed capability policy. All external side-effect capabilities remain blocked,
-- verification-required or read-only until a future explicit authorization.
select set_config('atlas.allow_high_risk_capability_grant','on',true);
insert into atlas_private.connection_capability_grants(
  connection_key,capability_key,capability_kind,grant_state,risk_level,
  manager_approval_required,automatic_execution_allowed,metadata
)
values
  ('production-auth','auth.session.verify','read','granted','low',false,false,'{}'),
  ('production-auth','auth.staff.invite','admin','verification_required','high',true,false,'{"server_side_only":true}'),
  ('production-auth','auth.password_reset','write','verification_required','medium',true,false,'{"supabase_managed":true}'),
  ('production-data','profiles.read','read','granted','low',false,false,'{"rls_enforced":true}'),
  ('production-data','inventory.read','read','read_only','medium',false,false,'{"role_filtered":true}'),
  ('production-data','inventory.adjust','write','blocked','critical',true,false,'{"controlled_rpc_only":true}'),
  ('atlas-private-database','private.rpc.read','read','granted','low',false,false,'{}'),
  ('atlas-private-database','private.review.write','write','granted','medium',true,false,'{"idempotency_required":true}'),
  ('atlas-private-database','production.sync','write','blocked','critical',true,false,'{"production_sync":false}'),
  ('atlas-private-edge','gateway.request','read','granted','low',false,false,'{"production_profile_revalidated":true}'),
  ('atlas-private-edge','external.side_effect','write','blocked','critical',true,false,'{"automatic_execution":false}'),
  ('atlas-private-storage','profile_photo.read','read','granted','low',false,false,'{"signed_url":true}'),
  ('atlas-private-storage','profile_photo.write','write','granted','medium',true,false,'{"server_gateway_only":true}'),
  ('custom-smtp','auth.email.invitation','write','verification_required','medium',true,false,'{"delivery_test_required":true}'),
  ('custom-smtp','auth.email.password_reset','write','verification_required','medium',true,false,'{"delivery_test_required":true}'),
  ('github','source.metadata.read','read','granted','low',false,false,'{"public_metadata_only":true}'),
  ('github','source.repository.write','write','blocked','high',true,false,'{"runtime_write":false}'),
  ('netlify','deploy.preview.read','read','granted','low',false,false,'{}'),
  ('netlify','deploy.production.write','publish','blocked','critical',true,false,'{"production_deploy":false}'),
  ('dineout','sales.read','read','verification_required','medium',true,false,'{"checkpoint_m_required":true}'),
  ('dineout','orders.write','write','blocked','critical',true,false,'{"automatic_ordering":false}'),
  ('supplier-ordering','purchase.draft','write','read_only','medium',true,false,'{"manager_review_required":true}'),
  ('supplier-ordering','purchase.submit','publish','blocked','critical',true,false,'{"automatic_submission":false}')
on conflict (connection_key,capability_key) do update
set capability_kind=excluded.capability_kind,
    grant_state=excluded.grant_state,
    risk_level=excluded.risk_level,
    manager_approval_required=excluded.manager_approval_required,
    automatic_execution_allowed=false,
    metadata=excluded.metadata,
    updated_at=now();

insert into atlas_private.connection_dependencies(
  connection_key,module_key,requirement_level,required_capabilities,safety_boundary
)
values
  ('production-auth','application-shell','required',array['auth.session.verify'],'Active production profile required on every gateway request.'),
  ('production-data','inventory','required',array['inventory.read'],'RLS and manager-only commercial access remain authoritative.'),
  ('production-data','reports','required',array['inventory.read'],'Read-only production evidence; no source mutation.'),
  ('atlas-private-database','settings','required',array['private.rpc.read'],'Versioned private settings; no credentials stored.'),
  ('atlas-private-database','system','required',array['private.rpc.read'],'Connection history and health evidence remain private.'),
  ('atlas-private-database','brain','required',array['private.rpc.read'],'Evidence-gated recommendations only.'),
  ('atlas-private-database','stock-counts','required',array['private.review.write'],'Publication remains a separate manager boundary.'),
  ('atlas-private-storage','profiles','optional',array['profile_photo.read'],'Private bucket and signed reads only.'),
  ('custom-smtp','authentication','required',array['auth.email.invitation','auth.email.password_reset'],'Configured is not healthy until delivery is demonstrated.'),
  ('github','system','optional',array['source.metadata.read'],'Public metadata verification only; no runtime repository write.'),
  ('netlify','system','optional',array['deploy.preview.read'],'Preview reachability only; production deployment remains disabled.'),
  ('dineout','checkpoint-m','future',array['sales.read'],'POS mapping must be approved before sales intelligence.'),
  ('supplier-ordering','purchasing','future',array['purchase.draft'],'Supplier submission remains blocked.')
on conflict (connection_key,module_key) do update
set requirement_level=excluded.requirement_level,
    required_capabilities=excluded.required_capabilities,
    safety_boundary=excluded.safety_boundary,
    updated_at=now();

insert into atlas_private.connection_events(
  connection_key,event_type,previous_state,new_state,actor_label,actor_role,payload
)
select connection.provider_key,'registry_initialized',null,connection.health_state,
       'Atlas migration','system',jsonb_build_object(
         'version','P2.0','check_strategy',connection.check_strategy,
         'automatic_external_side_effects',false
       )
from atlas_private.integration_connections connection
where not exists (
  select 1 from atlas_private.connection_events event
  where event.connection_key=connection.provider_key
    and event.event_type='registry_initialized'
);

-- Public wrappers are service-role-only. Browsers must use atlas-connections.
create or replace function public.atlas_connections_snapshot(
  p_actor_id uuid,
  p_actor_role text,
  p_history_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.connections_snapshot(p_actor_id,p_actor_role,p_history_limit);
$function$;

create or replace function public.atlas_connections_begin_check(
  p_connection_key text,
  p_request_id uuid,
  p_check_kind text,
  p_trigger_source text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.connections_begin_check(
    p_connection_key,p_request_id,p_check_kind,p_trigger_source,
    p_actor_id,p_actor_label,p_actor_role
  );
$function$;

create or replace function public.atlas_connections_finish_check(
  p_check_id uuid,
  p_result_state text,
  p_outcome text,
  p_latency_ms integer,
  p_error_code text,
  p_summary text,
  p_evidence jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.connections_finish_check(
    p_check_id,p_result_state,p_outcome,p_latency_ms,p_error_code,
    p_summary,p_evidence,p_actor_id,p_actor_label,p_actor_role
  );
$function$;

create or replace function public.atlas_connections_set_capability(
  p_connection_key text,
  p_capability_key text,
  p_capability_kind text,
  p_grant_state text,
  p_risk_level text,
  p_manager_approval_required boolean,
  p_metadata jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $function$
  select atlas_private.connections_set_capability(
    p_connection_key,p_capability_key,p_capability_kind,p_grant_state,
    p_risk_level,p_manager_approval_required,p_metadata,
    p_actor_id,p_actor_label,p_actor_role
  );
$function$;

create or replace function public.atlas_connections_brain_projection()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.connection_brain_projection();
$function$;

create or replace function public.atlas_connections_ping()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  select atlas_private.connections_ping();
$function$;

do $connection_function_grants$
declare
  function_row record;
begin
  for function_row in
    select p.oid::regprocedure signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='atlas_private' and p.proname like 'connection%')
       or (n.nspname='atlas_private' and p.proname like 'connections_%')
       or (n.nspname='public' and p.proname like 'atlas_connections_%')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',function_row.signature);
    execute format('grant execute on function %s to service_role',function_row.signature);
  end loop;
end
$connection_function_grants$;

comment on table atlas_private.integration_connections is
  'Canonical P2.0 connection registry. health_state is authoritative; status is trigger-maintained compatibility only.';
comment on table atlas_private.connection_health_checks is
  'Idempotent, manager-initiated or scheduled connection health-check evidence. No credential values are stored.';
comment on table atlas_private.connection_capability_grants is
  'Per-connection capability grants. Automatic external execution is hard-disabled in P2.0.';
comment on table atlas_private.connection_events is
  'Append-only Connection Center event history for checks, state transitions and capability review.';
comment on function atlas_private.connection_brain_projection() is
  'Derived P2.0 projection joining Checkpoint K evidence gates to the canonical provider/runtime connection registry.';
comment on table atlas_private.brain_data_connections is
  'Checkpoint K evidence-readiness gates. External/runtime connection truth comes only from atlas_private.integration_connections through source_ref.';
comment on function public.atlas_connections_snapshot(uuid,text,integer) is
  'Service-role-only shared Connection Center snapshot used by Settings, System and future evidence gates.';

notify pgrst,'reload schema';
