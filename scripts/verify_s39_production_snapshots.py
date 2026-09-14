#!/usr/bin/env python3
"""Compare external S39 before/after JSON snapshots without contacting Supabase."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads(
    (ROOT / "docs/release/Atlas_S39_Production_Launch_Manifest.json").read_text(encoding="utf-8")
)


def _last_json(path):
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
    return value.get("s39_snapshot", value)


def verify(before_path, after_path):
    before = _last_json(before_path)
    after = _last_json(after_path)
    if before.get("snapshot_version") != 1 or after.get("snapshot_version") != 1:
        raise AssertionError("Unsupported snapshot version")
    if before.get("protected") != after.get("protected"):
        raise AssertionError("Protected production data fingerprint changed")

    inventory = after["protected"]["inventory_items"]
    if inventory["negative_quantity_count"] != 0:
        raise AssertionError("Negative inventory quantity detected")
    expected_versions = {item["version"] for item in MANIFEST["migration_plan"]}
    if not expected_versions.issubset(set(after.get("migration_versions", []))):
        raise AssertionError("Planned production migration ledger is incomplete")
    if not all(after.get("required_tables", {}).values()):
        raise AssertionError("Required Atlas tables are missing")
    if after.get("public_tables_without_rls") != []:
        raise AssertionError("A public table is missing RLS")
    if not after.get("report_events", {}).get("rls_enabled"):
        raise AssertionError("atlas_private.report_events is not RLS protected")
    hardening = after.get("rls_auto_enable", {})
    if hardening.get("anon_execute") or hardening.get("authenticated_execute"):
        raise AssertionError("Browser roles can execute public.rls_auto_enable()")
    return {
        "passed": True,
        "protected_fingerprint_unchanged": True,
        "planned_migrations_present": len(expected_versions),
        "public_tables_without_rls": 0,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.before, args.after)))

