# A-ADMIN-01 — Low-privilege → Administrator takeover / Broken Function-Level Authorization
Consolidated from the authn, dbrls, edgea, aioauth agents and the main session's
`tests/sql/s96_aal2_direct_backend.sql`. All write-path tests ran on the local 147-migration
replay / Node handler harnesses; production checks were read-only. Attacker knows every route,
table, RPC and function name; UI hiding is not counted.

Identities: **N** = self-registered confirmed user, no Atlas role; **B** = bartender/lowest role;
**M** = manager; **A** = admin.

| Boundary | Identity | Result | Evidence |
|---|---|---|---|
| Self sign-up cannot obtain a role via metadata (`{"role":"admin"}`, `is_admin`) | N | CONTROL VERIFIED | handle_new_user md5==prod always yields role=viewer, active=false; s96_authn_gates.sql, dbrls |
| Direct PostgREST SELECT of business/profile rows | N | CONTROL VERIFIED | 0 rows from all 27 exposed tables/views; s96_authn_gates, s96_rls_ownership |
| Self-activation / self-role-escalation (UPDATE profiles) | N,B | CONTROL VERIFIED | UPDATE 0; only admins pass profiles UPDATE policy; dbrls, s96_authn_gates |
| Direct RPC (12 browser RPCs) | N,B | CONTROL VERIFIED | all 12 reject non-managers; dbrls s96_rls_ownership |
| Direct RPC (all authenticated-executable) as aal1 enrolled admin | A(aal1) | CONTROL VERIFIED | s96_aal2_direct_backend.sql: all 12 refused 42501; aal2 not refused |
| IDOR/BOLA with another user's ids (media, onboarding, profiles, messages) | B | CONTROL VERIFIED | cross-user rows return 0 / refused; dbrls, aioauth (conversation search 0 rows) |
| Admin-only reads: costs/margins via AI tools | B | CONTROL VERIFIED | tools role-gated server-side; staff never get cost/supplier fields; aioauth |
| Admin-only reads: costs via stock-count Edge gateway | B | **VULNERABLE→FIXED** | EDGEA-01 Medium: detail returned commercial fields to staff; fixed by 20261010092000 + gateway redaction; s96_stock_count_detail_redaction.sql |
| Admin-only writes: change own/other role, create/disable users | B,M | CONTROL VERIFIED | RLS + team-profiles requireManager; dbrls, authn |
| Approve privileged AI proposals (execute-action) | B, other user | CONTROL VERIFIED | not-found/forbidden; only approver finishes; command re-validated at execute; aioauth |
| Modify accounting state | B | CONTROL VERIFIED (deployed-source review) | accounting re-checks actor vs profiles; edgea isolated tests (deployed source) |
| Alter inventory/stock ledger directly | B,M | CONTROL VERIFIED | browser INSERT on inventory_movements revoked (dbrls 090200/opsrisk 096200); ledger only via reviewed RPCs |
| Change integrations/settings | B | CONTROL VERIFIED | integrations requireManager; settings save-role requireManager (+step-up); edgea/aioauth |
| Private Storage objects (cross-user/bucket) | N,B | CONTROL VERIFIED | storage RLS: aal1/staff insert refused; accounting/import buckets manager-only; s96_aal2_direct_backend, dbrls |
| Realtime subscribe to admin/other-user data | B | CONTROL VERIFIED (empty publication) + OWNER ACTION | supabase_realtime publication empty (no postgres_changes exposed); DBRLS-10 recommends private channels — owner setting |
| Tamper client fields role/user_id/actor_id/owner_id/venue_id/approved_by/is_admin/status | B,M | CONTROL VERIFIED | no authz reads user_metadata/app_metadata; service-role RPCs get actor from verified session, not body; dbrls DBRLS-08 (defence-in-depth note) |
| SECURITY DEFINER as escalation API | N,B | CONTROL VERIFIED | 0 public/atlas_private definers executable by anon/authenticated; 188 pin search_path; dbrls-secdef-table.md |
| MFA bypass: aal1 admin executes aal2-protected op by direct call | A(aal1) | CONTROL VERIFIED | s96_aal2_direct_backend.sql + s96_authn_gates.sql (RLS helpers require aal2 once enrolled) |

## Disposition
Every enumerated A-ADMIN-01 boundary is **independently proven** on the replay/harness, with the one
over-broad-read (EDGEA-01) fixed and regression-tested. The only residual is that these are
component-level proofs rather than one scripted end-to-end browser replay of a live low-priv JWT against
production (production is read-only; write-path escalation cannot be run there). No boundary is left
unproven, so no item is `could_be_high`. **A-ADMIN-01 disposition: CONTROL VERIFIED (consolidated); no
demonstrated low-privilege → admin path.** Residual note carried to the gate report: a single automated
end-to-end script is not present; each boundary is covered by its own negative regression test.
