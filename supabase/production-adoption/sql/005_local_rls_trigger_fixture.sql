-- Disposable-staging fixture matching the reviewed production event trigger.
-- This file is never part of the production candidate.

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = 'pg_catalog'
as $function$
declare
  command_row record;
begin
  for command_row in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if command_row.schema_name = 'public' then
      begin
        execute format(
          'alter table if exists %s enable row level security',
          command_row.object_identity
        );
      exception
        when others then
          raise log 'rls_auto_enable fixture could not enable RLS on %',
            command_row.object_identity;
      end;
    end if;
  end loop;
end;
$function$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
