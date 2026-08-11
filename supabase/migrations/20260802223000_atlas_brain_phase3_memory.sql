-- Sprint 4 Phase 3 - Atlas Brain decision memory and shadow recommendations.
-- Public-safe database contract only. Contains no VÁ operational rows.
-- All Phase 3 writes remain private, manager-reviewed and non-operational.

create table if not exists atlas_private.brain_data_connections (
  connection_key text primary key,
  label text not null,
  status text not null default 'not_connected'
    check (status in ('not_connected','pending_review','connected','verified','degraded')),
  source_ref text,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into atlas_private.brain_data_connections (connection_key,label,status,metadata)
values
  ('current_stock','Current verified stock','not_connected','{"required_for":["shortage_prediction","purchase_recommendations"]}'::jsonb),
  ('sales_history','Validated product-level sales history','not_connected','{"required_for":["shortage_prediction","purchase_recommendations","menu_recommendations"]}'::jsonb),
  ('confirmed_deliveries','Confirmed incoming deliveries','not_connected','{"required_for":["shortage_prediction","purchase_recommendations"]}'::jsonb),
  ('supplier_lead_times','Verified supplier lead times','not_connected','{"required_for":["shortage_prediction","purchase_recommendations"]}'::jsonb),
  ('supplier_constraints','Supplier package, minimum and contract constraints','pending_review','{"required_for":["purchase_recommendations"]}'::jsonb),
  ('recipe_costs','Complete verified recipe costs','pending_review','{"required_for":["menu_recommendations"]}'::jsonb),
  ('menu_prices','Verified current menu prices','pending_review','{"required_for":["menu_recommendations"]}'::jsonb),
  ('inventory_movements','Trusted inventory movement history','not_connected','{"required_for":["waste_identification"]}'::jsonb),
  ('stock_counts','Frequent verified stock counts','not_connected','{"required_for":["waste_identification"]}'::jsonb),
  ('waste_events','Waste and expiry event history','not_connected','{"required_for":["waste_identification"]}'::jsonb),
  ('bookings','Bookings and event demand','not_connected','{"optional_for":["shortage_prediction","purchase_recommendations"]}'::jsonb)
on conflict (connection_key) do nothing;

create table if not exists atlas_private.brain_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_key text not null,
  version integer not null check (version > 0),
  fingerprint text not null,
  recommendation_type text not null
    check (recommendation_type in ('data_quality','shortage','purchase','menu','waste','operations','governance')),
  capability_key text not null,
  subject_type text,
  subject_key text,
  title text not null,
  summary text not null,
  explanation text not null,
  suggested_action jsonb not null default '{}'::jsonb,
  alternatives jsonb not null default '[]'::jsonb
    check (jsonb_typeof(alternatives) = 'array'),
  consequence_of_inaction jsonb not null default '{}'::jsonb,
  confidence_state text not null
    check (confidence_state in ('verified','reviewed','pending','historical','modelled')),
  confidence_score numeric(5,4) not null check (confidence_score between 0 and 1),
  confidence_reason text not null,
  limitations text[] not null default '{}',
  priority integer not null default 100,
  shadow_mode boolean not null default true check (shadow_mode is true),
  status text not null default 'active'
    check (status in ('active','accepted','rejected','modified','deferred','expired','superseded')),
  deferred_until timestamptz,
  generated_by text not null default 'atlas-phase3-deterministic/0.1.0',
  generated_at timestamptz not null default now(),
  valid_until timestamptz,
  supersedes_id uuid references atlas_private.brain_recommendations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recommendation_key,version),
  unique (recommendation_key,fingerprint)
);

create table if not exists atlas_private.brain_recommendation_evidence (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.brain_recommendations(id) on delete cascade,
  evidence_key text not null,
  label text not null,
  source_kind text not null,
  source_schema text,
  source_object text,
  source_row_key text,
  source_document text,
  source_page integer check (source_page is null or source_page > 0),
  observed_at timestamptz,
  confidence_state text not null
    check (confidence_state in ('verified','reviewed','pending','historical','modelled')),
  confidence_score numeric(5,4) not null check (confidence_score between 0 and 1),
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (recommendation_id,evidence_key)
);

create table if not exists atlas_private.brain_decisions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.brain_recommendations(id) on delete cascade,
  client_request_id text unique,
  decision text not null check (decision in ('accept','reject','modify','defer','reset')),
  previous_status text not null,
  new_status text not null,
  reason_code text,
  notes text,
  modified_action jsonb,
  deferred_until timestamptz,
  decided_by uuid,
  decided_by_label text,
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.brain_outcomes (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references atlas_private.brain_recommendations(id) on delete cascade,
  decision_id uuid references atlas_private.brain_decisions(id) on delete set null,
  client_request_id text unique,
  outcome_type text not null,
  outcome_status text not null default 'observed'
    check (outcome_status in ('observed','confirmed','disputed')),
  success_score numeric(5,4) check (success_score is null or success_score between 0 and 1),
  result jsonb not null default '{}'::jsonb,
  source_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_refs) = 'array'),
  notes text,
  observed_at timestamptz not null,
  recorded_by uuid,
  recorded_by_label text,
  created_at timestamptz not null default now()
);

