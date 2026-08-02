from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "validate_sprint3_private_staging.py"
SPEC = importlib.util.spec_from_file_location("sprint3_validator", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


class Sprint3StagingContractTests(unittest.TestCase):
    def valid_directory(self, root: Path) -> None:
        batches = [
            {
                "batch_key": "sprint3:derived:inventory",
                "entity_scope": "inventory",
                "status": "prepared",
                "source_files": ["inventory.pdf"],
            },
            {
                "batch_key": "sprint3:derived:recipe",
                "entity_scope": "recipe",
                "status": "prepared",
                "source_files": ["recipes.pdf"],
            },
        ]
        inventory = [
            {
                "batch_key": "sprint3:derived:inventory",
                "row_number": 1,
                "source_hash": "a" * 64,
                "normalized_data": {"source_updated_at": "2026-07-19", "quantity": 2},
                "review_status": "pending",
                "proposed_action": "review",
            }
        ]
        entities = [
            {
                "batch_key": "sprint3:derived:recipe",
                "entity_scope": "recipe",
                "row_number": 1,
                "source_hash": "b" * 64,
                "normalized_data": {"name": "Example"},
                "review_status": "pending",
            }
        ]
        reviews = [
            {
                "batch_key": "sprint3:derived:inventory",
                "entity_type": "inventory_item",
                "source_key": "example",
                "severity": "review",
                "issue": "missing_cost",
            }
        ]
        write_jsonl(root / "import_batches.jsonl", batches)
        write_jsonl(root / "import_inventory_rows.jsonl", inventory)
        write_jsonl(root / "import_entity_rows.jsonl", entities)
        write_jsonl(root / "import_review_items.jsonl", reviews)

    def test_valid_review_only_export(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.valid_directory(root)
            report = MODULE.validate_directory(root)
            self.assertEqual(report["status"], "valid")
            self.assertEqual(report["counts"]["historical_july_inventory_rows"], 1)
            self.assertEqual(report["promotion_gate"], "blocked")

    def test_rejects_approved_inventory_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.valid_directory(root)
            rows = [json.loads(line) for line in (root / "import_inventory_rows.jsonl").read_text().splitlines()]
            rows[0]["review_status"] = "approved"
            write_jsonl(root / "import_inventory_rows.jsonl", rows)
            with self.assertRaises(MODULE.ValidationError):
                MODULE.validate_directory(root)

    def test_rejects_orphan_batch_reference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.valid_directory(root)
            rows = [json.loads(line) for line in (root / "import_entity_rows.jsonl").read_text().splitlines()]
            rows[0]["batch_key"] = "missing"
            write_jsonl(root / "import_entity_rows.jsonl", rows)
            with self.assertRaises(MODULE.ValidationError):
                MODULE.validate_directory(root)

    def test_sql_contract_is_private_and_review_first(self) -> None:
        sql = (ROOT / "supabase" / "drafts" / "20260802_sprint3_private_staging.sql").read_text(encoding="utf-8").lower()
        self.assertIn("create schema if not exists atlas_private", sql)
        self.assertIn("revoke all on schema atlas_private from public, anon, authenticated", sql)
        self.assertIn("enable row level security", sql)
        self.assertIn("to service_role", sql)
        self.assertIn("security_invoker = true", sql)
        self.assertNotIn("grant select on all tables in schema atlas_private to authenticated", sql)
        self.assertNotIn("grant all on all tables in schema atlas_private to anon", sql)


if __name__ == "__main__":
    unittest.main()
