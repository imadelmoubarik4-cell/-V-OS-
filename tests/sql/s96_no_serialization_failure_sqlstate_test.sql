-- S96 opsrisk regression test: no Atlas function may raise SQLSTATE 40001.
-- PostgREST retries a transaction that fails with 40001 indefinitely, so a
-- deterministic "stale version" refusal raised with 40001 never returns and
-- pins a pooled connection (observed live in production since 2026-09-26).
-- Fails before 20261010096300, passes after. Read-only.
do $t$
declare offenders text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by 1) into offenders
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'atlas_private', 'private')
    and p.prosrc ~ 'errcode\s*=\s*''40001''';
  if offenders is not null then
    raise exception 'FAIL: functions raise SQLSTATE 40001 (PostgREST infinite retry): %', offenders;
  end if;
  raise notice 'pass: no Atlas function raises SQLSTATE 40001';
end
$t$;
