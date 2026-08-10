from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MONTH_MIGRATION = (
    ROOT / "supabase/migrations/20260803214138_atlas_shifts_monthly_planning_f2.sql"
).read_text()
PUBLISH_FIX = (
    ROOT / "supabase/migrations/20260803225245_atlas_shifts_month_publish_complete_weeks.sql"
).read_text()
EDGE = (ROOT / "supabase/functions/atlas-shifts/index.ts").read_text()
BROWSER = (ROOT / "apps/web/assets/js/shifts-month-calendar.js").read_text()
CONFIG = (ROOT / "apps/web/config.js").read_text()
ALL_SQL = MONTH_MIGRATION + PUBLISH_FIX


class ShiftsMonthContractTests(unittest.TestCase):
    def test_month_state_and_publications_are_private(self):
        for table in ("shift_months", "shift_month_publications"):
            self.assertIn(
                f"alter table atlas_private.{table} enable row level security",
                MONTH_MIGRATION,
            )
            self.assertIn(
                f"revoke all on atlas_private.{table} from public,anon,authenticated",
                MONTH_MIGRATION,
            )
        self.assertNotIn("to authenticated using (true)", MONTH_MIGRATION.lower())

    def test_service_role_only_month_rpc_surface(self):
        signatures = (
            "public.atlas_shifts_month_snapshot(date,uuid,text)",
            "public.atlas_shifts_publish_month(date,text,uuid,text,text)",
        )
        for signature in signatures:
            self.assertIn(
                f"revoke execute on function {signature} from public,anon,authenticated",
                MONTH_MIGRATION,
            )
            self.assertIn(
                f"grant execute on function {signature} to service_role",
                MONTH_MIGRATION,
            )
        self.assertNotIn("security definer", ALL_SQL.lower())

    def test_month_edits_are_private_until_publication(self):
        self.assertIn("shift_entries_mark_month_unpublished", MONTH_MIGRATION)
        self.assertIn("has_unpublished_changes=true", MONTH_MIGRATION)
        self.assertIn("if is_manager then", MONTH_MIGRATION.lower())
        self.assertIn("publication_row.snapshot->'shifts'", MONTH_MIGRATION)
        self.assertIn("latest_published_month_revision", MONTH_MIGRATION)
        self.assertIn("staff_visibility", MONTH_MIGRATION)

    def test_month_publish_creates_immutable_revision_and_staff_announcement(self):
        self.assertIn("shift_month_publications", PUBLISH_FIX)
        self.assertIn("next_month_revision := month_row.revision+1", PUBLISH_FIX)
        self.assertIn("Monthly schedule published", PUBLISH_FIX)
        self.assertIn("Please review the full month", PUBLISH_FIX)
        self.assertIn("shift-month-published:", PUBLISH_FIX)
        self.assertIn("month_published", PUBLISH_FIX)

    def test_month_publish_refreshes_every_overlapping_week_including_empty_weeks(self):
        self.assertIn(
            "generate_series(grid_start,grid_end,interval '7 days')",
            PUBLISH_FIX,
        )
        self.assertIn("week_shift_count", PUBLISH_FIX)
        self.assertIn("week_shifts_json", PUBLISH_FIX)
        self.assertIn("shift.active=false", PUBLISH_FIX)
        self.assertIn("shift_count,planned_hours", PUBLISH_FIX)
        self.assertIn("week_revisions_json", PUBLISH_FIX)
        self.assertIn("last_published_revision=week_revision", PUBLISH_FIX)

    def test_gateway_revalidates_active_profiles_and_exposes_month_actions(self):
        self.assertIn("requireActiveProfile", EDGE)
        self.assertIn("This Atlas profile is inactive. Shift access has been removed.", EDGE)
        self.assertIn('action === "month-snapshot"', EDGE)
        self.assertIn('case "publish-month"', EDGE)
        self.assertIn("requireMonthStart", EDGE)
        self.assertIn("atlas_shifts_month_snapshot", EDGE)
        self.assertIn("atlas_shifts_publish_month", EDGE)
        self.assertIn("month_publish_to_team_enabled: true", EDGE)
        self.assertIn("production_shift_sync_enabled: false", EDGE)
        self.assertNotIn("/rest/v1/shifts", EDGE)

    def test_browser_month_editor_uses_authenticated_gateway_only(self):
        self.assertIn("SHIFTS_API", CONFIG)
        self.assertIn("shifts-month-editor.css", CONFIG)
        self.assertIn("window.atlasSupabase", BROWSER)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER)
        self.assertIn("api('month-snapshot'", BROWSER)
        self.assertIn("mutate('publish-month'", BROWSER)
        self.assertIn("mutate('save-shift'", BROWSER)
        self.assertIn("mutate('cancel-shift'", BROWSER)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", CONFIG + BROWSER)
        self.assertNotIn(".from(", BROWSER)
        self.assertNotIn("atlas_private", BROWSER)


if __name__ == "__main__":
    unittest.main()
