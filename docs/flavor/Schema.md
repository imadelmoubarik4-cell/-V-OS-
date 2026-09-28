# Flavor Intelligence: database schema (S95)

Migrations:

| File | Purpose |
|---|---|
| `supabase/migrations/20261005090000_s95a_flavor_graph.sql` | Tables, RLS, grants, the `public.atlas_flavor_snapshot()` reader |
| `supabase/migrations/20261005091000_s95b_recipe_draft_kind.sql` | Adds the `recipe.draft` proposal kind (admin/manager) to `atlas_private.ai_action_allowed_roles` |
| `supabase/migrations/20261005092000_s95c_flavor_seed.sql` | Curated seed. **Generated**: `node scripts/build_flavor_seed.mjs` (check with `--check`) |

Data sources for the seed live in `data/flavor/`: `sources.json`, `ingredients.json`, `preparations.json`, `pairings.json`, `item-links.json` (built by `node scripts/build_flavor_item_links.mjs` from `inventory-snapshot.json`; review report in `docs/flavor/Mapping_Report.md`).

The flavor graph is an additive, private layer next to the inventory. It never writes to inventory items, stock, recipes, suppliers, menus or purchasing. Inventory stays the only source of product facts and stock.

## Tables (all in `atlas_private`)

| Table | Key | What it holds |
|---|---|---|
| `flavor_sources` | `id text` (snake case) | Provider registry: name, url, licence, `commercial_use`, attribution, `verdict` (`use`, `use_with_attribution`, `do_not_ingest`, `needs_legal_review`), notes. Rejected sources stay in the registry so they are not added by mistake. |
| `flavor_ingredients` | `id uuid`, unique `slug` (kebab case) | Canonical ingredient concepts ("gin", "lime", "elderflower liqueur"), not products. `family`, `subfamily`, `aroma` (aroma family → 0..1), `taste` (`sweet, sour, bitter, salty, umami, fat, alcohol, astringency` → 0..5), `intensity` 1..5, `texture`, `abv_typical`, `allergens[]`, `dietary[]` (`vegan`, `vegan_check_label`, `vegetarian`, `gluten_free`, `contains_alcohol`, `contains_caffeine`), `uses[]` ⊆ `cocktail, mocktail, coffee, dessert, food`, `techniques[]`, `attributes` (trigeminal pungency/cooling/carbonation, may_contain, region_tags, seed_origin), `provider`, `confidence`, `version`, timestamps. |
| `flavor_aliases` | (`ingredient_id`, `alias_key`) | Search and mapping aliases in English, Icelandic and other languages (brand words included for search only). `alias_key` is the normalised form (`scripts/build_flavor_common.mjs` `aliasKey`: lower case, þ→th, ð→d, æ→ae, accents stripped, non-alphanumerics → one space). |
| `flavor_preparations` | `id uuid`, unique `slug` | Preparation types (juice, zest, syrup, infusion, fat-wash, clarified, puree, dehydrated, espresso, saline-solution, …) with heuristic `taste_shift` (delta on 0..5) and `aroma_shift` (delta on 0..1), texture, notes. |
| `flavor_ingredient_preparations` | (`ingredient_id`, `preparation_id`) | Which preparations make sense for an ingredient (from its techniques plus every preparation used by an item link). |
| `flavor_edges` | `id uuid`; unique on (`a_id`, `a_prep`, `b_id`, `b_prep`, `relation`, `evidence_type`) | Undirected pairing edge, stored once with `a_id < b_id` (check), `a_id <> b_id`. `relation` ∈ `complement, contrast, bridge, substitute`; `strength` 0..1; optional `aroma_score`, `taste_score`, `texture_score` 0..1; `contexts[]` (where it is known to work); `evidence_type`; `provider`; `confidence`; `explanation` (required); `version`. |
| `flavor_item_links` | (`inventory_item_id`, `ingredient_id`) | Inventory item → canonical ingredient (+ optional preparation). `status` ∈ `confirmed, needs_review, rejected`; `match_method`; `confidence`; `note`; `reviewed_by`, `reviewed_at`. FK to `public.inventory_items(id) on delete cascade` (deleting an item removes only its links). |

`aroma_score` in the seed is the cosine similarity of the two curated aroma vectors: a derived number, not a measurement. `taste_score`/`texture_score` are left empty for now.

## Evidence model

Each edge has exactly one `evidence_type` and one `provider`. Types are never mixed or averaged into one number:

| evidence_type | Meaning | MVP |
|---|---|---|
| `scientific` | Measured or literature-backed molecular evidence from a **licensed** provider | Empty. No commercially usable open compound dataset exists (see `data/flavor/sources.json`). |
| `culinary` | Established culinary/bartending practice, authored by Atlas (`provider = atlas_curated`) | All seeded edges (1026). |
| `atlas_learned` | Statistics from the venue's own recipes (co-occurrence) | Computed at request time by the atlas-ai Edge Function from current recipes; not stored in the seed. Provider row `atlas_learned`. |
| `ai_interpretation` | Model-generated text | Never stored as evidence. AI text is never labelled scientific. |

