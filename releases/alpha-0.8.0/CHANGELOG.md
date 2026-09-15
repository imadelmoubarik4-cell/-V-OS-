# Changelog — Alpha 0.8.0

## Added

- monorepo-style application, package, data, migration, test, and release boundaries;
- private multi-file import queue from Phase A.1.1;
- A.2 staging-table migration with provenance, match decisions, and RLS;
- canonical name, package, number, and money normalization;
- identifier-first duplicate matching with a review band;
- inventory PDF extraction and private master-data generation;
- approved non-sensitive catalogue extensions and alias references;
- JavaScript and Python regression tests;
- recovered copies of all five hosted migrations that precede A.1;
- active-role authorization helpers and a cost-redacted staff inventory catalogue;
- Release 1 security regression tests for anonymous, staff, manager/admin, browser, and trusted-worker boundaries.

## Changed

- Netlify deploy root is now `apps/web`;
- all Alpha 0.7 builds and data templates are retained under archive directories.

## Security

- private PDFs, current stock, costs, and generated outputs are Git-ignored;
- new staging resources revoke anonymous access and use explicit grants plus RLS;
- private inventory, supplier, movement, import, and source-file access requires an active manager/admin profile;
- authenticated browsers may review staged decisions but cannot create staging rows or aliases;
- trusted-worker writes remain server-only through `service_role`.
