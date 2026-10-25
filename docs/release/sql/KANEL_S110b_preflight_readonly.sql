-- KANEL × ALCEDO bookings — S110b PREFLIGHT (READ-ONLY). Run immediately before the
-- S110b apply bundle; keep the output. One SELECT; writes nothing. Go only if every
-- row is PASS.
select section, "check", status, detail from (
select 1 as ord, 'ledger' as section, 'production is at S110' as "check",
  case when (select max(version) from supabase_migrations.schema_migrations) = '20261027090000' then 'PASS' else 'FAIL' end as status,
  'last migration ' || coalesce((select max(version) from supabase_migrations.schema_migrations), 'none') as detail
union all select 2, 'ledger', 'no S110b row yet',
  case when not exists (select 1 from supabase_migrations.schema_migrations where version = '20261027120000') then 'PASS' else 'FAIL' end, ''
union all select 3, 'function', 'atlas_bookings_notifications is exactly the S109 definition',
  case when (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.atlas_bookings_notifications(uuid,text,integer)'::pg_catalog.regprocedure)))
            = 'ad9b5f669b08363c5ce9c1b3ba934cf1' then 'PASS' else 'FAIL' end,
  (select pg_catalog.md5(pg_catalog.pg_get_functiondef('public.atlas_bookings_notifications(uuid,text,integer)'::pg_catalog.regprocedure)))
union all select 4, 'function', 'browser roles cannot call it',
  case when not pg_catalog.has_function_privilege('anon', 'public.atlas_bookings_notifications(uuid,text,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.atlas_bookings_notifications(uuid,text,integer)', 'EXECUTE')
       then 'PASS' else 'FAIL' end, ''
) checks order by ord;
