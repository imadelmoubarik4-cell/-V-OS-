# Phase 4 — Single-interface replacement

## Decision

The Phase 4 overlay experiment is retired as an implementation strategy. It remains available in PR #9 for visual reference, but it is not the foundation of the release UI.

The production direction is:

- one login screen;
- one application shell;
- one navigation system;
- one renderer per visible workspace;
- existing Atlas Auth, RLS, Edge Functions, evidence and publication contracts beneath that interface.

The Claude Design remains authoritative for visual hierarchy, information architecture, responsive behavior, icons, Service Mode and interaction quality. It is not shipped as a runtime.

## Preview entry point

The replacement remains isolated at:

`/next.html`

This route exists so the single-interface architecture and connected workflows can be accepted before it replaces `/index.html`.

The foundation provides:

- production Supabase session recovery and password sign-in;
- canonical `public.profiles` access verification;
- real role-permitted Inventory, recipe, supplier and movement reads;
- one visible application shell;
- light and dark modes;
- responsive sidebar and mobile navigation;
- command palette;
- Service Mode;
- read-only ordinary Inventory presentation;
- direct mounting of the existing authenticated Atlas workspaces.

## Phase 3 — presentation-only refinement

The approved screenshot review was implemented as a presentation delta over the existing `/next.html` route. It did not create another shell or replace the authenticated data flow.

The refinement includes:

- a calmer active-navigation treatment using the existing Atlas teal tokens;
- more consistent sidebar spacing, brand proportions and top-bar controls;
- a compact shared Home KPI strip with responsive 2×2 and single-column states;
- refined panel spacing, row rhythm, type scale, borders and shadows;
- a compact Inventory header, controlled-boundary banner and grouped filter surface;
- explicit `Below par` text in addition to warning color;
- read-only Inventory cards below 640 px instead of a clipped desktop table;
- off-canvas navigation below 900 px;
- earlier top-bar search compaction below 1024 px;
- semantic Service Mode tokens in light and dark themes.

No screenshot fixture quantities, forecasts, supplier orders, operational status or other mock production facts were introduced.

## Phase 4.1 — L1 stock-count gateway reconnection

Checkpoint L1 was mounted directly inside the existing Inventory workspace through the deployed `atlas-stock-counts` Edge Function.

The Inventory workspace exposes:

- **Items** — role-permitted, read-only Inventory records;
- **Stock count** — the existing L1 evidence workflow.

L1 supports count-session reads, scoped count creation, unit-aware observations, skipped-line evidence, submission, manager verification, conflict acknowledgement, rejection, cancellation and separately gated publication planning.

Ordinary Inventory remains read-only. Observation, submission and verification do not mutate production Inventory. Publish remains a separate manager-only action and is visible only when both gateway permission and deployment policy enable it.

## Phase 4.2 — existing-workspace reconnection

The remaining implemented Atlas workspaces are now mounted inside the same `/next.html` shell. The route does not boot the legacy application and does not load the retired overlay. Existing workflow modules are reused as workspace renderers beneath the current navigation and authenticated session.

### Shared authenticated boundary

`atlas-next.js` still creates the one production Supabase client. It publishes that exact client as the existing Atlas compatibility surface and configures `AtlasData` once.

The connected workspaces receive:

- the current production Auth session;
- the active role from `public.profiles`;
- role-permitted Inventory records;
- role-permitted recipe records;
- manager-only supplier and movement evidence where authorized;
- explicit `atlas:auth`, `atlas:data` and `atlas:navigate` events.

Private workflows continue to call their already-deployed `atlas-*` Edge Functions with the signed-in user JWT. The browser does not receive a service-role credential and does not access `atlas_private` directly.

### Connected Inventory workflows

- ordinary read-only Items view;
- Checkpoint L1 stock counts;
- phone barcode scanner through `atlas-inventory-scanner`;
- Checkpoint L2 Item master through `atlas-item-master`;
- manager-controlled delivery logging through the existing `adjust_inventory` boundary;
- supplier creation through the existing role and RLS boundary.

Quantity editing is not added to ordinary Inventory. Scanner, count evidence, controlled delivery and Item master remain separate workflows.

### Connected Operations and Service Mode

- routine/checklist workspace through `atlas-operations-checkpoint-a`;
- temperature evidence and manager-confirmed ranges;
- Service Mode stock lookup;
- Service Mode L1 stock count;
- Service Mode phone scanner;
- Service Mode recipe lookup;
- Service Mode Knowledge;
- Service Mode operational checks and temperatures.

The 86 board remains visibly unavailable because no approved gateway is configured for it.

