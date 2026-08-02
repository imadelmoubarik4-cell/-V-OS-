# Atlas Sprint 3 - UI polish and navigation refinement

Sprint 3 is implemented as a small enhancement layer on top of the current Atlas modules in `apps/web`. It preserves the existing Supabase data model and feature scripts while improving presentation and interaction behavior.

## Included

- Unified hover lift, border and shadow behavior across Operations, Brain, Business and shared dashboard cards
- Centered Atlas image logo in the sidebar
- One active sub-navigation item at a time
- Two-way synchronization between Recipe Library category chips and recipe sidebar filters
- Manual dot-grouped ISK presentation through `AtlasSprint3.isk()` plus render-time normalization
- Light Service Mode theme
- Responsive sidebar, backdrop and single-column mobile refinements
- Atlas Brain topbar icon treatment
- Dynamic Atlas Brain musing based on the lowest stock-cover item and current featured-recipe recommendation
- Reduced-motion and touch-device safeguards

## Files

- `apps/web/assets/css/sprint3.css`
- `apps/web/assets/js/sprint3.js`
- `apps/web/config.js` loads the Sprint 3 assets after the existing application scripts are ready

## Validation

Run a JavaScript syntax check on `apps/web/assets/js/sprint3.js`, then verify Home, Inventory, Recipes, Operations, Atlas Brain, Business Intelligence and Service Mode at desktop, tablet and mobile widths.