create index if not exists brain_recommendations_status_priority_idx
  on atlas_private.brain_recommendations(status,priority,generated_at desc);
create index if not exists brain_recommendations_subject_idx
  on atlas_private.brain_recommendations(subject_type,subject_key,generated_at desc);
create index if not exists brain_evidence_recommendation_idx
  on atlas_private.brain_recommendation_evidence(recommendation_id,created_at);
create index if not exists brain_decisions_recommendation_idx
  on atlas_private.brain_decisions(recommendation_id,created_at desc);
create index if not exists brain_outcomes_recommendation_idx
  on atlas_private.brain_outcomes(recommendation_id,observed_at desc);

alter table atlas_private.brain_data_connections enable row level security;
alter table atlas_private.brain_recommendations enable row level security;
alter table atlas_private.brain_recommendation_evidence enable row level security;
alter table atlas_private.brain_decisions enable row level security;
alter table atlas_private.brain_outcomes enable row level security;

drop policy if exists "service role manages brain data connections" on atlas_private.brain_data_connections;
create policy "service role manages brain data connections"
  on atlas_private.brain_data_connections for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages brain recommendations" on atlas_private.brain_recommendations;
create policy "service role manages brain recommendations"
  on atlas_private.brain_recommendations for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages brain evidence" on atlas_private.brain_recommendation_evidence;
create policy "service role manages brain evidence"
  on atlas_private.brain_recommendation_evidence for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages brain decisions" on atlas_private.brain_decisions;
create policy "service role manages brain decisions"
  on atlas_private.brain_decisions for all to service_role
  using (true) with check (true);

drop policy if exists "service role manages brain outcomes" on atlas_private.brain_outcomes;
create policy "service role manages brain outcomes"
  on atlas_private.brain_outcomes for all to service_role
  using (true) with check (true);

revoke all on atlas_private.brain_data_connections from public,anon,authenticated;
revoke all on atlas_private.brain_recommendations from public,anon,authenticated;
revoke all on atlas_private.brain_recommendation_evidence from public,anon,authenticated;
revoke all on atlas_private.brain_decisions from public,anon,authenticated;
revoke all on atlas_private.brain_outcomes from public,anon,authenticated;
grant all on atlas_private.brain_data_connections to service_role;
grant all on atlas_private.brain_recommendations to service_role;
grant all on atlas_private.brain_recommendation_evidence to service_role;
grant all on atlas_private.brain_decisions to service_role;
grant all on atlas_private.brain_outcomes to service_role;
grant usage,select on all sequences in schema atlas_private to service_role;

drop trigger if exists brain_data_connections_touch on atlas_private.brain_data_connections;
create trigger brain_data_connections_touch
  before update on atlas_private.brain_data_connections
  for each row execute function atlas_private.touch_updated_at();

drop trigger if exists brain_recommendations_touch on atlas_private.brain_recommendations;
create trigger brain_recommendations_touch
  before update on atlas_private.brain_recommendations
  for each row execute function atlas_private.touch_updated_at();

