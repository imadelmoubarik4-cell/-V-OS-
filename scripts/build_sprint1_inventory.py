#!/usr/bin/env python3
"""Build Atlas Sprint 1 private inventory and recipe-link review artifacts.

The worker is intentionally offline: it reads local approved sources, preserves raw
evidence, and writes files only. It never connects to Supabase and never invents
missing costs, suppliers, quantities, or package sizes.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import pdfplumber


EXTRACTOR_VERSION = "atlas-sprint1-pdf/0.8.0"
NORMALIZER_VERSION = "atlas-inventory-normalizer/0.8.0"

CATEGORY_ALIASES = {
    "liquen": "Liqueur",
    "liqueurs": "Liqueur",
    "syrup": "Syrups",
    "syrups": "Syrups",
    "beer cider": "Beer & Cider",
    "beer cider keg": "Beer & Cider (Keg)",
    "soda mixer": "Soda & Mixer",
    "vermouth aperitivo": "Vermouth / Aperitivo",
    "tequila mezcal": "Tequila / Mezcal",
    "whiskey cognac": "Whiskey / Cognac",
    "puree fresh": "Purée & Fresh",
    "puree and fresh": "Purée & Fresh",
    "leaves fresh": "Fresh Herbs",
    "fresh fruit": "Fresh Fruit",
}

NAME_CORRECTIONS = {
    "Hennessy VOSP": "Hennessy VSOP",
    "Decaff": "Decaf Coffee",
    "Takeawey Big cup": "Takeaway Large Cup",
    "Homie Pink zero cafeinne": "Homie Pink Zero Caffeine",
}

CATEGORY_OVERRIDES = {
    "Demerara Raw Sugar": "Other",
    "Coffee Beans": "Coffee & Tea",
    "Decaf Coffee": "Coffee & Tea",
    "Cacao": "Coffee & Tea",
    "Small napkins": "Consumables",
    "Takeaway Large Cup": "Consumables",
    "Small straws": "Consumables",
    "Big straws": "Consumables",
}

GENERIC_RECIPE_NAMES = {
    "bourbon",
    "gin",
    "gin house",
    "prosecco",
    "rye whiskey",
    "sparkling wine house",
    "sparkling wine",
    "sweet vermouth",
    "tequila",
    "vodka",
    "vodka house",
    "white rum",
}

GLASS_ALIASES = {
    "patron small bottle": "Patron Small Bottle",
    "rocks": "Rocks Glass",
    "rocks!": "Rocks Glass",
    "coupe": "Coupe Glass",
    "low ball": "Lowball Glass",
    "highball": "Highball Glass",
    "hurricane": "Hurricane Glass",
    "wine": "Wine Glass",
    "wine glass": "Wine Glass",
    "irish coffee glass": "Irish Coffee Glass",
    "heatproof mug": "Heatproof Mug",
    "nick nora": "Nick & Nora Glass",
    "nick and nora": "Nick & Nora Glass",
    "mule mug": "Mule Mug",
}

COFFEE_RECIPES = {
    "Espresso": ["Coffee Beans"],
    "Double Espresso": ["Coffee Beans"],
    "Americano": ["Coffee Beans", "Hot Water"],
    "Cappuccino": ["Coffee Beans", "Barista Regular Milk"],
    "Latte": ["Coffee Beans", "Barista Regular Milk"],
    "Flat White": ["Coffee Beans", "Barista Regular Milk"],
    "Cortado": ["Coffee Beans", "Barista Regular Milk"],
    "Vanilla Latte": ["Coffee Beans", "Barista Regular Milk", "Vanilla syrup 20 ml"],
    "Caramel Latte": ["Coffee Beans", "Barista Regular Milk", "Caramel syrup 20 ml"],
    "Mocha": ["Coffee Beans", "Barista Regular Milk", "Chocolate sauce 20 ml"],
    "Iced Americano": ["Coffee Beans", "Hot Water", "Ice Cubes"],
    "Iced Latte": ["Coffee Beans", "Barista Regular Milk", "Ice Cubes"],
    "Iced Vanilla Latte": ["Coffee Beans", "Barista Regular Milk", "Vanilla syrup 20 ml", "Ice Cubes"],
    "Hot Chocolate": ["Barista Regular Milk", "Chocolate Powder", "Cream"],
    "Oat Matcha Latte": ["Oat milk", "Matcha Mix"],
    "Tea Selection": ["Tea Selection", "Hot Water"],
}

MASTER_FIELDS = [
    "item_id",
    "name",
    "canonical_key",
    "category",
    "subcategory",
    "unit",
    "package_quantity",
    "package_unit",
    "quantity",
    "quantity_raw",
    "supplier",
    "cost_price",
    "discount_percent",
    "net_cost",
    "true_cost_bottle",
    "true_cost_glass",
    "recommended_glass_price",
    "recommended_bottle_price",
    "sell_price",
    "source_type",
    "source_files",
    "source_pages",
    "source_updated_at",
    "source_confidence",
    "source_hash",
    "needs_review",
    "issues",
    "notes",
]

RECIPE_LINK_FIELDS = [
    "recipe_name",
    "recipe_source",
    "ingredient_raw",
    "ingredient_name",
    "quantity",
    "unit",
    "role",
    "matched_item_id",
    "matched_item_name",
    "matched_canonical_key",
    "match_strategy",
    "status",
    "issues",
]


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\u2018", "'").replace("\u2019", "'").replace("\u2032", "'").replace("\u2013", "-").replace("\u2014", "-")).strip()


def canonical_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = text.lower().replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


def stable_id(value: str) -> str:
    return "atlas-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def object_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalize_category(value: Any) -> str | None:
    raw = clean_text(value)
    if not raw:
        return None
    return CATEGORY_ALIASES.get(canonical_text(raw), raw)


@dataclass(frozen=True)
class ParsedValue:
    value: float | None
    issue: str | None = None


def parse_number(value: Any) -> ParsedValue:
    if value is None or value == "":
        return ParsedValue(None)
    if isinstance(value, (int, float)):
        return ParsedValue(float(value))
    raw = clean_text(value)
    match = re.search(r"-?\d+(?:[.,]\d+)?", raw)
    if not match:
        return ParsedValue(None, "unparsed_number")
    parsed = float(match.group(0).replace(",", "."))
    remainder = (raw[: match.start()] + raw[match.end() :]).strip()
    return ParsedValue(parsed, f"numeric_annotation:{remainder}" if remainder else None)


def parse_money(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = re.sub(r"(?i)(isk|kr\.?)", "", clean_text(value)).replace(" ", "")
    if not raw:
        return None
    if re.fullmatch(r"[+-]?\d{1,3}(?:[.,]\d{3})+", raw):
        raw = re.sub(r"[.,]", "", raw)
    elif "," in raw and "." in raw:
        decimal = max(raw.rfind(","), raw.rfind("."))
        raw = re.sub(r"[.,]", "", raw[:decimal]) + "." + raw[decimal + 1 :]
    else:
        raw = raw.replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def normalize_unit(value: Any) -> tuple[str | None, float | None, str | None]:
    raw = clean_text(value)
    if not raw:
        return None, None, None
    key = canonical_text(raw)
    match = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*(ml|l|cl|kg|g|gr)(?:\s+(.*))?", key)
    if not match:
        return raw.lower() if key in {"box", "pack", "can", "kg", "unit", "each", "bottle", "roll"} else raw, None, None
    quantity = float(match.group(1).replace(",", "."))
    unit = "g" if match.group(2) == "gr" else match.group(2)
    if unit == "l":
        quantity *= 1000
        unit = "ml"
    elif unit == "cl":
        quantity *= 10
        unit = "ml"
    elif unit == "kg":
        quantity *= 1000
        unit = "g"
    container = clean_text(match.group(3))
    number = str(int(quantity)) if quantity.is_integer() else f"{quantity:g}"
    label = f"{number}{unit}" + (f" {container}" if container else "")
    return label, quantity, unit


def parse_source_date(value: Any) -> str | None:
    match = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b", clean_text(value))
    if not match:
        return None
    day, month, year = map(int, match.groups())
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None


def make_record(**values: Any) -> dict[str, Any]:
    record = {
        "name": "",
        "canonical_name": "",
        "category": None,
        "subcategory": None,
        "unit": None,
        "package_quantity": None,
        "package_unit": None,
        "quantity": None,
        "quantity_raw": None,
        "supplier": None,
        "cost_price": None,
        "discount_percent": None,
        "net_cost": None,
        "true_cost_bottle": None,
        "true_cost_glass": None,
        "minimum_glass_price": None,
        "recommended_glass_price": None,
        "recommended_bottle_price": None,
        "sell_price": None,
        "service": None,
        "source_type": "unknown",
        "source_file": None,
        "source_page": None,
        "source_row": None,
        "source_updated_at": None,
        "source_confidence": 100,
        "source_hash": None,
        "needs_review": False,
        "issues": [],
        "notes": [],
        "raw_data": {},
    }
    record.update(values)
    record["name"] = clean_text(record["name"])
    record["canonical_name"] = canonical_text(record.get("canonical_name") or record["name"])
    return record


def extract_inventory_pdf(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current_category: str | None = None
    source_file_hash = file_sha256(path)
    with pdfplumber.open(path) as document:
        for page_number, page in enumerate(document.pages, start=1):
            table = page.extract_table()
            if not table:
                continue
            for table_row, raw in enumerate(table[1:], start=2):
                cells = [(cell or "").strip() for cell in raw]
                if len(cells) < 5:
                    cells.extend([""] * (5 - len(cells)))
                raw_category, raw_name, raw_unit, raw_quantity, raw_updated = cells[:5]
                if raw_category:
                    current_category = normalize_category(raw_category)
                if not clean_text(raw_name):
                    continue

                issues: list[str] = []
                source_name = clean_text(raw_name)
                name = NAME_CORRECTIONS.get(source_name, source_name)
                if name != source_name:
                    issues.append(f"source_name_corrected:{source_name}")
                category = CATEGORY_OVERRIDES.get(name, current_category)
                if category != current_category:
                    issues.append(f"category_reclassified:{current_category or 'missing'}")
                unit, package_quantity, package_unit = normalize_unit(raw_unit)
                quantity = parse_number(raw_quantity)
                if quantity.issue:
                    issues.append(quantity.issue)
                if not unit:
                    issues.append("missing_package_or_unit")
                source_updated_at = parse_source_date(raw_updated)
                if raw_updated and not source_updated_at:
                    issues.append("unparsed_source_date")

                raw_data = {
                    "category": clean_text(raw_category),
                    "item": source_name,
                    "unit": clean_text(raw_unit),
                    "qty_in_stock": clean_text(raw_quantity),
                    "last_updated": clean_text(raw_updated),
                }
                records.append(make_record(
                    name=name,
                    category=category or "Other",
                    unit=unit,
                    package_quantity=package_quantity,
                    package_unit=package_unit,
                    quantity=quantity.value,
                    quantity_raw=clean_text(raw_quantity),
                    source_type="inventory_pdf",
                    source_file=path.name,
                    source_page=page_number,
                    source_row=table_row,
                    source_updated_at=source_updated_at,
                    source_confidence=85 if issues else 100,
                    source_hash=object_sha256({"file": source_file_hash, "page": page_number, "row": table_row, "raw": raw_data}),
                    needs_review=bool(issues),
                    issues=issues,
                    notes=[f"Source category: {current_category or 'blank'}"],
                    raw_data=raw_data,
                ))
    return records


def _crop_text(page: Any, bounds: tuple[float, float, float, float]) -> str:
    return clean_text(page.crop(bounds).extract_text(x_tolerance=1, y_tolerance=2) or "")


def _wine_row_boundaries(page: Any) -> list[float]:
    tops = sorted({round(line["top"], 2) for line in page.lines if abs(line["y0"] - line["y1"]) < 0.1 and 90 <= line["top"] <= 731})
    if len(tops) != 30:
        raise ValueError(f"Wine pricing layout changed: expected 30 row boundaries, found {len(tops)}")
    return tops


def _money_tokens(value: str) -> list[float]:
    return [float(token.replace(",", "")) for token in re.findall(r"\d[\d,]*", value)]


def _repair_wine_name(value: str) -> tuple[str, str | None]:
    repairs = {
        "G.H. Mumm Cordon Rouge [Champagne": "G.H. Mumm Cordon Rouge [Champagne]",
        "Campo Viejo Gran Reserva [Gran Reser": "Campo Viejo Gran Reserva [Gran Reserva]",
        "Tommasi Amarone della Valpolicella [Sig": "Tommasi Amarone della Valpolicella [Signature]",
    }
    for truncated, repaired in repairs.items():
        if value.startswith(truncated):
            return repaired, f"layout_name_repaired:{value}"
    return value, None


def extract_wine_pricing_pdf(path: Path, supplier: str = "") -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    source_file_hash = file_sha256(path)
    with pdfplumber.open(path) as document:
        if len(document.pages) < 3:
            raise ValueError("Wine pricing PDF must contain all three calculator pages")
        first, second, third = document.pages[:3]
        boundaries = _wine_row_boundaries(second)
        for index in range(29):
            top, bottom = boundaries[index], boundaries[index + 1]
            row_number = _crop_text(first, (0, top, 26, bottom)) or None
            raw_category = _crop_text(first, (26, top, 78, bottom))
            raw_name = _crop_text(first, (78, top, 267, bottom))
            name, repair_issue = _repair_wine_name(raw_name)
            invoice_text = _crop_text(first, (425, top, 477, bottom))
            price_text = _crop_text(first, (500, top, 545, bottom))
            page_two_text = _crop_text(second, (0, top, 595, bottom))
            page_three_text = _crop_text(third, (0, top, 595, bottom))

            issues: list[str] = ["bottle_size_not_stated"]
            if repair_issue:
                issues.append(repair_issue)
            if not row_number:
                issues.append("missing_wine_index")
            estimated = "*est" in invoice_text.lower()
            if estimated:
                issues.append("estimated_supplier_price_requires_confirmation")

            price_matches = re.findall(r"\d{1,3},\d{3}", price_text)
            list_price = parse_money(price_matches[-1]) if price_matches else None
            if index == 1:
                list_price = 2999.0
                issues.append("overlapping_pdf_text_price_verified_from_visible_cell")
            elif index == 28:
                list_price = 5799.0
                issues.append("overlapping_pdf_text_price_verified_from_visible_cell")
            if list_price is None:
                issues.append("missing_list_price")

            formula_values = _money_tokens(page_two_text)
            if len(formula_values) >= 9:
                net_cost = formula_values[0]
                true_cost_bottle = formula_values[6]
                true_cost_glass = formula_values[7]
                minimum_glass = formula_values[8]
            elif len(formula_values) == 3:
                net_cost = None
                true_cost_bottle, true_cost_glass, minimum_glass = formula_values
                issues.append("missing_net_cost_formula")
            else:
                net_cost = true_cost_bottle = true_cost_glass = minimum_glass = None
                issues.append("unparsed_cost_formula_row")

            recommendation_values = _money_tokens(page_three_text)
            recommended_glass = recommendation_values[0] if len(recommendation_values) >= 2 else None
            recommended_bottle = recommendation_values[1] if len(recommendation_values) >= 2 else None
            service = "Glass + Bottle" if "Glass + Bottle" in page_three_text else "Bottle only" if "Bottle only" in page_three_text else None
            if service is None:
                issues.append("missing_service_mode")

            category_key = canonical_text(raw_category)
            category = "Sparkling" if category_key == "sparkling" else "Wine"
            subcategory = None if category == "Sparkling" else raw_category.title() if raw_category else None
            raw_data = {
                "index": row_number,
                "category": raw_category,
                "name": raw_name,
                "invoice_cell": invoice_text,
                "list_price_cell": price_text,
                "cost_formula_row": page_two_text,
                "recommendation_row": page_three_text,
            }
            records.append(make_record(
                name=name,
                category=category,
                subcategory=subcategory,
                unit="bottle",
                supplier=clean_text(supplier) or None,
                cost_price=list_price,
                net_cost=net_cost,
                true_cost_bottle=true_cost_bottle,
                true_cost_glass=true_cost_glass,
                minimum_glass_price=minimum_glass,
                recommended_glass_price=recommended_glass,
                recommended_bottle_price=recommended_bottle,
                sell_price=recommended_bottle,
                service=service,
                source_type="wine_pricing_pdf",
                source_file=path.name,
                source_page="1-3",
                source_row=index + 1,
                source_confidence=70 if estimated or not row_number else 90,
                source_hash=object_sha256({"file": source_file_hash, "row": index + 1, "raw": raw_data}),
                needs_review=True,
                issues=issues,
                notes=["Supplier attribution is supplied privately at build time.", "Recommended prices are proposals until reconciled with the corrected public wine menu."],
                raw_data=raw_data,
            ))
    return records


def load_aliases(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return [{key: clean_text(value) for key, value in row.items()} for row in csv.DictReader(handle)]


def alias_lookup(rows: Sequence[dict[str, str]], allowed_scopes: set[str]) -> dict[str, str]:
    return {
        canonical_text(row["alias"]): row["canonical_name"]
        for row in rows
        if row.get("scope", "global") in allowed_scopes
    }


def load_extensions(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    source_file_hash = file_sha256(path)
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row_number, row in enumerate(csv.DictReader(handle), start=2):
            unit, package_quantity, package_unit = normalize_unit(row.get("unit"))
            issues: list[str] = []
            requested_review = canonical_text(row.get("needs_review")) in {"true", "yes", "1"}
            if requested_review:
                issues.append("approved_candidate_requires_operational_review")
            if not unit:
                issues.append("missing_package_or_unit")
            raw_data = dict(row)
            records.append(make_record(
                name=row.get("name"),
                category=normalize_category(row.get("category")) or "Other",
                subcategory=clean_text(row.get("subcategory")) or None,
                unit=unit,
                package_quantity=package_quantity,
                package_unit=package_unit,
                supplier=clean_text(row.get("supplier")) or None,
                source_type="approved_catalogue_extension",
                source_file=clean_text(row.get("source_file")) or path.name,
                source_page=clean_text(row.get("source_page")) or None,
                source_row=row_number,
                source_confidence=int(row.get("confidence") or 80),
                source_hash=object_sha256({"file": source_file_hash, "row": row_number, "raw": raw_data}),
                needs_review=bool(issues),
                issues=issues,
                notes=[clean_text(row.get("source_note"))] if clean_text(row.get("source_note")) else [],
                raw_data=raw_data,
            ))
    return records


def load_known_costs(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.exists():
        return []
    costs: list[dict[str, Any]] = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            unit, _, _ = normalize_unit(row.get("unit"))
            cost_price = parse_money(row.get("cost_price"))
            discount = parse_money(row.get("discount_percent"))
            net_cost = parse_money(row.get("net_cost"))
            if net_cost is None and cost_price is not None:
                net_cost = round(cost_price * (1 - (discount or 0) / 100), 2)
            costs.append({
                "name": clean_text(row.get("name")),
                "canonical_name": canonical_text(row.get("name")),
                "unit": unit,
                "supplier": clean_text(row.get("supplier")) or None,
                "cost_price": cost_price,
                "discount_percent": discount,
                "net_cost": net_cost,
                "sell_price": parse_money(row.get("sell_price")),
                "source_note": clean_text(row.get("source_note")),
            })
    return costs


def units_compatible(left: str | None, right: str | None) -> bool:
    if left == right:
        return True
    generic = {None, "bottle", "unit", "each"}
    return left in generic or right in generic


def merge_records(records: Sequence[dict[str, Any]], aliases: Sequence[dict[str, str]], costs: Sequence[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    global_aliases = alias_lookup(aliases, {"global"})
    merged: list[dict[str, Any]] = []
    duplicates_collapsed = 0

    for source in records:
        record = deepcopy(source)
        canonical = global_aliases.get(record["canonical_name"])
        if canonical:
            record["notes"].append(f"Global alias resolved from {record['name']} to {canonical}.")
            record["canonical_name"] = canonical_text(canonical)
        candidates = [item for item in merged if item["canonical_name"] == record["canonical_name"] and units_compatible(item.get("unit"), record.get("unit"))]
        if len(candidates) != 1:
            record["sources"] = [source]
            merged.append(record)
            continue

        target = candidates[0]
        duplicates_collapsed += 1
        target["sources"].append(source)
        target["source_confidence"] = min(target["source_confidence"], record["source_confidence"])
        target["notes"].extend(note for note in record["notes"] if note not in target["notes"])
        target["issues"].extend(issue for issue in record["issues"] if issue not in target["issues"])
        if target.get("unit") in {None, "bottle", "unit", "each"} and record.get("unit") not in {None, "bottle", "unit", "each"}:
            target["unit"] = record["unit"]
            target["package_quantity"] = record["package_quantity"]
            target["package_unit"] = record["package_unit"]
        for field in ("supplier", "cost_price", "discount_percent", "net_cost", "true_cost_bottle", "true_cost_glass", "minimum_glass_price", "recommended_glass_price", "recommended_bottle_price", "sell_price", "service"):
            if target.get(field) is None and record.get(field) is not None:
                target[field] = record[field]
        if target.get("quantity") is None:
            target["quantity"] = record.get("quantity")
            target["quantity_raw"] = record.get("quantity_raw")
        elif record.get("quantity") is not None and target["quantity"] != record["quantity"]:
            target["quantity"] = None
            target["quantity_raw"] = f"conflict:{target.get('quantity_raw')}|{record.get('quantity_raw')}"
            if "conflicting_source_quantities" not in target["issues"]:
                target["issues"].append("conflicting_source_quantities")
        target["needs_review"] = target["needs_review"] or record["needs_review"]

    for item in merged:
        matching_costs = [cost for cost in costs if cost["canonical_name"] == item["canonical_name"] and units_compatible(cost.get("unit"), item.get("unit"))]
        if len(matching_costs) == 1:
            cost = matching_costs[0]
            for field in ("supplier", "cost_price", "discount_percent", "net_cost", "sell_price"):
                if cost.get(field) is not None:
                    item[field] = cost[field]
            if cost.get("source_note"):
                item["notes"].append(cost["source_note"])
        elif len(matching_costs) > 1:
            item["issues"].append("multiple_known_cost_rows")

        if item.get("cost_price") is None and item.get("net_cost") is None:
            item["issues"].append("missing_cost")
        if not item.get("supplier"):
            item["issues"].append("missing_supplier")
        if not item.get("unit") or item.get("unit") == "bottle":
            item["issues"].append("missing_verified_package_size")
        item["issues"] = list(dict.fromkeys(item["issues"]))
        item["needs_review"] = bool(item["issues"])
        item["canonical_key"] = item["canonical_name"] + (f"|{canonical_text(item.get('unit'))}" if item.get("unit") else "")
        item["item_id"] = stable_id(item["canonical_key"])
        item["source_files"] = sorted({clean_text(source.get("source_file")) for source in item["sources"] if source.get("source_file")})
        item["source_pages"] = sorted({str(source.get("source_page")) for source in item["sources"] if source.get("source_page") is not None})
        item["source_type"] = ";".join(sorted({source.get("source_type", "unknown") for source in item["sources"]}))
        item["source_hash"] = object_sha256(sorted(source.get("source_hash") for source in item["sources"] if source.get("source_hash")))
        source_dates = [source.get("source_updated_at") for source in item["sources"] if source.get("source_updated_at")]
        item["source_updated_at"] = max(source_dates) if source_dates else None
        item["notes"] = list(dict.fromkeys(filter(None, item["notes"])))

    merged.sort(key=lambda item: (canonical_text(item.get("category")), item["canonical_name"], canonical_text(item.get("unit"))))
    return merged, duplicates_collapsed


def _recipe_blocks(path: Path) -> list[dict[str, str]]:
    with pdfplumber.open(path) as document:
        pages = [page.extract_text() or "" for page in document.pages]
    text = "\n".join(pages)
    text = re.sub(r"(?m)^\s*[^A-Za-z0-9À-ÖØ-öø-ÿ]*(?=[A-ZÀ-ÖØ-Þ])", "", text)
    pattern = re.compile(r"(?m)^(?P<name>[A-ZÀ-ÖØ-Þ0-9][A-ZÀ-ÖØ-Þ0-9ÆŒ &'()/%\-]+)\nGlass:\s*(?P<glass>[^\n]+)")
    matches = list(pattern.finditer(text))
    blocks: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        glass = re.split(r"\s*(?:\||·)\s*Ice:\s*", match.group("glass"), maxsplit=1)[0]
        blocks.append({
            "name": clean_text(match.group("name")).title(),
            "glass": clean_text(glass),
            "body": text[match.end() : end],
        })
    return blocks


def _split_recipe_values(value: str) -> list[str]:
    normalized = re.sub(r"\s+[–—]\s+", " · ", value)
    normalized = re.sub(r"\n(?=Top(?:\s+with)?\b)", " · ", normalized, flags=re.IGNORECASE)
    normalized = normalized.replace("\n", " ")
    normalized = re.sub(
        r"(?<=[A-Za-zÀ-ÖØ-öø-ÿ])\s+(\d+(?:[.,]\d+)?\s*(?:ml|cl|l|tsp|dashes?))\s+(?=[A-ZÀ-ÖØ-Þ])",
        r" \1 · ",
        normalized,
    )
    return [clean_text(part).strip(" .") for part in re.split(r"\s*[·•]\s*", normalized) if clean_text(part).strip(" .")]


def parse_ingredient(value: str) -> tuple[str, str | None, str | None, list[str]]:
    raw = clean_text(value).strip(" .")
    issues: list[str] = []
    text = raw
    if re.match(r"(?i)^top\b", text):
        text = re.sub(r"(?i)^top(?:\s+with)?\s*", "", text)
        issues.append("open_ended_top_quantity")
    text = re.sub(r"(?i)^with\s+", "", text)

    quantity: str | None = None
    unit: str | None = None
    start = re.match(r"(?i)^(\d+(?:[.,]\d+)?(?:\s*[-]\s*\d+)?)\s*(ml|cl|l|tsp|dashes?|cans?|bar spoons?|small pieces?)?(?:\s+of)?\s+(.+)$", text)
    if start:
        quantity = start.group(1).replace(" ", "")
        unit = clean_text(start.group(2)).lower() or None
        text = start.group(3)
    else:
        end = re.match(r"(?i)^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(ml|cl|l|tsp|dashes?)(?:\s+(\(.*\)))?$", text)
        if end:
            text, quantity, unit = end.group(1), end.group(2), end.group(3).lower()
            if end.group(4):
                issues.append("ingredient_option_requires_review")

    text = re.sub(r"(?i)^of\s+", "", clean_text(text))
    text = re.sub(r"(?i)^the\s+", "", text)
    text = re.sub(r"(?i)^shakr\s+", "Shakr ", text)
    if "brown sugar" in canonical_text(text):
        text = "Brown Sugar"
    if canonical_text(text) == "light cream shaked hard":
        text = "Cream"
    if re.search(r"(?i)\bor\b|\boptional\b", text):
        issues.append("ingredient_option_requires_review")
    return clean_text(text), quantity, unit, issues


def extract_recipe_rows(paths: Sequence[tuple[Path, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path, source_label in paths:
        for block in _recipe_blocks(path):
            recipe_name = block["name"]
            body = block["body"]
            ingredient_match = re.search(r"(?is)Ingredients:?\s*(.+?)(?=\nMethod\b|\nSide:|\nGarnish:|\Z)", body)
            if ingredient_match:
                for raw in _split_recipe_values(ingredient_match.group(1)):
                    rows.append({"recipe_name": recipe_name, "recipe_source": source_label, "raw": raw, "role": "ingredient"})
            side_match = re.search(r"(?im)^Side:\s*(.+)$", body)
            if side_match:
                rows.append({"recipe_name": recipe_name, "recipe_source": source_label, "raw": side_match.group(1), "role": "side"})
            garnish_match = re.search(r"(?im)^Garnish:\s*(.+)$", body)
            if garnish_match:
                for garnish in re.split(r"\s*&\s*", garnish_match.group(1)):
                    rows.append({"recipe_name": recipe_name, "recipe_source": source_label, "raw": garnish, "role": "garnish"})
            glasses = re.split(r"\s*/\s*", block["glass"])
            for glass in glasses:
                if clean_text(glass):
                    rows.append({"recipe_name": recipe_name, "recipe_source": source_label, "raw": glass, "role": "glassware"})
    return rows


def append_coffee_recipe_rows(rows: list[dict[str, Any]], path: Path) -> None:
    with pdfplumber.open(path) as document:
        text = "\n".join(page.extract_text() or "" for page in document.pages)
    for recipe, ingredients in COFFEE_RECIPES.items():
        if recipe.lower() not in text.lower():
            continue
        for ingredient in ingredients:
            rows.append({"recipe_name": recipe, "recipe_source": "Coffee Program", "raw": ingredient, "role": "ingredient"})


def link_recipe_rows(rows: Sequence[dict[str, Any]], master: Sequence[dict[str, Any]], aliases: Sequence[dict[str, str]]) -> list[dict[str, Any]]:
    all_aliases = alias_lookup(aliases, {"global", "recipe"})
    liquid_aliases = alias_lookup(aliases, {"global", "recipe", "recipe_liquid"})
    garnish_aliases = alias_lookup(aliases, {"global", "recipe", "garnish"})
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in master:
        by_name[item["canonical_name"]].append(item)

    linked: list[dict[str, Any]] = []
    for row in rows:
        raw = clean_text(row["raw"])
        role = row["role"]
        ingredient_name, quantity, unit, issues = parse_ingredient(raw)
        strategy = "none"
        candidate_name = ingredient_name
        if role == "glassware":
            glass_key = canonical_text(ingredient_name.replace("&", "and"))
            candidate_name = GLASS_ALIASES.get(glass_key, ingredient_name)
            strategy = "glassware_alias" if candidate_name != ingredient_name else "exact_name"
        else:
            lookup = garnish_aliases if role == "garnish" else liquid_aliases if unit in {"ml", "cl", "l"} else all_aliases
            alias = lookup.get(canonical_text(ingredient_name))
            if alias:
                candidate_name = alias
                strategy = "reviewed_alias"

        key = canonical_text(candidate_name)
        candidates = by_name.get(key, [])
        matched: dict[str, Any] | None = None
        if canonical_text(ingredient_name) in GENERIC_RECIPE_NAMES and strategy == "none":
            issues.append("generic_ingredient_requires_recipe_house_mapping")
        elif len(candidates) == 1:
            matched = candidates[0]
            strategy = strategy if strategy != "none" else "exact_name"
        elif len(candidates) > 1:
            issues.append("multiple_package_candidates")
        else:
            issues.append("no_inventory_match")

        status = "linked" if matched and not issues else "review"
        linked.append({
            "recipe_name": row["recipe_name"],
            "recipe_source": row["recipe_source"],
            "ingredient_raw": raw,
            "ingredient_name": ingredient_name,
            "quantity": quantity,
            "unit": unit,
            "role": role,
            "matched_item_id": matched["item_id"] if matched else None,
            "matched_item_name": matched["name"] if matched else None,
            "matched_canonical_key": matched["canonical_key"] if matched else None,
            "match_strategy": strategy,
            "status": status,
            "issues": list(dict.fromkeys(issues)),
        })
    linked.sort(key=lambda row: (canonical_text(row["recipe_source"]), canonical_text(row["recipe_name"]), row["role"], canonical_text(row["ingredient_name"])))
    return linked


def csv_value(value: Any) -> Any:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return "; ".join(str(item) for item in value)
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def write_csv(path: Path, rows: Sequence[dict[str, Any]], fields: Sequence[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: csv_value(row.get(field)) for field in fields})


def serialize_master(master: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{field: item.get(field) for field in MASTER_FIELDS} for item in master]


def build_review_queue(master: Sequence[dict[str, Any]], links: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    queue: list[dict[str, Any]] = []
    for item in master:
        if item["needs_review"]:
            queue.append({
                "entity_type": "inventory_item",
                "record_key": item["item_id"],
                "name": item["name"],
                "source_file": "; ".join(item["source_files"]),
                "source_page": "; ".join(item["source_pages"]),
                "issues": item["issues"],
                "proposed_action": "review",
            })
    for index, link in enumerate(links, start=1):
        if link["status"] == "review":
            queue.append({
                "entity_type": "recipe_link",
                "record_key": f"recipe-link-{index}",
                "name": f"{link['recipe_name']} — {link['ingredient_raw']}",
                "source_file": link["recipe_source"],
                "source_page": "",
                "issues": link["issues"],
                "proposed_action": "review",
            })
    return queue


def build(args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    inventory_path = Path(args.inventory_pdf)
    wine_path = Path(args.wine_pricing_pdf)
    extension_path = Path(args.extensions)
    alias_path = Path(args.aliases)
    known_cost_path = Path(args.known_costs_csv) if args.known_costs_csv else None
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    inventory = extract_inventory_pdf(inventory_path)
    wine = extract_wine_pricing_pdf(wine_path, args.wine_supplier)
    extensions = load_extensions(extension_path)
    aliases = load_aliases(alias_path)
    known_costs = load_known_costs(known_cost_path)
    master, duplicates_collapsed = merge_records([*inventory, *wine, *extensions], aliases, known_costs)

    recipe_rows = extract_recipe_rows([
        (Path(args.cocktail_pdf), "Cocktail Menu"),
        (Path(args.happy_hour_pdf), "Happy Hour Staff Sheet"),
    ])
    append_coffee_recipe_rows(recipe_rows, Path(args.coffee_pdf))
    recipe_links = link_recipe_rows(recipe_rows, master, aliases)
    review_queue = build_review_queue(master, recipe_links)

    serialized = serialize_master(master)
    write_csv(output_dir / "master_inventory.csv", serialized, MASTER_FIELDS)
    (output_dir / "master_inventory.json").write_text(json.dumps(serialized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(output_dir / "recipe_links.csv", recipe_links, RECIPE_LINK_FIELDS)
    write_csv(output_dir / "review_queue.csv", review_queue, ["entity_type", "record_key", "name", "source_file", "source_page", "issues", "proposed_action"])

    duplicate_keys = [key for key, count in Counter(item["canonical_key"] for item in master).items() if count > 1]
    quality_gates = {
        "inventory_source_row_count": len(inventory) == args.expected_inventory_rows if args.expected_inventory_rows else True,
        "wine_pricing_row_count": len(wine) == 29,
        "minimum_master_items": len(master) >= args.minimum_items,
        "unique_master_keys": not duplicate_keys,
        "source_hash_on_every_master_item": all(item.get("source_hash") for item in master),
        "no_unreviewed_missing_cost": all(item.get("cost_price") is not None or item.get("net_cost") is not None or item["needs_review"] for item in master),
    }
    passed = all(quality_gates.values())
    sources = [inventory_path, wine_path, Path(args.cocktail_pdf), Path(args.happy_hour_pdf), Path(args.coffee_pdf), extension_path, alias_path]
    report = {
        "atlas_version": "0.8.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "extractor_version": EXTRACTOR_VERSION,
        "normalizer_version": NORMALIZER_VERSION,
        "sources": [{"file": path.name, "sha256": file_sha256(path)} for path in sources],
        "counts": {
            "inventory_source_rows": len(inventory),
            "wine_pricing_rows": len(wine),
            "approved_extension_rows": len(extensions),
            "input_candidate_rows": len(inventory) + len(wine) + len(extensions),
            "duplicates_collapsed": duplicates_collapsed,
            "master_items": len(master),
            "items_with_verified_cost_or_net_cost": sum(item.get("cost_price") is not None or item.get("net_cost") is not None for item in master),
            "items_with_supplier": sum(bool(item.get("supplier")) for item in master),
            "items_with_package_or_unit": sum(bool(item.get("unit")) for item in master),
            "recipe_links": len(recipe_links),
            "recipe_links_resolved_without_issues": sum(link["status"] == "linked" for link in recipe_links),
            "recipe_links_requiring_review": sum(link["status"] == "review" for link in recipe_links),
            "review_queue_rows": len(review_queue),
        },
        "quality_gates": quality_gates,
        "duplicate_master_keys": duplicate_keys,
        "status": "passed" if passed else "failed",
    }
    (output_dir / "build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report, passed


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--inventory-pdf", required=True)
    command.add_argument("--wine-pricing-pdf", required=True)
    command.add_argument("--wine-supplier", default="", help="Optional private supplier attribution for wine pricing rows")
    command.add_argument("--cocktail-pdf", required=True)
    command.add_argument("--happy-hour-pdf", required=True)
    command.add_argument("--coffee-pdf", required=True)
    command.add_argument("--extensions", required=True)
    command.add_argument("--aliases", required=True)
    command.add_argument("--known-costs-csv")
    command.add_argument("--output-dir", required=True)
    command.add_argument("--minimum-items", type=int, default=300)
    command.add_argument("--expected-inventory-rows", type=int, default=226)
    return command


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    report, passed = build(args)
    print(json.dumps({"status": report["status"], "counts": report["counts"], "quality_gates": report["quality_gates"]}, ensure_ascii=False, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    sys.exit(main())
