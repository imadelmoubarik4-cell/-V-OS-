"""S107 public booking API — static contract checks over the migration.

Live-DB behaviour is proven by tests/sql/s107_public_booking.sql via
scripts/verify_s107_public_booking.sh in the replay gate. Structural only.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = (ROOT / "supabase/migrations/20261024090000_s107_public_booking_api.sql").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/migration-replay.yml").read_text(encoding="utf-8")

PUBLIC_RPCS = (
    "public.atlas_public_booking_availability(date,integer,text)",
    "public.atlas_public_booking_request(jsonb)",
    "public.atlas_public_booking_status(text)",
)


class S107PublicBookingContract(unittest.TestCase):
    def test_server_flag_defaults_off(self):
        self.assertIn("add column if not exists public_online_enabled boolean not null default false", MIG)

    def test_public_rpcs_are_service_role_only(self):
        for sig in PUBLIC_RPCS:
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated", MIG)
            self.assertIn(f"grant execute on function {sig} to service_role", MIG)
        # No broad grant to browser roles anywhere.
        self.assertNotIn("to anon", MIG)
        self.assertNotIn("to authenticated", MIG)

    def test_every_definer_pins_search_path(self):
        self.assertEqual(MIG.count("security definer"), MIG.count("set search_path = ''"))

    def test_bar_only_online(self):
        self.assertIn("online_bookable boolean not null default false", MIG)
        self.assertIn("set online_bookable = true", MIG)
        self.assertIn("where id <> 'ba000000-0000-4000-8000-000000000001'", MIG)

    def test_requests_stay_requested_with_expiring_hold_and_token(self):
        self.assertIn("'requested'", MIG)
        self.assertIn("'web_pending'", MIG)
        self.assertIn("public_token", MIG)
        self.assertIn("booking_public_token()", MIG)
        # A request never writes a confirmed status or a reservation_tables row.
        self.assertNotIn("'confirmed'", MIG)
        self.assertNotIn("insert into atlas_private.reservation_tables", MIG)

    def test_status_returns_only_minimal_fields(self):
        # The status RPC exposes reference/status/start_at/party_size only.
        self.assertIn("'reference', r.booking_reference, 'status', r.status", MIG)
        self.assertNotIn("guest_phone', r.guest_phone", MIG)
        self.assertNotIn("staff_notes", MIG)

    def test_rate_limit_table_is_sealed(self):
        self.assertIn("create table if not exists atlas_private.booking_public_rate", MIG)
        self.assertIn("alter table atlas_private.booking_public_rate enable row level security", MIG)
        self.assertIn("revoke all on atlas_private.booking_public_rate from public, anon, authenticated", MIG)
        self.assertIn("booking_public_rate_ok", MIG)

    def test_enforces_party_cap_horizon_and_hours(self):
        self.assertIn("max_party_online", MIG)
        self.assertIn("advance_days", MIG)
        self.assertIn("booking_within_hours", MIG)
        self.assertIn("booking_day_last_start_minutes", MIG)

    def test_replay_gate_runs_the_s107_acceptance(self):
        self.assertIn("scripts/verify_s107_public_booking.sh", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
