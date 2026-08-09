# Phase 4 Interface Replacement — acceptance record

## Status

Implementation continues on `agent/phase4-interface-replacement` in draft PR #11.

This record does not authorize merge, production migration, stock publication or release.

## Replacement foundation

The `/next.html` route uses:

- one bounded boot screen;
- one production Supabase login and session-recovery path;
- active-profile verification through `public.profiles`;
- one visible application shell and navigation system;
- real role-permitted operational reads;
- responsive light and dark presentation;
- command palette and Service Mode;
- no retired overlay or duplicate login experience.

Ordinary Inventory remains read-only. Controlled workflows remain separate from the item list.

## Phase 3 — presentation refinement

The approved visual delta refined navigation, spacing, Home metrics, Inventory hierarchy, mobile cards, responsive breakpoints, light/dark Service Mode and status clarity without replacing the secure engine or introducing screenshot fixture data.

## Phase 4.1 — L1 stock-count reconnection

Checkpoint L1 is mounted as a Stock count section inside Inventory through the existing `atlas-stock-counts` Edge Function.

Connected capabilities include:

- snapshot and session-detail reads;
- all, location and category count sessions;
- unit-aware count evidence;
- skip, submit, manager verify, conflict acknowledgement, reject and cancel;
- manager publication-plan preparation;
- Publish visibility only when deployment policy and gateway permission both enable it.

Count observations and verification do not mutate production Inventory.

## Phase 4.2 — existing-workspace reconnection

The remaining implemented Atlas workflows are mounted beneath the same `/next.html` shell through their existing data boundaries and authenticated gateways.

### Inventory and purchasing

- read-only ordinary Inventory;
- phone barcode scanner;
- Checkpoint L1 stock counts;
- Checkpoint L2 Item master;
- manager-controlled delivery logging;
- supplier directory and manager-controlled supplier creation;
- exact `max(par - recorded on hand, 0)` replenishment review;
- local review-only purchase drafts and CSV export.

Purchase drafts cannot submit supplier orders. Automatic ordering remains disabled.

### Operations and Service Mode

- recurring operations routines and checklist evidence;
- temperature logging and manager-confirmed ranges;
- Service Mode stock lookup, stock count, scanner, recipe lookup, Knowledge, and operational checks.

The 86 board remains disabled because no approved gateway is configured.

### Remaining connected workspaces

- Recipes;
- Import Center;
- Real VÁ Data review;
- Marketing;
- Team Messages and unread indicators;
- Team profiles and profile photos;
- weekly and monthly Shifts;
- Knowledge and Source Center;
- Atlas Brain, Daily Briefing, Phase 3 memory and Checkpoint K;
- Business Intelligence;
- Reports and Checkpoint M;
- Settings;
- System;
- canonical Connection Center.

Unsupported sales evidence, automatic social publication, external execution and production synchronization remain explicit and disabled.

## Authentication and data boundary

The replacement route creates one production Supabase client and configures `AtlasData` once. The connected modules receive the same current session, active profile and role-permitted data.

Private modules call their existing `atlas-*` Edge Functions with the signed-in user JWT. The browser receives no service-role credential and does not access `atlas_private` directly.

The compatibility adapter supplies only the historical global names and mount selectors required by the already-built workflow renderers. It does not boot the old application, old login or old navigation.

## Phase 4.2 file boundary

Changes after the accepted Phase 4.1 head are limited to:

- `apps/web/next.html`;
- `apps/web/assets/js/atlas-next.js`;
- `apps/web/assets/js/atlas-next-config.js`;
- `apps/web/assets/js/atlas-next-workspaces.js`;
- `apps/web/assets/js/atlas-next-purchasing.js`;
- `apps/web/assets/js/team-unread-badge.js`;
- `apps/web/assets/css/atlas-next-workspaces.css`;
- focused Node and Python contracts;
- Phase 4 documentation.

No file below `supabase/` changed. No schema, migration, RLS policy, role, grant, Edge Function deployment, environment variable or production record changed.

## Validation record

A temporary validation-only PR ran the repository workflows against exact implementation head:

`3817e0f7e7aaa8129dd9ed124c908a9041ef1775`

It was closed without merge after recording:

- browser JavaScript syntax: passed;
- complete Node suite: **209 passed, 0 failed**;
- workspace-reconnection Node and Python contracts: passed;
- complete Python suite: **220 passed, 5 existing unrelated failures, 4 skipped**;
- Netlify Deploy Preview #11: deployed successfully;
- production fingerprint unchanged at **49 active Inventory records / 131.2 summed quantity / 12 Inventory movements / 3 active profiles**;
- private L1 sessions, lines, events, verified balances and publications: **0**.

Migration replay still stops at the existing `20260806194753_atlas_connections_p2_seeds_api.sql` high-risk capability seed/guard conflict. The five Python failures remain existing text/signature expectation drift outside the workspace-reconnection diff. Neither issue was altered to create a false green result.

## Remaining acceptance before production replacement

1. Reconcile PR #11 with its current base branch without losing the connected interface.
2. Repeat complete validation against the reconciled head.
3. Perform hosted login and active/inactive role acceptance using authorized test accounts.
4. Exercise each connected gateway in the deploy preview with every permitted role.
5. Confirm that non-publication acceptance leaves the production fingerprint unchanged.
6. Review all connected workspaces at 390 px, 768 px, 1024 px and 1440 px in both themes.
7. Resolve or formally disposition the existing Python and migration-replay blockers.
8. Resume the next design-polish pass only after the connected-workspace baseline is accepted.
9. Replace `/index.html` only after explicit owner approval.
10. Merge and publish only after the production replacement review is approved.
