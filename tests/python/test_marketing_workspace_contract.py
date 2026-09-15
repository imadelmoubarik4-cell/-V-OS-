from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql").read_text()
OCCURRENCES = (ROOT / "supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql").read_text()
OCCURRENCE_FIX = (ROOT / "supabase/migrations/20260803145746_atlas_marketing_recommendation_occurrence_fix.sql").read_text()
DISMISS_FIX = (ROOT / "supabase/migrations/20260803150024_atlas_marketing_recommendation_dismiss_occurrence_fix.sql").read_text()
SNAPSHOT_FIX = (ROOT / "supabase/migrations/20260803150212_atlas_marketing_snapshot_variable_conflict_fix.sql").read_text()
EDGE_FUNCTION = (ROOT / "supabase/functions/atlas-marketing-workspace/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER_MODULE = (ROOT / "apps/web/assets/js/marketing-workspace.js").read_text()


class MarketingWorkspaceContractTests(unittest.TestCase):
    def test_private_marketing_tables_are_rls_protected(self):
        for table in (
            "marketing_campaigns",
            "marketing_content_items",
            "marketing_content_revisions",
            "marketing_content_approvals",
            "marketing_recommendations",
            "marketing_workspace_events",
        ):
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", MIGRATION)
        self.assertIn(
            "alter table atlas_private.marketing_recommendation_occurrences enable row level security",
            OCCURRENCES,
        )
        self.assertIn(
            "revoke all on atlas_private.marketing_recommendation_occurrences from public,anon,authenticated",
            OCCURRENCES,
        )
        self.assertNotIn("to authenticated using (true)", (MIGRATION + OCCURRENCES).lower())

    def test_required_workspace_entities_and_workflow_states_exist(self):
        for table in (
            "marketing_campaigns",
            "marketing_content_items",
            "marketing_content_revisions",
            "marketing_content_approvals",
            "marketing_recommendations",
            "marketing_workspace_events",
            "marketing_recommendation_occurrences",
        ):
            self.assertIn(table, MIGRATION + OCCURRENCES)
        for content_type in (
            "post",
            "story",
            "reel",
            "campaign_task",
            "event_promotion",
            "content_idea",
            "google_post",
        ):
            self.assertIn(content_type, MIGRATION)
        for status in (
            "pending_approval",
            "changes_requested",
            "approved",
            "scheduled",
            "published",
            "completed",
        ):
            self.assertIn(status, MIGRATION)

    def test_va_recommendations_are_seeded_with_evidence_and_recurrence(self):
        self.assertIn("daily-happy-hour-instagram-story", MIGRATION)
        self.assertIn("Suggested Instagram Story for today", MIGRATION)
        self.assertIn("Promote Happy Hour from 15:00–18:00", MIGRATION)
        self.assertIn("Three-frame vertical Story", MIGRATION)
        self.assertIn("cocktails from 1,990 ISK", MIGRATION)
        self.assertIn("sunday-two-for-one-beer-reel", MIGRATION)
        self.assertIn("Suggested Sunday Reel", MIGRATION)
        self.assertIn("2-for-1 beer offer from 18:00–20:00", MIGRATION)
        self.assertIn("recurrence", MIGRATION)
        self.assertIn("evidence", MIGRATION)
        self.assertIn("confidence_score", MIGRATION)

    def test_recurring_recommendations_use_per_date_occurrences(self):
        self.assertIn("unique (recommendation_id,occurrence_date)", OCCURRENCES)
        self.assertIn("available_for_today", OCCURRENCES)
        self.assertIn("marketing_convert_recommendation_occurrence", OCCURRENCES)
        self.assertIn("marketing_dismiss_recommendation_occurrence", OCCURRENCES)
        self.assertIn("on conflict (recommendation_id,occurrence_date)", OCCURRENCES.lower())
        self.assertIn("client_request_id", OCCURRENCES)

    def test_marketing_runtime_ambiguity_fixes_are_versioned(self):
        self.assertIn("v_occurrence_date", OCCURRENCE_FIX)
        self.assertIn("occurrence.occurrence_date=v_occurrence_date", OCCURRENCE_FIX)
        self.assertIn("v_occurrence_date", DISMISS_FIX)
        self.assertIn("recommendation_row.id,v_occurrence_date,'dismissed'", DISMISS_FIX)
        self.assertIn("#variable_conflict use_variable", SNAPSHOT_FIX)
        self.assertIn("marketing_workspace_snapshot(uuid,text,date,date)", SNAPSHOT_FIX)

    def test_connection_boundaries_support_exact_requested_states(self):
        for state in (
            "not_connected",
            "waiting_for_authorization",
            "connected",
            "missing_publishing_permission",
            "missing_analytics_permission",
            "connection_expired",
        ):
            self.assertIn(state, MIGRATION)
        for provider in ("instagram", "facebook", "tiktok", "google-business-profile"):
            self.assertIn(provider, MIGRATION)
        self.assertIn("automatic_publishing_enabled", MIGRATION)
        self.assertIn("automatic_analytics_enabled", MIGRATION)
        self.assertIn("false", MIGRATION)

    def test_approval_publication_and_history_are_audited(self):
        for function in (
            "marketing_record_revision",
            "marketing_submit_approval",
            "marketing_decide_approval",
            "marketing_mark_published",
            "marketing_mark_completed",
        ):
            self.assertIn(function, MIGRATION)
        for event_type in (
            "approval_submitted",
            "approval_decided",
            "content_published",
            "content_completed",
        ):
            self.assertIn(event_type, MIGRATION)
        self.assertIn("marketing_content_revisions", MIGRATION)
        self.assertIn("marketing_content_approvals", MIGRATION)

    def test_rpc_surface_is_service_role_only(self):
        for signature in (
            "public.atlas_marketing_workspace_snapshot(uuid,text,date,date)",
            "public.atlas_marketing_submit_approval(uuid,text,uuid,text,text)",
            "public.atlas_marketing_decide_approval(uuid,text,text,uuid,text,text)",
            "public.atlas_marketing_mark_published(uuid,timestamptz,jsonb,text,uuid,text,text)",
            "public.atlas_marketing_mark_completed(uuid,text,uuid,text,text)",
        ):
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", MIGRATION)
            self.assertIn(f"grant execute on function {signature} to service_role", MIGRATION)
        for signature in (
            "public.atlas_marketing_recommendations(date)",
            "public.atlas_marketing_convert_recommendation_occurrence(uuid,date,uuid,timestamptz,timestamptz,uuid,text,text)",
            "public.atlas_marketing_dismiss_recommendation_occurrence(uuid,date,text,uuid,text,text)",
        ):
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", OCCURRENCES)
            self.assertIn(f"grant execute on function {signature} to service_role", OCCURRENCES)
        self.assertNotIn("security definer", (MIGRATION + OCCURRENCES).lower())

    def test_edge_function_revalidates_active_profile_and_roles(self):
        self.assertIn("requireActiveProfile", EDGE_FUNCTION)
        self.assertIn("if (!profile?.active)", EDGE_FUNCTION)
        self.assertIn("Marketing workspace access has been removed", EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager", "bartender"])', EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager"])', EDGE_FUNCTION)
        self.assertIn("requireWriter(context)", EDGE_FUNCTION)
        self.assertIn("requireManager(context)", EDGE_FUNCTION)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE_FUNCTION)
        self.assertIn("[functions.atlas-marketing-workspace]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_edge_function_never_calls_social_publish_or_analytics_apis(self):
        self.assertIn("actual_publishing_enabled: false", EDGE_FUNCTION)
        self.assertIn("analytics_ingestion_enabled: false", EDGE_FUNCTION)
        self.assertIn("automatic_social_action: false", EDGE_FUNCTION)
        for forbidden in (
            "graph.facebook.com",
            "open-api.tiktok.com",
            "businessprofileperformance.googleapis.com",
            "localPosts.create",
        ):
            self.assertNotIn(forbidden, EDGE_FUNCTION)

    def test_browser_uses_authenticated_gateway_without_private_table_access(self):
        self.assertIn("MARKETING_WORKSPACE_API", BROWSER_CONFIG)
        self.assertIn("marketing-workspace.js", BROWSER_CONFIG)
        self.assertIn("marketing-workspace.css", BROWSER_CONFIG)
        self.assertIn("window.atlasSupabase", BROWSER_MODULE)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER_MODULE)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER_MODULE)
        self.assertNotIn(".from(", BROWSER_MODULE)
        for private_table in (
            "marketing_content_items",
            "marketing_content_approvals",
            "marketing_workspace_events",
            "integration_connections",
        ):
            self.assertNotIn(private_table, BROWSER_MODULE)


if __name__ == "__main__":
    unittest.main()
