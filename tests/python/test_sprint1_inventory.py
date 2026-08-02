import csv
import unittest
from pathlib import Path

from scripts.build_sprint1_inventory import (
    canonical_text,
    extract_inventory_pdf,
    extract_recipe_rows,
    extract_wine_pricing_pdf,
    load_aliases,
    merge_records,
    normalize_unit,
    parse_money,
    parse_number,
    make_record,
)


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "source-data"
PRIVATE_REFERENCE = ROOT / "data/private/reference"
PRIVATE_EXTENSIONS = PRIVATE_REFERENCE / "approved-inventory-extensions.csv"


class NormalizationTests(unittest.TestCase):
    def test_diacritics_and_punctuation_normalize(self):
        self.assertEqual(canonical_text("Crème de Cassis"), "creme de cassis")
        self.assertEqual(canonical_text("Jack Daniel’s"), "jack daniel s")

    def test_package_units_normalize(self):
        self.assertEqual(normalize_unit("700 ml"), ("700ml", 700.0, "ml"))
        self.assertEqual(normalize_unit("1L"), ("1000ml", 1000.0, "ml"))
        self.assertEqual(normalize_unit("3 Kg"), ("3000g", 3000.0, "g"))

    def test_annotations_are_not_discarded(self):
        self.assertEqual(parse_number("5***").value, 5)
        self.assertEqual(parse_number("5***").issue, "numeric_annotation:***")
        self.assertEqual(parse_number("10unid").issue, "numeric_annotation:unid")

    def test_isk_thousands_parse_as_integer(self):
        self.assertEqual(parse_money("12,345 ISK"), 12345)
        self.assertEqual(parse_money("1.234 kr."), 1234)

    def test_duplicate_quantity_conflict_is_reviewed_not_summed(self):
        first = make_record(name="Ananas Purée", unit="1000ml", quantity=0, quantity_raw="0", source_file="one", source_hash="one")
        second = make_record(name="Ananas pure", unit="1000ml", quantity=3, quantity_raw="3", source_file="two", source_hash="two")
        aliases = [{
            "alias": "ananas puree",
            "canonical_name": "ananas pure",
            "scope": "global",
            "source_note": "synthetic test fixture",
        }]
        master, collapsed = merge_records([first, second], aliases, [])
        self.assertEqual(collapsed, 1)
        self.assertEqual(len(master), 1)
        self.assertIsNone(master[0]["quantity"])
        self.assertIn("conflicting_source_quantities", master[0]["issues"])


class SourceIntegrationTests(unittest.TestCase):
    @unittest.skipUnless(SOURCE.exists(), "private source PDFs are not present")
    def test_current_inventory_extracts_exact_source_rows(self):
        rows = extract_inventory_pdf(SOURCE / "VÁ Bar Inventory 2026 - 📦 Inventory(1).pdf")
        self.assertEqual(len(rows), 226)
        self.assertEqual(len({(row["name"], row["source_page"], row["source_row"]) for row in rows}), 226)

    @unittest.skipUnless(SOURCE.exists(), "private source PDFs are not present")
    def test_wine_calculator_extracts_29_rows(self):
        rows = extract_wine_pricing_pdf(SOURCE / "va_bar_wine_pricing - Wine Pricing(1).pdf")
        self.assertEqual(len(rows), 29)
        self.assertEqual(rows[0]["name"], "G.H. Mumm Cordon Rouge [Champagne]")
        self.assertIn("missing_wine_index", rows[5]["issues"])

    @unittest.skipUnless(SOURCE.exists(), "private source PDFs are not present")
    def test_staff_recipe_sources_produce_links(self):
        rows = extract_recipe_rows([
            (SOURCE / "COCKTAIL MENU 2026(1).pdf", "Cocktail Menu"),
            (SOURCE / "HAPPY HOUR STAFF RECIPE SHEET(1).pdf", "Happy Hour Staff Sheet"),
        ])
        recipes = {row["recipe_name"] for row in rows}
        self.assertIn("El Patron", recipes)
        self.assertIn("Basil Gimlet", recipes)
        self.assertGreater(len(rows), 100)

    @unittest.skipUnless(PRIVATE_EXTENSIONS.exists(), "private operational extensions are not present")
    def test_private_extension_reference_is_substantial_and_source_labelled(self):
        with PRIVATE_EXTENSIONS.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertGreaterEqual(len(rows), 100)
        self.assertTrue(all(row["source_file"] and row["source_note"] for row in rows))


if __name__ == "__main__":
    unittest.main()
