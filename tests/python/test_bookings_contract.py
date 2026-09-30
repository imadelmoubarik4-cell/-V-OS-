"""S99 Alcedo Bookings — static security/contract checks on the migration.

These guard the bookings gateway's invariants against future edits, independent of a live
database: every bookings table is sealed from browser roles (RLS + service-role-only grant),
every gateway RPC is service-role only, every SECURITY DEFINER function pins its
search_path, the status-history and events tables are append-only, the availability rules
live in a single seeded settings row, and the module stays single-venue (no venue_id).

The frontend endpoint / config.toml assertions live with the edge function (a later step),
so this file checks only what the DB migration establishes.
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "supabase/migrations/20261016090000_s99_bookings.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
CONFIG_TOML = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "apps/web/config.js").read_text(encoding="utf-8")

BOOKING_RPCS = [
    "atlas_bookings_snapshot", "atlas_bookings_config", "atlas_bookings_save_area",
    "atlas_bookings_save_table", "atlas_bookings_save_combination", "atlas_bookings_save_settings",
    "atlas_bookings_availability", "atlas_bookings_create", "atlas_bookings_assign",
    "atlas_bookings_set_status", "atlas_bookings_hold", "atlas_bookings_release_hold",
]
BOOKING_TABLES = [
    "booking_areas", "booking_tables", "booking_table_combinations", "booking_settings",
    "reservations", "reservation_tables", "reservation_status_history", "booking_holds",
    "booking_events",
]


class BookingsContractTests(unittest.TestCase):
    def test_all_tables_created_and_sealed(self):
        for table in BOOKING_TABLES:
            self.assertRegex(
                MIGRATION,
                rf"create table if not exists atlas_private\.{table}\b",
                f"{table} must be created in atlas_private",
            )
        # The sealing loop revokes from browser roles, grants only service_role, RLS on.
        self.assertIn("revoke all on atlas_private.%I from public, anon, authenticated", MIGRATION)
        self.assertIn("grant select, insert, update, delete on atlas_private.%I to service_role", MIGRATION)
        self.assertIn("for all to service_role using (true) with check (true)", MIGRATION)
        # Every booking table is enrolled in the sealing loop's array.
        loop = re.search(r"foreach t in array array\[([\s\S]*?)\] loop", MIGRATION)
        self.assertIsNotNone(loop, "the sealing loop must exist")
        for table in BOOKING_TABLES:
            self.assertIn(f"'{table}'", loop.group(1), f"{table} missing from the sealing loop")

    def test_every_rpc_is_service_role_only(self):
        for rpc in BOOKING_RPCS:
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

    def test_every_definer_function_pins_search_path(self):
        definer = len(re.findall(r"\nsecurity definer\n", MIGRATION))
        pinned = len(re.findall(r"set search_path = ''", MIGRATION))
        self.assertGreaterEqual(definer, 12, "expected the bookings RPCs to be SECURITY DEFINER")
        self.assertGreaterEqual(pinned, definer, "every SECURITY DEFINER function must pin search_path")

    def test_status_history_and_events_are_append_only(self):
        self.assertRegex(
            MIGRATION,
            r"revoke update, delete, truncate on atlas_private\.reservation_status_history",
        )
        self.assertRegex(
            MIGRATION,
            r"revoke update, delete, truncate on atlas_private\.booking_events",
        )
        self.assertIn("private.audit_append_only(", MIGRATION)

    def test_single_settings_row_is_seeded(self):
        # The availability rules live in one row (id boolean, only true allowed) and are seeded.
        self.assertRegex(MIGRATION, r"id boolean primary key default true check \(id = true\)")
        self.assertRegex(
            MIGRATION,
            r"insert into atlas_private\.booking_settings \(id\) values \(true\)\s*\n\s*on conflict",
        )

    def test_no_double_booking_guard_on_allocations(self):
        # A live allocation is unique per (reservation, table); the create/assign RPCs re-check
        # freeness under a row lock via booking_table_free.
        self.assertRegex(
            MIGRATION,
            r"create unique index if not exists reservation_tables_active_uniq[\s\S]*?where released_at is null",
        )
        self.assertIn("for update", MIGRATION)
        self.assertIn("atlas_private.booking_table_free(", MIGRATION)

    def test_single_venue_no_venue_id(self):
        # This is a single-venue app: no venue_id column or reference may be introduced by
        # this module (the header comment may mention its deliberate absence in prose).
        self.assertNotRegex(MIGRATION, r"venue_id\s+(uuid|text|bigint|integer|boolean)",
                            "no venue_id column may be declared")
        self.assertNotRegex(MIGRATION, r"\.venue_id\b", "no venue_id reference may be used")

    def test_migration_reloads_schema(self):
        self.assertIn("notify pgrst, 'reload schema';", MIGRATION)

    def test_function_config_registers_bookings_gateway(self):
        self.assertRegex(CONFIG_TOML, r"\[functions\.atlas-bookings\]\s*\nverify_jwt = false")

    # The frontend BOOKINGS_API endpoint + its ratchets land with the browser module that
    # reads it (the staff workspace), so that assertion lives with the frontend step.


if __name__ == "__main__":
    unittest.main()
