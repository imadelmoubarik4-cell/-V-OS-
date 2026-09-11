-- Atlas S36 Git-only staging-blocker remediation.
-- The historical migration replay does not include the S33 runtime overlay,
-- so this hardening is conditional there. S35 preflight requires the table.

set lock_timeout = '5s';
set statement_timeout = '2min';

do $migration$
begin
  if pg_catalog.to_regclass('atlas_private.report_events') is not null then
    execute 'alter table atlas_private.report_events enable row level security';

    execute 'revoke all on table atlas_private.report_events from public, anon, authenticated, service_role';
    execute 'grant select, insert on table atlas_private.report_events to service_role';

    execute 'drop policy if exists "service role reads report events" on atlas_private.report_events';
    execute 'create policy "service role reads report events" on atlas_private.report_events for select to service_role using (true)';

    execute 'drop policy if exists "service role inserts report events" on atlas_private.report_events';
    execute 'create policy "service role inserts report events" on atlas_private.report_events for insert to service_role with check (true)';
  end if;
end
$migration$;

reset statement_timeout;
reset lock_timeout;
