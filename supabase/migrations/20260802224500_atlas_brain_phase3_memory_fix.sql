-- Sprint 4 Phase 3 - qualify PL/pgSQL variables used by memory generation.
-- Public-safe function correction only. Contains no VÁ operational rows.

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
  v_recommendation_id uuid;
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
  from atlas_private.brain_recommendations recommendation
  where recommendation.recommendation_key=p_recommendation_key
    and recommendation.fingerprint=calculated_fingerprint;

  if found then
    if existing_row.status='active' then
      update atlas_private.brain_recommendations recommendation
      set updated_at=pg_catalog.now(),generated_at=pg_catalog.now()
      where recommendation.id=existing_row.id;
    end if;
    v_recommendation_id := existing_row.id;
  else
    select * into previous_row
    from atlas_private.brain_recommendations recommendation
    where recommendation.recommendation_key=p_recommendation_key
    order by recommendation.version desc
    limit 1;

    select coalesce(max(recommendation.version),0)+1 into next_version
    from atlas_private.brain_recommendations recommendation
    where recommendation.recommendation_key=p_recommendation_key;

    if previous_row.id is not null and previous_row.status in ('active','deferred') then
      update atlas_private.brain_recommendations recommendation
      set status='superseded',updated_at=pg_catalog.now()
      where recommendation.id=previous_row.id;
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
    ) returning id into v_recommendation_id;
  end if;

  insert into atlas_private.brain_recommendation_evidence (
    recommendation_id,evidence_key,label,source_kind,source_schema,source_object,
    source_row_key,observed_at,confidence_state,confidence_score,value
  ) values (
    v_recommendation_id,'primary',p_evidence_label,p_source_kind,p_source_schema,p_source_object,
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

  return v_recommendation_id;
end;
$$;

create or replace function atlas_private.refresh_phase3_shadow_recommendations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_total_rows bigint := 0;
  v_pending_rows bigint := 0;
  v_reviewed_rows bigint := 0;
  issue_row record;
  gate_row record;
  recommendation_id uuid;
  generated_ids uuid[] := '{}';
begin
  select
    coalesce(sum(coverage.total_rows),0),
    coalesce(sum(coverage.pending_rows),0),
    coalesce(sum(coverage.approved_rows+coverage.rejected_rows+coverage.imported_rows),0)
  into v_total_rows,v_pending_rows,v_reviewed_rows
  from atlas_private.data_coverage coverage;

  recommendation_id := atlas_private.upsert_shadow_recommendation(
    'data-readiness:review-queue','data_quality','decision_memory','review_queue','all',
    format('Review %s pending source records',v_pending_rows),
    format('%s of %s staged records have completed a manager decision.',v_reviewed_rows,v_total_rows),
    'Atlas cannot safely treat pending source rows as operational facts. Reviewing the highest-volume issue groups improves the evidence available to every later Brain capability.',
    jsonb_build_object('kind','open_review','target','sprint3-review','scope','all','status','pending'),
    jsonb_build_array(jsonb_build_object('label','Review one domain at a time','target','sprint3-review')),
    jsonb_build_object('risk','Shortage, purchase, menu and waste intelligence remain constrained by unresolved source mappings.'),
    'verified',1.00,'Queue totals are counted directly from the private review graph.',
    array['This recommendation improves data readiness; it does not change operational inventory.'],
    10,'database_view','atlas_private','data_coverage','all','Real VÁ Data review coverage',
    jsonb_build_object('total_rows',v_total_rows,'pending_rows',v_pending_rows,'reviewed_rows',v_reviewed_rows),pg_catalog.now()
  );
  generated_ids := array_append(generated_ids,recommendation_id);

  for gate_row in
    select * from atlas_private.brain_capability_gates where enabled is false order by capability_key
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'capability-blocker:'||gate_row.capability_key,'governance',gate_row.capability_key,'capability',gate_row.capability_key,
      'Unlock '||gate_row.label,
      gate_row.label||' remains blocked until its required evidence is connected and verified.',
      'Atlas is intentionally refusing to generate this operational recommendation because one or more required evidence streams are missing or unverified.',
      jsonb_build_object('kind','connect_evidence','capability',gate_row.capability_key,'required_connections',gate_row.required_connections),
      jsonb_build_array(jsonb_build_object('label','Keep capability disabled','safe',true)),
      jsonb_build_object('risk','Enabling this capability early could create false confidence and unsafe operational decisions.'),
      'verified',1.00,'The blocker is computed from the explicit Phase 3 data-connection registry.',
      gate_row.blockers,15,'database_view','atlas_private','brain_capability_gates',gate_row.capability_key,
      gate_row.label||' evidence gate',
      jsonb_build_object('enabled',gate_row.enabled,'blockers',gate_row.blockers,'required_connections',gate_row.required_connections),pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  for issue_row in
    select summary.entity_type,summary.issue,summary.severity,summary.issue_count,
      case summary.severity when 'error' then 1 when 'warning' then 2 when 'review' then 3 else 4 end as severity_rank
    from atlas_private.review_summary summary
    order by severity_rank,summary.issue_count desc,summary.issue
    limit 8
  loop
    recommendation_id := atlas_private.upsert_shadow_recommendation(
      'data-quality:'||issue_row.entity_type||':'||issue_row.issue,'data_quality','recommendation_explanations',
      issue_row.entity_type,issue_row.issue,initcap(replace(issue_row.issue,'_',' ')),
      format('%s %s records carry this unresolved issue.',issue_row.issue_count,replace(issue_row.entity_type,'_',' ')),
      'Atlas recommends resolving this issue group because it is one of the largest current gaps in the private VÁ source graph. The recommendation is about evidence quality, not current stock or sales performance.',
      jsonb_build_object('kind','open_review','target','sprint3-review','entity_type',issue_row.entity_type,'issue',issue_row.issue),
      jsonb_build_array(jsonb_build_object('label','Defer this issue group','effect','The related Brain capabilities remain constrained.')),
      jsonb_build_object('risk','Unresolved records cannot be promoted into trusted operational context.'),
      'pending',0.45,'The issue count is verified, while the affected records remain unresolved.',
      array['Pending records are review work and are not treated as operational facts.'],
      20+issue_row.severity_rank,'database_view','atlas_private','review_summary',issue_row.entity_type||':'||issue_row.issue,
      'Unresolved source issue count',
      jsonb_build_object('entity_type',issue_row.entity_type,'issue_key',issue_row.issue,'severity',issue_row.severity,'issue_count',issue_row.issue_count),pg_catalog.now()
    );
    generated_ids := array_append(generated_ids,recommendation_id);
  end loop;

  return jsonb_build_object(
    'mode','shadow','generated_at',pg_catalog.now(),
    'generated_recommendation_ids',to_jsonb(generated_ids),
    'recommendation_count',coalesce(array_length(generated_ids,1),0),
    'automatic_mutation',false
  );
end;
$$;