### Connected commercial and review workspaces

- Recipes and recipe costing over role-permitted Inventory and recipe records;
- Purchasing shortfall review;
- supplier directory;
- controlled delivery history;
- local review-only purchase drafts and CSV export;
- Import Center queue;
- Real VÁ Data review workspace.

Purchasing suggestions use exactly `max(par - recorded on hand, 0)`. Review drafts cannot submit a supplier order. Automatic ordering and supplier submission remain disabled.

### Connected people, growth and knowledge workspaces

- Team Messages and unread indicators;
- Team profiles and profile photos;
- weekly and monthly Shifts;
- Marketing planning and approval;
- Knowledge, required reading and source governance;
- Source Center through the read-only gateway.

The top-bar notification control now opens Messages and displays the existing unread count instead of presenting a disconnected control.

### Connected intelligence and administration workspaces

- Atlas Brain overview;
- Daily Briefing;
- Phase 3 recommendation memory;
- Checkpoint K intelligence;
- Business Intelligence;
- Reports;
- Checkpoint M POS mapping;
- Settings;
- System control room;
- canonical Connection Center.

Unsupported sales evidence, automatic publication, external execution and production synchronization remain explicit and disabled.

### Compatibility layer

The connected workspace adapter supplies only the legacy global names that the existing workflow renderers require, including the same Auth client, current user, role-permitted data arrays and route bridge. It does not initialize the old login, old shell or old navigation.

A hidden compatibility navigation tree exists only so independently developed workspace modules can locate their historical mount selectors. It is never presented as a second navigation system.

### Phase 4.2 file boundary

Changes after the accepted Phase 4.1 head are limited to:

- `apps/web/next.html`;
- `apps/web/assets/js/atlas-next.js`;
- `apps/web/assets/js/atlas-next-config.js`;
- `apps/web/assets/js/atlas-next-workspaces.js`;
- `apps/web/assets/js/atlas-next-purchasing.js`;
- `apps/web/assets/js/team-unread-badge.js`;
- `apps/web/assets/css/atlas-next-workspaces.css`;
- focused Node and Python contracts;
- this documentation and the matching release acceptance record.

No file below `supabase/` changed. No schema, migration, RLS policy, role, grant, Edge Function deployment, environment variable or production record changed.

## Performance contract

The replacement route must not:

- initialize the old Atlas application shell;
- initialize the retired Phase 4 overlay;
- render more than one login screen;
- use a `MutationObserver` to rebuild the replacement shell;
- use a polling shell renderer;
- leave the boot spinner visible after a timeout or startup failure.

Session recovery remains bounded to 15 seconds. Initial production reads remain bounded to 12 seconds. Individual existing gateway modules retain their bounded request and visible error contracts.

Existing workflow-specific observers or visibility-aware polling remain scoped to their own connected modules; they do not rebuild the application shell.

## Validation recorded for Phase 4.2

A temporary validation-only PR executed the existing repository workflows against exact head `3817e0f7e7aaa8129dd9ed124c908a9041ef1775` and was closed without merge.

- browser JavaScript syntax step: passed;
- complete Node suite: **209 passed, 0 failed**;
- new Node workspace-reconnection contracts: passed;
- new Python workspace-reconnection contracts: passed;
- complete Python suite: **220 passed, 5 existing unrelated failures, 4 skipped**;
- Netlify Deploy Preview #11: deployed successfully;
- production fingerprint: unchanged at 49 active Inventory records, 131.2 summed quantity, 12 Inventory movements and 3 active profiles;
- private L1 tables: still empty;
- migration replay: stopped at the existing high-risk capability seed/guard conflict in `20260806194753_atlas_connections_p2_seeds_api.sql`.

The existing Python text/signature drift and migration replay conflict were not modified to make the interface reconnection appear green.

## Remaining acceptance before production replacement

1. Reconcile PR #11 with its current base branch without losing the connected interface.
2. Repeat the complete validation against the reconciled head.
3. Perform hosted login and active/inactive role acceptance with authorized test accounts.
4. Exercise every connected gateway in the hosted preview at least once with the roles that are permitted to use it.
5. Confirm that non-publication acceptance leaves the production fingerprint unchanged.
6. Review every connected workspace at 390 px, 768 px, 1024 px and 1440 px in light and dark mode.
7. Resolve or formally disposition the existing Python contract drift and migration replay blocker.
8. Resume presentation polishing only after the connected-workspace baseline is accepted.
9. Replace `/index.html` only after explicit owner approval.
10. Merge and publish only after the production replacement review is approved.