create or replace view atlas_private.brain_capability_gates
with (security_invoker = true)
as
with connection_map as (
  select coalesce(jsonb_object_agg(connection_key,status),'{}'::jsonb) as states
  from atlas_private.brain_data_connections
), gates as (
  select
    'decision_memory'::text as capability_key,
    'Decision memory'::text as label,
    true as enabled,
    'verified'::text as confidence_state,
    1.00::numeric as confidence_score,
    array[]::text[] as blockers,
    array[]::text[] as required_connections
  union all
  select
    'recommendation_explanations','Recommendation explanations',true,'verified',1.00,
    array[]::text[],array[]::text[]
  union all
  select
    'shortage_prediction','Shortage prediction',
    (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'),
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified') then 'reviewed' else 'pending' end,
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified') then 0.85 else 0.20 end,
    array_remove(array[
      case when coalesce(states->>'current_stock','not_connected')<>'verified' then 'Current stock is not verified.' end,
      case when coalesce(states->>'sales_history','not_connected')<>'verified' then 'Validated product-level sales history is not connected.' end,
      case when coalesce(states->>'confirmed_deliveries','not_connected') not in ('connected','verified') then 'Confirmed incoming deliveries are not connected.' end,
      case when coalesce(states->>'supplier_lead_times','not_connected')<>'verified' then 'Supplier lead times are not verified.' end
    ],null),
    array['current_stock','sales_history','confirmed_deliveries','supplier_lead_times']::text[]
  from connection_map
  union all
  select
    'purchase_recommendations','Purchase recommendations',
    (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'
      and states->>'supplier_constraints'='verified'),
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'
      and states->>'supplier_constraints'='verified') then 'reviewed' else 'pending' end,
    case when (states->>'current_stock'='verified'
      and states->>'sales_history'='verified'
      and states->>'confirmed_deliveries' in ('connected','verified')
      and states->>'supplier_lead_times'='verified'
      and states->>'supplier_constraints'='verified') then 0.85 else 0.15 end,
    array_remove(array[
      case when coalesce(states->>'current_stock','not_connected')<>'verified' then 'Current stock is not verified.' end,
      case when coalesce(states->>'sales_history','not_connected')<>'verified' then 'Validated sales history is not connected.' end,
      case when coalesce(states->>'confirmed_deliveries','not_connected') not in ('connected','verified') then 'Confirmed deliveries are not connected.' end,
      case when coalesce(states->>'supplier_lead_times','not_connected')<>'verified' then 'Supplier lead times are not verified.' end,
      case when coalesce(states->>'supplier_constraints','not_connected')<>'verified' then 'Supplier package, cost and contract constraints remain unverified.' end
    ],null),
    array['current_stock','sales_history','confirmed_deliveries','supplier_lead_times','supplier_constraints']::text[]
  from connection_map
  union all
  select
    'menu_recommendations','Menu recommendations',
    (states->>'sales_history'='verified'
      and states->>'recipe_costs'='verified'
      and states->>'menu_prices'='verified'),
    case when (states->>'sales_history'='verified'
      and states->>'recipe_costs'='verified'
      and states->>'menu_prices'='verified') then 'reviewed' else 'pending' end,
    case when (states->>'sales_history'='verified'
      and states->>'recipe_costs'='verified'
      and states->>'menu_prices'='verified') then 0.85 else 0.20 end,
    array_remove(array[
      case when coalesce(states->>'sales_history','not_connected')<>'verified' then 'Validated product-level sales history is not connected.' end,
      case when coalesce(states->>'recipe_costs','not_connected')<>'verified' then 'Complete recipe costs remain unverified.' end,
      case when coalesce(states->>'menu_prices','not_connected')<>'verified' then 'Current menu prices remain unverified.' end
    ],null),
    array['sales_history','recipe_costs','menu_prices']::text[]
  from connection_map
  union all
  select
    'waste_identification','Waste identification',
    (states->>'inventory_movements'='verified'
      and states->>'stock_counts'='verified'
      and states->>'waste_events' in ('connected','verified')),
    case when (states->>'inventory_movements'='verified'
      and states->>'stock_counts'='verified'
      and states->>'waste_events' in ('connected','verified')) then 'reviewed' else 'pending' end,
    case when (states->>'inventory_movements'='verified'
      and states->>'stock_counts'='verified'
      and states->>'waste_events' in ('connected','verified')) then 0.85 else 0.15 end,
    array_remove(array[
      case when coalesce(states->>'inventory_movements','not_connected')<>'verified' then 'Trusted inventory movement history is not connected.' end,
      case when coalesce(states->>'stock_counts','not_connected')<>'verified' then 'Frequent verified stock counts are not connected.' end,
      case when coalesce(states->>'waste_events','not_connected') not in ('connected','verified') then 'Waste and expiry events are not connected.' end
    ],null),
    array['inventory_movements','stock_counts','waste_events']::text[]
  from connection_map
)
select
  capability_key,label,enabled,confidence_state,confidence_score,blockers,required_connections,
  'atlas_private.brain_data_connections'::text as source_ref
from gates;

create or replace view atlas_private.brain_decision_memory
with (security_invoker = true)
as
select
  decision.id as memory_id,
  'recommendation_decision'::text as memory_type,
  coalesce(recommendation.subject_type,recommendation.recommendation_type) as subject_type,
  coalesce(recommendation.subject_key,recommendation.recommendation_key) as subject_key,
  decision.decision as action,
  recommendation.title,
  coalesce(decision.notes,
    format('%s changed the recommendation from %s to %s.',coalesce(decision.decided_by_label,'A manager'),decision.previous_status,decision.new_status)) as summary,
  jsonb_build_object(
    'recommendation_id',recommendation.id,
    'recommendation_key',recommendation.recommendation_key,
    'version',recommendation.version,
    'reason_code',decision.reason_code,
    'modified_action',decision.modified_action,
    'previous_status',decision.previous_status,
    'new_status',decision.new_status
  ) as context,
  decision.decided_by as actor_id,
  decision.decided_by_label as actor_label,
  decision.created_at as occurred_at,
  'atlas_private.brain_decisions'::text as source_ref