Edge relations in the seed: `complement` (classic combinations and complements), `bridge` (shared aroma character), `contrast`, `substitute` (Atlas-authored swaps such as lemon ↔ lime, egg white ↔ aquafaba, whole milk ↔ oat milk). The curator's finer label (`classic_combination`, `shared_aroma`, …) is kept as `source_relation` in `data/flavor/pairings.json`.

## Provenance and review

- Every ingredient and edge carries `provider` (FK to `flavor_sources`) and `confidence`. The seed generator refuses any provider whose verdict is not `use`/`use_with_attribution`.
- Seed data: 200 research-authored ingredients (general culinary knowledge, hand-estimated vectors, confidence 0.55–0.6) plus 29 ingredients Atlas added for the venue's stock (pink gin, spiced rum, coconut rum, añejo tequila, Tennessee whiskey, fruit liqueurs, limoncello, bergamot/anise/honey liqueurs, rosé, orange/lemon-lime soda, ginger ale, sugar, demerara sugar, cocoa, caramel, apple cake, pecan pie, chocolate chip cookie). Everything is a draft that needs human review (`review_status` in the JSON files). Research backlog edges with generic explanations are not shipped.
- Item links: `confirmed` only from an explicit, unambiguous rule; everything uncertain is `needs_review` (a *possible match*, never counted as available stock) with candidates in the report. The seed never overwrites a link whose `reviewed_at` is set.
- No inventory data is copied: links hold ids, status and method; product names, sizes, ABV, stock and cost are read from inventory at request time.

## Versioning

- Rows carry `version` (starts at 1). The seed is an upsert: an unchanged row is not touched; a changed curated row is updated and its `version` bumped. Re-running the seed is a no-op (checked by `scripts/verify_s95_flavor_replay.sql`).
- Ids are deterministic md5 uuids: `md5('flavor:'||slug)`, `md5('flavor-prep:'||slug)`, `md5('flavor-edge:'||a||'|'||a_prep||'|'||b||'|'||b_prep||'|'||relation||'|'||evidence_type)` (identical in JS and SQL), so replays and re-seeds keep ids stable.
- `public.atlas_flavor_snapshot()` returns `version` = md5 of the snapshot content, so a cache can tell when curated data changed.
- The seed only adds or updates. Removing a curated row from `data/flavor/*.json` does not delete it from the database; a removal needs an explicit migration.

## Security model

- Tables: `atlas_private`, RLS enabled, one policy `service role manages <table>` (`for all to service_role`), `revoke all … from public, anon, authenticated`, `grant select, insert, update, delete … to service_role` (no truncate/references/trigger). Browsers cannot read or write any flavor table.
- Reader: `public.atlas_flavor_snapshot()` returns `{version, sources[], ingredients[], aliases[], preparations[], ingredient_preparations[], edges[], links[]}`. `security definer`, `stable`, `set search_path = ''`, fully qualified names, execute revoked from `public, anon, authenticated` and granted to `service_role` only. Links in the snapshot are only `confirmed` and `needs_review` (with status).
- The atlas-ai Edge Function calls it through `services.serviceRpc` after its own role gate; cost and stock rules stay in the Edge Function (`projectStock`), never in this schema.
- No write RPCs in the MVP. Curated changes arrive as migrations.
- `recipe.draft` (S95B): proposals only, approvable by admin/manager. Approval saves a new recipe through `public.atlas_save_recipe` with the approver's JWT, `active = false`, `show_on_menu = false`.
- Supabase lints: every table has RLS and a service-role policy (no "RLS enabled, no policy" finding); every function pins `search_path`.

## Verification

- Static contracts: `tests/node/flavor-migrations.test.js` (RLS, revokes, definer + search_path, no writes to inventory/recipes/suppliers/stock/menu/purchasing in any S95 file, seed and mapping reproducible).
- Local replay: `PGHOST=127.0.0.1 scripts/verify_full_migration_replay.sh`, then `psql -X -qAt -f scripts/verify_s95_flavor_replay.sql` (snapshot counts, privileges, RLS, deterministic ids, idempotent seed, where-exists links, reviewed links preserved, delete cascade only to links) and `scripts/verify_s95b_recipe_draft_kind_preview.sql`.

## Rollback

Nothing outside the flavor tables depends on them. To remove S95 (in this order):

```sql
begin;
-- S95B: restore the S90F allow-list (re-run the body of
-- supabase/migrations/20260929092000_s90f_ai_update_draft_order_kind.sql).
-- Do this only after no pending recipe.draft proposals remain.
drop function if exists public.atlas_flavor_snapshot();
drop table if exists atlas_private.flavor_item_links;
drop table if exists atlas_private.flavor_edges;
drop table if exists atlas_private.flavor_ingredient_preparations;
drop table if exists atlas_private.flavor_aliases;
drop table if exists atlas_private.flavor_preparations;
drop table if exists atlas_private.flavor_ingredients;
drop table if exists atlas_private.flavor_sources;
notify pgrst, 'reload schema';
commit;
```

Dropping `flavor_item_links` removes its foreign key to `public.inventory_items`; no inventory row is affected. Recipes saved from approved drafts are ordinary recipes and are not removed by a rollback.
