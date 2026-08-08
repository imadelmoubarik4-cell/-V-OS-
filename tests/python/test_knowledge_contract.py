from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260804004723_atlas_knowledge_checkpoint_g.sql").read_text()
HARDENING = (ROOT / "supabase/migrations/20260804005004_atlas_knowledge_checkpoint_g_hardening.sql").read_text()
NAMED_ARGS = (ROOT / "supabase/migrations/20260804005558_atlas_knowledge_rpc_named_arguments.sql").read_text()
EDGE_FUNCTION = (ROOT / "supabase/functions/atlas-knowledge/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER_MODULE = (ROOT / "apps/web/assets/js/knowledge-workspace.js").read_text()
TEAM_BRIDGE = (ROOT / "apps/web/assets/js/knowledge-team-link-bridge.js").read_text()


class KnowledgeContractTests(unittest.TestCase):
    def test_private_knowledge_tables_are_rls_protected(self):
        tables = (
            "knowledge_settings",
            "knowledge_categories",
            "knowledge_articles",
            "knowledge_article_versions",
            "knowledge_sources",
            "knowledge_task_links",
            "knowledge_reads",
            "knowledge_acknowledgements",
            "knowledge_events",
        )
        for table in tables:
            self.assertIn(
                f"alter table atlas_private.{table} enable row level security",
                MIGRATION,
            )
            self.assertIn(
                f"revoke all on atlas_private.{table} from public,anon,authenticated",
                MIGRATION,
            )
            self.assertIn(f"grant all on atlas_private.{table} to service_role", MIGRATION)
        self.assertNotIn("to authenticated using (true)", MIGRATION.lower())

    def test_versioning_acknowledgement_and_source_entities_exist(self):
        for entity in (
            "knowledge_articles",
            "knowledge_article_versions",
            "knowledge_sources",
            "knowledge_task_links",
            "knowledge_reads",
            "knowledge_acknowledgements",
        ):
            self.assertIn(entity, MIGRATION)
        self.assertIn("published_versions_immutable", MIGRATION)
        self.assertIn("only_published_versions_visible_to_staff", MIGRATION)
        self.assertIn("current_version_id", MIGRATION)
        self.assertIn("draft_version_id", MIGRATION)
        self.assertIn("unique (article_id,version_number)", MIGRATION)

    def test_staff_visibility_is_role_targeted_and_manager_drafts_stay_private(self):
        self.assertIn("knowledge_article_visible", MIGRATION)
        self.assertIn("p_article.status='published'", MIGRATION)
        self.assertIn("p_actor_role=any(p_article.target_roles)", MIGRATION)
        self.assertIn("p_prefer_draft", MIGRATION)
        self.assertIn("is_manager and coalesce(p_prefer_draft,false)", MIGRATION)

    def test_required_reading_is_version_specific(self):
        self.assertIn("primary key (version_id,user_id)", MIGRATION)
        self.assertIn("Only the current published version can be acknowledged", MIGRATION)
        self.assertIn("article_acknowledged", MIGRATION)
        self.assertIn("required_due", MIGRATION)

    def test_team_messages_support_first_class_knowledge_links(self):
        self.assertIn("knowledge_article", HARDENING)
        self.assertIn("team_messages_link_type_check", HARDENING)
        self.assertIn("team_messages_post_system", HARDENING)
        self.assertIn("'knowledge'", HARDENING)
        self.assertIn('data-team-open-link="knowledge_article"', TEAM_BRIDGE)

    def test_public_rpc_surface_is_service_role_only_and_named(self):
        signatures = (
            "public.atlas_knowledge_snapshot(jsonb,jsonb,jsonb,uuid,text)",
            "public.atlas_knowledge_article_detail(uuid,uuid,text,boolean)",
            "public.atlas_knowledge_save_draft(uuid,text,uuid,text,text,text,text,boolean,text[],text,text,uuid,text,text)",
            "public.atlas_knowledge_publish(uuid,text,uuid,text,text)",
            "public.atlas_knowledge_retire(uuid,text,uuid,text,text)",
            "public.atlas_knowledge_mark_read(uuid,uuid,uuid,text,text)",
            "public.atlas_knowledge_acknowledge(uuid,uuid,uuid,text,text)",
            "public.atlas_knowledge_save_source(uuid,uuid,text,text,text,text,text,text,boolean,jsonb,uuid,text,text)",
            "public.atlas_knowledge_remove_source(uuid,uuid,text,text)",
            "public.atlas_knowledge_set_task_links(uuid,uuid[],uuid,text,text)",
        )
        for signature in signatures:
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", NAMED_ARGS)
            self.assertIn(f"grant execute on function {signature} to service_role", NAMED_ARGS)
        self.assertIn("p_profiles jsonb", NAMED_ARGS)
        self.assertIn("p_article_id uuid", NAMED_ARGS)
        self.assertNotIn("security definer", (MIGRATION + HARDENING + NAMED_ARGS).lower())

    def test_edge_function_revalidates_active_profiles_and_roles(self):
        self.assertIn("requireActiveProfile", EDGE_FUNCTION)
        self.assertIn("if (!profile?.active)", EDGE_FUNCTION)
        self.assertIn("Knowledge access has been removed", EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager", "bartender", "viewer"])', EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager"])', EDGE_FUNCTION)
        self.assertIn("requireManager(context)", EDGE_FUNCTION)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE_FUNCTION)
        self.assertIn("[functions.atlas-knowledge]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_browser_has_no_service_key_or_direct_private_table_access(self):
        self.assertIn("KNOWLEDGE_API", BROWSER_CONFIG)
        self.assertIn("knowledge-workspace.js", BROWSER_CONFIG)
        self.assertIn("window.atlasSupabase", BROWSER_MODULE)
        self.assertIn("authorization: `Bearer ${session.access_token}`", BROWSER_MODULE)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER_MODULE)
        self.assertNotRegex(BROWSER_MODULE, r"\.from\s*\(")
        for table in (
            "knowledge_articles",
            "knowledge_article_versions",
            "knowledge_acknowledgements",
            "knowledge_sources",
        ):
            self.assertNotIn(table, BROWSER_MODULE)

    def test_public_repository_contains_no_private_drive_urls_or_alarm_credentials(self):
        public_files = "\n".join((
            MIGRATION,
            HARDENING,
            NAMED_ARGS,
            EDGE_FUNCTION,
            BROWSER_CONFIG,
            BROWSER_MODULE,
            TEAM_BRIDGE,
        ))
        self.assertNotIn("docs.google.com/document/d/", public_files)
        self.assertNotRegex(public_files, re.compile(r"alarm\s*(code|pin)\s*[:=]", re.I))
        self.assertIn("source_text_in_public_repository',false", MIGRATION)
        self.assertIn("sensitive_credentials_imported',false", MIGRATION)


if __name__ == "__main__":
    unittest.main()
