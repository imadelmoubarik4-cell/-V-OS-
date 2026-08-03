from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql").read_text()
HARDENING = (ROOT / "supabase/migrations/20260803125530_atlas_team_messages_hardening.sql").read_text()
IDEMPOTENCY = (ROOT / "supabase/migrations/20260803132222_atlas_team_messages_idempotency.sql").read_text()
EDGE_FUNCTION = (ROOT / "supabase/functions/atlas-team-messages/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BROWSER_CONFIG = (ROOT / "apps/web/config.js").read_text()
BROWSER_MODULE = (ROOT / "apps/web/assets/js/team-messages.js").read_text()


class TeamMessagesContractTests(unittest.TestCase):
    def test_private_message_tables_are_rls_protected(self):
        for table in (
            "team_channels",
            "team_messages",
            "team_message_revisions",
            "team_channel_reads",
            "team_message_events",
        ):
            self.assertIn(f"alter table atlas_private.{table} enable row level security", MIGRATION)
            self.assertIn(f"revoke all on atlas_private.{table} from public,anon,authenticated", MIGRATION)
        self.assertNotIn("to authenticated using (true)", MIGRATION.lower())

    def test_required_channels_and_announcement_rule_are_seeded(self):
        for channel in ("general", "operations", "shift-handover", "announcements", "marketing"):
            self.assertIn(f"('{channel}'", MIGRATION)
        self.assertIn("manager_post_only", MIGRATION)
        self.assertIn("Only managers can post in Announcements", MIGRATION + IDEMPOTENCY)

    def test_read_state_revision_and_soft_delete_contracts_exist(self):
        self.assertIn("last_read_at timestamptz not null", MIGRATION)
        self.assertIn("last_read_message_id uuid", MIGRATION)
        self.assertIn("team_message_revisions", MIGRATION)
        self.assertIn("edited_at timestamptz", MIGRATION)
        self.assertIn("deleted_at timestamptz", MIGRATION)
        self.assertIn("soft_delete_with_audit", MIGRATION)
        self.assertIn("15 minutes", MIGRATION)

    def test_linked_records_are typed_and_server_validated(self):
        for link_type in ("inventory_item", "routine", "shift", "brain_recommendation"):
            self.assertIn(link_type, MIGRATION)
            self.assertIn(link_type, EDGE_FUNCTION)
        self.assertIn("validateLink", EDGE_FUNCTION)
        self.assertIn("The linked inventory item is no longer active", EDGE_FUNCTION)
        self.assertIn("The linked routine is not scheduled for today", EDGE_FUNCTION)
        self.assertIn("The linked shift is no longer available", EDGE_FUNCTION)
        self.assertIn("The linked Atlas recommendation is no longer active", EDGE_FUNCTION)

    def test_inactive_profiles_are_denied_on_every_gateway_request(self):
        self.assertIn("requireActiveProfile", EDGE_FUNCTION)
        self.assertIn("if (!profile?.active)", EDGE_FUNCTION)
        self.assertIn("Team-message access has been removed", EDGE_FUNCTION)
        self.assertIn("inactive_profile_access", EDGE_FUNCTION)
        self.assertIn("denied_on_every_request", EDGE_FUNCTION)

    def test_message_writes_are_idempotent_rate_limited_and_audited(self):
        self.assertIn("client_request_id uuid unique", MIGRATION)
        self.assertIn("system_event_key text unique", MIGRATION)
        self.assertIn("on conflict (system_event_key) do nothing", IDEMPOTENCY.lower())
        self.assertIn("recent_message_count", IDEMPOTENCY)
        self.assertIn("recent_message_count>=20", IDEMPOTENCY)
        self.assertIn("team_message_events", MIGRATION)
        self.assertIn("message_sent", MIGRATION)
        self.assertIn("message_edited", MIGRATION)
        self.assertIn("message_deleted", MIGRATION)

    def test_routine_completion_can_publish_an_idempotent_operations_message(self):
        self.assertIn("routine-completed:", MIGRATION)
        self.assertIn("team_messages_post_system", MIGRATION)
        self.assertIn("maintenance_count", MIGRATION)
        self.assertIn("require manager review", MIGRATION)

    def test_rpc_surface_is_service_role_only(self):
        for signature in (
            "public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer)",
            "public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb)",
            "public.atlas_team_messages_edit(uuid,text,uuid,text,text)",
            "public.atlas_team_messages_delete(uuid,text,uuid,text,text)",
            "public.atlas_team_messages_mark_read(text,uuid,text,text)",
        ):
            self.assertIn(f"revoke execute on function {signature} from public,anon,authenticated", MIGRATION)
            self.assertIn(f"grant execute on function {signature} to service_role", MIGRATION)
        self.assertNotIn("security definer", MIGRATION.lower() + HARDENING.lower() + IDEMPOTENCY.lower())

    def test_edge_function_uses_custom_active_profile_authorization(self):
        self.assertIn('new Set(["admin", "manager", "bartender"])', EDGE_FUNCTION)
        self.assertIn('new Set(["admin", "manager"])', EDGE_FUNCTION)
        self.assertIn("requireWriter(context)", EDGE_FUNCTION)
        self.assertIn("requireManager(context)", EDGE_FUNCTION)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE_FUNCTION)
        self.assertIn("[functions.atlas-team-messages]", CONFIG)
        self.assertIn("verify_jwt = false", CONFIG)

    def test_browser_has_no_service_key_or_direct_database_access(self):
        self.assertIn("TEAM_MESSAGES_API", BROWSER_CONFIG)
        self.assertIn("team-messages.js", BROWSER_CONFIG)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BROWSER_CONFIG + BROWSER_MODULE)
        self.assertNotIn(".from(", BROWSER_MODULE)
        for private_table in (
            "team_messages",
            "team_channel_reads",
            "team_message_events",
        ):
            self.assertNotIn(private_table, BROWSER_MODULE)


if __name__ == "__main__":
    unittest.main()
