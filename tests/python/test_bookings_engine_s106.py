"""S106 bookings-engine corrections — static contract checks over the migration.

These assert the text-level invariants of the KANEL x ALCEDO Phase 2 engine
migration (the live-DB behaviour is proven by tests/sql/s106_bookings_engine.sql
via scripts/verify_s106_bookings_engine.sh in the replay gate). Structural only.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = (ROOT / "supabase/migrations/20261023090000_s106_bookings_engine.sql").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/migration-replay.yml").read_text(encoding="utf-8")
CONFIG = (ROOT / "apps/web/config.js").read_text(encoding="utf-8")
WORKSPACE = (ROOT / "apps/web/assets/js/bookings-workspace.js").read_text(encoding="utf-8")


class S106BookingsEngineContract(unittest.TestCase):
    def test_approved_settings_values(self):
        self.assertIn("max_party_online = 4", MIG)
        self.assertIn("turnaround_minutes = 15", MIG)
        self.assertIn("where id = true", MIG)

    def test_segment_model_replaces_circular(self):
        # A segment column is added and the Bar is seeded into three sections.
        self.assertIn("add column if not exists segment text", MIG)
        self.assertIn("when position_index between 1 and 8 then 'A'", MIG)
        self.assertIn("when position_index between 9 and 12 then 'B'", MIG)
        self.assertIn("when position_index between 13 and 16 then 'C'", MIG)
        # The Bar's circular flag is retired.
        self.assertIn("set circular_adjacency = false", MIG)

    def test_contiguity_is_segment_bounded_and_never_wraps(self):
        self.assertIn("create or replace function atlas_private.booking_find_contiguous_tables", MIG)
        # Same-section guard and no modulo/wrap arithmetic.
        self.assertIn("t.segment is not distinct from start_seg", MIG)
        self.assertNotIn("% max_pos", MIG)
        self.assertNotIn("is_circular", MIG)

    def test_assign_enforces_single_section(self):
        self.assertIn("create or replace function atlas_private.booking_tables_contiguous_segment", MIG)
        self.assertIn("create or replace function public.atlas_bookings_assign", MIG)
        self.assertIn("booking_tables_contiguous_segment(v_table_ids)", MIG)
        # Definer functions keep their sealed grants and pinned search_path.
        self.assertEqual(MIG.count("set search_path = ''"),
                         MIG.count("security definer"))
        for fn in ("booking_find_contiguous_tables", "booking_tables_contiguous_segment",
                   "booking_day_last_start_minutes"):
            self.assertIn(f"revoke all on function atlas_private.{fn}", MIG)

    def test_per_day_last_start_helper_reads_the_venue_hours(self):
        self.assertIn("create or replace function atlas_private.booking_day_last_start_minutes", MIG)
        self.assertIn("from atlas_private.settings_business_hours", MIG)
        self.assertIn("close_next_day", MIG)

    def test_replay_gate_runs_the_s106_acceptance(self):
        self.assertIn("scripts/verify_s106_bookings_engine.sh", WORKFLOW)

    def test_public_booking_stays_flagged_off(self):
        self.assertIn("PUBLIC_BOOKING_ENABLED: false", CONFIG)

    def test_staff_floor_grid_no_longer_keys_off_circular(self):
        # The staff Bar grid must still render once circular_adjacency is false.
        self.assertNotIn("area.circular_adjacency && areaTables.some", WORKSPACE)
        self.assertIn("areaTables.some((table) => table.position_index) ? ' bk-floor-grid'", WORKSPACE)


if __name__ == "__main__":
    unittest.main()
