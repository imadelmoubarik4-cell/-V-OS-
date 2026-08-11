#!/usr/bin/env python3
"""Validate an ignored Sprint 3 private-staging JSONL export.

The validator never connects to Supabase and never prints operational row content.
It reports structural counts and release-blocking safety failures only.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

REQUIRED_FILES = {
    "batches": "import_batches.jsonl",
    "inventory": "import_inventory_rows.jsonl",
    "entities": "import_entity_rows.jsonl",
    "reviews": "import_review_items.jsonl",
}

ALLOWED_BATCH_SCOPES = {
    "inventory", "wine", "recipe", "coffee", "menu", "supplier",
    "invoice", "delivery", "equipment", "purchase",
}
ALLOWED_ENTITY_SCOPES = {
    "recipe", "menu", "supplier", "invoice", "delivery", "equipment", "purchase",
}
BLOCKED_REVIEW_STATUSES = {"approved", "imported"}
SECRET_MARKERS = {
    "service_role", "private_key", "client_secret", "database_password",
    "supabase_service_key", "authorization: bearer",
}


class ValidationError(ValueError):
    """Raised when a private staging export violates the Sprint 3 contract."""


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise ValidationError(f"Missing required file: {path.name}")
    rows: list[dict[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValidationError(f"{path.name}:{line_number}: invalid JSON") from exc
        if not isinstance(value, dict):
            raise ValidationError(f"{path.name}:{line_number}: row must be an object")
        rows.append(value)
    return rows


def serialized_contains_secret(rows: Iterable[dict[str, Any]]) -> bool:
    text = json.dumps(list(rows), ensure_ascii=False, sort_keys=True).lower()
    return any(marker in text for marker in SECRET_MARKERS)


def _require(row: dict[str, Any], keys: set[str], label: str) -> None:
    missing = sorted(key for key in keys if key not in row)
    if missing:
        raise ValidationError(f"{label}: missing fields: {', '.join(missing)}")


def validate_directory(directory: Path) -> dict[str, Any]:
    groups = {
        name: read_jsonl(directory / filename)
        for name, filename in REQUIRED_FILES.items()
    }
    if any(serialized_contains_secret(rows) for rows in groups.values()):
        raise ValidationError("Potential credential material found in staging export")

    batches = groups["batches"]
    inventory = groups["inventory"]
    entities = groups["entities"]
    reviews = groups["reviews"]

    batch_keys: set[str] = set()
    for index, row in enumerate(batches, start=1):
        _require(row, {"batch_key", "entity_scope", "status", "source_files"}, f"batch {index}")
        key = str(row["batch_key"])
        if key in batch_keys:
            raise ValidationError(f"Duplicate batch key: {key}")
        batch_keys.add(key)
        if row["entity_scope"] not in ALLOWED_BATCH_SCOPES:
            raise ValidationError(f"Batch {key}: unsupported scope {row['entity_scope']!r}")
        if row.get("status") in {"approved", "promoted"}:
            raise ValidationError(f"Batch {key}: promotion state is not allowed in staging export")

    historical_july_rows = 0
    entity_counts: Counter[str] = Counter()
    pending_counts: Counter[str] = Counter()

    for index, row in enumerate(inventory, start=1):
        _require(
            row,
            {"batch_key", "row_number", "source_hash", "normalized_data", "review_status", "proposed_action"},
            f"inventory row {index}",
        )
        if row["batch_key"] not in batch_keys:
            raise ValidationError(f"Inventory row {index}: unknown batch key")
        if row["review_status"] in BLOCKED_REVIEW_STATUSES:
            raise ValidationError(f"Inventory row {index}: approved/imported rows are not allowed")
        normalized = row.get("normalized_data") or {}
        source_date = str(normalized.get("source_updated_at") or "")
        if source_date.startswith("2026-07-"):
            historical_july_rows += 1
        entity_counts["inventory"] += 1
        if row["review_status"] == "pending":
            pending_counts["inventory"] += 1

    for index, row in enumerate(entities, start=1):
        _require(
            row,
            {"batch_key", "entity_scope", "row_number", "source_hash", "normalized_data", "review_status"},
            f"entity row {index}",
        )
        if row["batch_key"] not in batch_keys:
            raise ValidationError(f"Entity row {index}: unknown batch key")
        scope = row["entity_scope"]
        if scope not in ALLOWED_ENTITY_SCOPES:
            raise ValidationError(f"Entity row {index}: unsupported scope {scope!r}")
        if row["review_status"] in BLOCKED_REVIEW_STATUSES:
            raise ValidationError(f"Entity row {index}: approved/imported rows are not allowed")
        entity_counts[scope] += 1
        if row["review_status"] == "pending":
            pending_counts[scope] += 1

    for index, row in enumerate(reviews, start=1):
        _require(row, {"batch_key", "entity_type", "source_key", "severity", "issue"}, f"review row {index}")
        if row["batch_key"] not in batch_keys:
            raise ValidationError(f"Review row {index}: unknown batch key")

    return {
        "status": "valid",
        "counts": {
            "batches": len(batches),
            "inventory_rows": len(inventory),
            "entity_rows": len(entities),
            "review_items": len(reviews),
            "historical_july_inventory_rows": historical_july_rows,
        },
        "entity_counts": dict(sorted(entity_counts.items())),
        "pending_counts": dict(sorted(pending_counts.items())),
        "promotion_gate": "blocked",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path, help="Directory containing the four ignored JSONL files")
    parser.add_argument("--output", type=Path, help="Optional public-safe validation report path")
    args = parser.parse_args()
    report = validate_directory(args.directory)
    payload = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
