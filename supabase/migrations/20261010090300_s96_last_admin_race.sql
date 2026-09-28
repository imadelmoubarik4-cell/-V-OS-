-- S96 (security hardening, finding DBRLS-06): close the last-administrator write-skew race.
--
-- private.preserve_active_admin() refuses to remove the last active administrator by
-- counting the OTHER active administrators. Two administrators who demote or deactivate
-- each other at the same time each still see the other as active (the rows differ, so
-- nothing blocks), and both commits succeed: proven on the local replay with two
-- concurrent sessions, leaving zero active administrators (Accounting, profile/role
-- management and every admin-only path locked out until someone uses the service role).
--
-- The trigger now serialises every administrator removal on one transaction-scoped
-- advisory lock before counting. Under READ COMMITTED the count runs in a new snapshot
-- after the lock is granted, so the second transaction sees the first one's committed
-- change and is refused. Behaviour is otherwise identical.

create or replace function private.preserve_active_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  removing_active_admin boolean := false;
  other_admins integer := 0;
begin
  if tg_op = 'DELETE' then
    removing_active_admin := old.active is true and old.role::text = 'admin';
  else
    removing_active_admin :=
      old.active is true
      and old.role::text = 'admin'
      and (new.active is not true or new.role::text <> 'admin');
  end if;

  if removing_active_admin then
    -- One administrator removal at a time (S96 DBRLS-06).
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('atlas:preserve_active_admin', 0));

    select count(*)
      into other_admins
    from public.profiles as profile
    where profile.id <> old.id
      and profile.active is true
      and profile.role::text = 'admin';

    if other_admins = 0 then
      raise exception 'Atlas must retain at least one active administrator';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.preserve_active_admin() from public, anon, authenticated;
grant execute on function private.preserve_active_admin() to service_role;
