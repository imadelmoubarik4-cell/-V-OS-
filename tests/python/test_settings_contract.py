from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (
    ROOT
    / "supabase/migrations/20260806090938_atlas_settings_checkpoint_j_named_arguments.sql"
).read_text()
EDGE = (ROOT / "supabase/functions/atlas-settings/index.ts").read_text()
CONFIG = (ROOT / "supabase/config.toml").read_text()
BRIDGE = (ROOT / "apps/web/assets/js/settings-mount-bridge.js").read_text()


def function_arguments(function_name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(function_name)}\s*\((.*?)\)\s*returns",
        MIGRATION,
        re.IGNORECASE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"Missing function definition for {function_name}")
    return re.sub(r"\s+", " ", match.group(1).strip()).lower()


class SettingsCheckpointJContractTests(unittest.TestCase):
    def test_public_settings_wrappers_have_named_postgrest_arguments(self):
        expected = {
            "atlas_settings_snapshot": [
                "p_profiles jsonb",
                "p_actor_id uuid",
                "p_actor_role text",
            ],
            "atlas_settings_save_section": [
                "p_section_key text",
                "p_value jsonb",
                "p_expected_version integer",
                "p_actor_id uuid",
                "p_actor_label text",
                "p_actor_role text",
            ],
            "atlas_settings_save_hours": [
                "p_hours jsonb",
                "p_actor_id uuid",
                "p_actor_label text",
                "p_actor_role text",
            ],
            "atlas_settings_save_offer": [
                "p_offer_id uuid",
                "p_offer_key text",
                "p_name text",
                "p_description text",
                "p_active boolean",
                "p_days smallint[]",
                "p_start_time time without time zone",
                "p_end_time time without time zone",
                "p_end_next_day boolean",
                "p_pricing jsonb",
                "p_booking_url text",
                "p_expected_version integer",
                "p_actor_id uuid",
                "p_actor_label text",
                "p_actor_role text",
            ],
            "atlas_settings_save_role": [
                "p_role_key text",
                "p_permissions jsonb",
                "p_expected_version integer",
                "p_actor_id uuid",
                "p_actor_label text",
                "p_actor_role text",
            ],
            "atlas_settings_save_notification_policy": [
                "p_event_key text",
                "p_enabled boolean",
                "p_channels jsonb",
                "p_target_roles text[]",
                "p_reminder_minutes integer[]",
                "p_escalation_minutes integer",
                "p_manager_approval_required boolean",
                "p_expected_version integer",
                "p_actor_id uuid",
                "p_actor_label text",
                "p_actor_role text",
            ],
            "atlas_settings_save_preferences": [
                "p_user_id uuid",
                "p_theme text",
                "p_density text",
                "p_language text",
                "p_start_view text",
                "p_timezone text",
                "p_reduce_motion boolean",
                "p_browser_notifications boolean",
                "p_email_notifications boolean",
                "p_preferences jsonb",
                "p_actor_id uuid",
                "p_actor_label text",
                "p_actor_role text",
            ],
        }

        for function_name, expected_arguments in expected.items():
            arguments = function_arguments(function_name)
            cursor = -1
            for expected_argument in expected_arguments:
                next_cursor = arguments.find(expected_argument, cursor + 1)
                self.assertGreaterEqual(
                    next_cursor,
                    0,
                    f"{function_name} is missing named argument {expected_argument}",
                )
                self.assertGreater(
                    next_cursor,
                    cursor,
                    f"{function_name} argument order changed at {expected_argument}",
                )
                cursor = next_cursor

        self.assertNotRegex(MIGRATION, r"\$\d+")
        self.assertNotIn("security definer", MIGRATION.lower())

    def test_edge_payload_names_match_the_public_rpc_contract(self):
        for function_name in (
            "atlas_settings_snapshot",
            "atlas_settings_save_section",
            "atlas_settings_save_hours",
            "atlas_settings_save_offer",
            "atlas_settings_save_role",
            "atlas_settings_save_notification_policy",
            "atlas_settings_save_preferences",
        ):
            self.assertIn(f'branchRpc("{function_name}"', EDGE)

        for payload_key in (
            "p_profiles",
            "p_actor_id",
            "p_actor_role",
            "p_actor_label",
            "p_section_key",
            "p_hours",
            "p_offer_key",
            "p_role_key",
            "p_event_key",
            "p_preferences",
        ):
            self.assertIn(payload_key, EDGE)

    def test_public_settings_rpc_surface_is_service_role_only(self):
        normalized = re.sub(r"\s+", " ", MIGRATION.lower())
        for function_name in (
            "atlas_settings_snapshot",
            "atlas_settings_save_section",
            "atlas_settings_save_hours",
            "atlas_settings_save_offer",
            "atlas_settings_save_role",
            "atlas_settings_save_notification_policy",
            "atlas_settings_save_preferences",
        ):
            self.assertIn(
                f"revoke all on function public.{function_name}",
                normalized,
            )
            self.assertIn(
                f"grant execute on function public.{function_name}",
                normalized,
            )

        self.assertGreaterEqual(normalized.count("from public, anon, authenticated"), 7)
        self.assertGreaterEqual(normalized.count("to service_role"), 7)
        self.assertIn("notify pgrst, 'reload schema'", normalized)

    def test_settings_gateway_revalidates_production_profile(self):
        self.assertIn("requireActiveProfile", EDGE)
        self.assertIn("/auth/v1/user", EDGE)
        self.assertIn("/rest/v1/profiles", EDGE)
        self.assertIn('new Set(["admin", "manager"])', EDGE)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", EDGE)
        self.assertIn("[functions.atlas-settings]", CONFIG)
        self.assertRegex(
            CONFIG,
            r"\[functions\.atlas-settings\]\s+verify_jwt\s*=\s*false",
        )

    def test_primary_settings_actions_keep_readable_contrast(self):
        self.assertIn("BUTTON_CONTRAST_STYLE_ID", BRIDGE)
        self.assertIn(".settings-view .settings-primary", BRIDGE)
        self.assertIn("color:#fff", BRIDGE)
        self.assertIn("ensureButtonContrast", BRIDGE)


if __name__ == "__main__":
    unittest.main()
