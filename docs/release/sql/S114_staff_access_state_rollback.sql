-- S114 rollback: removes the two read-only access-state functions added by
-- 20261031090000_s114_staff_access_state.sql. No table, policy or data was
-- added by S114, so nothing else needs undoing.
--
-- Roll back the Edge Functions FIRST (redeploy atlas-team-profiles and
-- atlas-team-profile-photos from the pre-S114 commit): the S114 functions call
-- atlas_team_profile_access_state and, without it, refuse to activate pending
-- invitations (fail closed) until they are rolled back too.
begin;
drop function if exists public.atlas_team_profile_access_state(uuid);
drop function if exists atlas_private.team_profile_access_state(uuid);
-- The ledger row the S114 apply bundle recorded (absent on a replay: a no-op).
delete from supabase_migrations.schema_migrations where version = '20261031090000';
notify pgrst, 'reload schema';
commit;
