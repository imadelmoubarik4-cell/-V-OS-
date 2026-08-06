from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_FILES = [
    ROOT / "supabase/migrations/20260806190744_atlas_connections_p2_registry.sql",
    ROOT / "supabase/migrations/20260806190833_atlas_connections_p2_evidence.sql",
    ROOT / "supabase/migrations/20260806190928_atlas_connections_p2_snapshot.sql",
    ROOT / "supabase/migrations/20260806191017_atlas_connections_p2_checks.sql",
    ROOT / "supabase/migrations/20260806191056_atlas_connections_p2_capabilities.sql",
    ROOT / "supabase/migrations/20260806191151_atlas_connections_p2_seeds_api.sql",
    ROOT / "supabase/migrations/20260806192234_atlas_connections_p2_legacy_compatibility.sql",
]
MIGRATION = "\n".join(path.read_text() for path in MIGRATION_FILES)
COMPATIBILITY = MIGRATION_FILES[-1].read_text()
EDGE = (ROOT / "supabase/functions/atlas-connections/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER = (ROOT / "apps/web/assets/js/connection-center.js").read_text()
LOADER = (ROOT / "apps/web/assets/js/settings-mount-bridge.js").read_text()
CSS = (ROOT / "apps/web/assets/css/connection-center.css").read_text()


class ConnectionCenterP20ContractTests(unittest.TestCase):
    def test_existing_integration_table_is_the_only_provider_registry(self):
        self.assertIn("atlas_private.integration_connections", MIGRATION)
        self.assertIn("remains the single", MIGRATION)
        self.assertNotIn("create table if not exists atlas_private.connection_registry", MIGRATION)
        self.assertIn("`health_state` is the canonical state", MIGRATION)
        for state in (
            "not_configured",
            "authorization_required",
            "verifying",
            "healthy",
            "degraded",
            "expired",
            "blocked",
            "intentionally_disabled",
        ):
            self.assertIn(state, MIGRATION)

    def test_registry_and_connection_evidence_are_private_and_rls_protected(self):
        self.assertIn(
            "alter table atlas_private.integration_connections enable row level security",
            MIGRATION,
        )
        self.assertIn(
            "revoke all on atlas_private.integration_connections from public,anon,authenticated",
            MIGRATION,
        )
        self.assertIn(
            "grant all on atlas_private.integration_connections to service_role",
            MIGRATION,
        )
        for table in (
            "connection_capability_grants",
            "connection_health_checks",
            "connection_events",
            "connection_dependencies",
        ):
            self.assertIn(table, MIGRATION)
        self.assertIn(
            "alter table atlas_private.connection_capability_grants enable row level security",
            MIGRATION,
        )
        self.assertIn("execute format('revoke all on atlas_private.%I from public,anon,authenticated'", MIGRATION)
        self.assertIn("execute format('grant all on atlas_private.%I to service_role'", MIGRATION)

    def test_health_protocol_requires_verified_success_for_healthy_state(self):
        self.assertIn("atlas.allow_connection_verified", MIGRATION)
        self.assertIn(
            "Healthy connection state requires a completed controlled health check",
            MIGRATION,
        )
        self.assertIn(
            "Healthy connection state requires a passed verification check",
            MIGRATION,
        )
        self.assertIn("connection_effective_state", MIGRATION)
        self.assertIn("stale_after_seconds", MIGRATION)
        self.assertIn("make_interval", MIGRATION)
        self.assertIn("unique (connection_key,request_id)", MIGRATION)

    def test_legacy_connected_state_becomes_verifying_not_healthy(self):
        self.assertIn("when 'connected' then 'verifying'", COMPATIBILITY)
        self.assertNotIn("when 'connected' then 'healthy'", COMPATIBILITY)
        self.assertIn("only a passed controlled health check", COMPATIBILITY)

    def test_event_and_check_history_are_immutable(self):
        self.assertIn("connection_events_append_only", MIGRATION)
        self.assertIn("Connection event history is append-only", MIGRATION)
        self.assertIn("connection_checks_immutable_after_finish", MIGRATION)
        self.assertIn("Completed connection health checks are immutable", MIGRATION)
        self.assertIn("before update or delete", MIGRATION.lower())

    def test_capability_grants_never_enable_automatic_external_execution(self):
        self.assertIn("automatic_execution_allowed boolean not null default false", MIGRATION)
        self.assertIn("check (automatic_execution_allowed is false)", MIGRATION)
        self.assertIn("connection_capability_guard", MIGRATION)
        self.assertIn("atlas.allow_high_risk_capability_grant", MIGRATION)
        self.assertIn("p_actor_role,true,true", MIGRATION)
        for blocked in (
            "purchase.submit",
            "orders.write",
            "deploy.production.write",
            "external.side_effect",
            "production.sync",
        ):
            self.assertIn(blocked, MIGRATION)

    def test_brain_receives_a_derived_projection_not_a_second_provider_truth(self):
        self.assertIn("evidence_gate_not_provider_registry", MIGRATION)
        self.assertIn("connection_brain_projection", MIGRATION)
        self.assertIn("canonical_connection_state", MIGRATION)
        self.assertIn("effective_evidence_state", MIGRATION)
        self.assertIn("source_ref", MIGRATION)
        self.assertIn("'brain_projection'", MIGRATION)

    def test_public_rpc_surface_is_service_role_only_and_security_invoker(self):
        normalized = re.sub(r"\s+", " ", MIGRATION.lower())
        for function in (
            "atlas_connections_snapshot",
            "atlas_connections_begin_check",
            "atlas_connections_finish_check",
            "atlas_connections_set_capability",
            "atlas_connections_brain_projection",
            "atlas_connections_ping",
        ):
            self.assertIn(f"function public.{function}", normalized)
        self.assertIn("from public,anon,authenticated", normalized)
        self.assertIn("to service_role", normalized)
        self.assertNotIn("security definer", normalized)

    def test_gateway_revalidates_production_profile_and_uses_service_role_server_side(self):
        self.assertIn("requireActiveProfile", EDGE)
        self.assertIn("/auth/v1/user", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn('new Set(["admin", "manager"])', EDGE)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE)
        self.assertIn("atlas_connections_snapshot", EDGE)
        self.assertIn("atlas_connections_begin_check", EDGE)
        self.assertIn("atlas_connections_finish_check", EDGE)
        self.assertIn("atlas_connections_set_capability", EDGE)
        self.assertIn("[functions.atlas-connections]", CONFIG)
        self.assertRegex(
            CONFIG,
            r"\[functions\.atlas-connections\]\s+verify_jwt\s*=\s*false",
        )

    def test_gateway_has_safe_health_checks_and_no_automatic_side_effects(self):
        for strategy in (
            "production_auth",
            "production_data",
            "branch_rpc",
            "edge_runtime",
            "branch_storage",
            "github_public",
            "netlify_public",
        ):
            self.assertIn(strategy, EDGE)
        for code in (
            "AUTHENTICATION_EXPIRED",
            "PERMISSION_DENIED",
            "PROVIDER_RATE_LIMITED",
            "PROVIDER_UNAVAILABLE",
            "CONNECTION_TIMEOUT",
            "INVALID_PROVIDER_RESPONSE",
            "CONFIGURATION_MISSING",
            "ENVIRONMENT_MISMATCH",
        ):
            self.assertIn(code, EDGE)
        self.assertIn("x-atlas-request-id", EDGE)
        self.assertIn("crypto.randomUUID()", EDGE)
        self.assertIn("SMTP health requires both invitation", EDGE)
        self.assertIn("UNSUPPORTED_MANUAL_VERIFICATION", EDGE)
        self.assertNotRegex(EDGE, r"jsonResponse\([^\)]*serviceRoleKey")

    def test_shared_browser_center_mounts_in_settings_and_system(self):
        self.assertIn("#settings-view .settings-integrations", BROWSER)
        self.assertIn("#system-view .system-integrations", BROWSER)
        self.assertIn("atlas-connections", BROWSER)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER)
        self.assertIn("x-atlas-request-id", BROWSER)
        self.assertIn("Connection safety boundary", BROWSER)
        self.assertIn("Healthy requires recent verification", BROWSER)
        self.assertIn("needsMount", BROWSER)
        self.assertNotRegex(BROWSER, r"\.from\s*\(\s*['\"]")
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER + LOADER)
        self.assertIn("connection-center.js", LOADER)
        self.assertIn("connection-center.css", LOADER)
        self.assertIn("data-atlas-connection-center", BROWSER)
        self.assertIn("@media", CSS)


if __name__ == "__main__":
    unittest.main()
