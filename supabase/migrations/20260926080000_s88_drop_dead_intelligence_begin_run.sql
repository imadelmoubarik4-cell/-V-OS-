-- S88: remove the orphaned Checkpoint K experiment entry point.
--
-- 20260805122942_atlas_intelligence_checkpoint_k.sql created
-- atlas_private.intelligence_begin_run(...) and its service-role wrapper
-- public.atlas_intelligence_begin_run(...). Both insert into
-- atlas_private.intelligence_runs. 20260805125412_atlas_intelligence_checkpoint_k_consolidation.sql
-- dropped that table and the experiment's other functions, but not these two,
-- and no later migration recreates the table. No Edge Function, browser module
-- or script calls either function, so they can only fail at runtime.
--
-- Drop them only while the experiment table is absent. Signatures are exact;
-- IF EXISTS keeps the migration safe on databases that never had them.

do $s88_dead_begin_run$
begin
  if to_regclass('atlas_private.intelligence_runs') is null then
    drop function if exists public.atlas_intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text);
    drop function if exists atlas_private.intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text);
  end if;
end
$s88_dead_begin_run$;

notify pgrst, 'reload schema';
