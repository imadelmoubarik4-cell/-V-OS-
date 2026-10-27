-- S114 pre-flight — READ-ONLY. Run in the production SQL editor before the
-- S114 rollout and keep the output with the release record. It changes nothing.
-- It answers: are the S96 audit trigger and the S99 policy RPC in place, what are
-- the MFA policy flags, who will the edge MFA check affect, and which inactive
-- profiles setup would refuse (a manager activates those through Team instead).
begin transaction read only;

-- 1. Prerequisites (all must be true).
select
  exists (select 1 from pg_trigger where tgname = 's96_profiles_access_audit' and tgrelid = 'public.profiles'::regclass) as audit_trigger_present,
  to_regprocedure('public.atlas_auth_policy()') is not null as auth_policy_rpc_present,
  to_regprocedure('atlas_private.team_profile_onboarding_ready(uuid)') is not null as onboarding_ready_present,
  to_regprocedure('public.atlas_team_profile_access_state(uuid)') is not null as s114_already_applied;

-- 2. The MFA policy flags the edge will now enforce.
select require_privileged_mfa, require_all_staff_mfa from private.auth_policy where id;

-- 3. Active staff by role and authenticator status. Anyone with a verified
--    factor must use it (aal2) for edge requests too after S114; the app already
--    asks them for the code at sign-in.
select p.role::text as role,
       count(*) as active_staff,
       count(*) filter (where exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status::text = 'verified')) as with_verified_factor
from public.profiles p
where p.active is true
group by p.role order by p.role;

-- 4. Inactive profiles and how account setup will treat them after S114
--    (no names or emails: ids only, for a manager to look up in Team). Mirrors
--    atlas_team_profile_access_state and _shared/staff-access.mjs; an
--    invitation older than 14 days or from an inviter who is no longer an
--    active manager/administrator needs a manager (re-invite or activate).
with audit as (
  select target_id,
         bool_or(action = 'profile.created') as audited,
         bool_or(coalesce(new_values ->> 'active', '') = 'true' or coalesce(old_values ->> 'active', '') = 'true') as ever_active
  from atlas_private.security_audit_events
  where target_type = 'profile'
  group by target_id
), removal as (
  select distinct target_profile_id
  from atlas_private.team_member_deletion_audit
  where action in ('removed_from_team', 'permanently_deleted')
), inactive as (
  select p.id,
         u.raw_app_meta_data ? 'atlas_invited_by' as invited,
         u.raw_app_meta_data ? 'atlas_access_revoked_at' as revoked_marker,
         coalesce(a.audited, false) as audited,
         coalesce(a.ever_active, false) as ever_active,
         r.target_profile_id is not null as removed,
         floor(extract(epoch from (now() - u.invited_at)) / 86400)::int as invitation_age_days,
         inviter.active is true
           and (inviter.role::text = 'admin'
             or (inviter.role::text = 'manager' and coalesce(u.raw_app_meta_data ->> 'atlas_intended_role', '') <> 'admin')) as inviter_qualified
  from public.profiles p
  join auth.users u on u.id = p.id
  left join audit a on a.target_id = p.id
  left join removal r on r.target_profile_id = p.id
  left join public.profiles inviter
    on coalesce(u.raw_app_meta_data ->> 'atlas_invited_by', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and inviter.id = (u.raw_app_meta_data ->> 'atlas_invited_by')::uuid
  where p.active is not true
)
select id as profile_id, invited, audited, ever_active, removed, invitation_age_days, inviter_qualified,
       case
         when not invited then 'setup refused: not an invitation'
         when revoked_marker or ever_active or removed then 'setup refused: access was removed'
         when not audited then 'setup refused: pre-audit; a manager activates through Team'
         when invitation_age_days is null or invitation_age_days > 14 then 'setup refused: invitation expired; re-invite or activate through Team'
         when not coalesce(inviter_qualified, false) then 'setup refused: inviter may no longer give this role; a manager reviews it'
         else 'pending invitation: setup may finish'
       end as after_s114
from inactive
order by after_s114, id;

rollback;
