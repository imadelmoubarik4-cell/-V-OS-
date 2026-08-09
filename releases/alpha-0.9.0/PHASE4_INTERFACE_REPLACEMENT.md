# Phase 4 Interface Replacement — acceptance record

## Status

Implementation continues on `agent/phase4-interface-replacement`, based on the stable Phase 2 branch.

This record does not authorize merge, production migration or release.

## Reason for the reset

The earlier Phase 4 overlay loaded a second presentation layer over the legacy application. Browser acceptance showed two login experiences alternating during startup and a spinner that remained for more than two minutes. That implementation strategy is retired.

## Replacement foundation

The new `/next.html` route has one static presentation tree and does not load the old application or Phase 4 overlay.

It currently provides:

- one bounded boot screen;
- one production Supabase login and session-recovery path;
- active-profile verification through `public.profiles`;
- real, role-permitted inventory reads;
- read-only quantity presentation;
- Claude-style responsive navigation, command palette, theme and Service Mode shell;
- visible placeholders for workflows awaiting direct gateway connection.

## Phase 3 presentation-only implementation

The approved visual delta has been applied without replacing the shell or changing the secure engine.

Included presentation changes:

- refined sidebar spacing, brand proportions and Atlas-teal active navigation;
- consistent 42–44 px top-bar controls and a lower-weight Service Mode launcher;
- compact Home KPI strip and improved dashboard panel rhythm;
- compact Inventory heading, safety banner and filter surface;
- explicit below-par status in addition to warning color;
- read-only mobile Inventory cards below 640 px;
- off-canvas navigation below 900 px and earlier top-bar search compaction;
- semantic Service Mode colors for consistent light and dark rendering;
- disabled, clearly labelled notification control until the real notification workflow is connected.

The implementation deliberately does not add screenshot fixture quantities, forecasts, supplier orders, purchase states or other simulated production facts.

The protected runtime remains unchanged in purpose:

- the existing Supabase configuration and session flow remain in place;
- active-profile verification remains required;
- the real Inventory read and compatibility fallback remain in place;
- the route still contains no operational insert, update, upsert, delete or RPC;
- scanner and L1 count actions remain honest no-change placeholders;
- `/index.html`, `atlas-data.js` and every `supabase/` file remain outside this Phase 3 implementation.

## Safety boundary

- no database migration;
- no RLS, role or grant change;
- no service-role credential;
- no operational insert, update, upsert or delete;
- no stock-adjustment RPC;
- no count publication;
- no supplier submission;
- no social publication;
- no POS ingestion;
- no production synchronization.

## Remaining first-unit acceptance

1. Browser JavaScript syntax.
2. Focused Node and Python contracts.
3. Complete repository suites and migration replay.
4. Exact Netlify Deploy Preview for the updated draft PR.
5. One-login and bounded-startup acceptance.
6. Administrator, manager, bartender, viewer and inactive-profile acceptance.
7. Light and dark review at 390 px, 768 px, 1024 px and 1440 px.
8. Production fingerprint confirmation.

The accepted route may replace `/index.html` only after these checks and after L1, scanner and L2 gateway connections are restored in the new interface.
