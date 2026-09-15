# Atlas Alpha 0.8.0

Atlas is the operating system for VÁ. Alpha 0.8.0 starts the real-data foundation: private source files enter a controlled queue, become normalized staging rows, and reach live inventory only after review.

## Sprint 1

- preserve the working Alpha 0.7 application and release history;
- establish the package, database, data, test, and release boundaries;
- extract the 2026 source inventory without inventing missing values;
- normalize categories, units, aliases, and source provenance;
- stage duplicate decisions before any live inventory mutation;
- build a master catalogue of at least 300 documented items from approved VÁ sources.

The repository is public. Source PDFs, current stock quantities, supplier costs, generated master data, and review exports are deliberately ignored by Git.

## Layout

```text
apps/web/                    current static Atlas application
packages/import-engine/      normalization and duplicate matching
packages/inventory/          inventory domain contract
supabase/migrations/         reviewed database changes
data/templates/              safe import templates
data/templates/              header-only public import/reference templates
scripts/                     private-source extraction tools
tests/                       repository-level tests
releases/alpha-0.8.0/        release checkpoint
releases/archive/            preserved Alpha 0.7 builds
```

## Local verification

```bash
npm test
python -m unittest discover -s tests/python -v
```

To generate the private Sprint 1 dataset, install `requirements-dev.txt` and follow [data/README.md](data/README.md). Never commit operational reference CSVs or the resulting `data/private/` directory.

See [docs/ATLAS_MASTER_PLAN.md](docs/ATLAS_MASTER_PLAN.md) for the delivery sequence, [docs/SECURITY.md](docs/SECURITY.md) for the Release 1 access model, and [releases/alpha-0.8.0/INSTALL.md](releases/alpha-0.8.0/INSTALL.md) for setup.
