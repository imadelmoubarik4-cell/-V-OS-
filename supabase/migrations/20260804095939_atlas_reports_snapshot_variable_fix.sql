-- The first live-source draft used the local name `generated_at`, which could
-- collide with brain_recommendations.generated_at in PL/pgSQL. The versioned
-- function stored by the preceding migration already uses
-- `generated_at_value`. Keep this migration as an explicit history checkpoint
-- and fail clearly if the corrected function is ever missing on a fresh branch.

do $migration$
begin
  if pg_catalog.to_regprocedure(
    'atlas_private.reports_snapshot_v2(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,text,date,date,date,date,text,jsonb)'
  ) is null then
    raise exception 'Corrected Reports snapshot function is missing';
  end if;
end;
$migration$;
