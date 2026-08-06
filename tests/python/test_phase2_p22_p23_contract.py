from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
P22 = (ROOT / "supabase/migrations/20260806232000_atlas_read_sources_p22.sql").read_text()
P23 = (ROOT / "supabase/migrations/20260806234000_atlas_pos_mapping_checkpoint_m.sql").read_text()
READ_EDGE = (ROOT / "supabase/functions/atlas-read-sources/index.ts").read_text()
POS_EDGE = (ROOT / "supabase/functions/atlas-pos-mapping/index.ts").read_text()
READ_UI = (ROOT / "apps/web/assets/js/read-sources-p22.js").read_text()
POS_UI = (ROOT / "apps/web/assets/js/pos-mapping-checkpoint-m.js").read_text()
LOADER = (ROOT / "apps/web/assets/js/settings-mount-bridge.js").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()


class ReadSourceContractTests(unittest.TestCase):
    def test_existing_knowledge_source_model_is_extended(self):
        self.assertIn("alter table atlas_private.knowledge_sources", P22)
        for column in (
            "connection_key text",
            "external_document_id text",
            "external_modified_at timestamptz",
            "last_checked_at timestamptz",
            "content_fingerprint text",
            "freshness_state text",
        ):
            self.assertIn(column, P22)
        self.assertNotIn("create table if not exists atlas_private.external_sources", P22)

    def test_source_events_are_private_and_append_only(self):
        self.assertIn("create table if not exists atlas_private.read_source_events", P22)
        self.assertIn("alter table atlas_private.read_source_events enable row level security", P22)
        self.assertIn("revoke all on atlas_private.read_source_events from public,anon,authenticated", P22)
        self.assertIn("read_source_events_append_only", P22)
        self.assertIn("raise exception 'Read-source event history is append-only'", P22)

    def test_source_snapshot_is_metadata_only_and_service_role_only(self):
        signature = "public.atlas_read_sources_snapshot(uuid,text,integer)"
        self.assertIn(signature, P22)
        self.assertIn("from public,anon,authenticated", P22)
        self.assertIn(f"grant execute on function {signature} to service_role", P22)
        self.assertIn("'source_bodies_returned',false", P22)
        self.assertIn("'private_urls_returned',false", P22)
        self.assertIn("'credentials_returned',false", P22)
        self.assertIn("'automatic_sync_enabled',false", P22)
        self.assertNotIn("security definer", P22.lower())

    def test_canonical_provider_registry_remains_authoritative(self):
        self.assertIn("atlas_private.integration_connections", P22)
        self.assertIn("'atlas-source-library'", P22)
        for provider in ("google-drive", "gmail", "outlook"):
            self.assertIn(f"'{provider}'", P22)
        self.assertIn("knowledge_sync_drive_connection_status", P22)
        self.assertIn("automatic_drive_sync_enabled=false", P22)

    def test_source_gateway_revalidates_manager_and_is_get_only(self):
        self.assertIn("requireManagerProfile", READ_EDGE)
        self.assertIn("/auth/v1/user", READ_EDGE)
        self.assertIn("/rest/v1/profiles", READ_EDGE)
        self.assertIn('new Set(["admin", "manager"])', READ_EDGE)
        self.assertIn('request.method !== "GET"', READ_EDGE)
        self.assertIn("P2.2 Source Center is read-only", READ_EDGE)
        self.assertIn('branchRpc("atlas_read_sources_snapshot"', READ_EDGE)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", READ_UI)
        self.assertNotRegex(READ_UI, r"\.from\s*\(")

    def test_source_ui_is_loaded_into_knowledge(self):
        self.assertIn("AtlasReadSourcesP22", READ_UI)
        self.assertIn("knowledge-sources-page", READ_UI)
        self.assertIn("source bodies, private URLs or credentials", READ_UI)
        self.assertIn("READ_SOURCES_SRC", LOADER)
        self.assertIn("read-sources-p22.js", LOADER)
        self.assertIn("[functions.atlas-read-sources]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)


class CheckpointMContractTests(unittest.TestCase):
    def test_private_mapping_model_is_rls_protected(self):
        tables = (
            "pos_mapping_settings",
            "pos_mapping_targets",
            "pos_import_runs",
            "pos_products",
            "pos_product_candidates",
            "pos_product_mappings",
            "pos_mapping_events",
        )
        for table in tables:
            self.assertIn(f"create table if not exists atlas_private.{table}", P23)
            self.assertIn(f"alter table atlas_private.{table} enable row level security", P23)
        self.assertIn("revoke all on atlas_private.%I from public,anon,authenticated", P23)
        self.assertNotIn("security definer", P23.lower())

    def test_mapping_is_deterministic_but_never_auto_approved(self):
        self.assertIn("pos_normalize_name", P23)
        self.assertIn("pos_candidate_score", P23)
        self.assertIn("exact_name", P23)
        self.assertIn("contained_name", P23)
        self.assertIn("token_overlap", P23)
        self.assertIn("'automatic_approval',false", P23)
        self.assertIn("automatic_mapping_enabled boolean not null default false", P23)
        self.assertIn("check (automatic_mapping_enabled is false)", P23)

    def test_external_product_stage_requires_healthy_dineout(self):
        self.assertIn("p_provider_key<>'dineout'", P23)
        self.assertIn("connection_state is distinct from 'healthy'", P23)
        self.assertIn("The POS connection must be healthy before products can be staged", P23)
        self.assertIn("'connector_blocked'", P23)

    def test_manager_decision_boundary_is_explicit(self):
        self.assertIn("pos_decide_mapping", P23)
        self.assertIn("p_actor_role not in ('admin','manager')", P23)
        self.assertIn("when 'approve' then 'approved'", P23)
        self.assertIn("An active mapping target is required for approval", P23)
        self.assertIn("mapping_approved", P23)
        self.assertIn("manager_approval_required", P23)

    def test_sales_and_external_side_effects_remain_disabled(self):
        for phrase in (
            "sales_ingestion_enabled boolean not null default false",
            "check (sales_ingestion_enabled is false)",
            "'sales_ingestion_enabled',false",
            "'brain_sales_evidence_enabled',false",
            "'automatic_ordering_enabled',false",
            "'production_source_mutation',false",
        ):
            self.assertIn(phrase, P23)
        self.assertIn("orders.write", P23)
        self.assertIn("automatic_ordering", P23)

    def test_pos_rpc_surface_is_service_role_only(self):
        for signature in (
            "public.atlas_pos_mapping_snapshot(uuid,text,integer)",
            "public.atlas_pos_mapping_refresh_targets(jsonb,uuid,text,text)",
            "public.atlas_pos_mapping_stage_products(text,text,jsonb,uuid,text,text)",
            "public.atlas_pos_mapping_decide(uuid,uuid,text,text,uuid,text,text)",
            "public.atlas_pos_mapping_ping()",
        ):
            self.assertIn(signature, P23)
        self.assertIn("p.proname like 'atlas_pos_mapping_%'", P23)
        self.assertIn("grant execute on function %s to service_role", P23)

    def test_pos_gateway_reads_production_targets_but_never_writes_production(self):
        self.assertIn("requireManagerProfile", POS_EDGE)
        self.assertIn("/auth/v1/user", POS_EDGE)
        self.assertIn("/rest/v1/profiles", POS_EDGE)
        self.assertIn('new Set(["admin", "manager"])', POS_EDGE)
        self.assertIn('productionRows(\n    context,\n    "recipes"', POS_EDGE)
        self.assertIn('branchRpc("atlas_pos_mapping_refresh_targets"', POS_EDGE)
        self.assertIn("POS_CONNECTION_REQUIRED", POS_EDGE)
        for forbidden in ('method: "PATCH"', 'method: "DELETE"', 'method: "PUT"'):
            self.assertNotIn(forbidden, POS_EDGE)
        self.assertNotIn("adjust_inventory", POS_EDGE)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", POS_UI)
        self.assertNotRegex(POS_UI, r"\.from\s*\(")

    def test_checkpoint_m_ui_is_loaded_into_reports(self):
        self.assertIn("AtlasCheckpointM", POS_UI)
        self.assertIn("reports-navigation", POS_UI)
        self.assertIn("Sales intelligence remains off", POS_UI)
        self.assertIn("POS_MAPPING_SRC", LOADER)
        self.assertIn("pos-mapping-checkpoint-m.js", LOADER)
        self.assertIn("[functions.atlas-pos-mapping]", CONFIG)


if __name__ == "__main__":
    unittest.main()
