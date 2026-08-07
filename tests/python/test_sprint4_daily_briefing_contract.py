from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260802192300_sprint4_daily_briefing.sql").read_text()
ORDERING_MIGRATION = (ROOT / "supabase/migrations/20260802202000_sprint4_briefing_priority_order.sql").read_text()
EDGE = (ROOT / "supabase/functions/atlas-sprint4-briefing/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()


class Sprint4DailyBriefingContractTests(unittest.TestCase):
    def test_briefing_contract_contains_confidence_sources_and_evidence(self) -> None:
        self.assertIn("create or replace function public.atlas_sprint4_daily_briefing()", MIGRATION)
        self.assertIn("'confidence'", MIGRATION)
        self.assertIn("'sources'", MIGRATION)
        self.assertIn("'evidence'", MIGRATION)
        self.assertIn("'generated_at'", MIGRATION)
        self.assertIn("'freshness'", MIGRATION)

    def test_database_contract_is_read_only_and_service_role_only(self) -> None:
        self.assertIn("security invoker", MIGRATION.lower())
        self.assertIn("revoke execute on function public.atlas_sprint4_daily_briefing()", MIGRATION)
        self.assertIn("grant execute on function public.atlas_sprint4_daily_briefing() to service_role", MIGRATION)
        self.assertNotRegex(MIGRATION.lower(), r"\b(insert|update|delete|truncate)\b\s+(into\s+|from\s+|table\s+)?public\.")

    def test_signals_are_exposed_in_numeric_priority_order(self) -> None:
        self.assertIn("rename to atlas_sprint4_daily_briefing_raw", ORDERING_MIGRATION)
        self.assertIn("jsonb_array_elements", ORDERING_MIGRATION)
        self.assertIn("jsonb_agg(signal order by", ORDERING_MIGRATION)
        self.assertIn("(signal ->> 'priority')::integer", ORDERING_MIGRATION)
        self.assertIn("grant execute on function public.atlas_sprint4_daily_briefing()", ORDERING_MIGRATION)
        self.assertNotRegex(ORDERING_MIGRATION.lower(), r"\b(insert|update|delete|truncate)\b\s+(into\s+|from\s+|table\s+)?atlas_private\.")

    def test_edge_function_enforces_custom_manager_authentication(self) -> None:
        self.assertIn('/auth/v1/user', EDGE)
        self.assertIn('/rest/v1/profiles', EDGE)
        self.assertIn('profile.role !== "admin" && profile.role !== "manager"', EDGE)
        self.assertIn('request.method !== "GET"', EDGE)
        self.assertIn('branchRpc("atlas_sprint4_daily_briefing")', EDGE)
        self.assertIn('SUPABASE_SERVICE_ROLE_KEY', EDGE)
        self.assertNotIn('OPENAI_API_KEY', EDGE)
        self.assertNotRegex(EDGE, re.compile(r"\b(post|put|patch|delete)\b.*operational", re.IGNORECASE))

    def test_gateway_jwt_is_disabled_only_for_in_handler_custom_auth(self) -> None:
        self.assertRegex(CONFIG, r"\[functions\.atlas-sprint4-briefing\]\s+verify_jwt\s*=\s*false")
        self.assertIn("production VÁ Auth", CONFIG)
        self.assertIn("server-controlled active profile", CONFIG)
        self.assertIn("manager/admin profile", CONFIG)


if __name__ == "__main__":
    unittest.main()
