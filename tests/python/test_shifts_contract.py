from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260803193953_atlas_shifts_checkpoint_f.sql").read_text()
WORKFLOWS = (ROOT / "supabase/migrations/20260803194238_atlas_shifts_checkpoint_f_workflows.sql").read_text()
HARDENING = (ROOT / "supabase/migrations/20260803201746_atlas_shifts_checkpoint_f_hardening.sql").read_text()
COPY_FIX = (ROOT / "supabase/migrations/20260803202056_atlas_shifts_copy_week_interval_fix.sql").read_text()
EDGE = (ROOT / "supabase/functions/atlas-shifts/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER = (ROOT / "apps/web/assets/js/shifts-workspace.js").read_text()
GALLERY = (ROOT / "apps/web/assets/js/team-profile-photo-gallery.js").read_text()
ALL_SQL = MIGRATION + WORKFLOWS + HARDENING + COPY_FIX


class ShiftsContractTests(unittest.TestCase):
    def test_private_shift_tables_are_rls_protected(self):
        tables = (
            "shift_settings",
            "shift_people",
            "shift_weeks",
            "shift_entries",
            "shift_publications",
            "shift_availability",
            "shift_time_off",
            "shift_responses",
            "shift_events",
        )
        for table in tables:
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", MIGRATION)
        self.assertNotIn("to authenticated using (true)", MIGRATION.lower())

    def test_schedule_stays_isolated_from_production(self):
        self.assertIn("live_publish_enabled boolean not null default false", MIGRATION)
        self.assertIn("production_shift_sync_enabled", MIGRATION)
        self.assertIn("'isolated_branch'", MIGRATION)
        self.assertIn("production_shift_sync_enabled: false", EDGE)
        self.assertNotIn("/rest/v1/shifts", EDGE)
        self.assertNotIn("p_movement_type", EDGE)

    def test_weekly_planning_and_publication_history_exist(self):
        for table in (
            "shift_weeks",
            "shift_entries",
            "shift_publications",
            "shift_availability",
            "shift_time_off",
            "shift_responses",
        ):
            self.assertIn(table, MIGRATION)
        self.assertIn("unique (week_start,revision)", MIGRATION)
        self.assertIn("last_published_revision", MIGRATION)
        self.assertIn("Resolve overlapping shifts before publishing", MIGRATION)
        self.assertIn("team_messages_post_system", MIGRATION)
        self.assertIn("Please review and confirm your assigned shifts", MIGRATION)

    def test_role_boundaries_and_self_service_are_enforced(self):
        self.assertIn("Only managers can create or edit shifts", MIGRATION)
        self.assertIn("Only managers can publish schedules", MIGRATION)
        self.assertIn("Staff may edit only their own availability", MIGRATION)
        self.assertIn("Staff may request time off only for themselves", WORKFLOWS)
        self.assertIn("You can respond only to your own shift", MIGRATION)
        self.assertIn("Only managers can decide time-off requests", WORKFLOWS)
        self.assertIn("Only managers can decide shift requests", WORKFLOWS)

    def test_profile_sync_is_idempotent_and_event_noise_is_avoided(self):
        self.assertIn("where (", HARDENING.lower())
        self.assertIn("is distinct from", HARDENING.lower())
        self.assertIn("if changed_count>0 then", HARDENING.lower())
        self.assertIn("shift_events_shift_created_idx", HARDENING)

    def test_week_copy_uses_a_timestamp_interval(self):
        self.assertIn("week_offset interval", COPY_FIX)
        self.assertIn("* interval '1 day'", COPY_FIX)
        self.assertIn("shift.starts_at+week_offset", COPY_FIX)
        self.assertIn("shift.ends_at+week_offset", COPY_FIX)

    def test_rpc_surface_is_service_role_only(self):
        signatures = (
            "public.atlas_shifts_sync_profiles(jsonb,uuid,text,text)",
            "public.atlas_shifts_snapshot(date,uuid,text)",
            "public.atlas_shifts_create_person(text,text,text,uuid,text,text)",
            "public.atlas_shifts_save_shift(uuid,date,uuid,text,timestamp,timestamp,integer,text,uuid,text,text)",
            "public.atlas_shifts_cancel_shift(uuid,uuid,text,text)",
            "public.atlas_shifts_publish_week(date,text,uuid,text,text)",
            "public.atlas_shifts_save_availability(uuid,smallint,time,time,boolean,text,uuid,text,text)",
            "public.atlas_shifts_respond(uuid,text,text,uuid,text,text)",
        )
        for signature in signatures:
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", MIGRATION)
            self.assertIn(f"grant execute on function {signature} to service_role", MIGRATION)

        workflow_signatures = (
            "public.atlas_shifts_update_person(uuid,text,text,text,boolean,uuid,text,text)",
            "public.atlas_shifts_copy_week(date,date,uuid,text,text)",
            "public.atlas_shifts_request_time_off(uuid,date,date,text,text,uuid,text,text)",
            "public.atlas_shifts_decide_time_off(uuid,text,text,uuid,text,text)",
            "public.atlas_shifts_decide_response(uuid,uuid,text,text,uuid,text,text)",
        )
        for signature in workflow_signatures:
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", WORKFLOWS)
            self.assertIn(f"grant execute on function {signature} to service_role", WORKFLOWS)
        self.assertNotIn("security definer", ALL_SQL.lower())

    def test_gateway_revalidates_production_auth_and_roles(self):
        self.assertIn("requireActiveProfile", EDGE)
        self.assertIn("This Atlas profile is inactive. Shift access has been removed.", EDGE)
        self.assertIn("MANAGER_ROLES", EDGE)
        self.assertIn("requireManager(context)", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE)
        self.assertIn("[functions.atlas-shifts]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_browser_has_no_privileged_key_or_direct_table_access(self):
        self.assertIn("SHIFTS_API", BROWSER_CONFIG)
        self.assertIn("shifts-workspace.js", BROWSER_CONFIG)
        self.assertIn("window.atlasSupabase", BROWSER)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER + GALLERY)
        self.assertNotRegex(
            BROWSER,
            r"(?:atlasSupabase|supabase|client)\s*\.\s*from\s*\(",
        )
        self.assertNotIn("atlas_private", BROWSER)

    def test_mobile_photo_picker_allows_gallery_selection(self):
        self.assertIn("removeAttribute('capture')", GALLERY)
        self.assertIn("camera or gallery", GALLERY)
        self.assertIn("image/jpeg,image/png,image/webp", GALLERY)
        self.assertNotIn("setAttribute('capture'", GALLERY)


if __name__ == "__main__":
    unittest.main()
