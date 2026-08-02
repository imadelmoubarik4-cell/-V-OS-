# Database

## Core tables

- `inventory_items`: canonical operational items already used by Atlas.
- `suppliers`: canonical suppliers.
- `recipes` and `recipe_ingredients`: production definitions and inventory links.
- `import_batches`: source-file lifecycle and storage provenance.
- `import_inventory_rows`: one immutable-ish staging record per extracted source row.
- `inventory_aliases`: reviewed alternative names that resolve to a canonical item.
- `import_review_items`: the existing general review queue.

## Data rules

1. Keep `raw_data` unchanged and store normalized values separately.
2. A source hash and `(batch_id, row_number)` make retries idempotent.
3. Missing costs, suppliers, sizes, or units stay null; they are never guessed.
4. Exact identifiers may auto-match. Names below the configured threshold require review.
5. Staging rows cannot be promoted by anonymous clients.
6. All public-schema tables use explicit grants and row-level security.
7. Authentication alone never grants private inventory or import access; active manager/admin authorization comes from `public.profiles`.
8. Bartender/viewer reads use `inventory_catalog`, which omits costs, supplier links, private notes, and source evidence.

The five hosted migrations before A.1 are preserved locally with their original versions and recorded SQL. Migration `20260802090000_phase_a_02_inventory_staging.sql` adds staging and replaces permissive inventory/import policies; it remains unapplied to the hosted project.

See [SECURITY.md](SECURITY.md) for the authorization matrix.
