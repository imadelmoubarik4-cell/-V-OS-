-- Consolidate Checkpoint K on the deployed atlas_private.brain_* model.
-- The later atlas_private.intelligence_* experiment was never used by the
-- browser or Edge Function. Refuse to remove it if any operational records
-- unexpectedly exist, then remove only that unused model.

do $$
begin
  if to_regclass('atlas_private.intelligence_runs') is not null
     and exists (select 1 from atlas_private.intelligence_runs limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_runs contains records';
  end if;
  if to_regclass('atlas_private.intelligence_capabilities') is not null
     and exists (select 1 from atlas_private.intelligence_capabilities limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_capabilities contains records';
  end if;
  if to_regclass('atlas_private.intelligence_recommendations') is not null
     and exists (select 1 from atlas_private.intelligence_recommendations limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_recommendations contains records';
  end if;
  if to_regclass('atlas_private.intelligence_evidence') is not null
     and exists (select 1 from atlas_private.intelligence_evidence limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_evidence contains records';
  end if;
  if to_regclass('atlas_private.intelligence_decisions') is not null
     and exists (select 1 from atlas_private.intelligence_decisions limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_decisions contains records';
  end if;
  if to_regclass('atlas_private.intelligence_outcomes') is not null
     and exists (select 1 from atlas_private.intelligence_outcomes limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_outcomes contains records';
  end if;
  if to_regclass('atlas_private.intelligence_events') is not null
     and exists (select 1 from atlas_private.intelligence_events limit 1) then
    raise exception 'Cannot consolidate Checkpoint K: intelligence_events contains records';
  end if;
end;
$$;

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
