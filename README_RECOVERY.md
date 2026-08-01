# Atlas Alpha 0.2 — Recovery + Recipe Intelligence

This release restores the functionality that was accidentally rolled back and advances the Recipe Engine into Phase 2.

## Restored

- Clickable Home focus rows and metric cards
- Clickable low-stock banner
- Working sidebar sub-navigation and titles
- Recipe category filters
- Quick Actions: add item, restock, add recipe, add supplier
- New Supplier button and supplier form
- Supplier records included in the supplier list
- Working Supabase authentication and current Atlas dashboard retained
- Atlas logo embedded in the interface so it cannot break when an asset path is missed

## New in Phase 2

- Calculates how many servings each recipe can currently produce
- Identifies the limiting ingredient
- Recipe statuses: Ready, Needs setup, Low servings, Out of stock
- Recipe dashboard totals for Ready today and Need attention
- Atlas Intelligence panel recommends the recipe needing attention first
- Recipe editor displays live service availability while ingredients are added
- Recipe alert can appear in Today's Focus on Home

## Upload

Upload these files while preserving the folder structure:

- `index.html`
- `assets/css/recipes.css`
- `assets/js/modal.js`
- `assets/js/recipes.js`
- `assets/logo/atlas-icon.png`

Do not replace or delete your existing `config.js`.

Netlify should publish automatically after the GitHub commit.
