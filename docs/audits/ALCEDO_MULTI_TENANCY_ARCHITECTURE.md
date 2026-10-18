# ALCEDO — Multi-Organization / Multi-Location Architecture Report

**Date:** 2026-10-18 · **Status:** design + risk assessment (no code). Release-blocking security work; **do not** ship as an "Add Location button on the single-venue DB."

## 1. Current reality (audited, evidence-based)
Alcedo is **single-tenant to the bone.** Of **187 domain tables** (170 `atlas_private` + 17 `public`), exactly **7** carry any tenant-like column — the S104 `pricing_*` tables' `venue_id text default 'kanel'` — and even those are **not** isolation-enforcing (the column exists only for SKU uniqueness, never in an RLS predicate). S103 bookings states it explicitly: *"no venue_id anywhere; isolation is by role, not tenant."*

Structural single-tenant assumptions:
- **Auth boundary:** `resolveActor()` (`_shared/auth.mjs`) returns `userId/email/role/active` — **no org/location**. Every SECURITY DEFINER RPC takes only `p_actor_id`/`p_actor_role` and reads the single global dataset. Authorization is pure role.
- **Storage:** 7 shared buckets; policies are `bucket_id + auth.uid()`; path prefixes are per-user, never per-tenant.
- **AI:** conversations are user-scoped and read the one global operational dataset — would leak across tenants.
- **Integrations (hard blocker):** `integration_connections.provider_key` is the **primary key** → exactly one credential set per provider for the whole app; a second tenant collides on day one.
- **Settings singletons:** `settings_business_hours.weekday` PK, `section_key` PK, `offer_key`, `role_key` — one config for everyone.
- **Frontend:** single global `window.VABAR_CONFIG`; UI speaks of "the venue"; no switcher.
- **Naming trap:** `public.inventory_locations` (S97) already means *storage bins*, not venues. The tenant model must use a distinct term (`sites`/`org_location`).

## 2. Proposed model (minimal, non-destructive)
Three new tables; no existing column changed on day one:
- `public.organizations` — tenant/billing boundary (e.g. "KANEL ehf.").
- `public.locations` — `org_id` FK, `time_zone`, etc. (a physical venue; named away from `inventory_locations`).
- `public.memberships` — `user_id × org_id × (nullable) location_id × role × active`, unique per triple. A user can belong to several orgs/locations.

