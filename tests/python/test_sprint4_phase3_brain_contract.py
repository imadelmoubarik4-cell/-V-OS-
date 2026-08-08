from __future__ import annotations

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260802223000_atlas_brain_phase3_memory.sql").read_text(encoding="utf-8")
FIX = (ROOT / "supabase/migrations/20260802224500_atlas_brain_phase3_memory_fix.sql").read_text(encoding="utf-8")
API_MIGRATION = (ROOT / "supabase/migrations/20260802225000_atlas_brain_phase3_api.sql").read_text(encoding="utf-8")
EDGE = (ROOT / "supabase/functions/atlas-phase3-brain/index.ts").read_text(encoding="utf-8")
CONFIG = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")


class Sprint4Phase3BrainContractTests(unittest.TestCase):
    def test_private_memory_tables_are_rls_protected(self) -> None:
        for table in (
            "brain_data_connections",
            "brain_recommendations",
            "brain_recommendation_evidence",
            "brain_decisions",
            "brain_outcomes",
        ):
            self.assertIn(f"create table if not exists atlas_private.{table}", MIGRATION)
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", MIGRATION)
        self.assertIn("shadow_mode boolean not null default true check (shadow_mode is true)", MIGRATION)

    def test_capabilities_are_evidence_gated(self) -> None:
        for capability in (
            "decision_memory",
            "recommendation_explanations",
            "shortage_prediction",
            "purchase_recommendations",
            "menu_recommendations",
            "waste_identification",
        ):
            self.assertIn(f"'{capability}'", MIGRATION)
        for connection in (
            "current_stock",
            "sales_history",
            "confirmed_deliveries",
            "supplier_lead_times",
            "supplier_constraints",
            "recipe_costs",
            "menu_prices",
            "inventory_movements",
            "stock_counts",
            "waste_events",
        ):
            self.assertIn(f"'{connection}'", MIGRATION)
        self.assertIn("historical_stock_used_for_prediction',false", MIGRATION)
        self.assertIn("automatic_operational_mutation',false", MIGRATION)

    def test_decision_memory_filters_no_op_source_reviews(self) -> None:
        self.assertIn("create or replace view atlas_private.brain_decision_memory", MIGRATION)
        self.assertIn("decision.previous_status is distinct from decision.new_status", MIGRATION)
        self.assertIn("decision.previous_action is distinct from decision.new_action", MIGRATION)
        self.assertIn("decision.previous_matched_id is distinct from decision.new_matched_id", MIGRATION)

    def test_recommendation_decisions_and_outcomes_are_idempotent(self) -> None:
        self.assertIn("client_request_id text unique", MIGRATION)
        self.assertIn("where client_request_id=p_client_request_id", MIGRATION)
        self.assertIn("decision in ('accept','reject','modify','defer','reset')", MIGRATION)
        self.assertIn("outcome_status in ('observed','confirmed','disputed')", MIGRATION)
        self.assertIn("Only shadow recommendations can be decided", MIGRATION)
        self.assertIn("automatic_mutation',false", MIGRATION)

    def test_service_role_is_the_only_rpc_caller(self) -> None:
        for signature in (
            "public.atlas_phase3_snapshot()",
            "public.atlas_phase3_refresh_shadow_recommendations()",
            "public.atlas_phase3_decide_recommendation(uuid,text,text,text,jsonb,timestamptz,uuid,text,text)",
            "public.atlas_phase3_record_outcome(uuid,uuid,text,text,numeric,jsonb,jsonb,text,timestamptz,uuid,text,text)",
        ):
            self.assertIn(f"revoke execute on function {signature}", MIGRATION)
            self.assertIn(f"grant execute on function {signature}", MIGRATION)
        self.assertIn("to service_role", MIGRATION)

    def test_runtime_ambiguity_fixes_are_versioned(self) -> None:
        self.assertIn("v_recommendation_id uuid", FIX)
        self.assertIn("v_total_rows bigint", FIX)
        self.assertIn("v_pending_rows bigint", FIX)
        self.assertIn("from atlas_private.data_coverage coverage", FIX)
        self.assertIn("recommendation.recommendation_key=p_recommendation_key", FIX)
        self.assertNotRegex(FIX, re.compile(r"\binto\s+total_rows\b", re.IGNORECASE))

    def test_detail_and_memory_read_apis_are_private(self) -> None:
        self.assertIn("public.atlas_phase3_recommendation_detail", API_MIGRATION)
        self.assertIn("public.atlas_phase3_memory_search", API_MIGRATION)
        self.assertIn("brain_recommendation_feed", API_MIGRATION)
        self.assertIn("brain_decision_memory", API_MIGRATION)
        self.assertIn("from public,anon,authenticated", API_MIGRATION)
        self.assertIn("to service_role", API_MIGRATION)

    def test_edge_function_verifies_manager_and_validates_writes(self) -> None:
        self.assertIn('/auth/v1/user', EDGE)
        self.assertIn('/rest/v1/profiles', EDGE)
        self.assertIn('profile.role !== "admin" && profile.role !== "manager"', EDGE)
        self.assertIn('const DECISIONS = new Set(["accept", "reject", "modify", "defer", "reset"])', EDGE)
        self.assertIn('client_request_id is required', EDGE)
        self.assertIn('success_score must be between 0 and 1', EDGE)
        self.assertIn('request.method === "GET"', EDGE)
        self.assertIn('request.method === "POST"', EDGE)
        self.assertIn('SUPABASE_SERVICE_ROLE_KEY', EDGE)
        self.assertNotIn('OPENAI_API_KEY', EDGE)

    def test_custom_auth_is_declared_in_branch_config(self) -> None:
        self.assertRegex(CONFIG, r"\[functions\.atlas-phase3-brain\]\s+verify_jwt\s*=\s*false")
        self.assertIn("production VÁ Auth", CONFIG)
        self.assertIn("server-controlled active profile", CONFIG)
        self.assertIn("manager/admin profile", CONFIG)


if __name__ == "__main__":
    unittest.main()
