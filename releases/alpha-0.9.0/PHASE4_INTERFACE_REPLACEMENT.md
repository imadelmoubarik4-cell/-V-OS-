# Phase 4 Interface Replacement — acceptance record

## Status

Implementation continues on `agent/phase4-interface-replacement`, based on the stable Phase 2 branch.

This record does not authorize merge, production migration, stock publication or release.

## Reason for the reset

The earlier Phase 4 overlay loaded a second presentation layer over the legacy application. Browser acceptance showed two login experiences alternating during startup and a spinner that remained for more than two minutes. That implementation strategy is retired.

## Replacement foundation

The `/next.html` route has one static presentation tree and does not load the old application or retired overlay.

It provides:

- one bounded boot screen;
- one production Supabase login and session-recovery path;
- active-profile verification through `public.profiles`;
- real, role-permitted inventory reads;
- read-only ordinary Inventory quantities;
- responsive navigation, command palette, theme and Service Mode;
- visible placeholders for workflows awaiting direct gateway connection.

## Phase 3 presentation-only implementation

The approved visual delta was applied without replacing the shell or changing the secure engine. It refined navigation, spacing, Home metrics, Inventory hierarchy, mobile cards, responsive breakpoints, light/dark Service Mode and the honest disabled notification state. It introduced no fixture quantities, forecasts, supplier orders, purchase states or simulated production facts.

## Phase 4.1 — L1 stock-count reconnection

Checkpoint L1 is now mounted as a Stock count subview inside the existing Inventory workspace.

Connected UI paths:

- Inventory → Start stock count;
- Inventory → Stock count section;
- Service Mode → Stock count.

The phone scanner is not part of this unit and remains the next separately reviewed gateway reconnection.

### Existing gateway used

The interface calls the already deployed `atlas-stock-counts` Edge Function. A small bridge reuses the exact production Auth client already created by `/next.html`, retrieves the current session, and forwards only the user JWT to the approved private-runtime gateway.

The bridge:

- does not create a second Supabase client;
- does not expose a service-role credential;
- does not expose `atlas_private` to the browser;
- validates the approved gateway host and `/functions/v1/atlas-*` path;
- permits only bounded GET and POST requests.

The deployed gateway remains responsible for active-profile and role validation and for all private RPC access.

### Connected workflow

- snapshot and session-detail reads;
- all, location and category count sessions;
- manual unit-aware count evidence;
- bottle, case, unit, litre, millilitre, kilogram and gram input;
- original and normalized quantity evidence handled by the existing gateway;
- skip, submit, manager verify, conflict acknowledgement, reject and cancel;
- manager publication-plan preparation;
- Publish visibility only when deployment policy and gateway permission both enable it.

The interface presents current, stale, historical and unverified quantity states explicitly.

### Safety evidence

- ordinary Inventory is still read-only;
- count observation and verification do not mutate production inventory;
- no browser code calls `adjust_inventory`, private RPCs, or direct Inventory writes;
- production publication remains a separate manager-only, double-gated action;
- publication remains disabled unless the existing deployment environment enables it;
- scanner functionality is not silently bundled into L1;
- no file under `supabase/` changed;
- no Edge Function, schema, migration, role, grant or RLS policy changed.

### Phase 4.1 files

- `apps/web/next.html`;
- `apps/web/assets/js/atlas-next-gateway-bridge.js`;
- `apps/web/assets/js/atlas-next-stock-counts.js`;
- `apps/web/assets/css/atlas-next-stock-counts.css`;
- `tests/node/atlas-next-stock-counts.test.js`;
- `tests/python/test_atlas_next_stock_count_reconnection.py`;
- Phase 4 documentation.

## Remaining acceptance

1. Browser JavaScript syntax.
2. Focused Node and Python L1 contracts.
3. Complete repository suites and migration replay.
4. Exact Netlify Deploy Preview for the updated draft PR.
5. One-login and bounded-startup acceptance.
6. Administrator, manager, bartender, viewer and inactive-profile acceptance.
7. L1 start, save, skip, submit, verify, reject and cancel acceptance.
8. Confirmation that production quantity and movement fingerprints remain unchanged during non-publication acceptance.
9. Light and dark review at 390 px, 768 px, 1024 px and 1440 px.
10. Separate review and authorization before beginning the phone-scanner reconnection.

The replacement route may not replace `/index.html` until these checks and the remaining approved gateway reconnections are complete.
