-- S99 (authn): mandatory TOTP two-factor for ALL staff, staged and OFF by default.
--
-- This extends the S96 privileged-MFA model (see
-- 20261010091000_s96_privileged_mfa_rls.sql) from managers/admins to every
-- staff role. It mirrors private.privileged_session_ok() exactly so behaviour
-- stays consistent between the two gates. NOTHING changes on apply:
--   * private.auth_policy.require_all_staff_mfa defaults FALSE (this migration
--     never sets it true; the owner flips it during rollout, after every staff
--     member has enrolled — see docs/rollout in the PR/handoff);
--   * with the flag false and no verified factor enrolled, private.staff_session_ok()
--     returns true for everyone, so private.is_active_staff() is unchanged and
--     there are no lock-outs;
--   * once a person enrols a verified TOTP factor, an aal1 session (password
--     only) no longer carries staff access in PostgREST — the same rule S96
--     already applies to manager/admin power. The app's login gate steps such a
--     session up to aal2 before entering, so this is transparent in practice;
--   * with require_all_staff_mfa = true, aal2 becomes mandatory for every staff
--     member, enrolled or not.
--
-- IMPORTANT — separation of concerns:
--   * This DB flag governs RUNTIME access enforcement across the whole app and
--     stays OFF until rollout.
--   * The new-invitee onboarding requirements (password + name + phone + photo +
--     verified TOTP before the account is activated) are enforced entirely in
--     the invite flow (the invitation wizard client + the atlas-team-profiles
--     `complete-onboarding` edge action). They are INDEPENDENT of this flag and
--     already active for the invite path; they do not affect existing staff.
-- Service-role and database-owner contexts (Edge Function service RPCs) are
-- unaffected: staff_session_ok() short-circuits for any non-"authenticated" role.

alter table private.auth_policy
  add column if not exists require_all_staff_mfa boolean not null default false;

-- Mirror of private.privileged_session_ok(): same shape, same short-circuits,
-- reading require_all_staff_mfa instead of require_privileged_mfa so the
-- all-staff gate behaves identically to the privileged one. plpgsql so the
-- reference to auth.mfa_factors is resolved at run time.
create or replace function private.staff_session_ok()
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
  select coalesce(policy.require_all_staff_mfa, false) into mandatory
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
revoke all on function private.staff_session_ok() from public, anon, authenticated;

-- is_active_staff() now additionally requires staff_session_ok(). With the flag
-- false and no enrolled factor this is a no-op (staff_session_ok() returns true),
-- so existing staff are unaffected until they enrol or the owner turns the flag on.
create or replace function private.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.active is true
        and profile.role::text in ('admin', 'manager', 'bartender', 'viewer')
    )
    and private.staff_session_ok();
$function$;

-- S99: let any authenticated person read THEIR OWN profile row, even before the
-- account is active. An invitee mid-onboarding is an inactive viewer, and the
-- existing "active staff read profiles" policy would otherwise stop even
-- resolveActor (Edge auth) from reading their own row, blocking the whole invite
-- flow (save-details, photo upload, complete-onboarding). This is a single-row,
-- self-only read (id = auth.uid()); it does not expose the staff directory to
-- inactive accounts. Permissive policies are OR'd, so active staff/managers are
-- unaffected.
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  as permissive for select to authenticated
  using (id = (select auth.uid()));

-- Onboarding readiness (service-role only, read-only). complete-onboarding uses
-- this to confirm server-side that the invitee actually saved a phone and stored
-- a profile photo before the account is activated — never trusting the client's
-- word. It reveals only two booleans, no personal data.
create or replace function atlas_private.team_profile_onboarding_ready(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'has_phone', exists (
      select 1 from atlas_private.team_profile_details d
      where d.profile_id = p_profile_id and nullif(trim(coalesce(d.phone, '')), '') is not null
    ),
    'has_photo', exists (
      select 1 from atlas_private.team_profile_photos p
      where p.profile_id = p_profile_id
    )
  );
$$;
revoke all on function atlas_private.team_profile_onboarding_ready(uuid) from public, anon, authenticated;
grant execute on function atlas_private.team_profile_onboarding_ready(uuid) to service_role;

create or replace function public.atlas_team_profile_onboarding_ready(uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select atlas_private.team_profile_onboarding_ready($1); $$;
revoke all on function public.atlas_team_profile_onboarding_ready(uuid) from public, anon, authenticated;
grant execute on function public.atlas_team_profile_onboarding_ready(uuid) to service_role;

comment on function public.atlas_team_profile_onboarding_ready(uuid) is
  'Service-role-only onboarding readiness check: whether an invitee has a stored phone and profile photo. Used by atlas-team-profiles complete-onboarding.';

-- S99: authoritative rollout-policy read for the client entry gate. Returns the
-- two policy flags and, crucially, `must_enroll` COMPUTED for the calling user:
-- true only when the caller has NO verified factor AND the policy requires 2FA
-- for them (require_all_staff_mfa for everyone, or require_privileged_mfa for an
-- admin/manager). With both flags off this is false for everyone, so the client
-- gate never forces enrolment on existing factor-less staff — the release stays
-- non-breaking. This is a read of policy + the caller's own factor/role only; it
-- exposes no one else's data.
create or replace function public.atlas_auth_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  priv boolean;
  allstaff boolean;
  caller_role text;
  enrolled boolean;
begin
  select coalesce(policy.require_privileged_mfa, false), coalesce(policy.require_all_staff_mfa, false)
    into priv, allstaff
  from private.auth_policy as policy where policy.id;
  priv := coalesce(priv, false);
  allstaff := coalesce(allstaff, false);
  select profile.role::text into caller_role
  from public.profiles as profile where profile.id = (select auth.uid());
  select exists (
    select 1 from auth.mfa_factors as factor
    where factor.user_id = (select auth.uid()) and factor.status::text = 'verified'
  ) into enrolled;
  return jsonb_build_object(
    'require_privileged_mfa', priv,
    'require_all_staff_mfa', allstaff,
    'must_enroll', (not coalesce(enrolled, false))
      and (allstaff or (coalesce(caller_role, '') in ('admin', 'manager') and priv))
  );
end;
$$;
revoke all on function public.atlas_auth_policy() from public, anon;
grant execute on function public.atlas_auth_policy() to authenticated;
comment on function public.atlas_auth_policy() is
  'Rollout-policy read for the client MFA entry gate: the two auth_policy flags plus must_enroll computed for the caller (no verified factor AND policy requires 2FA for their role). Non-breaking: false for everyone until the owner flips a flag.';

notify pgrst, 'reload schema';