from atlas_private.brain_decisions decision
join atlas_private.brain_recommendations recommendation on recommendation.id=decision.recommendation_id
union all
select
  decision.id,
  'source_review_decision'::text,
  decision.row_kind,
  coalesce(decision.source_key,decision.row_id::text),
  decision.decision,
  format('Real VÁ Data decision: %s',coalesce(decision.source_key,decision.row_id::text)),
  coalesce(decision.notes,
    format('%s changed this source row from %s to %s.',coalesce(decision.decided_by_label,'A manager'),decision.previous_status,decision.new_status)),
  jsonb_build_object(
    'row_kind',decision.row_kind,
    'row_id',decision.row_id,
    'batch_id',decision.batch_id,
    'previous_status',decision.previous_status,
    'new_status',decision.new_status,
    'previous_action',decision.previous_action,
    'new_action',decision.new_action,
    'previous_matched_id',decision.previous_matched_id,
    'new_matched_id',decision.new_matched_id
  ),
  decision.decided_by,
  decision.decided_by_label,
  decision.created_at,
  'atlas_private.review_decisions'::text
from atlas_private.review_decisions decision
where decision.previous_status is distinct from decision.new_status
   or decision.previous_action is distinct from decision.new_action
   or decision.previous_matched_id is distinct from decision.new_matched_id;

create or replace view atlas_private.brain_recommendation_feed
with (security_invoker = true)
as
select
  recommendation.*,
  coalesce(evidence.items,'[]'::jsonb) as evidence,
  coalesce(decisions.decision_count,0) as decision_count,
  decisions.last_decision,
  coalesce(outcomes.outcome_count,0) as outcome_count,
  outcomes.last_outcome,
  coalesce(memory.previous_decisions,'[]'::jsonb) as previous_decisions
from atlas_private.brain_recommendations recommendation
left join lateral (
  select jsonb_agg(jsonb_build_object(
    'evidence_key',item.evidence_key,
    'label',item.label,
    'source',jsonb_build_object(
      'kind',item.source_kind,
      'schema',item.source_schema,
      'object',item.source_object,
      'row_key',item.source_row_key,
      'document',item.source_document,
      'page',item.source_page
    ),
    'observed_at',item.observed_at,
    'confidence',jsonb_build_object(
      'state',item.confidence_state,
      'score',item.confidence_score
    ),
    'value',item.value
  ) order by item.evidence_key) as items
  from atlas_private.brain_recommendation_evidence item
  where item.recommendation_id=recommendation.id
) evidence on true
left join lateral (
  select
    count(*)::bigint as decision_count,
    (array_agg(jsonb_build_object(
      'id',decision.id,
      'decision',decision.decision,
      'reason_code',decision.reason_code,
      'notes',decision.notes,
      'modified_action',decision.modified_action,
      'deferred_until',decision.deferred_until,
      'decided_by_label',decision.decided_by_label,
      'created_at',decision.created_at
    ) order by decision.created_at desc))[1] as last_decision
  from atlas_private.brain_decisions decision
  where decision.recommendation_id=recommendation.id
) decisions on true
left join lateral (
  select
    count(*)::bigint as outcome_count,
    (array_agg(jsonb_build_object(
      'id',outcome.id,
      'outcome_type',outcome.outcome_type,
      'outcome_status',outcome.outcome_status,
      'success_score',outcome.success_score,
      'result',outcome.result,
      'notes',outcome.notes,
      'observed_at',outcome.observed_at,
      'recorded_by_label',outcome.recorded_by_label
    ) order by outcome.observed_at desc))[1] as last_outcome
  from atlas_private.brain_outcomes outcome
  where outcome.recommendation_id=recommendation.id
) outcomes on true
left join lateral (
  select coalesce(jsonb_agg(jsonb_build_object(
    'decision',decision.decision,
    'reason_code',decision.reason_code,
    'notes',decision.notes,
    'modified_action',decision.modified_action,
    'status',decision.new_status,
    'actor',decision.decided_by_label,
    'occurred_at',decision.created_at,
    'recommendation_version',previous.version
  ) order by decision.created_at desc),'[]'::jsonb) as previous_decisions
  from atlas_private.brain_recommendations previous
  join atlas_private.brain_decisions decision on decision.recommendation_id=previous.id
  where previous.recommendation_key=recommendation.recommendation_key
    and previous.id<>recommendation.id
) memory on true;

revoke all on atlas_private.brain_capability_gates from public,anon,authenticated;
revoke all on atlas_private.brain_decision_memory from public,anon,authenticated;
revoke all on atlas_private.brain_recommendation_feed from public,anon,authenticated;
grant select on atlas_private.brain_capability_gates to service_role;
grant select on atlas_private.brain_decision_memory to service_role;
grant select on atlas_private.brain_recommendation_feed to service_role;

