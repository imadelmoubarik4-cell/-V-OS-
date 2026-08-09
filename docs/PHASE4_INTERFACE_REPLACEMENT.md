# Phase 4 — Single-interface replacement

## Decision

The Phase 4 overlay experiment is retired as an implementation strategy. It remains available in PR #9 for visual reference, but it is not the foundation of the release UI.

The production direction is now:

- one login screen;
- one application shell;
- one navigation system;
- one renderer per workspace;
- existing Atlas Auth, RLS, Edge Functions, evidence and publication contracts beneath that interface.

The Claude Design remains authoritative for visual hierarchy, information architecture, responsive behavior, icons, Service Mode and interaction quality. It is not shipped as a runtime.

## Preview entry point

The replacement begins at:

`/next.html`

This isolated route exists so the single-renderer architecture can be accepted before it replaces `/index.html`.

The first unit provides:

- production Supabase session recovery and password sign-in;
- canonical `public.profiles` access verification;
- real role-permitted inventory reads;
- a static Claude-style shell with no DOM mutation observer;
- light and dark modes;
- responsive sidebar and mobile navigation;
- command palette;
- Service Mode shell;
- read-only inventory presentation;
- explicit placeholders for workflows that have not yet been connected.

## Phase 3 — presentation-only refinement

The approved screenshot review is implemented as a presentation delta over the existing `/next.html` route. It does not create another shell or replace the authenticated data flow.

The refinement includes:

- a calmer active-navigation treatment using the existing Atlas teal tokens;
- more consistent sidebar spacing, brand proportions and top-bar controls;
- a compact shared Home KPI strip with responsive 2×2 and single-column states;
- refined panel spacing, row rhythm, type scale, borders and shadows;
- a compact Inventory header, controlled-boundary banner and grouped filter surface;
- explicit `Below par` text in addition to warning color;
- read-only Inventory cards below 640 px instead of a clipped desktop table;
- off-canvas navigation below 900 px so the 768 px layout is not compressed;
- earlier top-bar search compaction below 1024 px;
- semantic Service Mode tokens that remain consistent in light and dark themes;
- an explicitly disabled notification control until its real gateway is connected.

The implementation preserves:

- the existing Supabase client configuration;
- the 15-second startup and 12-second request bounds;
- password sign-in and session recovery;
- active-profile verification;
- the existing production Inventory read and compatibility fallback;
- the absence of direct inventory writes and quantity editors;
- honest placeholders and no-change messages for unreconnected workflows.

No screenshot fixture quantities, forecasts, supplier orders, operational status or other mock production facts are introduced.

The Phase 3 change boundary is limited to:

- `apps/web/next.html`;
- `apps/web/assets/css/atlas-next.css`;
- presentation rendering in `apps/web/assets/js/atlas-next.js`;
- the focused replacement-route contract tests;
- this documentation and the matching release acceptance record.

No file under `supabase/` is changed. `apps/web/index.html` and `apps/web/assets/js/data/atlas-data.js` remain outside the Phase 3 change boundary.

## Performance contract

The replacement route must not:

- initialize the old Atlas interface;
- initialize the Phase 4 overlay interface;
- render more than one login screen;
- use `MutationObserver` to rebuild the shell;
- use a polling renderer;
- leave the boot spinner visible after a timeout or startup failure.

Session recovery is bounded to 15 seconds. Individual data reads are bounded to 12 seconds and fail into a visible state rather than an endless spinner.

## Safety contract

The first replacement unit is read-only outside Supabase authentication.

It does not:

- call a stock-adjustment RPC;
- insert, update, upsert or delete an operational record;
- publish a stock count;
- create or submit a supplier order;
- publish social content;
- ingest POS sales;
- access `atlas_private` directly;
- expose a service-role credential;
- change a schema, migration, grant, role or RLS policy.

## Migration sequence

1. Accept fast authentication and real inventory reads on `/next.html`.
2. Connect L1 stock counts, scanner and L2 item master through their existing authenticated gateways.
3. Connect Recipes, Purchasing and Service Mode.
4. Connect Messages, Team, Profiles, Shifts and Knowledge.
5. Connect Brain, Business Intelligence, Reports, Settings and System.
6. Run complete role, device, CI, migration-replay and production-fingerprint acceptance.
7. Replace `/index.html` with the accepted single-interface route.
8. Remove the legacy presentation assets only after release rollback evidence is preserved.

## Acceptance for the first unit

- the login appears once;
- the initial route becomes usable or visibly fails within 15 seconds;
- a valid active Atlas profile reaches Home;
- inactive or unlisted profiles receive no operational access;
- Inventory displays real role-permitted records;
- the Inventory screen has no editable quantity control;
- command palette, theme and mobile navigation work;
- no old interface is visible behind the replacement route;
- production data remains unchanged.
