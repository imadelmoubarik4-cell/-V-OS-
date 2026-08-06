-- Consolidate Checkpoint K on the deployed atlas_private.brain_* model.
-- The later atlas_private.intelligence_* experiment was never used by the
-- browser or Edge Function. Refuse to remove it if any operational records
-- unexpectedly exist, then remove only that unused model.
--
-- Every experimental relation is checked through dynamic SQL. PostgreSQL parses
-- static relation references before evaluating to_regclass guards, so a clean
-- replay where one optional experiment table is absent must never fail merely
-- because the relation name appears in an unreachable branch.
do $checkpoint_k_consolidation$
declare
  table_name text;
  contains_records boolean;
begin
  foreach table_name in array array[
    'intelligence_runs',
    'intelligence_capabilities',
    'intelligence_recommendations',
    'intelligence_evidence',
    'intelligence_decisions',
    'intelligence_outcomes',
    'intelligence_events'
  ]
  loop
    if to_regclass(format('atlas_private.%I',table_name)) is null then
      continue;
    end if;

    execute format(
      'select exists (select 1 from atlas_private.%I limit 1)',
      table_name
    ) into contains_records;

    if contains_records then
      raise exception 'Cannot consolidate Checkpoint K: % contains records',table_name;
    end if;
  end loop;
end
$checkpoint_k_consolidation$;

drop function if exists public.atlas_intelligence_decide(uuid,text,text,uuid,text,text);
drop function if exists public.atlas_intelligence_record_outcome(uuid,text,text,jsonb,timestamptz,uuid,text,text);
drop function if exists public.atlas_intelligence_save_run(jsonb,jsonb,jsonb,uuid,text,text);
drop function if exists public.atlas_intelligence_snapshot(uuid,text);

drop function if exists atlas_private.intelligence_decide(uuid,text,text,uuid,text,text);
drop function if exists atlas_private.intelligence_record_outcome(uuid,text,text,jsonb,timestamptz,uuid,text,text);
drop function if exists atlas_private.intelligence_save_run(jsonb,jsonb,jsonb,uuid,text,text);
drop function if exists atlas_private.intelligence_snapshot(uuid,text);

drop table if exists atlas_private.intelligence_events;
drop table if exists atlas_private.intelligence_outcomes;
drop table if exists atlas_private.intelligence_decisions;
drop table if exists atlas_private.intelligence_evidence;
drop table if exists atlas_private.intelligence_recommendations;
drop table if exists atlas_private.intelligence_capabilities;
drop table if exists atlas_private.intelligence_runs;

comment on table atlas_private.brain_intelligence_snapshots is
  'Canonical Checkpoint K private source-coverage snapshot. Uses the existing brain recommendation, evidence, decision and outcome model.';
