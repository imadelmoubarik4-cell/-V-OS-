-- Phase 2 / P2.0: one canonical Atlas connection registry, verified health
-- protocol, capability grants, immutable event history and service-role API.
--
-- The existing atlas_private.integration_connections table remains the single
-- registry consumed by Settings, System, Marketing, Operations and Brain.
-- Legacy `status` is retained only as a trigger-maintained compatibility field;
-- `health_state` is the canonical state used by the Connection Center.

do $p2_invariant$
begin
  if to_regclass('atlas_private.integration_connections') is null then
    raise exception 'P2.0 requires atlas_private.integration_connections';
  end if;
end
$p2_invariant$;

alter table atlas_private.integration_connections
  add column if not exists environment text not null default 'external',
  add column if not exists owner_module text not null default 'system',
  add column if not exists provider_type text not null default 'external_api',
  add column if not exists health_state text not null default 'not_configured',
  add column if not exists check_strategy text not null default 'manual',
  add column if not exists stale_after_seconds integer not null default 3600,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_succeeded_at timestamptz,
  add column if not exists last_failed_at timestamptz,
  add column if not exists latency_ms integer,
  add column if not exists last_error_code text,
  add column if not exists last_error_summary text,
  add column if not exists credential_source text not null default 'none',
  add column if not exists active boolean not null default true,
  add column if not exists version integer not null default 1;

alter table atlas_private.integration_connections
  drop constraint if exists integration_connections_environment_check,
  drop constraint if exists integration_connections_health_state_check,
  drop constraint if exists integration_connections_check_strategy_check,
  drop constraint if exists integration_connections_stale_after_check,
  drop constraint if exists integration_connections_latency_check,
  drop constraint if exists integration_connections_credential_source_check,
  drop constraint if exists integration_connections_version_check;

alter table atlas_private.integration_connections
  add constraint integration_connections_environment_check
    check (environment in ('production','atlas_private','external','cross_project')),
  add constraint integration_connections_health_state_check
    check (health_state in (
      'not_configured','authorization_required','verifying','healthy',
      'degraded','expired','blocked','intentionally_disabled'
    )),
  add constraint integration_connections_check_strategy_check
    check (check_strategy in (
      'production_auth','production_data','branch_rpc','edge_runtime',
      'branch_storage','github_public','netlify_public','manual',
      'aggregate','disabled'
    )),
  add constraint integration_connections_stale_after_check
    check (stale_after_seconds between 60 and 2592000),
  add constraint integration_connections_latency_check
    check (latency_ms is null or latency_ms between 0 and 120000),
  add constraint integration_connections_credential_source_check
    check (credential_source in (
      'none','supabase_managed','edge_environment','oauth_vault','manual'
    )),
  add constraint integration_connections_version_check
    check (version > 0);

alter table atlas_private.integration_connections enable row level security;
revoke all on atlas_private.integration_connections from public,anon,authenticated;
grant all on atlas_private.integration_connections to service_role;
drop policy if exists "service role manages integration connections"
  on atlas_private.integration_connections;
drop policy if exists integration_connections_service_only
  on atlas_private.integration_connections;
create policy integration_connections_service_only
  on atlas_private.integration_connections for all to service_role
  using (true) with check (true);

update atlas_private.integration_connections
set
  environment = case
    when provider_key='supabase' then 'cross_project'
    when provider_key in ('github','netlify') then 'external'
    else 'external'
  end,
  owner_module = case
    when category in ('social','reputation','business_profile') then 'marketing'
    when category in ('operations','payments') then 'reports'
    when category in ('email','storage') then 'knowledge'
    else 'system'
  end,
  provider_type = case
    when provider_key='supabase' then 'supabase_platform'
    when provider_key='github' then 'source_control'
    when provider_key='netlify' then 'hosting'
    when provider_key='google-drive' then 'document_storage'
    when category='email' then 'email_provider'
    when category='social' then 'social_platform'
    when category='reputation' then 'reputation_platform'
    when category='business_profile' then 'business_profile'
    when category='payments' then 'payments'
    when category='operations' then 'pos'
    else 'external_api'
  end,
  health_state = case
    when provider_key in ('supabase','github','netlify') then 'verifying'
    when status='degraded' then 'degraded'
    when status='expired' or authorization_state='expired' then 'expired'
    when status='authorization_required' or authorization_state='waiting_authorization'
      then 'authorization_required'
    when status='pending_review' then 'verifying'
    when status='not_applicable' then 'intentionally_disabled'
    else 'not_configured'
  end,
  check_strategy = case
    when provider_key='supabase' then 'aggregate'
    when provider_key='github' then 'github_public'
    when provider_key='netlify' then 'netlify_public'
    else 'manual'
  end,
  stale_after_seconds = case
    when provider_key in ('supabase','github','netlify') then 1800
    else 86400
  end,
  last_checked_at = last_verified_at,
  last_succeeded_at = null,
  credential_source = case
    when provider_key='supabase' then 'edge_environment'
    when provider_key in ('github','netlify') then 'none'
    when authorization_state='authorized' then 'oauth_vault'
    else 'manual'
  end,
  metadata = metadata || jsonb_build_object(
    'p2_0_canonical_registry',true,
    'legacy_status_compatibility',true
  );

