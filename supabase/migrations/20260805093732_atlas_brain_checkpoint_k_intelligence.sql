-- Checkpoint K: evidence-gated shortage, purchase, menu and waste intelligence.
-- Source records remain in production. The preview stores only private snapshots,
-- recommendation evidence and manager decisions. No operational mutation occurs.

create table if not exists atlas_private.brain_intelligence_snapshots (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  source_observed_at timestamptz,
  actor_id uuid,
  actor_label text,
  source_status jsonb not null default '{}'::jsonb,
  domains jsonb not null default '[]'::jsonb,
  recommendation_ids uuid[] not null default '{}',
  automatic_operational_mutation boolean not null default false
    check (automatic_operational_mutation is false),
  created_at timestamptz not null default now(),
  check (jsonb_typeof(source_status)='object'),
  check (jsonb_typeof(domains)='array')
);

create index if not exists brain_intelligence_snapshots_generated_idx
  on atlas_private.brain_intelligence_snapshots(generated_at desc);

alter table atlas_private.brain_intelligence_snapshots enable row level security;
drop policy if exists "service role manages brain intelligence snapshots" on atlas_private.brain_intelligence_snapshots;
create policy "service role manages brain intelligence snapshots"
  on atlas_private.brain_intelligence_snapshots for all to service_role
  using (true) with check (true);
revoke all on atlas_private.brain_intelligence_snapshots from public,anon,authenticated;
grant all on atlas_private.brain_intelligence_snapshots to service_role;

create or replace function atlas_private.phase3_intelligence_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'inventory',coalesce((select settings_value from atlas_private.settings_sections where section_key='inventory'),'{}'::jsonb),
    'brain',coalesce((select settings_value from atlas_private.settings_sections where section_key='brain'),'{}'::jsonb),
    'modules',coalesce((select settings_value from atlas_private.settings_sections where section_key='modules'),'{}'::jsonb),
    'trust',jsonb_build_object(
      'automatic_reorder_execution',false,
      'automatic_brain_execution',false,
      'automatic_menu_changes',false,
      'automatic_waste_attribution',false,
      'production_sync',false
    )
  );
$$;

