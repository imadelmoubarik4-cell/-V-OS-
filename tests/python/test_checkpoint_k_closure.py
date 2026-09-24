from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = (ROOT / "supabase/migrations/20260805093732_atlas_brain_checkpoint_k_intelligence.sql").read_text()
CONSOLIDATION = (ROOT / "supabase/migrations/20260805125412_atlas_intelligence_checkpoint_k_consolidation.sql").read_text()
EDGE = (ROOT / "supabase/functions/atlas-phase3-intelligence/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
DEAD_BEGIN_RUN = (ROOT / "supabase/migrations/20260926080000_s88_drop_dead_intelligence_begin_run.sql").read_text()
REPLAY = (ROOT / "scripts/verify_full_migration_replay.sh").read_text()
SHARED_STOCK = (ROOT / "supabase/functions/_shared/stock-provenance.mjs").read_text()


class CheckpointKClosureTests(unittest.TestCase):
    def test_brain_model_is_the_only_canonical_checkpoint_k_store(self):
        self.assertIn("create table if not exists atlas_private.brain_intelligence_snapshots", FOUNDATION)
        self.assertIn("alter table atlas_private.brain_intelligence_snapshots enable row level security", FOUNDATION)
        self.assertIn(
            "revoke all on atlas_private.brain_intelligence_snapshots from public,anon,authenticated",
            FOUNDATION,
        )
        self.assertIn("Canonical Checkpoint K private source-coverage snapshot", CONSOLIDATION)
        for table in (
            "intelligence_events",
            "intelligence_outcomes",
            "intelligence_decisions",
            "intelligence_evidence",
            "intelligence_recommendations",
            "intelligence_capabilities",
            "intelligence_runs",
        ):
            self.assertIn(f"drop table if exists atlas_private.{table}", CONSOLIDATION)
        self.assertIn("Cannot consolidate Checkpoint K", CONSOLIDATION)
        self.assertIn("contains records", CONSOLIDATION)

    def test_orphaned_experiment_entry_point_is_dropped_only_without_its_table(self):
        signature = "intelligence_begin_run(text,text,timestamptz,jsonb,text,uuid,text,text)"
        self.assertIn("if to_regclass('atlas_private.intelligence_runs') is null then", DEAD_BEGIN_RUN)
        self.assertIn(f"drop function if exists public.atlas_{signature};", DEAD_BEGIN_RUN)
        self.assertIn(f"drop function if exists atlas_private.{signature};", DEAD_BEGIN_RUN)
        self.assertNotIn("intelligence_begin_run", EDGE)
        self.assertIn('assert state["dead_begin_run"] is False', REPLAY)
        later = sorted(
            path for path in (ROOT / "supabase/migrations").glob("*.sql")
            if path.name > "20260805125412_atlas_intelligence_checkpoint_k_consolidation.sql"
        )
        for path in later:
            text = path.read_text()
            self.assertNotIn("create table if not exists atlas_private.intelligence_runs", text, path.name)
            if path.name != "20260926080000_s88_drop_dead_intelligence_begin_run.sql":
                self.assertNotIn("intelligence_begin_run", text, path.name)

    def test_checkpoint_k_is_manager_only_and_service_role_mediated(self):
        self.assertIn("async function requireManager", EDGE)
        self.assertIn("/auth/v1/user", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn("if (!profile?.active)", EDGE)
        self.assertIn('const MANAGER_ROLES = new Set(["admin", "manager"])', EDGE)
        self.assertIn("Checkpoint K is limited to managers and administrators", EDGE)
        self.assertIn('branchRpc("atlas_phase3_intelligence_settings")', EDGE)
        self.assertIn('branchRpc("atlas_phase3_sync_intelligence"', EDGE)
        self.assertIn('branchRpc("atlas_phase3_snapshot")', EDGE)
        self.assertRegex(CONFIG, r"\[functions\.atlas-phase3-intelligence\]\s+verify_jwt\s*=\s*false")
        self.assertIn("production VÁ Auth", CONFIG)
        self.assertIn("active manager/admin profile", CONFIG)

    def test_historical_stock_and_missing_evidence_are_explicitly_gated(self):
        # S88: one historical cutoff, owned by the shared stock module (Reports').
        self.assertNotIn("const HISTORICAL_OPENING_CUTOFF", EDGE)
        self.assertNotIn("2026-07-26", EDGE)
        self.assertIn('from "../_shared/atlas-domain.mjs"', EDGE)
        self.assertIn('HISTORICAL_OPENING_CUTOFF = "2026-07-31"', SHARED_STOCK)
        self.assertIn("function historicalOpeningRow", EDGE)
        self.assertIn("historical July opening snapshot", EDGE)
        self.assertIn("Current stock is not verified", EDGE)
        self.assertIn("No validated demand history is connected", EDGE)
        self.assertIn("Supplier lead times, minimums and incoming deliveries are not connected", EDGE)
        self.assertIn("No validated product-level sales history is connected", EDGE)
        self.assertIn("verified_current_count: false", EDGE)
        self.assertIn("historical_stock_used_for_prediction: false", EDGE)

    def test_recommendations_remain_shadow_only_and_non_mutating(self):
        self.assertIn("automatic_operational_mutation boolean not null default false", FOUNDATION)
        self.assertIn("check (automatic_operational_mutation is false)", FOUNDATION)
        for flag in (
            "automatic_reorder_execution',false",
            "automatic_brain_execution',false",
            "automatic_menu_changes',false",
            "automatic_waste_attribution',false",
            "production_sync',false",
            "manager_review_required',true",
        ):
            self.assertIn(flag, FOUNDATION)
        for flag in (
            "shadow_mode: true",
            "automatic_ordering: false",
            "automatic_menu_changes: false",
            "automatic_waste_attribution: false",
            "production_source_mutation: false",
            "manager_review_required: true",
        ):
            self.assertIn(flag, EDGE)
        self.assertNotIn("adjust_inventory", EDGE)
        self.assertNotRegex(EDGE, re.compile(r'method:\s*"(?:PATCH|PUT|DELETE)"'))

    def test_waste_intelligence_never_infers_blame_from_adjustments(self):
        self.assertIn("const EXPLICIT_WASTE_TYPES", EDGE)
        self.assertIn('lower(row.movement_type) === "adjustment"', EDGE)
        self.assertIn("negative_adjustments_excluded", EDGE)
        self.assertIn("Negative adjustments are never assumed to be waste", EDGE)
        self.assertIn("Atlas does not infer causes or assign staff blame", EDGE)
        self.assertIn("negative_adjustments_treated_as_waste: false", EDGE)

    def test_public_checkpoint_k_rpcs_are_service_role_only(self):
        for signature in (
            "public.atlas_phase3_intelligence_settings()",
            "public.atlas_phase3_sync_intelligence(jsonb,jsonb,jsonb,jsonb,timestamptz,uuid,text,text)",
        ):
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", FOUNDATION)
            self.assertIn(f"grant execute on function {signature} to service_role", FOUNDATION)


if __name__ == "__main__":
    unittest.main()