-- New platform components are separate because Auth, Data API, private RPC,
-- Edge runtime, Storage and SMTP can fail independently.
insert into atlas_private.integration_connections (
  provider_key,label,category,status,capabilities,requirements,metadata,
  authorization_state,publishing_permission_state,analytics_permission_state,
  environment,owner_module,provider_type,health_state,check_strategy,
  stale_after_seconds,credential_source,active
)
values
  ('production-auth','Production authentication','infrastructure','pending_review',
    '{"session_verification":true,"staff_invitation":"admin_server_only","password_reset":true}'::jsonb,
    '{"active_profile_required":true,"public_signup_disabled":true}'::jsonb,
    '{"secrets_returned":false,"health_scope":"current authenticated session"}'::jsonb,
    'authorized','not_supported','not_supported','production','security',
    'supabase_auth','verifying','production_auth',900,'supabase_managed',true),
  ('production-data','Production Data API','infrastructure','pending_review',
    '{"profile_read":true,"inventory_read":"role_filtered","commercial_write":"manager_only"}'::jsonb,
    '{"rls_required":true,"active_profile_required":true}'::jsonb,
    '{"secrets_returned":false,"service_role_in_browser":false}'::jsonb,
    'authorized','not_supported','not_supported','production','system',
    'supabase_data','verifying','production_data',900,'supabase_managed',true),
  ('atlas-private-database','Atlas private database','infrastructure','pending_review',
    '{"private_rpc":true,"review_storage":true,"operational_source_mutation":false}'::jsonb,
    '{"service_role_server_only":true,"production_sync":false}'::jsonb,
    '{"secrets_returned":false,"environment":"isolated_branch"}'::jsonb,
    'authorized','not_supported','not_supported','atlas_private','system',
    'supabase_data','verifying','branch_rpc',900,'edge_environment',true),
  ('atlas-private-edge','Atlas Edge gateway','infrastructure','pending_review',
    '{"authenticated_gateway":true,"custom_profile_authorization":true}'::jsonb,
    '{"production_profile_revalidation":true,"request_id_required":true}'::jsonb,
    '{"secrets_returned":false,"automatic_external_writes":false}'::jsonb,
    'authorized','not_supported','not_supported','atlas_private','system',
    'supabase_edge','verifying','edge_runtime',900,'edge_environment',true),
  ('atlas-private-storage','Atlas private Storage','storage','pending_review',
    '{"profile_photos":true,"signed_reads":true,"public_bucket":false}'::jsonb,
    '{"private_bucket_required":true,"server_side_access":true}'::jsonb,
    '{"secrets_returned":false,"expected_bucket":"atlas-profile-photos"}'::jsonb,
    'authorized','not_supported','not_supported','atlas_private','profiles',
    'supabase_storage','verifying','branch_storage',3600,'edge_environment',true),
  ('custom-smtp','Authentication email delivery','email','pending_review',
    '{"staff_invitation":true,"password_reset":true,"email_confirmation":true}'::jsonb,
    '{"custom_smtp_configured":true,"invitation_delivery_test":true,"password_reset_delivery_test":true}'::jsonb,
    '{"credentials_managed_by_supabase":true,"delivery_evidence_required":true}'::jsonb,
    'authorized','not_supported','not_supported','production','security',
    'smtp','verifying','manual',2592000,'supabase_managed',true),
  ('supplier-ordering','Supplier order submission','operations','not_applicable',
    '{"draft_generation":true,"supplier_submission":false}'::jsonb,
    '{"manager_review_required":true,"explicit_future_authorization":true}'::jsonb,
    '{"automatic_ordering":false,"phase":"future"}'::jsonb,
    'not_connected','not_supported','not_supported','external','purchasing',
    'supplier_api','intentionally_disabled','disabled',2592000,'none',true)
