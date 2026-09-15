# Data workflow

Only source-safe, header-only templates belong in Git. Private documents, operational catalogue inputs, alias mappings, and generated exports belong under ignored directories.

Copy the two public templates into `data/private/reference/`, then fill those private copies from approved VÁ sources. The real rows must never be committed:

```bash
mkdir -p data/private/reference
cp data/templates/approved-inventory-extensions.template.csv data/private/reference/approved-inventory-extensions.csv
cp data/templates/inventory-aliases.template.csv data/private/reference/inventory-aliases.csv
```

## Sprint 1 generator

```bash
python scripts/build_sprint1_inventory.py \
  --inventory-pdf "source-data/VÁ Bar Inventory 2026 - 📦 Inventory(1).pdf" \
  --wine-pricing-pdf "source-data/va_bar_wine_pricing - Wine Pricing(1).pdf" \
  --wine-supplier "$ATLAS_WINE_SUPPLIER" \
  --cocktail-pdf "source-data/COCKTAIL MENU 2026(1).pdf" \
  --happy-hour-pdf "source-data/HAPPY HOUR STAFF RECIPE SHEET(1).pdf" \
  --coffee-pdf "source-data/☕ COFFEE PROGRAM  STAFF DOCUMENT(1).pdf" \
  --extensions data/private/reference/approved-inventory-extensions.csv \
  --aliases data/private/reference/inventory-aliases.csv \
  --known-costs-csv data/private/known-costs.csv \
  --output-dir data/private/sprint-1 \
  --minimum-items 300
```

`--wine-supplier` and `--known-costs-csv` are optional. Set `ATLAS_WINE_SUPPLIER` only in the private build environment; do not put the real supplier identity in public source files. Generated files are:

- `master_inventory.csv` and `master_inventory.json` — canonical catalogue candidates with source evidence;
- `recipe_links.csv` — recipe ingredient-to-inventory proposals;
- `review_queue.csv` — every unresolved or annotated record;
- `build_report.json` — counts, hashes, duplicates, and quality gates.

Unknown values remain blank and enter review. The generator never writes to Supabase.

The repository-wide ignore rules also block the two operational CSV filenames outside `data/private/`, preventing an accidental move from exposing them.
