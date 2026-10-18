# ALCEDO — Cost Optimization Report

**Date:** 2026-10-18 · **Method:** Supabase Management API (read-only) + repo/config inspection + invoice `QSKSEG-00004` reconciliation. No service was paused, downgraded or deleted.

## Current infrastructure (verified today, read-only)

| Resource | State (verified) | Notes |
|---|---|---|
| Supabase project `dnefgcmjcgxlynycxkts` (vabar-inventory) | `ACTIVE_HEALTHY`, **production** | referenced by `netlify.toml`, `config.js`, all runtime code. **KEEP.** |
| Supabase project `atialqebqxcquzdkezln` (atlas-pr30-validation) | `ACTIVE_HEALTHY`, **idle** | referenced **only** in staging/rehearsal docs + 2 tests (`rehearsal-boundary`, `security-supply-chain`), never production runtime. Retirement candidate. |
| Supabase branches (both projects) | **none** | the invoice's branching refs `cwazoxupbwxnixpmmlhx` / `uhbamqetppqmygesoeeh` no longer exist. |
| `pg_cron` jobs | **none** | nothing recurring burning compute. |
| Production DB size | tiny (largest table 2.7 MB; `storage.objects` 41 rows) | no bloat; no storage cleanup needed. |
| AI spend/rate controls | **present** (S100) | daily+monthly USD budget, token-bucket rate limit, per-user daily turn cap, append-only block log. |
| Netlify | publish dir `apps/web`; `prototypes/*` carry their **own** `netlify.toml` (separate standalone deploys) | current Netlify charges not retrievable from this environment (no Netlify token) — see risks. |

## Invoice `QSKSEG-00004` reconciliation (2 Sep – 1 Oct 2026)

| Line | Invoice | Current status |
|---|---|---|
| Supabase Pro subscription | $25.00 | **Ongoing** (base plan). |
| Branching compute | $18.31 | **STOPPED** — those branch projects are gone; no branches exist now. Not a current cost, and **not** a claimable "saving." |
| Compute after credits | $6.69 | Residual compute beyond the Pro credit — driven by the **second active project** (validation). |
| Due after VAT + credit note | $45.00 | one-off historical total. |

Historical per-project compute hours on the invoice (`cwazox…`/`uhbamq…` 675h each = the retired branches; `atial…` 518h; `dnefg…` 720h) are **historical**, not proof of current spend. Verified-current reality: 2 active projects, 0 branches.

## Cost-savings table

Columns: **Resource | Verified current cost | Proposed action | Expected monthly saving | Risk**

| Resource | Verified current cost | Proposed action | Expected monthly saving | Risk |
|---|---|---|---|---|
| `atlas-pr30-validation` project | Active compute beyond Pro credit (maps to the invoice's ~$6.69 "compute after credits"; exact current $ not re-pullable here) | **Pause** (reversible) after confirming no CI/rehearsal dependency, or **retire** with a backup. **APPROVAL REQUIRED.** | ~**$6–10 / mo** (potential, awaiting current-usage confirmation) | Low–med: used only by staging/rehearsal docs + 2 tests; see plan below |
| Supabase branching | **$0 now** (already stopped) | Keep the "open a branch only when needed, delete after test" discipline | $0 (already realized; **do not double-count** the historical $18.31) | none |
| Supabase Pro plan | $25 / mo | **Keep** — do not downgrade (loses PITR/backups, support, compute). | $0 (not recommended) | high if downgraded |
| AI / API spend | pay-per-use, already capped (S100) | Keep caps; add the 8s→15–30s unread-poll reduction (fewer background calls) | small (battery/egress; not a line item) | low |
| Frontend background polling | n/a (bandwidth) | `team-unread-badge` 8s→15–30s or Realtime; drop redundant 2.5s shell timer | marginal egress | low |
| Netlify previews/sites | unknown (no token here) | Audit sites/previews; retire abandoned previews after checking auth-callback/data deps | TBD — **cannot claim until current charges are confirmed** | low |

### Validation-project retirement plan (APPROVAL REQUIRED — not executed)
1. Confirm nothing in CI/workflows points at `atialqebqxcquzdkezln` at run time (repo refs are docs + 2 tests that only assert the app **rejects** that origin — they don't need the project live).
2. Take a backup (schema + any retained data) and record it.
3. **Pause** first (reversible) for one billing cycle; confirm no workflow breaks.
4. If clean, retire; keep the backup. Alternative test workflow: spin an ephemeral branch/preview on demand and delete after use (cheaper than a standing project).
Rollback: un-pause / restore from backup. Savings realize only after the pause is confirmed.

## Infrastructure cost per additional business/location (for the multi-tenant roadmap)

The multi-tenant audit recommends a **single, properly isolated shared platform** (one Supabase project), not a project-per-customer. Cost implication:

| Model | Base cost per new customer | Marginal cost per customer | Isolation |
|---|---|---|---|
| **Shared platform (recommended)** | ~$0 (no new project/plan) | DB storage (cents–$ / GB), storage objects, AI (metered, capped), auth emails, egress — all usage-based | Enforced at RPC/RLS layer (see architecture report) |
| Project-per-customer | ~$10/mo compute + Pro overhead **each** | same usage-based on top | Physical, but 10×+ cost and ops burden |

A shared platform keeps the marginal cost of an additional restaurant/location close to its real usage (likely a few $/mo for a small venue) instead of a fixed ~$10+/mo floor per project. **Add per-organization usage metering + spend caps** (extend the existing S100 AI budget pattern to storage/egress) before onboarding paying customers, so one tenant can't run up another's bill and each can be invoiced on real usage. Do **not** prioritize this consolidation over isolation — isolation is the release blocker (see `ALCEDO_MULTI_TENANCY_ARCHITECTURE.md`).

## Approvals required
- Pause/retire `atlas-pr30-validation`.
- Any Netlify site/preview retirement (after confirming current charges + auth/data deps).
- Do **not** downgrade Supabase Pro.

Nothing in this report was executed; all items above are proposals.
