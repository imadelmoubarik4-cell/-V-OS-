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
