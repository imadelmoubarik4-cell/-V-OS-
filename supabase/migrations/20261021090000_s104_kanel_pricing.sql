-- S104 KANEL Pricing & Profitability — persistence layer for the Menu Pricing
-- module (Finance › Menu Pricing), per the KANEL Pricing & Profitability prompt
-- and the V07 Price-Lock + On-Request Classics addendum.
--
-- Scope of THIS migration (DB layer): the pricing baseline profile (versioned
-- assumptions + the monthly expense ledger), products reconciled by canonical SKU,
-- the owner-locked printed price snapshot (immutable, effective-dated), the margin
-- exceptions register, the staff-only on-request classics draft catalogue, a price
-- approval trail, and an append-only audit. The calculation engine lives in the
-- browser/Node (apps/web/assets/js/kanel-pricing-engine.js) and is the single source
-- of truth for the maths; this schema stores inputs, owner decisions and evidence.
--
-- SINGLE-VENUE app (VÁ Bar / KANEL ehf.), consistent with S103: isolation is by role,
-- not by tenant, and there is no multi-tenant RLS. A `venue_id` column (default
-- 'kanel') is carried on keyed tables so products/prices reconcile by (venue_id, sku)
-- and never duplicate — honouring the V07 rule "reconcile by exact canonical SKU and
-- venue id; never create duplicate menu products" and leaving room for future venues.
--
-- Security model = the S92/S94/S98/S103 private gateway pattern (Pattern A): every
-- table lives in atlas_private with RLS on and a service-role-only policy; the browser
-- holds no grant and never reaches these tables. Confidential supplier costs, margins,
-- overhead and financing never leave a SECURITY DEFINER gateway RPC to a public caller.
-- Admin/manager only (bartenders and ordinary staff gain no access).
--
-- SAFETY (prompt constraints):
--   * Ships DORMANT. No production rows are written here. The module is feature-flagged
--     in the client (VABAR_CONFIG.KANEL_PRICING_ENABLED) and off the critical path.
--   * NEVER auto-publishes to POS/menu: pos_published defaults false everywhere and NO
--     code path in this migration sets it true. Publication is a future, owner-gated,
--     explicitly-authorized action — out of scope here.
--   * Locked price snapshots are IMMUTABLE and effective-dated (append-only; update and
--     delete are revoked). Unfreeze/reprice is only ever a NEW versioned snapshot.
--   * Non-destructive + re-runnable: create ... if not exists, drop-then-create policies
--     and triggers, create or replace functions.
--
-- Time zone: VÁ is Atlantic/Reykjavik (UTC year-round); instants are timestamptz in UTC.

set lock_timeout = '5s';
set statement_timeout = '2min';

-- 1. Tables (atlas_private) -------------------------------------------------------

-- Versioned pricing baseline: the assumptions and the monthly expense ledger that the
-- engine prices against. Exactly one row is active; a new version supersedes the old
-- (old rows are kept for audit). `assumptions` and `expenses` mirror the engine's
-- DEFAULT_PROFILE shape (rates as fractions; expenses as {key,label,category,
-- monthlyEffective,monthlyCash,vatRecoverable,source}).
create table if not exists atlas_private.pricing_profiles (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  version text not null,
  is_active boolean not null default false,
  currency text not null default 'ISK',
  sales_vat_rate numeric(6,4) not null default 0.11 check (sales_vat_rate >= 0 and sales_vat_rate < 1),
  turnover_rent_pct numeric(6,4) not null default 0.09 check (turnover_rent_pct >= 0 and turnover_rent_pct < 1),
  loan_collection_pct numeric(6,4) not null default 0.15 check (loan_collection_pct >= 0 and loan_collection_pct < 1),
  loan_collection_base text not null default 'gross_incl_vat'
    check (loan_collection_base in ('gross_incl_vat','net_ex_vat','card_only','settlement')),
  card_share numeric(6,4) not null default 0.90 check (card_share >= 0 and card_share <= 1),
  merchant_fee_pct numeric(6,4) not null default 0.02 check (merchant_fee_pct >= 0 and merchant_fee_pct < 1),
  employer_cost_pct numeric(6,4) not null default 0.35 check (employer_cost_pct >= 0 and employer_cost_pct < 1),
  target_cash_surplus_pct numeric(6,4) not null default 0.05,
  waste_pct numeric(6,4) not null default 0.03,
  garnish_per_serving numeric(12,2) not null default 20,
  forecast_monthly_net numeric(14,2) not null check (forecast_monthly_net > 0),
  historical_monthly_net numeric(14,2),
  monthly_overhead numeric(14,2),
  assumptions jsonb not null default '{}'::jsonb,
  expenses jsonb not null default '[]'::jsonb,
  source text,
  note text,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_profiles_version_unique unique (venue_id, version)
);
-- At most one active profile per venue.
create unique index if not exists pricing_profiles_one_active
  on atlas_private.pricing_profiles (venue_id) where is_active;

