# Atlas Alpha 0.3.0 — Recipe Intelligence

This is an incremental module release. It does not replace `index.html`, `config.js`, Inventory, Suppliers, authentication, or the Home dashboard.

## Upload only these files

- `assets/js/recipes.js`
- `assets/css/recipes.css`

Replace the existing files at the same paths and commit the change. Netlify should publish automatically.

## Included

- Three-panel Recipe Intelligence workspace
- Search, category and health-status filtering
- Full recipe profile without opening the editor
- Live stock coverage for every linked ingredient
- Recipe health: Ready, Low availability, Out of stock, Incomplete and Draft
- Cost per serving, cost percentage, margin and profit
- Limiting-ingredient analysis and recommended action
- Featured-recipe recommendation based on readiness, margin and service coverage
- Full-screen Service View with large measurements and keyboard navigation
- Professional Lucide icons in Quick Actions; no emojis
- Home briefing integration for urgent recipe alerts or featured recommendations

## Database

No database migration is required. The release uses the existing `recipes`, `recipe_ingredients`, `inventory_items` and `recipe_categories` tables.

## Validation completed

- JavaScript syntax check passed
- Recipe availability calculation test passed
- Required Supabase columns and table relationships verified
- `index.html` was not changed