create or replace function atlas_private.upsert_shadow_recommendation(
  p_recommendation_key text,
  p_recommendation_type text,
  p_capability_key text,
  p_subject_type text,
  p_subject_key text,
  p_title text,
  p_summary text,
  p_explanation text,
  p_suggested_action jsonb,
  p_alternatives jsonb,
  p_consequence_of_inaction jsonb,
  p_confidence_state text,
  p_confidence_score numeric,
  p_confidence_reason text,
  p_limitations text[],
  p_priority integer,
  p_source_kind text,
  p_source_schema text,
  p_source_object text,
  p_source_row_key text,
  p_evidence_label text,
  p_evidence_value jsonb,
  p_observed_at timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  calculated_fingerprint text;
  existing_row atlas_private.brain_recommendations;
  previous_row atlas_private.brain_recommendations;
  next_version integer;
  recommendation_id uuid;
begin
  if p_confidence_score < 0 or p_confidence_score > 1 then
    raise exception 'Confidence score must be between 0 and 1';
  end if;
  if jsonb_typeof(coalesce(p_alternatives,'[]'::jsonb)) <> 'array' then
    raise exception 'Alternatives must be a JSON array';
  end if;

  calculated_fingerprint := md5(concat_ws('|',
    p_recommendation_key,
    coalesce(p_subject_key,''),
    coalesce(p_evidence_value,'{}'::jsonb)::text,
    coalesce(p_suggested_action,'{}'::jsonb)::text,
    p_confidence_state,
    p_confidence_score::text,
    coalesce(array_to_string(p_limitations,'|'),'')
  ));

  select * into existing_row
  from atlas_private.brain_recommendations
  where recommendation_key=p_recommendation_key
    and fingerprint=calculated_fingerprint;

  if found then
    if existing_row.status='active' then
      update atlas_private.brain_recommendations
      set updated_at=pg_catalog.now(),generated_at=pg_catalog.now()
      where id=existing_row.id;
    end if;
    recommendation_id := existing_row.id;
  else
    select * into previous_row
    from atlas_private.brain_recommendations
    where recommendation_key=p_recommendation_key
    order by version desc
    limit 1;

    select coalesce(max(version),0)+1 into next_version
    from atlas_private.brain_recommendations
    where recommendation_key=p_recommendation_key;

    if previous_row.id is not null and previous_row.status in ('active','deferred') then
      update atlas_private.brain_recommendations
      set status='superseded',updated_at=pg_catalog.now()
      where id=previous_row.id;
    end if;

    insert into atlas_private.brain_recommendations (
      recommendation_key,version,fingerprint,recommendation_type,capability_key,
      subject_type,subject_key,title,summary,explanation,suggested_action,
      alternatives,consequence_of_inaction,confidence_state,confidence_score,
      confidence_reason,limitations,priority,shadow_mode,status,generated_by,
      generated_at,supersedes_id
    ) values (
      p_recommendation_key,next_version,calculated_fingerprint,p_recommendation_type,p_capability_key,
      p_subject_type,p_subject_key,p_title,p_summary,p_explanation,coalesce(p_suggested_action,'{}'::jsonb),
      coalesce(p_alternatives,'[]'::jsonb),coalesce(p_consequence_of_inaction,'{}'::jsonb),
      p_confidence_state,p_confidence_score,p_confidence_reason,coalesce(p_limitations,'{}'::text[]),
      p_priority,true,'active','atlas-phase3-deterministic/0.1.0',pg_catalog.now(),previous_row.id
    ) returning id into recommendation_id;
  end if;

  insert into atlas_private.brain_recommendation_evidence (
    recommendation_id,evidence_key,label,source_kind,source_schema,source_object,
    source_row_key,observed_at,confidence_state,confidence_score,value
  ) values (
    recommendation_id,'primary',p_evidence_label,p_source_kind,p_source_schema,p_source_object,
    p_source_row_key,p_observed_at,p_confidence_state,p_confidence_score,coalesce(p_evidence_value,'{}'::jsonb)
  )
  on conflict (recommendation_id,evidence_key) do update
  set label=excluded.label,
      source_kind=excluded.source_kind,
      source_schema=excluded.source_schema,
      source_object=excluded.source_object,
      source_row_key=excluded.source_row_key,
      observed_at=excluded.observed_at,
      confidence_state=excluded.confidence_state,
      confidence_score=excluded.confidence_score,
      value=excluded.value;

  return recommendation_id;
end;
$$;

create or replace function atlas_private.refresh_phase3_shadow_recommendations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  total_rows bigint := 0;
  pending_rows bigint := 0;
  reviewed_rows bigint := 0;
  issue_row record;
  gate_row record;
  recommendation_id uuid;
  generated_ids uuid[] := '{}';
begin
  select
    coalesce(sum(total_rows),0),
    coalesce(sum(pending_rows),0),
    coalesce(sum(approved_rows+rejected_rows+imported_rows),0)
  into total_rows,pending_rows,reviewed_rows
  from atlas_private.data_coverage;

  recommendation_id := atlas_private.upsert_shadow_recommendation(
    'data-readiness:review-queue',
    'data_quality',
    'decision_memory',
    'review_queue',
    'all',
    format('Review %s pending source records',pending_rows),
    format('%s of %s staged records have completed a manager decision.',reviewed_rows,total_rows),
    'Atlas cannot safely treat pending source rows as operational facts. Reviewing the highest-volume issue groups improves the evidence available to every later Brain capability.',
    jsonb_build_object('kind','open_review','target','sprint3-review','scope','all','status','pending'),
    jsonb_build_array(jsonb_build_object('label','Review one domain at a time','target','sprint3-review')),
    jsonb_build_object('risk','Shortage, purchase, menu and waste intelligence remain constrained by unresolved source mappings.'),
    'verified',1.00,
    'Queue totals are counted directly from the private review graph.',
    array['This recommendation improves data readiness; it does not change operational inventory.'],
    10,
    'database_view','atlas_private','data_coverage','all',
    'Real VÁ Data review coverage',
    jsonb_build_object('total_rows',total_rows,'pending_rows',pending_rows,'reviewed_rows',reviewed_rows),
    pg_catalog.now()
  );
  generated_ids := array_append(generated_ids,recommendation_id);

  for gate_row in
    select * from atlas_private.brain_capability_gates
    where enabled is false
    order by capability_key
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'capability-blocker:'||gate_row.capability_key,
      'governance',
      gate_row.capability_key,
      'capability',
      gate_row.capability_key,
      'Unlock '||gate_row.label,
      gate_row.label||' remains blocked until its required evidence is connected and verified.',
      'Atlas is intentionally refusing to generate this operational recommendation because one or more required evidence streams are missing or unverified.',
      jsonb_build_object('kind','connect_evidence','capability',gate_row.capability_key,'required_connections',gate_row.required_connections),
      jsonb_build_array(jsonb_build_object('label','Keep capability disabled','safe',true)),
      jsonb_build_object('risk','Enabling this capability early could create false confidence and unsafe operational decisions.'),
      'verified',1.00,
      'The blocker is computed from the explicit Phase 3 data-connection registry.',
      gate_row.blockers,
      15,
      'database_view','atlas_private','brain_capability_gates',gate_row.capability_key,
      gate_row.label||' evidence gate',
      jsonb_build_object('enabled',gate_row.enabled,'blockers',gate_row.blockers,'required_connections',gate_row.required_connections),
      pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  for issue_row in
    select entity_type,issue,severity,issue_count,
      case severity when 'error' then 1 when 'warning' then 2 when 'review' then 3 else 4 end as severity_rank
    from atlas_private.review_summary
    order by severity_rank,issue_count desc,issue
    limit 8
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'data-quality:'||issue_row.entity_type||':'||issue_row.issue,
      'data_quality',
      'recommendation_explanations',
      issue_row.entity_type,
      issue_row.issue,
      initcap(replace(issue_row.issue,'_',' ')),
      format('%s %s records carry this unresolved issue.',issue_row.issue_count,replace(issue_row.entity_type,'_',' ')),
      'Atlas recommends resolving this issue group because it is one of the largest current gaps in the private VÁ source graph. The recommendation is about evidence quality, not current stock or sales performance.',
      jsonb_build_object('kind','open_review','target','sprint3-review','entity_type',issue_row.entity_type,'issue',issue_row.issue),
      jsonb_build_array(jsonb_build_object('label','Defer this issue group','effect','The related Brain capabilities remain constrained.')),
      jsonb_build_object('risk','Unresolved records cannot be promoted into trusted operational context.'),
      'pending',0.45,
      'The issue count is verified, while the affected records remain unresolved.',
      array['Pending records are review work and are not treated as operational facts.'],
      20+issue_row.severity_rank,
      'database_view','atlas_private','review_summary',issue_row.entity_type||':'||issue_row.issue,
      'Unresolved source issue count',
      jsonb_build_object('entity_type',issue_row.entity_type,'issue_key',issue_row.issue,'severity',issue_row.severity,'issue_count',issue_row.issue_count),
      pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  return jsonb_build_object(
    'mode','shadow',
    'generated_at',pg_catalog.now(),
    'generated_recommendation_ids',to_jsonb(generated_ids),
    'recommendation_count',coalesce(array_length(generated_ids,1),0),
    'automatic_mutation',false
  );
end;
$$;

create or replace function atlas_private.decide_phase3_recommendation(
  p_recommendation_id uuid,
  p_decision text,
  p_reason_code text default null,
  p_notes text default null,
  p_modified_action jsonb default null,
  p_deferred_until timestamptz default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  before_row atlas_private.brain_recommendations;
  after_row atlas_private.brain_recommendations;
  existing_decision atlas_private.brain_decisions;
  new_status text;
  decision_id uuid;
begin
  if p_decision not in ('accept','reject','modify','defer','reset') then
    raise exception 'Invalid Phase 3 decision: %',p_decision;
  end if;

  if p_client_request_id is not null then
    select * into existing_decision
    from atlas_private.brain_decisions
    where client_request_id=p_client_request_id;
    if found then
      return jsonb_build_object('idempotent',true,'decision_id',existing_decision.id,'recommendation_id',existing_decision.recommendation_id);
    end if;
  end if;

  select * into before_row
  from atlas_private.brain_recommendations
  where id=p_recommendation_id
  for update;
  if not found then raise exception 'Phase 3 recommendation not found'; end if;

  if before_row.shadow_mode is not true then
    raise exception 'Only shadow recommendations can be decided in this Phase 3 checkpoint';
  end if;

  new_status := case p_decision
    when 'accept' then 'accepted'
    when 'reject' then 'rejected'
    when 'modify' then 'modified'
    when 'defer' then 'deferred'
    else 'active'
  end;

  if p_decision='modify' and (p_modified_action is null or p_modified_action='{}'::jsonb) then
    raise exception 'A modified recommendation requires a replacement action';
  end if;
  if p_decision='defer' and p_deferred_until is null then
    raise exception 'A deferred recommendation requires a deferred-until timestamp';
  end if;

  update atlas_private.brain_recommendations
  set status=new_status,
      suggested_action=case when p_decision='modify' then p_modified_action else suggested_action end,
      deferred_until=case when p_decision='defer' then p_deferred_until else null end,
      updated_at=pg_catalog.now()
  where id=p_recommendation_id
  returning * into after_row;

  insert into atlas_private.brain_decisions (
    recommendation_id,client_request_id,decision,previous_status,new_status,
    reason_code,notes,modified_action,deferred_until,decided_by,decided_by_label
  ) values (
    p_recommendation_id,p_client_request_id,p_decision,before_row.status,after_row.status,
    p_reason_code,p_notes,p_modified_action,p_deferred_until,p_decided_by,p_decided_by_label
  ) returning id into decision_id;

  return jsonb_build_object(
    'idempotent',false,
    'decision_id',decision_id,
    'recommendation_id',after_row.id,
    'recommendation_key',after_row.recommendation_key,
    'previous_status',before_row.status,
    'new_status',after_row.status,
    'automatic_mutation',false
  );
end;
$$;

create or replace function atlas_private.record_phase3_outcome(
  p_recommendation_id uuid,
  p_decision_id uuid default null,
  p_outcome_type text default 'manager_observation',
  p_outcome_status text default 'observed',
  p_success_score numeric default null,
  p_result jsonb default '{}'::jsonb,
  p_source_refs jsonb default '[]'::jsonb,
  p_notes text default null,
  p_observed_at timestamptz default now(),
  p_recorded_by uuid default null,
  p_recorded_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_outcome atlas_private.brain_outcomes;
  outcome_id uuid;
begin
  if p_success_score is not null and (p_success_score<0 or p_success_score>1) then
    raise exception 'Outcome success score must be between 0 and 1';
  end if;
  if p_outcome_status not in ('observed','confirmed','disputed') then
    raise exception 'Invalid outcome status';
  end if;
  if jsonb_typeof(coalesce(p_source_refs,'[]'::jsonb))<>'array' then
    raise exception 'Outcome source references must be a JSON array';
  end if;

  perform 1 from atlas_private.brain_recommendations where id=p_recommendation_id;
  if not found then raise exception 'Phase 3 recommendation not found'; end if;

  if p_client_request_id is not null then
    select * into existing_outcome
    from atlas_private.brain_outcomes
    where client_request_id=p_client_request_id;
    if found then
      return jsonb_build_object('idempotent',true,'outcome_id',existing_outcome.id,'recommendation_id',existing_outcome.recommendation_id);
    end if;
  end if;

  insert into atlas_private.brain_outcomes (
    recommendation_id,decision_id,client_request_id,outcome_type,outcome_status,
    success_score,result,source_refs,notes,observed_at,recorded_by,recorded_by_label
  ) values (
    p_recommendation_id,p_decision_id,p_client_request_id,p_outcome_type,p_outcome_status,
    p_success_score,coalesce(p_result,'{}'::jsonb),coalesce(p_source_refs,'[]'::jsonb),
    p_notes,p_observed_at,p_recorded_by,p_recorded_by_label
  ) returning id into outcome_id;

  return jsonb_build_object(
    'idempotent',false,
    'outcome_id',outcome_id,
    'recommendation_id',p_recommendation_id,
    'automatic_mutation',false
  );
end;
$$;

create or replace function atlas_private.phase3_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
select jsonb_build_object(
  'version','atlas-phase3/0.1.0',
  'mode','shadow',
  'generated_at',pg_catalog.now(),
  'stats',jsonb_build_object(
    'active_recommendations',(select count(*) from atlas_private.brain_recommendations where status='active'),
    'deferred_recommendations',(select count(*) from atlas_private.brain_recommendations where status='deferred'),
    'manager_decisions',(select count(*) from atlas_private.brain_decisions),
    'recorded_outcomes',(select count(*) from atlas_private.brain_outcomes),
    'memory_events',(select count(*) from atlas_private.brain_decision_memory)
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
    'manager_review_required',true
  )
);
$$;

create or replace function public.atlas_phase3_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select atlas_private.phase3_snapshot();
$$;

create or replace function public.atlas_phase3_refresh_shadow_recommendations()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.refresh_phase3_shadow_recommendations();
$$;

create or replace function public.atlas_phase3_decide_recommendation(
  p_recommendation_id uuid,
  p_decision text,
  p_reason_code text default null,
  p_notes text default null,
  p_modified_action jsonb default null,
  p_deferred_until timestamptz default null,
  p_decided_by uuid default null,
  p_decided_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.decide_phase3_recommendation(
    p_recommendation_id,p_decision,p_reason_code,p_notes,p_modified_action,
    p_deferred_until,p_decided_by,p_decided_by_label,p_client_request_id
  );
$$;

create or replace function public.atlas_phase3_record_outcome(
  p_recommendation_id uuid,
  p_decision_id uuid default null,
  p_outcome_type text default 'manager_observation',
  p_outcome_status text default 'observed',
  p_success_score numeric default null,
  p_result jsonb default '{}'::jsonb,
  p_source_refs jsonb default '[]'::jsonb,
  p_notes text default null,
  p_observed_at timestamptz default now(),
  p_recorded_by uuid default null,
  p_recorded_by_label text default null,
  p_client_request_id text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select atlas_private.record_phase3_outcome(
    p_recommendation_id,p_decision_id,p_outcome_type,p_outcome_status,p_success_score,
    p_result,p_source_refs,p_notes,p_observed_at,p_recorded_by,p_recorded_by_label,p_client_request_id
  );
$$;

revoke execute on function atlas_private.upsert_shadow_recommendation(text,text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text,numeric,text,text[],integer,text,text,text,text,text,jsonb,timestamptz)
  from public,anon,authenticated;
revoke execute on function atlas_private.refresh_phase3_shadow_recommendations()
  from public,anon,authenticated;
revoke execute on function atlas_private.decide_phase3_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  from public,anon,authenticated;
revoke execute on function atlas_private.record_phase3_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  from public,anon,authenticated;
revoke execute on function atlas_private.phase3_snapshot()
  from public,anon,authenticated;

revoke execute on function public.atlas_phase3_snapshot()
  from public,anon,authenticated;
revoke execute on function public.atlas_phase3_refresh_shadow_recommendations()
  from public,anon,authenticated;
revoke execute on function public.atlas_phase3_decide_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  from public,anon,authenticated;
revoke execute on function public.atlas_phase3_record_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  from public,anon,authenticated;

grant execute on function atlas_private.upsert_shadow_recommendation(text,text,text,text,text,text,text,text,jsonb,jsonb,jsonb,text,numeric,text,text[],integer,text,text,text,text,text,jsonb,timestamptz)
  to service_role;
grant execute on function atlas_private.refresh_phase3_shadow_recommendations()
  to service_role;
grant execute on function atlas_private.decide_phase3_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  to service_role;
grant execute on function atlas_private.record_phase3_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  to service_role;
grant execute on function atlas_private.phase3_snapshot()
  to service_role;

grant execute on function public.atlas_phase3_snapshot()
  to service_role;
grant execute on function public.atlas_phase3_refresh_shadow_recommendations()
  to service_role;
grant execute on function public.atlas_phase3_decide_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)
  to service_role;
grant execute on function public.atlas_phase3_record_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)
  to service_role;

comment on table atlas_private.brain_recommendations is
  'Versioned, evidence-backed Atlas Brain recommendations. Phase 3 begins in shadow mode only.';
comment on table atlas_private.brain_decisions is
  'Immutable manager decisions used by Atlas Decision Memory.';
comment on table atlas_private.brain_outcomes is
  'Observed outcomes used to measure recommendation usefulness and future accuracy.';
comment on view atlas_private.brain_decision_memory is
  'Auditable memory of significant Real VÁ Data and Atlas recommendation decisions.';
comment on function public.atlas_phase3_snapshot() is
  'Service-role-only Phase 3 shadow snapshot. Never mutates operational records.';
