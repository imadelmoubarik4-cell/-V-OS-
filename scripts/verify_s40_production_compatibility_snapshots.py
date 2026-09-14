#!/usr/bin/env python3
"""Verify S40 protected and adopted-source snapshots without contacting Supabase."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads(
    (ROOT / "docs/release/Atlas_S40_Production_Compatibility_Manifest.json").read_text(encoding="utf-8")
)


def _last_json(path, wrapper=None):
    values = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                values.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    if not values:
        raise ValueError(f"No JSON snapshot found in {path}")
    value = values[-1]
    return value.get(wrapper, value) if wrapper else value


def verify(protected_before_path, protected_after_path, source_before_path, source_after_path):
    protected_before = _last_json(protected_before_path, "s39_snapshot")
    protected_after = _last_json(protected_after_path, "s39_snapshot")
    source_before = _last_json(source_before_path)
    source_after = _last_json(source_after_path)

    if protected_before.get("snapshot_version") != 1 or protected_after.get("snapshot_version") != 1:
        raise AssertionError("Unsupported protected snapshot version")
    if source_before.get("source_contract_snapshot_version") != 1:
        raise AssertionError("Unsupported source-contract snapshot version")
    if source_after.get("source_contract_snapshot_version") != 1:
        raise AssertionError("Unsupported source-contract snapshot version")
    if protected_before.get("protected") != protected_after.get("protected"):
        raise AssertionError("Protected production-shaped fingerprint changed")
    if source_before != source_after:
        raise AssertionError("Adopted onboarding or shift rows changed")
    if source_after["onboarding_tasks"]["count"] != 8:
        raise AssertionError("Synthetic production-shaped onboarding row count changed")

    inventory = protected_after["protected"]["inventory_items"]
    if inventory["negative_quantity_count"] != 0:
        raise AssertionError("Negative inventory quantity detected")

    expected_versions = {
        *MANIFEST["production_checkpoint"]["applied_s39_versions"],
        *(item["version"] for item in MANIFEST["remaining_migration_plan"]),
    }
    actual_versions = set(protected_after.get("migration_versions", []))
    if not expected_versions.issubset(actual_versions):
        raise AssertionError("Revised production migration ledger is incomplete")
    failed_version = MANIFEST["replaced_s39_step"]["version"]
    if failed_version in actual_versions:
        raise AssertionError("Failed S39 migration version must remain absent")
    if not all(protected_after.get("required_tables", {}).values()):
        raise AssertionError("Required Atlas tables are missing")
    if protected_after.get("public_tables_without_rls") != []:
        raise AssertionError("A public table is missing RLS")
    if not protected_after.get("report_events", {}).get("rls_enabled"):
        raise AssertionError("atlas_private.report_events is not RLS protected")

    return {
        "passed": True,
        "protected_fingerprint_unchanged": True,
        "source_contract_fingerprint_unchanged": True,
        "synthetic_onboarding_tasks_preserved": 8,
        "revised_remaining_migrations_present": len(MANIFEST["remaining_migration_plan"]),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("protected_before", type=Path)
    parser.add_argument("protected_after", type=Path)
    parser.add_argument("source_before", type=Path)
    parser.add_argument("source_after", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(
        args.protected_before,
        args.protected_after,
        args.source_before,
        args.source_after,
    )))
