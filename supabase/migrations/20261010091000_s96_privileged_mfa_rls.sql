-- S96 (authn): MFA assurance for privileged database access.
--
-- private.is_manager_or_admin() and private.current_profile_role() are the
-- privileged gates behind every manager/admin RLS policy and invoker RPC.
-- From this migration, a signed-in (role "authenticated") admin or manager is
-- privileged only when the session is aal2, OR the person has no verified
-- second factor yet AND mandatory mode is off. That means:
--   * nothing changes for anyone until they enrol a TOTP factor (no lock-out);
--   * once enrolled, an aal1 session (password only) no longer carries
--     manager/admin power in PostgREST, the same rule _shared/auth.mjs applies
--     to Edge Functions;
--   * private.auth_policy.require_privileged_mfa = true (set by the owner only
--     after every admin/manager has enrolled) makes aal2 mandatory.
-- Service-role and database-owner contexts (Edge Function service RPCs, which
-- enforce the same rule in _shared/auth.mjs before calling) are unaffected.
-- Staff-level access (private.is_active_staff) is unchanged.

create table if not exists private.auth_policy (
  id boolean primary key default true check (id),
  require_privileged_mfa boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.auth_policy (id) values (true) on conflict (id) do nothing;
alter table private.auth_policy enable row level security;
revoke all on private.auth_policy from public, anon, authenticated;

-- Invoker function: it is only reached from the SECURITY DEFINER gates below
-- (owner context), so it needs no definer rights of its own. plpgsql so the
-- reference to auth.mfa_factors is resolved at run time.
create or replace function private.privileged_session_ok()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  mandatory boolean;
  enrolled boolean;
begin
  if coalesce(claims ->> 'role', '') <> 'authenticated' then
    return true;
  end if;
  if coalesce(claims ->> 'aal', 'aal1') = 'aal2' then
    return true;
  end if;
  select coalesce(policy.require_privileged_mfa, false) into mandatory
  from private.auth_policy as policy where policy.id;
  if coalesce(mandatory, false) then
    return false;
  end if;
  select exists (
    select 1 from auth.mfa_factors as factor
    where factor.user_id = (select auth.uid()) and factor.status::text = 'verified'
  ) into enrolled;
  return not enrolled;
end;
$$;
revoke all on function private.privileged_session_ok() from public, anon, authenticated;

create or replace function private.is_manager_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
        and profile.role::text in ('admin', 'manager')
    )
    and private.privileged_session_ok();
$$;

create or replace function private.current_profile_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select profile.role::text
  from public.profiles as profile
  where profile.id = (select auth.uid())
    and profile.active is true
    and (profile.role::text not in ('admin', 'manager') or private.privileged_session_ok())
  limit 1;
$$;
