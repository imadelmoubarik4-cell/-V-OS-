from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = (ROOT / "supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql").read_text()
SNAPSHOT = (ROOT / "supabase/migrations/20260804134510_atlas_system_snapshot.sql").read_text()
EDGE = (ROOT / "supabase/functions/atlas-system/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER = (ROOT / "apps/web/assets/js/system-workspace.js").read_text()


class SystemContractTests(unittest.TestCase):
    def test_private_tables_are_rls_protected(self):
        for table in (
            "system_settings",
            "system_services",
            "system_data_sources",
            "system_jobs",
            "system_incidents",
            "system_release_checkpoints",
            "system_events",
        ):
            self.assertIn(
                f"alter table atlas_private.{table} enable row level security",
                FOUNDATION,
            )
            self.assertIn(
                f"revoke all on atlas_private.{table} from public,anon,authenticated",
                FOUNDATION,
            )
            self.assertIn(
                f"grant all on atlas_private.{table} to service_role",
                FOUNDATION,
            )
        self.assertNotIn("to authenticated using (true)", FOUNDATION.lower())

    def test_snapshot_is_manager_only_and_service_role_only(self):
        self.assertIn("p_actor_role not in ('admin','manager')", SNAPSHOT)
        signature = "public.atlas_system_snapshot(jsonb,jsonb,jsonb,uuid,text)"
        self.assertIn(f"revoke execute on function {signature}", SNAPSHOT)
        self.assertIn("from public,anon,authenticated", SNAPSHOT)
        self.assertIn(f"grant execute on function {signature}", SNAPSHOT)
        self.assertIn("to service_role", SNAPSHOT)
        self.assertNotIn("security definer", (FOUNDATION + SNAPSHOT).lower())

    def test_reports_problem_is_preserved_as_an_open_release_blocker(self):
        self.assertIn("reports-loading-stall", FOUNDATION)
        self.assertIn("Reports authenticated snapshot does not complete", FOUNDATION)
        self.assertIn("Reports authenticated snapshot remains unresolved", FOUNDATION)
        self.assertIn("'release_blocker',true", FOUNDATION)
        self.assertIn("'production_records_changed',false", FOUNDATION)

    def test_destructive_and_automatic_controls_default_off(self):
        for setting in (
            "production_sync_enabled boolean not null default false",
            "destructive_actions_enabled boolean not null default false",
            "automatic_retries_enabled boolean not null default false",
            "rollback_actions_enabled boolean not null default false",
            "secrets_visible_in_ui boolean not null default false",
        ):
            self.assertIn(setting, FOUNDATION)
        for result in (
            "'can_retry_jobs',false",
            "'can_resolve_incidents',false",
            "'can_run_rollback',false",
            "'can_promote_production',false",
            "'production_source_mutation',false",
            "'destructive_controls_enabled',false",
        ):
            self.assertIn(result, SNAPSHOT)

    def test_edge_gateway_revalidates_active_production_manager(self):
        self.assertIn("requireManagerProfile", EDGE)
        self.assertIn("/auth/v1/user", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn("if (!profile?.active)", EDGE)
        self.assertIn('new Set(["admin", "manager"])', EDGE)
        self.assertIn("System is available only to managers and administrators", EDGE)
        self.assertIn('request.method !== "GET"', EDGE)
        self.assertIn("Checkpoint I System is view-only", EDGE)
        self.assertIn("[functions.atlas-system]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_gateway_returns_no_secrets_or_tokens(self):
        self.assertIn("secrets_returned: false", EDGE)
        self.assertIn("tokens_returned: false", EDGE)
        self.assertIn("production_promotion_enabled: false", EDGE)
        self.assertNotRegex(EDGE, r"jsonResponse\([^\)]*serviceRoleKey")
        self.assertNotRegex(EDGE, r"jsonResponse\([^\)]*SUPABASE_SERVICE_ROLE_KEY")
        self.assertNotRegex(EDGE, r"return\s*\{[^}]*serviceRoleKey")

    def test_browser_uses_authenticated_gateway_without_direct_private_access(self):
        self.assertIn("SYSTEM_API", BROWSER_CONFIG)
        self.assertIn("system-workspace.js", BROWSER_CONFIG)
        self.assertIn("window.atlasSupabase", BROWSER)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER)
        self.assertNotRegex(BROWSER, r"\.from\s*\(\s*['\"]")
        for private_table in (
            "system_services",
            "system_incidents",
            "system_jobs",
            "system_release_checkpoints",
        ):
            self.assertNotIn(private_table, BROWSER)

    def test_system_ui_is_view_only(self):
        self.assertIn("Retry controls are disabled", BROWSER)
        self.assertIn("Incident mutation is disabled", BROWSER)
        self.assertIn("Rollback unavailable", BROWSER)
        self.assertIn("Secrets and tokens never returned", BROWSER)
        self.assertNotRegex(BROWSER, r"method:\s*['\"]POST['\"]")
        self.assertNotRegex(BROWSER, r"\bDELETE\b|\bPATCH\b|\bPUT\b")


if __name__ == "__main__":
    unittest.main()
