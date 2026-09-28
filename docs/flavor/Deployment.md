# S95 Atlas Flavor Intelligence — production deployment and rollback

Production project `dnefgcmjcgxlynycxkts`. Nothing here runs without the owner's approval.

## What changes in production

| Kind | Object | Change |
|---|---|---|
| Table (new) | `atlas_private.flavor_sources` | provider/licence register (21 rows) |
| Table (new) | `atlas_private.flavor_ingredients` | canonical ingredients (229) |
| Table (new) | `atlas_private.flavor_aliases` | names and Icelandic aliases (550) |
| Table (new) | `atlas_private.flavor_preparations` | juice, syrup, peel, … (29) |
| Table (new) | `atlas_private.flavor_ingredient_preparations` | valid pairs (812) |
| Table (new) | `atlas_private.flavor_edges` | culinary pairings with explanation (1026) |
| Table (new) | `atlas_private.flavor_item_links` | inventory item → ingredient, `confirmed` / `needs_review` (FK to `public.inventory_items(id)`, cascade deletes the link only) |
| Trigger (new) | `flavor_ingredients_touch` on `atlas_private.flavor_ingredients` | uses the existing `atlas_private.touch_updated_at()` |
| Function (new) | `public.atlas_flavor_snapshot()` | SECURITY DEFINER, `search_path ''`, EXECUTE for `service_role` only; read-only |
| Function (changed) | `atlas_private.ai_action_allowed_roles(text, jsonb)` | same CASE as today plus `recipe.draft` for admin/manager |
| Edge Function | `atlas-ai` | new routes `flavor-map`, `flavor-search`, `flavor-substitutes`, `flavor-candidates`, `flavor-compose`; `flavor.*` tools and `recipes.compose_draft`; `recipe.draft` proposals |

All seven tables have RLS on, one `service_role` policy and no privilege for `anon` or `authenticated`.
No other table, function, view, grant, cron job or Edge Function changes.

## What it can read, and what it can never change

* Reads (through `atlas-ai` with the signed-in person's role): inventory items, verified balances and
  movements through the existing projected-stock services, recipes (managers) or the recipe catalog
  (staff), and the flavour snapshot.
* Writes: only after a manager or admin taps **Approve** on a `recipe.draft` proposal, one **new** recipe via
  the existing `public.atlas_save_recipe` (`p_recipe_id = null`, `active = false`, `show_on_menu = false`)
  with the approver's JWT. Proposal and audit rows go to the existing `atlas_private.ai_actions` and
  `ai_tool_calls` tables.
* Never: inventory items, quantities, verified balances, movements, suppliers, existing recipes or their
  lines, the menu, stock counts or purchasing. `inventory_items.quantity` is never read as stock.

## Deployment steps

1. Record read-only checksums of `inventory_items`, `recipes`, `recipe_ingredients`, `suppliers`,
   verified balances, movements and purchase orders.
2. Apply `20261005090000_s95a_flavor_graph.sql`, `20261005091000_s95b_recipe_draft_kind.sql`,
   `20261005092000_s95c_flavor_seed.sql` in that order (apply_migration, one each).
3. Verify: counts above, RLS/grants, `authenticated` refused on the tables and the snapshot function,
   `ai_action_allowed_roles` = previous CASE + `recipe.draft`, security advisors (no new lint), checksums
   of step 1 unchanged.
4. Deploy `atlas-ai` from the PR head (all files under `supabase/functions/atlas-ai` and
   `supabase/functions/_shared`, `verify_jwt` false as today).
5. Verify the routes signed in (manager and bartender) on the deploy preview; checksums still unchanged.

## Rollback

1. Run `scripts/rollback_s95_flavor.sql` (one transaction): expires pending `recipe.draft` proposals, drops
   `public.atlas_flavor_snapshot()` and the seven `flavor_*` tables, restores `ai_action_allowed_roles` to
   today's definition (md5 `824bcf569e213e178dbd54022d0e709f`, checked on the local replay) and removes the
   three ledger rows.
2. Redeploy `atlas-ai` from `main` (version 18 today is identical to main).
3. The web UI is only on the deploy preview until PR #103 merges; after a merge, revert the merge commit.
Draft recipes already approved stay as ordinary inactive recipes.
