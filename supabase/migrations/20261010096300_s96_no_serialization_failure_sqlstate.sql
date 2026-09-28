-- S96 (opsrisk): application errors must never use SQLSTATE 40001.
--
-- PostgREST runs every request in a transaction and automatically retries a
-- transaction that fails with SQLSTATE 40001 (serialization_failure). Several
-- Atlas RPCs used 40001 for a *deterministic* optimistic-concurrency refusal
-- ("this changed, refresh"): a retry can never succeed, so PostgREST retries
-- the same request forever, holding one pooled database connection and
-- writing an ERROR line per attempt.
--
-- Production evidence (S96, read-only): one PostgREST backend has been
-- "active" in a stale atlas_accounting_command call since 2026-09-26 01:18
-- UTC, raising 'document changed' (40001) ~100 times per second: 8.3 M and
-- 8.6 M postgres ERROR log lines on consecutive days. Every further stale
-- refusal (catalogue decide/withdraw, marketing reschedule/patch, accounting)
-- pins one more pool connection; a handful exhausts the Data API pool and
-- takes all of Atlas down.
--
-- Fix: rewrite every Atlas function body that raises errcode '40001' to raise
-- 'PT409' instead. PostgREST maps PTxyz to HTTP status xyz, so callers get a
-- 409 immediately; every Edge Function maps these errors by their
-- 'atlas:stale_request' / 'atlas:stale_item' hint, which is unchanged.
-- Accounting functions (production-only, PR #93 lineage) are excluded here and
-- fixed by the isolated accounting patch.

do $rewrite$
declare
  fn record;
  definition text;
  rewritten text;
begin
  for fn in
    select p.oid, n.nspname, p.proname
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'atlas_private', 'private')
      and p.prokind = 'f'
      and p.prosrc ~ 'errcode\s*=\s*''40001'''
      and p.proname !~ '^atlas_accounting'
  loop
    definition := pg_catalog.pg_get_functiondef(fn.oid);
    rewritten := pg_catalog.regexp_replace(definition, 'errcode\s*=\s*''40001''', 'errcode = ''PT409''', 'g');
    if rewritten is distinct from definition then
      execute rewritten;
      raise notice 's96: %.% now raises PT409 instead of 40001', fn.nspname, fn.proname;
    end if;
  end loop;
end
$rewrite$;