-- A sellable product reconciled by canonical SKU. Links to the existing inventory item
-- or recipe by reference where known (no duplicate entities invented). cost sources are
-- resolved by the engine/edge function; this row carries the reconciliation identity.
create table if not exists atlas_private.pricing_products (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  sku text not null,
  product text not null check (char_length(btrim(product)) between 1 and 160),
  category text,
  recipe_id uuid references public.recipes(id) on delete set null,
  inventory_item_id uuid,
  is_active boolean not null default true,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_products_sku_unique unique (venue_id, sku)
);

-- IMMUTABLE owner-locked printed price snapshot. One row per (venue, snapshot_version,
-- sku). Prices are frozen exactly to the owner's decision and effective-dated. Locking
-- is NOT commercial sign-off; the modeled_* columns and financial_flag carry the model's
-- own verdict so warnings survive the lock. pos_published stays false (no auto-publish).
create table if not exists atlas_private.pricing_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  snapshot_version text not null,
  sku text not null,
  product text not null,
  category text,
  guest_menu text,
  guest_price_incl_vat numeric(12,2) not null check (guest_price_incl_vat >= 0),
  sales_vat_rate numeric(6,4) not null default 0.11,
  owner_locked boolean not null default true,
  locked_on date,
  source_version text,
  cost_evidence text,
  modeled_cost numeric(12,2),
  modeled_cash_margin numeric(8,4),
  model_5pct_price_floor numeric(12,2),
  financial_flag text,
  pos_published boolean not null default false,
  note text,
  locked_by uuid,
  locked_by_label text,
  created_at timestamptz not null default now(),
  constraint pricing_snapshot_unique unique (venue_id, snapshot_version, sku)
);
create index if not exists pricing_snapshot_version_idx
  on atlas_private.pricing_price_snapshots (venue_id, snapshot_version);

-- Margin exceptions register: owner-locked items below the forecast 5% cash floor. A
-- derived view over a snapshot; kept as rows so the owner-only register is queryable
-- and auditable. Severity mirrors the workbook (UNDER CASH TARGET / NEGATIVE CASH MODEL).
create table if not exists atlas_private.pricing_margin_exceptions (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  snapshot_version text not null,
  sku text not null,
  item text not null,
  category text,
  locked_price numeric(12,2) not null,
  cash_5pct_floor numeric(12,2),
  gap numeric(12,2),
  cash_margin numeric(8,4),
  severity text,
  created_at timestamptz not null default now(),
  constraint pricing_exception_unique unique (venue_id, snapshot_version, sku)
);

