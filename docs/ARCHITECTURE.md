# Architecture

Atlas uses a source-to-staging-to-canonical pipeline.

```text
Private files -> import_batches -> import_inventory_rows -> review -> inventory_items
                                      |                    |
                                      +-> source evidence  +-> aliases and links
```

## Boundaries

- `apps/web` is the static authenticated application deployed by Netlify.
- `packages/import-engine` owns deterministic normalization and matching.
- domain packages own contracts, not direct infrastructure access.
- `supabase/migrations` is the only source of new database structure.
- `scripts` turns private operational documents into private review artifacts.
- `data/templates` contains header-only examples; operational catalogue candidates and alias mappings stay under ignored `data/private` paths.

The browser uploads source files but does not perform authoritative extraction or directly insert staged inventory rows. A trusted worker or operator runs extraction, then reviewers approve promotion.
