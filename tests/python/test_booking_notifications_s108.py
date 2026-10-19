"""S108 booking notifications + email outbox + hardening — static contract.

Live-DB behaviour is proven by tests/sql/s108_booking_notifications.sql via
scripts/verify_s108_booking_notifications.sh in the replay gate. Structural only.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = (ROOT / "supabase/migrations/20261025090000_s108_booking_notifications.sql").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/migration-replay.yml").read_text(encoding="utf-8")


class S108BookingNotificationsContract(unittest.TestCase):
    def test_email_outbox_is_sealed(self):
        self.assertIn("create table if not exists atlas_private.booking_email_outbox", MIG)
        self.assertIn("alter table atlas_private.booking_email_outbox enable row level security", MIG)
        self.assertIn("revoke all on atlas_private.booking_email_outbox from public, anon, authenticated", MIG)

    def test_outbound_delivery_is_inert(self):
        # Nothing in the migration moves a row out of 'queued'.
        self.assertIn("status text not null default 'queued'", MIG)
        self.assertNotIn("status = 'sent'", MIG)
        self.assertNotIn("update atlas_private.booking_email_outbox set status", MIG)

    def test_sender_is_kanel(self):
        self.assertIn("default 'kanel@kanel.is'", MIG)

    def test_notification_workflow_extended_for_bookings(self):
        self.assertIn("'booking_request'", MIG)
        self.assertIn("route in ('team','shifts','marketing','bookings')", MIG)
        # Alerts target active managers/admins only.
        self.assertIn("where active and role in ('admin','manager')", MIG)

    def test_kanel_reference_prefix(self):
        self.assertIn("create or replace function atlas_private.booking_public_reference", MIG)
        self.assertIn("candidate := 'KA-'", MIG)

    def test_idempotency_is_channel_and_fingerprint_isolated(self):
        self.assertIn("'web:' || coalesce(v_fingerprint, 'anon') || ':' || v_raw_idem", MIG)

    def test_lifecycle_trigger_is_web_only_and_definer(self):
        self.assertIn("create trigger booking_lifecycle_notify_trg", MIG)
        self.assertIn("after insert or update on atlas_private.reservations", MIG)
        self.assertIn("if coalesce(new.source,'') <> 'web' then return new; end if;", MIG)
        self.assertEqual(MIG.count("security definer"), MIG.count("set search_path = ''"))

    def test_replay_gate_runs_the_s108_acceptance(self):
        self.assertIn("scripts/verify_s108_booking_notifications.sh", WORKFLOW)


if __name__ == "__main__":
    unittest.main()
