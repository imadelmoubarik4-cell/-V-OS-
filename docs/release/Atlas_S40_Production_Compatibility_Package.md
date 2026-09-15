# Atlas S40 production compatibility package

## Outcome

This is a Git-only replacement plan for the unapplied fifth S39 production migration. It does not authorize or perform hosted database changes, function deployment, endpoint changes, site publication, feature activation, or real-stock writes.

The original S39 source-contract migration correctly failed closed because production already contained `public.onboarding_tasks`, `public.onboarding_progress`, and `public.shifts`. Its transaction rolled back and its checksum-pinned file remains unchanged.

## Compatibility approach

The S40 migration treats the existing public tables as protected production contracts:

- it requires all runtime-read columns and their exact PostgreSQL types;
- it requires primary keys and the onboarding progress conflict key;
- it requires RLS, authenticated grants, and the twelve Phase 1 access policies already established by the first S39 migration;
- it does not drop, recreate, backfill, update, or alter their columns or rows;
- it creates only missing indexes on those tables;
- it creates `atlas_private.report_events` only when absent and secures it immediately with RLS and service-role-only policies.

The SQL is retry-safe, but the launch operator must still apply each checksum-pinned migration once and record the intended version only after that transaction succeeds.

## Revised remaining plan

The four successful S39 migrations remain the production checkpoint. The failed and unapplied S39 source-contract file is superseded only in the remaining plan; it is not edited or deleted.

The revised order is:

1. S40 production source-contract adoption;
2. S33 CSV import pipeline;
3. S34 foreign-key indexes;
4. S34 notifications and conversation pins data contracts;
5. S36 report-events RLS hardening.

Every file and checksum is recorded in `Atlas_S40_Production_Compatibility_Manifest.json`.

## Isolated production-shaped replay

CI reconstructs the six-migration legacy baseline, adds synthetic copies of the already-existing onboarding and shift tables, applies the four successful S39 migrations, and verifies that the ledger contains exactly the current ten-version checkpoint.

The replay then:

1. confirms the old S39 migration fails with the production error and rolls back;
2. confirms the old failed version is absent from the ledger;
3. applies the S40 migration transactionally and repeats it to prove safe retry;
4. applies the four remaining checksum-pinned migrations;
5. compares protected inventory, movement, supplier, recipe, profile, and auth fingerprints;
6. compares every synthetic onboarding and shift row identity and value;
7. verifies the final ledger, required tables, RLS, role matrix, and security gate.

The fixture has eight synthetic onboarding tasks to mirror only the observed row count. It contains no production labels, identities, stock values, or credentials.

## Explicit stop boundary

Merging S40 changes Git only. A new explicit approval is required before any revised migration is run against production. Functions, endpoints, the site, write features, and real stock remain outside this package.
