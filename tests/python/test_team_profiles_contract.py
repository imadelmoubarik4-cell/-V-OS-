from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / 'supabase/migrations/20260803155556_atlas_team_profiles_checkpoint_e.sql').read_text()
EDGE = (ROOT / 'supabase/functions/atlas-team-profiles/index.ts').read_text()
CONFIG = (ROOT / 'supabase/config.toml').read_text()
BROWSER = (ROOT / 'apps/web/config.js').read_text()

class TeamProfilesContractTests(unittest.TestCase):
    def test_private_tables_are_rls_protected(self):
        for table in ('team_profile_details','team_emergency_contacts','team_profile_events'):
            self.assertIn(f'alter table atlas_private.{table} enable row level security', MIGRATION)
            self.assertIn(f'revoke all on atlas_private.{table} from public,anon,authenticated', MIGRATION)
        self.assertNotIn('to authenticated using (true)', MIGRATION.lower())

    def test_snapshot_enforces_visibility_boundaries(self):
        self.assertIn("p_actor_role in ('admin','manager') or p.active=true or p.id=p_actor_id", MIGRATION)
        self.assertIn("'emergency_contacts','self_or_manager'", MIGRATION)
        self.assertIn("'manager_notes'", MIGRATION)
        self.assertIn("jsonb_build_object('private',true)", MIGRATION)
        self.assertIn("'direct_browser_table_access',false", MIGRATION)

    def test_profile_and_emergency_mutations_are_audited(self):
        for event in ('profile_details_updated','emergency_contact_saved','emergency_contact_removed','onboarding_status_changed','role_changed','active_status_changed'):
            self.assertIn(event, MIGRATION)
        self.assertIn('team_profile_events', MIGRATION)
        self.assertIn('updated_by', MIGRATION)
        self.assertIn('updated_by_label', MIGRATION)

    def test_rpc_surface_is_service_role_only(self):
        signatures = (
            'public.atlas_team_profiles_snapshot(jsonb,jsonb,jsonb,uuid,text)',
            'public.atlas_team_profile_upsert_details(uuid,text,text,text,text,date,text,text,text,text,uuid,text,text)',
            'public.atlas_team_profile_save_emergency_contact(uuid,uuid,text,text,text,text,smallint,uuid,text,text)',
            'public.atlas_team_profile_remove_emergency_contact(uuid,uuid,uuid,text,text)',
            'public.atlas_team_profile_log_external_event(text,uuid,uuid,text,text,jsonb)',
        )
        for signature in signatures:
            self.assertIn(f'revoke execute on function {signature} from public,anon,authenticated', MIGRATION)
            self.assertIn(f'grant execute on function {signature} to service_role', MIGRATION)
        self.assertNotIn('security definer', MIGRATION.lower())

    def test_gateway_revalidates_active_profile_and_roles(self):
        self.assertIn('requireActiveProfile', EDGE)
        self.assertIn('This Atlas profile is inactive. Team access has been removed.', EDGE)
        self.assertIn('MANAGER_ROLES', EDGE)
        self.assertIn('You cannot change your own role or active status', EDGE)
        self.assertIn('Only an administrator can assign or modify the administrator role', EDGE)
        self.assertIn('Atlas must retain at least one active manager or administrator', EDGE)
        self.assertIn('[functions.atlas-team-profiles]', CONFIG)
        self.assertIn('verify_jwt = false', CONFIG)

    def test_existing_auth_and_onboarding_are_authoritative(self):
        self.assertIn('/rest/v1/profiles', EDGE)
        self.assertIn('/rest/v1/onboarding_tasks', EDGE)
        self.assertIn('/rest/v1/onboarding_progress', EDGE)
        self.assertIn('active.desc,display_name.asc.nullslast,email.asc', EDGE)
        self.assertIn('account_invitations_enabled: false', EDGE)

    def test_browser_has_no_service_key_or_private_table_access(self):
        self.assertIn('TEAM_PROFILES_API', BROWSER)
        self.assertIn('team-profiles-bootstrap.js', BROWSER)
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY', BROWSER)

if __name__ == '__main__':
    unittest.main()
