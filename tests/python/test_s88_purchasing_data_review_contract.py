from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PURCHASING = (ROOT / "supabase/migrations/20260926093000_s88_purchase_order_receiving_approval.sql").read_text()
DATA_REVIEW = (ROOT / "supabase/migrations/20260926094000_s88_data_review_and_par_levels.sql").read_text()
RUNNER = ROOT / "scripts/verify_s88_purchasing_previews.sh"
WORKFLOW = (ROOT / ".github/workflows/migration-replay.yml").read_text()
GATE = (ROOT / "scripts/verify_phase1_security_gate.sql").read_text()

BROWSER_RPCS = {
    "purchase_order_command_v2": PURCHASING,
    "purchase_order_policy": PURCHASING,
    "purchase_order_detail": PURCHASING,
    "data_review_summary": DATA_REVIEW,
    "data_review_rows": DATA_REVIEW,
    "par_level_evidence": DATA_REVIEW,
    "apply_par_levels": DATA_REVIEW,
}


def body(sql, name):
    match = re.search(rf"create or replace function private\.{name}\(.*?\$function\$(.*?)\$function\$;", sql, re.S)
    assert match, name
    return match.group(0)


class S88PurchasingDataReviewContractTests(unittest.TestCase):
    def test_every_browser_rpc_is_a_manager_gated_definer_behind_an_invoker_wrapper(self):
        for name, sql in BROWSER_RPCS.items():
            definition = body(sql, name)
            self.assertIn("security definer", definition, name)
            self.assertIn("set search_path = ''", definition, name)
            self.assertIn("auth.uid() is null or not private.is_manager_or_admin()", definition, name)
            self.assertIn("errcode='42501'", definition, name)
            self.assertRegex(sql, rf"create or replace function public\.atlas_{name}\([\s\S]*?security invoker set search_path = ''")
            self.assertRegex(sql, rf"revoke all on function public\.atlas_{name}\([^)]*\) from public, ?anon;")
            self.assertIn(f"public.atlas_{name}(", GATE)

    def test_stock_is_posted_only_through_the_canonical_adjustment(self):
        self.assertIn("perform public.adjust_inventory(item.id,qty,'restock',price,result.supplier_id,", PURCHASING)
        self.assertNotRegex(PURCHASING, r"insert into public\.inventory_movements")
        self.assertNotRegex(PURCHASING, r"set\s+quantity\s*=")
        self.assertNotRegex(DATA_REVIEW, r"set\s+quantity\s*=|insert into public\.inventory_movements|adjust_inventory")

    def test_v1_command_keeps_its_signature_and_delegates_to_v2(self):
        v1 = body(PURCHASING, "purchase_order_command")
        self.assertIn("p_action not in ('create','update','place','receive','cancel')", v1)
        self.assertIn("private.purchase_order_command_v2(", v1)
        self.assertIn(
            "grant execute on function private.purchase_order_command(uuid,text,integer,uuid,jsonb,text) to authenticated",
            PURCHASING,
        )

    def test_owner_decision_defaults_reproduce_v1(self):
        policy = body(PURCHASING, "purchase_order_policy_values")
        self.assertIn("'approval_required', coalesce(v->'purchase_approval_required' = 'true'::jsonb, false)", policy)
        self.assertIn("tolerance numeric := 0", policy)
        self.assertIn("'short_close_enabled', coalesce(v->'purchase_short_close_enabled' = 'true'::jsonb, false)", policy)
        self.assertIn("else 'update_item_cost' end", policy)
        self.assertIn("'staff_receiving_enabled', false", policy)

    def test_par_evidence_rule_is_explicit_and_never_writes(self):
        evidence = body(DATA_REVIEW, "par_level_evidence")
        for fragment in (
            "when n < 3 then 'insufficient_observations'",
            "when span < 14 then 'span_too_short'",
            "when negative then 'inconsistent_evidence'",
            "'saved', false",
        ):
            self.assertIn(fragment, evidence)
        self.assertNotRegex(evidence, r"\bupdate\b|\binsert\b")

    def test_runner_is_loopback_only_and_wired_into_ci(self):
        self.assertIn("bash scripts/verify_s88_purchasing_previews.sh", WORKFLOW)
        runner = RUNNER.read_text()
        for script in ("verify_s88_purchasing_preview.sql", "verify_s88_data_review_preview.sql"):
            self.assertIn(script, runner)
            self.assertTrue((ROOT / "scripts" / script).exists())
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "psql-called"
            psql = Path(directory) / "psql"
            psql.write_text(f'#!/bin/sh\ntouch "{marker}"\n')
            psql.chmod(0o755)
            result = subprocess.run(
                ["bash", str(RUNNER)],
                capture_output=True,
                text=True,
                env={**os.environ, "PGHOST": "remote.invalid", "PATH": directory + os.pathsep + os.environ["PATH"]},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Refusing non-loopback", result.stderr)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
