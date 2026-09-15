# Releases

Release checkpoints live under `releases/<version>/`. Each checkpoint records the version, changes, installation requirements, and known limitations.

Alpha 0.7 artifacts are preserved under `releases/archive/`; they are reference material and are not part of the deploy root.

Planned branch flow:

```text
main
└── release/alpha-0.8.0
    ├── feature/import-engine
    ├── feature/inventory
    ├── feature/recipes
    └── feature/supplier-center
```

No release is complete until tests pass, private-data exclusions are checked, and database migrations have been reviewed separately from application deployment.