on conflict (provider_key) do update
set
  label=excluded.label,
  category=excluded.category,
  capabilities=excluded.capabilities,
  requirements=excluded.requirements,
  metadata=atlas_private.integration_connections.metadata || excluded.metadata,
  authorization_state=excluded.authorization_state,
  publishing_permission_state=excluded.publishing_permission_state,
  analytics_permission_state=excluded.analytics_permission_state,
  environment=excluded.environment,
  owner_module=excluded.owner_module,
  provider_type=excluded.provider_type,
  health_state=excluded.health_state,
  check_strategy=excluded.check_strategy,
  stale_after_seconds=excluded.stale_after_seconds,
  credential_source=excluded.credential_source,
  active=true,
  updated_at=now();

update atlas_private.integration_connections
set requirements = requirements || jsonb_build_object(
      'repository','imadelmoubarik4-cell/-V-OS-',
      'branch','agent/phase2-connection-center-p2-0'
    ),
    metadata = metadata || jsonb_build_object('verification_scope','public_branch_metadata')
where provider_key='github';

-- Checkpoint K's brain_data_connections remain evidence-readiness gates, not a
-- second provider registry. source_ref links each relevant evidence gate to the
-- canonical runtime/external connection whose health constrains that evidence.
do $brain_source_links$
begin
  if to_regclass('atlas_private.brain_data_connections') is not null then
    update atlas_private.brain_data_connections
    set source_ref = case connection_key
      when 'sales_history' then 'dineout'
      when 'bookings' then 'dineout'
      when 'confirmed_deliveries' then 'supplier-ordering'
      when 'supplier_constraints' then 'supplier-ordering'
      when 'supplier_lead_times' then 'supplier-ordering'
      when 'current_stock' then 'atlas-private-database'
      when 'stock_counts' then 'atlas-private-database'
      when 'inventory_movements' then 'production-data'
      when 'menu_prices' then 'production-data'
      when 'recipe_costs' then 'production-data'
      when 'waste_events' then 'production-data'
      else source_ref
    end,
    metadata = metadata || jsonb_build_object(
      'p2_0_semantics','evidence_gate_not_provider_registry'
    )
    where connection_key in (
      'sales_history','bookings','confirmed_deliveries','supplier_constraints',
      'supplier_lead_times','current_stock','stock_counts','inventory_movements',
      'menu_prices','recipe_costs','waste_events'
    );
  end if;
end
$brain_source_links$;

create or replace function atlas_private.connection_sync_compatibility()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  if tg_op='UPDATE'
     and new.health_state is not distinct from old.health_state
     and new.status is distinct from old.status then
    new.health_state := case new.status
      when 'connected' then 'healthy'
      when 'authorization_required' then 'authorization_required'
      when 'pending_review' then 'verifying'
      when 'degraded' then 'degraded'
      when 'expired' then 'expired'
      when 'not_applicable' then 'intentionally_disabled'
      else 'not_configured'
    end;
  end if;

  if new.token_expires_at is not null
     and new.token_expires_at <= now()
     and new.health_state not in ('blocked','intentionally_disabled') then
    new.health_state := 'expired';
  end if;

  if new.health_state='healthy'
     and (tg_op='INSERT' or new.health_state is distinct from old.health_state)
     and coalesce(current_setting('atlas.allow_connection_verified',true),'') <> 'on' then
    raise exception 'Healthy connection state requires a completed controlled health check'
      using errcode='42501';
  end if;
  if new.health_state='healthy' and new.last_succeeded_at is null then
    raise exception 'Healthy connection state requires successful verification evidence';
  end if;

  new.status := case new.health_state
    when 'healthy' then 'connected'
    when 'authorization_required' then 'authorization_required'
    when 'verifying' then 'pending_review'
    when 'degraded' then 'degraded'
    when 'expired' then 'expired'
    when 'blocked' then 'degraded'
    when 'intentionally_disabled' then 'not_applicable'
    else 'not_connected'
  end;

  if tg_op='UPDATE' then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function atlas_private.connection_sync_compatibility()
  from public,anon,authenticated;
grant execute on function atlas_private.connection_sync_compatibility()
  to service_role;

drop trigger if exists integration_connections_p2_compatibility
  on atlas_private.integration_connections;
create trigger integration_connections_p2_compatibility
before insert or update on atlas_private.integration_connections
for each row execute function atlas_private.connection_sync_compatibility();

-- Align compatibility status for rows backfilled before the trigger existed.
update atlas_private.integration_connections
set status = case health_state
  when 'healthy' then 'connected'
  when 'authorization_required' then 'authorization_required'
  when 'verifying' then 'pending_review'
  when 'degraded' then 'degraded'
  when 'expired' then 'expired'
  when 'blocked' then 'degraded'
  when 'intentionally_disabled' then 'not_applicable'
  else 'not_connected'
end;
