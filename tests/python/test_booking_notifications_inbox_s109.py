"""S109 in-app booking notification inbox + lifecycle/security corrections —
static contract.

Live-DB behaviour is proven by tests/sql/s109_booking_notifications_inbox.sql via
scripts/verify_s109_booking_notifications_inbox.sh in the replay gate. Structural only.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = (ROOT / "supabase/migrations/20261026090000_s109_booking_notifications_inbox.sql").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/migration-replay.yml").read_text(encoding="utf-8")


class S109BookingInboxContract(unittest.TestCase):
    def test_inbox_table_is_sealed(self):
        self.assertIn("create table if not exists atlas_private.booking_notifications", MIG)
        self.assertIn("alter table atlas_private.booking_notifications enable row level security", MIG)
        self.assertIn("revoke all on atlas_private.booking_notifications from public, anon, authenticated", MIG)

    def test_inbox_rpcs_are_manager_gated_and_definer(self):
        self.assertIn("create or replace function public.atlas_bookings_notifications", MIG)
        self.assertIn("create or replace function public.atlas_bookings_notification_read", MIG)
        # Both require a manager actor.
        self.assertEqual(MIG.count("perform atlas_private.booking_require_manager(p_actor_id, p_actor_role)"), 2)
        # Browser roles can never execute them.
        self.assertIn("revoke all on function public.atlas_bookings_notifications(uuid, text, integer) from public, anon, authenticated", MIG)
        self.assertIn("revoke all on function public.atlas_bookings_notification_read(uuid, text, jsonb, boolean) from public, anon, authenticated", MIG)

    def test_lifecycle_gated_on_public_token_not_source(self):
        # #3 origin marker: public_token, not source='web'.
        self.assertIn("if new.public_token is null then return new; end if;", MIG)
        self.assertNotIn("<> 'web' then return new", MIG)

    def test_rejection_vs_cancellation_vs_no_show(self):
        # #4: requested->cancelled is a rejection ('declined'); confirmed->cancelled
        # is a cancellation; no_show never sets an email kind.
        self.assertIn("new.status = 'cancelled' and old.status = 'requested'", MIG)
        self.assertIn("email_kind := 'declined'", MIG)
        self.assertIn("elsif new.status = 'no_show' then", MIG)
        self.assertIn("email_kind := null;", MIG)

    def test_outbox_dedup_key(self):
        # #6: a non-partial unique index + ON CONFLICT DO NOTHING.
        self.assertIn("create unique index if not exists booking_email_outbox_dedupe_idx", MIG)
        self.assertIn("on conflict (dedupe_key) do nothing", MIG)
        self.assertIn("'declined'", MIG)  # the outbox kind check now allows 'declined'

    def test_status_rpc_enforces_db_flag(self):
        # #5a: the status RPC checks public_online_enabled.
        self.assertIn("create or replace function public.atlas_public_booking_status", MIG)
        block = MIG[MIG.index("function public.atlas_public_booking_status"):]
        block = block[: block.index("$function$", block.index("$function$") + 1)]
        self.assertIn("if not s.public_online_enabled then", block)

    def test_edge_committed_rate_rpc(self):
        # #5c: a standalone rate RPC the edge consumes before the work.
        self.assertIn("create or replace function public.atlas_public_booking_rate", MIG)
        self.assertIn("grant execute on function public.atlas_public_booking_rate(text, text) to service_role", MIG)

    def test_idempotency_conflict_refused(self):
        # #5f: a conflicting reuse raises instead of returning the stored token.
        self.assertIn("existing.party_size <> v_party or existing.start_at <> v_start", MIG)
        self.assertIn("That request conflicts with an earlier one.", MIG)

    def test_all_definers_pin_search_path(self):
        self.assertEqual(MIG.count("security definer"), MIG.count("set search_path = ''"))

    def test_replay_gate_runs_the_s109_acceptance(self):
        self.assertIn("scripts/verify_s109_booking_notifications_inbox.sh", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
