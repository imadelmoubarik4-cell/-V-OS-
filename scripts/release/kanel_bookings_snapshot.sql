-- Read-only structural snapshot of the public + atlas_private schemas, as one JSON
-- document. Used to derive and to verify the S106–S109 rollback (and, at release
-- time, to record production's pre-migration state). Reads catalog views only.
select pg_catalog.jsonb_build_object(
  'functions', (
    select coalesce(pg_catalog.jsonb_object_agg(k, v), '{}'::jsonb) from (
      select n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as k,
        pg_catalog.jsonb_build_object(
          'schema', n.nspname, 'name', p.proname,
          'args', pg_catalog.pg_get_function_identity_arguments(p.oid),
          'src_md5', pg_catalog.md5(p.prosrc),
          'secdef', p.prosecdef,
          'config', coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
          'acl', coalesce(p.proacl::text, ''),
          'def', pg_catalog.pg_get_functiondef(p.oid)) as v
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','atlas_private') and p.prokind = 'f'
        and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
    ) f),
  'triggers', (
    select coalesce(pg_catalog.jsonb_object_agg(k, v), '{}'::jsonb) from (
      select n.nspname || '.' || c.relname || '.' || t.tgname as k,
        pg_catalog.jsonb_build_object('table', n.nspname || '.' || c.relname, 'name', t.tgname,
          'def', pg_catalog.pg_get_triggerdef(t.oid)) as v
      from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','atlas_private') and not t.tgisinternal
    ) t),
  'constraints', (
    select coalesce(pg_catalog.jsonb_object_agg(k, v), '{}'::jsonb) from (
      select n.nspname || '.' || c.relname || '.' || con.conname as k,
        pg_catalog.jsonb_build_object('table', n.nspname || '.' || c.relname, 'name', con.conname,
          'def', pg_catalog.pg_get_constraintdef(con.oid)) as v
      from pg_catalog.pg_constraint con join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','atlas_private')
    ) x),
  'policies', (
    select coalesce(pg_catalog.jsonb_object_agg(schemaname || '.' || tablename || '.' || policyname,
      pg_catalog.jsonb_build_object('cmd', cmd, 'roles', roles::text, 'qual', qual, 'check', with_check)), '{}'::jsonb)
    from pg_catalog.pg_policies where schemaname in ('public','atlas_private')),
  'tables', (
    select coalesce(pg_catalog.jsonb_object_agg(n.nspname || '.' || c.relname,
      (select pg_catalog.jsonb_agg(a.attname order by a.attnum) from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)), '{}'::jsonb)
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','atlas_private') and c.relkind in ('r','p'))
)::text;
