"""S98 Atlas Training — static security/contract checks on the migration and config.

These guard the training gateway's invariants against future edits, independent of a
live database: the video bucket is private with no storage.objects policy, the training
tables and RPCs are sealed from browser roles, every SECURITY DEFINER function pins its
search_path, and the frontend endpoint stays inside the configured Atlas host.
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "supabase/migrations/20261015090000_s98_training.sql").read_text(encoding="utf-8")
CONFIG_TOML = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "apps/web/config.js").read_text(encoding="utf-8")
MIGRATIONS_DIR = ROOT / "supabase/migrations"

TRAINING_RPCS = [
    "atlas_training_snapshot", "atlas_training_lesson", "atlas_training_reserve_media",
    "atlas_training_finalize_media", "atlas_training_save_draft", "atlas_training_attach_media",
    "atlas_training_publish", "atlas_training_playback_path", "atlas_training_start",
    "atlas_training_save_progress", "atlas_training_complete", "atlas_training_completion_report",
]
TRAINING_TABLES = [
    "training_media_assets", "training_lesson_versions", "training_chapters",
    "training_steps", "training_progress", "training_events",
]


class TrainingContractTests(unittest.TestCase):
    def test_video_bucket_is_private_with_video_types(self):
        self.assertRegex(
            MIGRATION,
            r"insert into storage\.buckets[\s\S]*?'atlas-training-videos'[\s\S]*?false",
            "atlas-training-videos must be inserted as a private bucket",
        )
        for mime in ("video/mp4", "video/webm", "video/quicktime"):
            self.assertIn(mime, MIGRATION)
        # 2 GiB limit.
        self.assertIn("2147483648", MIGRATION)

    def test_no_storage_objects_policy_for_training_bucket(self):
        # No migration may attach a storage.objects policy to the private video bucket.
        for path in MIGRATIONS_DIR.glob("*.sql"):
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r"create policy[\s\S]{0,600}?;", text, re.IGNORECASE):
                block = match.group(0)
                if "storage.objects" in block and "atlas-training-videos" in block:
                    self.fail(f"{path.name} attaches a storage.objects policy to the private bucket")
        self.assertIn("No storage.objects policy is created for this bucket", MIGRATION)

    def test_training_tables_are_sealed_from_browser_roles(self):
        # Each training table is created and enrolled in the sealing loop.
        for table in TRAINING_TABLES:
            self.assertIn(f"atlas_private.{table}", MIGRATION, f"{table} missing from migration")
            self.assertRegex(MIGRATION, rf"create table if not exists atlas_private\.{table}")
        # The sealing loop revokes from browser roles, grants only service_role, RLS on.
        self.assertIn("revoke all on atlas_private.%I from public, anon, authenticated", MIGRATION)
        self.assertIn("grant select, insert, update, delete on atlas_private.%I to service_role", MIGRATION)
        self.assertIn("for all to service_role using (true) with check (true)", MIGRATION)

    def test_every_training_rpc_is_service_role_only(self):
        for rpc in TRAINING_RPCS:
            self.assertRegex(
                MIGRATION,
                rf"revoke all on function public\.{rpc}\([^)]*\) from public, anon, authenticated",
                f"{rpc} must be revoked from browser roles",
            )
            self.assertRegex(
                MIGRATION,
                rf"grant execute on function public\.{rpc}\([^)]*\) to service_role",
                f"{rpc} must be granted to service_role",
            )
            self.assertNotRegex(
                MIGRATION,
                rf"grant execute on function public\.{rpc}\([^)]*\) to [^;]*authenticated",
                f"{rpc} must NOT be executable by authenticated (browser)",
            )

    def test_every_function_pins_search_path(self):
        # Count SECURITY DEFINER function definitions (lowercase DDL, not comment prose)
        # and ensure each pins search_path = ''.
        definer = len(re.findall(r"\nsecurity definer\n", MIGRATION))
        pinned = len(re.findall(r"set search_path = ''", MIGRATION))
        self.assertGreaterEqual(definer, 12, "expected the training RPCs to be SECURITY DEFINER")
        self.assertGreaterEqual(pinned, definer, "every SECURITY DEFINER function must pin search_path")

    def test_append_only_audit_on_training_events(self):
        self.assertRegex(MIGRATION, r"revoke update, delete, truncate on atlas_private\.training_events")
        self.assertIn("private.audit_append_only(", MIGRATION)

    def test_function_config_registers_training_gateway(self):
        self.assertRegex(CONFIG_TOML, r"\[functions\.atlas-training\]\s*\nverify_jwt = false")

    def test_frontend_endpoint_inside_configured_host(self):
        # rehearsal-boundary requires every *_API to start with SUPABASE_URL/functions/v1/.
        self.assertRegex(
            CONFIG_JS,
            r'TRAINING_API:\s*"https://dnefgcmjcgxlynycxkts\.supabase\.co/functions/v1/atlas-training"',
        )


if __name__ == "__main__":
    unittest.main()