create or replace function atlas_private.sync_phase3_intelligence(
  p_connections jsonb,
  p_domains jsonb,
  p_recommendations jsonb,
  p_source_status jsonb,
  p_source_observed_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  connection_row record;
  recommendation jsonb;
  recommendation_id uuid;
  generated_ids uuid[] := '{}';
  generated_keys text[] := '{}';
  limitations text[];
  confidence_score numeric;
  snapshot_row atlas_private.brain_intelligence_snapshots;
begin
  if p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can refresh operational intelligence';
  end if;
  if jsonb_typeof(coalesce(p_connections,'[]'::jsonb))<>'array' then
    raise exception 'Intelligence connections must be an array';
  end if;
  if jsonb_typeof(coalesce(p_domains,'[]'::jsonb))<>'array' then
    raise exception 'Intelligence domains must be an array';
  end if;
  if jsonb_typeof(coalesce(p_recommendations,'[]'::jsonb))<>'array' then
    raise exception 'Intelligence recommendations must be an array';
  end if;
  if jsonb_typeof(coalesce(p_source_status,'{}'::jsonb))<>'object' then
    raise exception 'Intelligence source status must be an object';
  end if;

  for connection_row in
    select *
    from jsonb_to_recordset(coalesce(p_connections,'[]'::jsonb)) as connection(
      connection_key text,
      status text,
      last_verified_at timestamptz,
      metadata jsonb
    )
  loop
    if connection_row.status not in ('not_connected','pending_review','connected','degraded') then
      raise exception 'Checkpoint K cannot automatically assign connection status %',connection_row.status;
    end if;
    if not exists (
      select 1 from atlas_private.brain_data_connections
      where connection_key=connection_row.connection_key
    ) then
      raise exception 'Unknown Brain connection %',connection_row.connection_key;
    end if;
    if connection_row.metadata is not null and jsonb_typeof(connection_row.metadata)<>'object' then
      raise exception 'Brain connection metadata must be an object';
    end if;

    update atlas_private.brain_data_connections
    set status=connection_row.status,
        last_verified_at=connection_row.last_verified_at,
        metadata=metadata||jsonb_build_object('checkpoint_k',coalesce(connection_row.metadata,'{}'::jsonb)),
        updated_by=p_actor_id,
        updated_by_label=p_actor_label
    where connection_key=connection_row.connection_key;
  end loop;

  for recommendation in
    select value from jsonb_array_elements(coalesce(p_recommendations,'[]'::jsonb))
  loop
    if jsonb_typeof(recommendation)<>'object' then
      raise exception 'Intelligence recommendation must be an object';
    end if;
    if coalesce(recommendation->>'recommendation_key','') !~ '^checkpoint-k:[a-z0-9:_-]+$' then
      raise exception 'Checkpoint K recommendation key is invalid';
    end if;
    if recommendation->>'recommendation_type' not in ('data_quality','shortage','purchase','menu','waste','operations','governance') then
      raise exception 'Checkpoint K recommendation type is invalid';
    end if;
    if recommendation->>'confidence_state' not in ('verified','reviewed','pending','historical','modelled') then
      raise exception 'Checkpoint K confidence state is invalid';
    end if;
    confidence_score := coalesce((recommendation->>'confidence_score')::numeric,0);
    if confidence_score<0 or confidence_score>1 then
      raise exception 'Checkpoint K confidence score is invalid';
    end if;
    if jsonb_typeof(coalesce(recommendation->'suggested_action','{}'::jsonb))<>'object' then
      raise exception 'Checkpoint K suggested action must be an object';
    end if;
    if jsonb_typeof(coalesce(recommendation->'alternatives','[]'::jsonb))<>'array' then
      raise exception 'Checkpoint K alternatives must be an array';
    end if;
    if jsonb_typeof(coalesce(recommendation->'consequence_of_inaction','{}'::jsonb))<>'object' then
      raise exception 'Checkpoint K consequence must be an object';
    end if;
    if jsonb_typeof(coalesce(recommendation->'limitations','[]'::jsonb))<>'array' then
      raise exception 'Checkpoint K limitations must be an array';
    end if;

    select coalesce(array_agg(value),'{}'::text[])
    into limitations
    from jsonb_array_elements_text(coalesce(recommendation->'limitations','[]'::jsonb));

    recommendation_id := atlas_private.upsert_shadow_recommendation(
      recommendation->>'recommendation_key',
      recommendation->>'recommendation_type',
      recommendation->>'capability_key',
      recommendation->>'subject_type',
      recommendation->>'subject_key',
      recommendation->>'title',
      recommendation->>'summary',
      recommendation->>'explanation',
      coalesce(recommendation->'suggested_action','{}'::jsonb),
      coalesce(recommendation->'alternatives','[]'::jsonb),
      coalesce(recommendation->'consequence_of_inaction','{}'::jsonb),
      recommendation->>'confidence_state',
      confidence_score,
      recommendation->>'confidence_reason',
      limitations,
      coalesce((recommendation->>'priority')::integer,100),
      coalesce(recommendation->>'source_kind','edge_function'),
      recommendation->>'source_schema',
      recommendation->>'source_object',
      recommendation->>'source_row_key',
      coalesce(recommendation->>'evidence_label','Checkpoint K evidence'),
      coalesce(recommendation->'evidence_value','{}'::jsonb),
      coalesce(nullif(recommendation->>'observed_at','')::timestamptz,p_source_observed_at,pg_catalog.now())
    );

    generated_ids := array_append(generated_ids,recommendation_id);
    generated_keys := array_append(generated_keys,recommendation->>'recommendation_key');
  end loop;

  update atlas_private.brain_recommendations
  set status='expired',updated_at=pg_catalog.now()
  where recommendation_key like 'checkpoint-k:%'
    and status in ('active','deferred')
    and not (recommendation_key=any(generated_keys));

  insert into atlas_private.brain_intelligence_snapshots (
    generated_at,source_observed_at,actor_id,actor_label,source_status,domains,
    recommendation_ids,automatic_operational_mutation
  ) values (
    pg_catalog.now(),p_source_observed_at,p_actor_id,p_actor_label,
    coalesce(p_source_status,'{}'::jsonb),coalesce(p_domains,'[]'::jsonb),
    generated_ids,false
  ) returning * into snapshot_row;

  return jsonb_build_object(
    'version','atlas-intelligence-k/0.1.0',
    'snapshot_id',snapshot_row.id,
    'generated_at',snapshot_row.generated_at,
    'source_observed_at',snapshot_row.source_observed_at,
    'source_status',snapshot_row.source_status,
    'domains',snapshot_row.domains,
    'recommendation_ids',to_jsonb(snapshot_row.recommendation_ids),
    'recommendation_count',coalesce(array_length(snapshot_row.recommendation_ids,1),0),
    'automatic_operational_mutation',false
  );
end;
$$;

create or replace function atlas_private.phase3_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
select jsonb_build_object(
  'version','atlas-phase3/0.2.0',
  'mode','shadow',
  'generated_at',pg_catalog.now(),
  'stats',jsonb_build_object(
    'active_recommendations',(select count(*) from atlas_private.brain_recommendations where status='active'),
    'deferred_recommendations',(select count(*) from atlas_private.brain_recommendations where status='deferred'),
    'manager_decisions',(select count(*) from atlas_private.brain_decisions),
    'recorded_outcomes',(select count(*) from atlas_private.brain_outcomes),
    'memory_events',(select count(*) from atlas_private.brain_decision_memory),
    'operational_signals',(select count(*) from atlas_private.brain_recommendations where status='active' and recommendation_key like 'checkpoint-k:%')
  ),
  'capabilities',coalesce((
    select jsonb_agg(jsonb_build_object(
      'key',capability_key,
      'label',label,
      'enabled',enabled,
      'confidence',jsonb_build_object('state',confidence_state,'score',confidence_score),
      'blockers',blockers,
      'required_connections',required_connections,
      'source',source_ref
    ) order by capability_key)
    from atlas_private.brain_capability_gates
  ),'[]'::jsonb),
  'intelligence',coalesce((
    select jsonb_build_object(
      'version','atlas-intelligence-k/0.1.0',
      'snapshot_id',snapshot.id,
      'generated_at',snapshot.generated_at,
      'source_observed_at',snapshot.source_observed_at,
      'source_status',snapshot.source_status,
      'domains',snapshot.domains,
      'recommendation_ids',to_jsonb(snapshot.recommendation_ids),
      'automatic_operational_mutation',snapshot.automatic_operational_mutation
    )
    from atlas_private.brain_intelligence_snapshots snapshot
    order by snapshot.generated_at desc
    limit 1
  ),jsonb_build_object(
    'version','atlas-intelligence-k/0.1.0',
    'generated_at',null,
    'source_status','{}'::jsonb,
    'domains','[]'::jsonb,
    'recommendation_ids','[]'::jsonb,
    'automatic_operational_mutation',false
  )),
  'recommendations',coalesce((
    select jsonb_agg(to_jsonb(feed) order by feed.priority,feed.recommendation_key)
    from atlas_private.brain_recommendation_feed feed
    where feed.status in ('active','deferred')
      and (feed.valid_until is null or feed.valid_until>pg_catalog.now())
  ),'[]'::jsonb),
  'memory',coalesce((
    select jsonb_agg(to_jsonb(memory) order by memory.occurred_at desc)
    from (
      select * from atlas_private.brain_decision_memory
      order by occurred_at desc
      limit 30
    ) memory
  ),'[]'::jsonb),
  'trust',jsonb_build_object(
    'ai_generation_used',false,
    'automatic_ordering',false,
    'automatic_menu_changes',false,
    'automatic_operational_mutation',false,
    'historical_stock_used_for_prediction',false,
    'negative_adjustments_treated_as_waste',false,
    'sales_performance_inference',false,
    'manager_review_required',true
  )
);
$$;

create or replace function public.atlas_phase3_intelligence_settings()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$ select atlas_private.phase3_intelligence_settings(); $$;

create or replace function public.atlas_phase3_sync_intelligence(
  p_connections jsonb,
  p_domains jsonb,
  p_recommendations jsonb,
  p_source_status jsonb,
  p_source_observed_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.sync_phase3_intelligence(
    p_connections,p_domains,p_recommendations,p_source_status,p_source_observed_at,
    p_actor_id,p_actor_label,p_actor_role
  );
$$;

revoke execute on function public.atlas_phase3_intelligence_settings() from public,anon,authenticated;
revoke execute on function public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_phase3_intelligence_settings() to service_role;
grant execute on function public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text) to service_role;

comment on table atlas_private.brain_intelligence_snapshots is
  'Private Checkpoint K source coverage and four-domain shadow-intelligence snapshots. Never mutates operational source records.';
comment on function public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text) is
  'Service-role-only Checkpoint K synchronization of evidence-gated shortage, purchase, menu and explicit-waste recommendations.';
comment on function public.atlas_phase3_intelligence_settings() is
  'Service-role-only safe settings subset used by the Checkpoint K deterministic intelligence gateway.';