-- STAFF-ONLY on-request classics draft catalogue. Never on the printed menu; never
-- published to POS without explicit owner price approval. price_status stays a proposal
-- until an approval row flips it (future, owner-gated). pos_published stays false.
create table if not exists atlas_private.pricing_classics (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  catalogue_version text not null,
  sku text not null,
  name text not null,
  service_scope text,
  printed_menu boolean not null default false check (printed_menu = false),
  price_status text not null default 'PROPOSAL - NEEDS OWNER PRICE APPROVAL',
  previous_v06_price numeric(12,2),
  proposed_price_incl_vat numeric(12,2),
  calculated_minimum_5pct numeric(12,2),
  estimated_portion_cost numeric(12,2),
  estimated_raw_gross_margin numeric(8,4),
  estimated_cash_margin numeric(8,4),
  recipe_provenance text,
  cost_status text,
  pos_published boolean not null default false,
  approved_by uuid,
  approved_by_label text,
  approved_at timestamptz,
  cautions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_classic_unique unique (venue_id, catalogue_version, sku)
);

-- Price approval trail (append-only): who proposed/locked/approved which price, old→new,
-- effective date. A record of authority; it never itself changes a live price or POS.
create table if not exists atlas_private.pricing_price_approvals (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  sku text not null,
  scope text not null check (scope in ('locked_menu','classic')),
  action text not null check (action in ('locked','approved','unfrozen','repriced','rejected')),
  previous_price numeric(12,2),
  new_price numeric(12,2),
  snapshot_version text,
  effective_on date,
  actor_id uuid,
  actor_label text,
  actor_role text,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists pricing_approvals_sku_idx
  on atlas_private.pricing_price_approvals (venue_id, sku, created_at);

-- Generic append-only audit for the module (reads of confidential data, imports, edits).
create table if not exists atlas_private.pricing_audit (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null default 'kanel',
  actor_id uuid,
  actor_label text,
  actor_role text,
  action text not null,
  entity text,
  entity_ref text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pricing_audit_created_idx
  on atlas_private.pricing_audit (created_at);

-- 2. RLS, grants, timestamp + append-only triggers -------------------------------

do $grants$
declare t text;
begin
  foreach t in array array[
    'pricing_profiles','pricing_products','pricing_price_snapshots','pricing_margin_exceptions',
    'pricing_classics','pricing_price_approvals','pricing_audit'
  ] loop
    execute format('alter table atlas_private.%I enable row level security', t);
    execute format('drop policy if exists %I on atlas_private.%I', 'service role manages ' || replace(t, '_', ' '), t);
    execute format('create policy %I on atlas_private.%I for all to service_role using (true) with check (true)',
      'service role manages ' || replace(t, '_', ' '), t);
    execute format('revoke all on atlas_private.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on atlas_private.%I to service_role', t);
    execute format('revoke truncate, references, trigger on atlas_private.%I from service_role', t);
  end loop;
end
$grants$;

drop trigger if exists pricing_profiles_touch on atlas_private.pricing_profiles;
create trigger pricing_profiles_touch before update on atlas_private.pricing_profiles
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists pricing_products_touch on atlas_private.pricing_products;
create trigger pricing_products_touch before update on atlas_private.pricing_products
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists pricing_classics_touch on atlas_private.pricing_classics;
create trigger pricing_classics_touch before update on atlas_private.pricing_classics
  for each row execute function atlas_private.touch_updated_at();

-- Locked price snapshots, approvals and audit are APPEND-ONLY (S96 pattern): once a
-- price is locked it is immutable; a change is a new snapshot/approval row.
revoke update, delete, truncate on atlas_private.pricing_price_snapshots from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.pricing_price_snapshots;
create trigger s96_append_only before update or delete on atlas_private.pricing_price_snapshots
  for each row execute function private.audit_append_only('sku', 'snapshot_version');
drop trigger if exists s96_append_only_no_truncate on atlas_private.pricing_price_snapshots;
create trigger s96_append_only_no_truncate before truncate on atlas_private.pricing_price_snapshots
  for each statement execute function private.audit_append_only();

revoke update, delete, truncate on atlas_private.pricing_price_approvals from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.pricing_price_approvals;
create trigger s96_append_only before update or delete on atlas_private.pricing_price_approvals
  for each row execute function private.audit_append_only('sku');
drop trigger if exists s96_append_only_no_truncate on atlas_private.pricing_price_approvals;
create trigger s96_append_only_no_truncate before truncate on atlas_private.pricing_price_approvals
  for each statement execute function private.audit_append_only();

revoke update, delete, truncate on atlas_private.pricing_audit from service_role, authenticated, anon;
drop trigger if exists s96_append_only on atlas_private.pricing_audit;
create trigger s96_append_only before update or delete on atlas_private.pricing_audit
  for each row execute function private.audit_append_only();
drop trigger if exists s96_append_only_no_truncate on atlas_private.pricing_audit;
create trigger s96_append_only_no_truncate before truncate on atlas_private.pricing_audit
  for each statement execute function private.audit_append_only();

-- 3. Helpers (atlas_private) ------------------------------------------------------

-- The actor the gateway passes must be an active profile with the claimed role. Pricing
-- is admin/manager only. Returns a safe display label (never an email). Trusted-server
-- re-check — the browser-sent id/role is never trusted.
create or replace function atlas_private.pricing_require_manager(p_actor_id uuid, p_actor_role text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare actor record; label text;
begin
  if p_actor_id is null then
    raise exception 'A signed-in Alcedo profile is required.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  select p.id, p.role::text as role, p.active, p.display_name into actor
  from public.profiles p where p.id = p_actor_id;
  if actor.id is null or actor.active is not true or actor.role is distinct from p_actor_role then
    raise exception 'This Alcedo profile cannot access Menu Pricing.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  if p_actor_role not in ('admin','manager') then
    raise exception 'Menu Pricing is for managers and administrators.' using errcode = '42501', hint = 'atlas:forbidden';
  end if;
  label := case
    when actor.display_name is null or pg_catalog.btrim(actor.display_name) = '' or pg_catalog.strpos(actor.display_name, '@') > 0 then 'Manager'
    else pg_catalog.left(pg_catalog.btrim(actor.display_name), 120) end;
  return label;
end
$function$;
revoke all on function atlas_private.pricing_require_manager(uuid, text) from public, anon, authenticated;

-- 4. Gateway RPC (public, SECURITY DEFINER, service_role only) --------------------

-- A single read for the dashboard: the active profile + the price-lock counts. It never
-- exposes row-level supplier costs to a browser; the Edge Function calls it as the
-- resolved actor. (Writes — import, lock, approve — are added with the Edge Function in
-- a later step; nothing here publishes to POS.)
create or replace function public.atlas_pricing_overview(p_actor_id uuid, p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare label text; result jsonb;
begin
  label := atlas_private.pricing_require_manager(p_actor_id, p_actor_role);
  insert into atlas_private.pricing_audit (actor_id, actor_label, actor_role, action, entity)
    values (p_actor_id, label, p_actor_role, 'read_overview', 'pricing');
  select jsonb_build_object(
    'profile', (select to_jsonb(pp) - 'created_by' from atlas_private.pricing_profiles pp
                where pp.is_active order by pp.created_at desc limit 1),
    'counts', jsonb_build_object(
      'locked', (select count(*) from atlas_private.pricing_price_snapshots),
      'exceptions', (select count(*) from atlas_private.pricing_margin_exceptions),
      'classics', (select count(*) from atlas_private.pricing_classics),
      'products', (select count(*) from atlas_private.pricing_products)
    )
  ) into result;
  return result;
end
$function$;
revoke all on function public.atlas_pricing_overview(uuid, text) from public, anon, authenticated;
grant execute on function public.atlas_pricing_overview(uuid, text) to service_role;

-- NOTE: No data is seeded. The module ships dormant and feature-flagged. The owner
-- price snapshot the UI renders today is the committed, read-only file
-- apps/web/assets/data/kanel-price-lock-v07.json; persisting it through these tables
-- (with a lock/approve audit trail) is the next increment, behind owner authorization.
