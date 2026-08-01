# Atlas Alpha 0.7 - Build 0.5

This build connects the inventory importer to the current Atlas application.

## Included

- Updated `index.html`
- `assets/css/import-center.css`
- `assets/js/import-center.js`
- `atlas-inventory-import-template.csv`

## Install

1. Replace the repository root `index.html` with the included file.
2. Copy `assets/css/import-center.css` into `assets/css/`.
3. Copy `assets/js/import-center.js` into `assets/js/`.
4. Commit and deploy. No database migration is required for this build.

## Features

- Import Center navigation and workspace
- Excel, XLS and CSV parsing through SheetJS
- Header alias mapping for common inventory spreadsheets
- Duplicate matching by SKU or normalized product name
- Per-row Merge, Create New or Skip action
- Safe merge rules that preserve existing descriptive fields
- Progress reporting and failure handling
- Recent import history stored on the current device
- Downloadable CSV template

## Database fields used

This build writes only fields already used by the current Atlas `inventory_items` implementation: `name`, `category`, `quantity`, `unit`, `par_level`, `supplier`, `sku`, `bin_location`, `units_per_case`, `case_cost`, `cost_price`, `discount_percent`, and `updated_by`.
