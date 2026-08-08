# Phase 4B — Operational Interface Migration

Phase 4B applies the approved Claude Design language to the release-critical Atlas workflows without replacing their existing data, authorization, evidence or publication contracts.

## Source-of-truth split

- **Claude Design:** visual hierarchy, navigation, responsive behavior, interaction patterns, Service Mode and component language.
- **Current Atlas runtime:** Supabase Auth, `public.profiles`, RLS, Edge Functions, inventory movements, L1/L2 evidence, Checkpoint K, Checkpoint M and canonical connection health.

No Claude runtime, fixture business dataset, React/Babel runtime compiler or design sidecar is shipped.

## Delivered surfaces

### Home → Operations Hub

The separate Operations destination is retired from the visible navigation. Its existing live readiness, priorities, purchasing suggestions and checklist workspace is mounted into Home. Quick actions open the actual scanner, stock-count, item-master, recipe and purchasing workflows.

### Inventory

Inventory receives one in-page workspace structure:

- Items
- Stock count
- Item master
- Movements
- Waste

Displayed live quantities are read-only in the normal item list. The old plus/minus controls are hidden. Stock may change only through an already-authorized controlled workflow.

### L1 current stock counts

The existing authenticated L1 workspace is restyled for desktop, tablet and mobile. Phase 4B does not change its evidence model: count observations remain private, submission locks the session, and only manager verification/publication may create the approved inventory adjustment.

### L2 item master

The existing manager-only private draft queue is restyled without changing the L2 contract. L2 cannot change quantity or create an inventory movement.

### Barcode scanner

The current authenticated camera/manual scanner is presented as a responsive full-screen operational surface on mobile. Barcode lookup and count evidence still flow through the existing server gateway.

### Movements and Waste

Movement and explicit waste records are displayed from existing runtime evidence. Phase 4B does not infer waste, assign blame or add a new browser-side write path. If no approved waste gateway exists, the interface says so and performs no stock mutation.

### Recipes

The existing recipe library and editor retain their real inventory links, cost boundaries and availability logic. The visual intelligence surface is relabelled Atlas Brain and uses the approved robot icon.

### Purchasing

Purchasing is organised as Suppliers, Purchase drafts and Deliveries. Drafts reuse the existing deterministic replenishment suggestions but do not submit an order. Delivery entry continues to use the existing controlled manager workflow.

### Service Mode

Service Mode now exposes focused cards for quick stock review, stock counting, barcode scanning, recipes, checklists, the daily brief, waste review and manager delivery entry. Unsupported capabilities such as the 86 board are visibly disabled instead of simulated.

## Safety invariants

Phase 4B does not:

- access `atlas_private` directly from the browser;
- use or expose a service-role credential;
- call a new direct database mutation;
- reintroduce silent quantity editing;
- publish a stock count;
- submit a supplier order;
- publish social content;
- ingest POS sales;
- enable automatic execution;
- weaken CSP or RLS.

## Browser acceptance

Review in the exact PR Deploy Preview at 390 px, 768 px, 1024 px and 1440 px.

Required checks:

1. Home renders the Operations Hub without a duplicate Operations nav item.
2. Inventory tabs open Items, L1, L2, Movements and Waste.
3. Quantity inputs cannot be edited from the normal item list.
4. Scanner opens and closes correctly on phone and desktop.
5. L1 and L2 retain authenticated role boundaries.
6. Purchasing drafts have no supplier-submit action.
7. Waste clearly distinguishes recorded events from unexplained variance.
8. Service Mode cards open the intended real workspaces.
9. Light and dark themes remain readable.
10. No existing production inventory value changes during visual acceptance.
