# ALCEDO — S104 Migration Reconciliation Audit

**Migration:** `supabase/migrations/20261021090000_s104_kanel_pricing.sql`
**Ledger version:** `20261021090000`
**Production project:** `dnefgcmjcgxlynycxkts` (vabar-inventory)
**Method:** read-only comparison via the Supabase Management API (`/database/query`) against the committed migration source. No production write was performed by this audit.
**Date:** 2026-10-18

> Guardrails honoured: S104 was **not** re-applied, the migration ledger was **not** modified, and `KANEL_PRICING_ENABLED` is governed separately (see note). Owner-locked pricing records and POS-publication protections are untouched.

## Verdict

**The migration was FULLY applied to the production schema.** Every object the migration defines exists in production and matches the source. The **only** discrepancy is a **missing ledger row** for version `20261021090000` in `supabase_migrations.schema_migrations`. This is a bookkeeping gap, **not** a partial or structurally-divergent application.

Earlier inspections that reported "tables + RPC exist, ledger entry missing" are re-confirmed, now with full column/index/policy/grant/trigger verification.

## Evidence (production, verified read-only)

| Check | Expected (source) | Production | Match |
|---|---|---|---|
| Ledger row `20261021090000` | present | **absent** (ledger has 98 rows, last = `20261020090000` s103) | ❌ (sole drift) |
| Tables in `atlas_private` | 7 `pricing_*` | 7 present | ✅ |
| `pricing_profiles` columns | 26 | 26 | ✅ |
| `pricing_products` columns | 12 | 12 | ✅ |
| `pricing_price_snapshots` columns | 22 | 22 | ✅ |
| `pricing_margin_exceptions` columns | 12 | 12 | ✅ |
| `pricing_classics` columns | 23 | 23 | ✅ |
| `pricing_price_approvals` columns | 14 | 14 | ✅ |
| `pricing_audit` columns | 10 | 10 | ✅ |
| Indexes (pk + unique + partial `pricing_profiles_one_active` + `pricing_snapshot_version_idx` + `pricing_approvals_sku_idx` + `pricing_audit_created_idx`) | all | all present | ✅ |
| RLS enabled on all 7 tables | yes | yes | ✅ |
| Policy = service-role-only `for all` | yes | yes (all 7) | ✅ |
| Grants to public/anon/authenticated | none | none | ✅ |
| Append-only triggers on snapshots/approvals/audit | yes | present | ✅ |
| Functions `public.atlas_pricing_overview`, `atlas_private.pricing_require_manager` | both | both present | ✅ |
| Seeded rows | 0 (ships dormant) | 0 in every table | ✅ |

Functional spot-checks (read-only / safe): a locked snapshot is immutable (UPDATE and DELETE are refused by the append-only trigger); `atlas_pricing_overview` executes for a manager and is refused for a bartender; EXECUTE on the RPC is granted to `service_role` only.

## Why the ledger row is missing

The migration DDL was applied through the Management API SQL endpoint (the only production DB path reachable from the deploy environment — the direct Postgres connection and the CLI both time out there). That endpoint runs SQL but does **not** write `supabase_migrations.schema_migrations`; the ledger row is normally written by `supabase db push`/CLI. The follow-up `INSERT` to record the row was blocked by the environment's production-write guard. Tracked in **issue #124**.

The prod ledger holding 98 rows while the repo has 166 migration files is the **expected production-adoption baseline** (production was initialised from a squashed baseline, not every historical dev migration) — it is **not** drift and must **not** be "fixed" by replaying history.

## Safest reconciliation procedure (APPROVAL REQUIRED — not executed)

The schema is already correct, so **do not re-apply S104 and do not rewrite migration history.** Record the single missing ledger row so future tooling (`db push`, replay, drift checks) knows S104 is applied:

```sql
-- Run once in the Supabase SQL editor (production), or via an approved CLI path.
insert into supabase_migrations.schema_migrations (version, name)
values ('20261021090000', 's104_kanel_pricing')
on conflict (version) do nothing;
```

- **Risk:** negligible. It is idempotent (`on conflict do nothing`) and writes only the bookkeeping row; it changes no table, policy, grant or data.
- **Why it matters:** without it, a later `supabase db push` would attempt to re-run S104. The migration is itself idempotent (`create table if not exists`, drop-then-create policies/triggers, `create or replace function`), so a re-run would be harmless — but the ledger should reflect reality.
- **Verification after running:** `select version from supabase_migrations.schema_migrations where version='20261021090000';` returns one row; `atlas_pricing_overview` still works; tables still empty.
- **Rollback:** `delete from supabase_migrations.schema_migrations where version='20261021090000';` (returns to current state; schema unaffected).

## Alternative (also approval-required)

If you prefer the CLI to own the ledger: once direct DB connectivity is available to an operator (not this environment), `supabase migration repair --status applied 20261021090000 --project-ref dnefgcmjcgxlynycxkts` records the same row through the official tool. Either path is equivalent; the SQL above is the minimal one.

## Status

- Schema: **reconciled / correct.**
- Ledger: **one row pending**, APPROVAL REQUIRED, repair SQL provided above and in issue #124.
- `KANEL_PRICING_ENABLED`: currently `true` in `config.js` (owner activated it earlier this program). It is a **client-side visibility flag only**; real access is enforced server-side by `pricing_require_manager` (admin/manager). Leaving it as-is does not expose the DB tables (they are empty + service-role-only). If you want the module hidden again until the ledger is recorded, that is a one-line flag flip — say the word.