**Roles layered on membership:** `platform_admin` (cross-org, Alcedo operator), `org_owner`/`org_admin` (all locations in an org), `location_manager` (≈ today's `manager`), `staff` (≈ `bartender`/`viewer`). Platform admin access is explicit, authorized and **audited**.

Domain tables gain **nullable** `org_id`/`location_id` (operational tables scope by `location_id`; cross-location config by `org_id`), backfilled before being promoted to `NOT NULL`.

## 3. Isolation enforcement (why frontend filtering is insufficient)
Under Pattern A the browser holds **no** table grants and the **service role bypasses RLS**, so table-level RLS alone cannot isolate tenants and client-side filtering is meaningless — a crafted request to a global RPC would still read another tenant's rows. Isolation must live at the **RPC/actor boundary**, mirroring today's role gate:
1. Extend `resolveActor()` to attach the caller's memberships; the Edge handler passes a **server-chosen** `p_location_id` (from the active membership / a validated header checked against memberships) — never browser-asserted, exactly as `p_actor_role` is server-resolved today.
2. Every RPC gains `p_location_id` and, as its first act, calls a new `private.actor_in_location(p_actor_id, p_location_id)` guard, then filters every query by it.
3. Add RLS predicates on private tables as **defense-in-depth** via a membership helper, so a future direct-grant mistake still can't cross tenants.

## 4. Non-destructive migration of existing KANEL data
A forward-only, idempotent `s105_tenant_foundation` migration: create the 3 tables; seed one default org "KANEL ehf." + one default location (fixed, recorded UUIDs; tz `Atlantic/Reykjavik`); create a membership per existing `profiles` row (map `staff_role`→tenant role); add nullable `org_id`/`location_id` to domain tables and backfill all existing rows to the default org/location. **Preserve every historical identifier** — no PK/UUID/SKU/snapshot rewritten. S104 `venue_id='kanel'` rows map to the default location; keep `venue_id` as-is for SKU back-compat and add `location_id` alongside. Promote to `NOT NULL` + composite keys only in a later, verified migration.

## 5. Per-module isolation test matrix (must pass before any 2nd tenant)
Fixtures: Org A/Location A1 and Org B/Location B1 with distinct staff. For every module assert A cannot **read or modify** B (and vice versa), org_owner sees only their org, inactive membership loses access, and a dual-org user sees each only in context:
Inventory & movements & storage-bins · Stock counts · Recipes/menu/flavor · Suppliers/POs/receipts · Bookings · Shifts/availability/time-off · Team messages/channels/profiles/photos · Training/knowledge · Accounting/exports · Pricing (snapshots/classics/approvals/audit) · Marketing · Integrations/credentials · AI conversations/brain · Settings/hours/offers · Storage (every bucket, path membership check). Platform-admin cross-org access is explicit + audited.

## 6. Staged rollout
1. **Reconcile the S104 ledger first** (issue #124) — do not stack schema changes on a drifted ledger.
2. **S105 tenant foundation (dormant):** tables + default org/location + membership backfill + nullable scoping columns. App stays single-tenant; no behaviour change.
3. **Enforcement layer:** extend `resolveActor` + `actor_in_location` + thread `p_location_id` through RPCs **module-by-module** (bookings/inventory/stock first, then accounting/pricing), each behind a flag defaulting to the single default location.
4. **Storage:** new object paths carry a location segment; keep old paths readable; update bucket policies to membership checks.
5. **Integrations:** restructure `integration_connections`/`_credentials` to per-location (composite key); migrate the single KANEL connection to the default location.
6. **Promote NOT NULL + composite keys; cross-tenant RLS defense-in-depth; location switcher; per-location settings.**
7. **Full isolation matrix green** before onboarding any paying tenant.

## 7. Biggest risks
- **Integrations one-per-provider PK** — genuine structural break; highest effort.
- **Singleton settings** — must become per-location composite keys.
- **Large SECURITY DEFINER surface** (26 functions, hundreds of RPCs) — a single missed RPC is a silent cross-tenant leak; the service role bypasses table RLS, so the `actor_in_location` guard must be added everywhere.
- **Storage path migration** — must preserve existing `storage_path` references.
- **AI data leakage** — scoping must cover the AI tool layer, not just CRUD.
- **`venue_id='kanel'` is a false friend** — looks like tenancy, enforces nothing; don't reuse it as the tenant key.
- **Ledger/history divergence** (166 files vs 98 prod rows) — migrations must be forward-only + idempotent.

## 8. Scenarios covered
- **A — existing business, second location:** new `location` under the same `org`; owners with org-wide membership access both; data separate per location.
- **B — new restaurant buys Alcedo:** new `org` + first `location` + owner invitation; fully isolated from KANEL and every other customer.

## 9. Cost
Shared isolated platform (one Supabase project) → marginal cost per new location/customer ≈ real usage (storage/AI/egress), not a fixed per-project floor. Add per-org usage metering + spend caps (extend S100's pattern) before paid onboarding. Full numbers in `ALCEDO_COST_OPTIMIZATION.md` §per-tenant.

## 10. Recommendation
This is a multi-release program, not a cleanup-PR item. Approve the **S104 ledger reconciliation** and the **S105 dormant tenant-foundation migration + enforcement design** as the first reviewed step; build enforcement module-by-module behind flags; keep multi-tenant features unavailable to customers until the isolation matrix passes. No production schema/auth change proceeds without your explicit authorization.
