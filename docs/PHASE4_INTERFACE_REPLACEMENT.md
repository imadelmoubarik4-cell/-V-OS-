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

The foundation provides:

- production Supabase session recovery and password sign-in;
- canonical `public.profiles` access verification;
- real role-permitted inventory reads;
- one static shell with no DOM mutation observer or polling renderer;
- light and dark modes;
- responsive sidebar and mobile navigation;
- command palette;
- Service Mode shell;
- read-only ordinary Inventory presentation;
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

No screenshot fixture quantities, forecasts, supplier orders, operational status or other mock production facts are introduced.

## Phase 4.1 — L1 stock-count gateway reconnection

The first workflow reconnection mounts the existing Checkpoint L1 stock-count contract directly inside the Inventory workspace. It does not load the legacy Inventory page, create a second shell, or introduce a replacement backend.

The `/next.html` Inventory workspace now has two presentation states:

- **Items** — the existing role-permitted, read-only Inventory table/cards;
- **Stock count** — the existing L1 evidence workflow reached through the deployed `atlas-stock-counts` Edge Function.

The Start stock count action and the Service Mode Stock count action both open this same workspace. The phone scanner is deliberately not included; it remains Phase 4.2.

### Authentication and gateway boundary

`atlas-next-gateway-bridge.js` captures the one production Supabase client created by the existing `/next.html` runtime, then restores the original `createClient` function. It does not create a second client or expose the client, access token, or private credentials globally.

For each gateway request it:

1. obtains the current production Auth session from that existing client;
2. sends the session access token as `Authorization: Bearer <user-jwt>`;
3. permits only HTTPS requests to the approved Atlas private-runtime host;
4. permits only `/functions/v1/atlas-*` gateway paths and GET/POST methods;
5. applies a bounded request timeout and visible error handling.

The browser does not access `atlas_private`, a service-role credential, or a private table. The deployed gateway revalidates the production Auth user and active `public.profiles` role before it performs any private operation.

### Connected L1 capabilities

The replacement interface now supports the gateway’s existing capabilities:

- load count-session and verified-balance snapshots;
- start all-inventory, location, or category sessions;
- open count-session detail;
- record manual observations;
- preserve original input quantity and selected unit;
- preserve staff, timestamp, capture-surface and note evidence;
- show current, stale, historical and unverified quantity states;
- skip inaccessible lines with a reason;
- submit completed sessions;
- allow manager verification, rejection and conflict acknowledgement;
- cancel sessions while preserving audit evidence;
- prepare a manager publication plan;
- expose Publish only when both gateway permission and deployment policy enable it.

Historical opening inventory is never presented as current stock.

### Safety boundary

Ordinary Inventory remains read-only. L1 browser requests go only to the existing authenticated Edge Function.

- starting and editing a count writes private count evidence only;
- submission and manager verification do not mutate live inventory;
- the browser never calls `adjust_inventory`, writes `inventory_items`, or invokes private RPCs directly;
- automatic inventory adjustment remains disabled;
- production publication is a separate manager-only action, requires a prepared publication plan, and remains disabled unless its deployment environment flag and gateway permission are both true;
- no schema, migration, RLS, role, grant, Edge Function or Supabase configuration was changed for this reconnection.

### Phase 4.1 file boundary

The reconnection changes only:

- `apps/web/next.html`;
- `apps/web/assets/js/atlas-next-gateway-bridge.js`;
- `apps/web/assets/js/atlas-next-stock-counts.js`;
- `apps/web/assets/css/atlas-next-stock-counts.css`;
- focused Node and Python contracts;
- this documentation and the matching release acceptance record.

It does not change:

- `apps/web/index.html`;
- `apps/web/assets/js/atlas-next.js`;
- `apps/web/assets/js/data/atlas-data.js`;
- any file below `supabase/`;
- the deployed gateway or database.

## Performance contract

The replacement route must not:

- initialize the old Atlas interface;
- initialize the retired Phase 4 overlay;
- render more than one login screen;
- use `MutationObserver` to rebuild the shell;
- use a polling renderer;
- leave the boot spinner visible after a timeout or startup failure.

Session recovery remains bounded to 15 seconds. Initial Inventory reads remain bounded to 12 seconds. L1 gateway calls are separately bounded and fail into a visible state rather than an endless spinner.

## Migration sequence

1. Accept fast authentication and real inventory reads on `/next.html`.
2. Connect L1 stock counts through the existing authenticated gateway. **Implemented in Phase 4.1.**
3. Connect the phone scanner through its existing gateway.
4. Connect L2 item master through its existing gateway.
5. Connect Operations checklist and temperature workflows.
6. Connect Recipes, Purchasing, Brain, Reports, Knowledge and Connection Center one workspace at a time.
7. Run complete role, device, CI, migration-replay and production-fingerprint acceptance.
8. Replace `/index.html` only after the connected interface is accepted.
9. Remove legacy presentation assets only after release rollback evidence is preserved.

## Acceptance before production replacement

- the login appears once;
- the initial route becomes usable or visibly fails within 15 seconds;
- active and inactive profile behavior is verified for every supported role;
- Inventory displays real role-permitted records and has no direct quantity editor;
- L1 is accepted for administrator, manager, bartender and viewer permissions;
- count observations, submission and verification leave production inventory unchanged;
- publication remains unavailable unless the explicit production gate is enabled;
- command palette, theme, Service Mode and mobile navigation work;
- light and dark layouts pass at 390 px, 768 px, 1024 px and 1440 px;
- no old interface is visible behind the replacement route;
- the production inventory fingerprint remains unchanged outside an explicitly approved publication acceptance test.
