#!/usr/bin/env node
// S96 (opsrisk): repeatable, read-only production drift check.
//
// Compares what is deployed on a Supabase project with what Git says should
// be deployed, and reports security-relevant platform settings against the
// S96 policy. It never writes: it only issues GET requests to the Management
// API and SQL with {"read_only": true}. It never prints secret values and
// deliberately avoids endpoints that return them (for example
// GET /v1/projects/{ref}/postgrest returns the legacy JWT secret).
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=... node scripts/verify_s96_production_drift.mjs \
//     --project dnefgcmjcgxlynycxkts \
//     [--replay-db postgresql://postgres@127.0.0.1:55432/vaos_replay] \
//     [--baseline releases/production-drift-baseline.json] [--write-baseline FILE] \
//     [--json]
//
//   --replay-db   a loopback database with every repo migration replayed
//                 (scripts/verify_full_migration_replay.sh). Enables the
//                 function-definition and policy fingerprint comparison.
//   --baseline    a previously written baseline (deployed function ezbr
//                 sha256 per slug and the catalogue fingerprints). Any
//                 difference is drift: someone deployed or changed SQL
//                 outside the recorded release.
//
// Exit code: 0 = no drift and policy met; 1 = drift or policy violation;
// 2 = the check itself could not run.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.supabase.com/v1";

// Supabase's own "auto-enable RLS" event trigger function (public.rls_auto_enable,
// event trigger ensure_rls) and extension-owned functions are excluded from
// the catalogue comparison.
//
// Functions that are deployed from outside this repository on purpose.
// Keep this list short and reviewed; everything else must match Git.
const KNOWN_OUT_OF_REPO = new Set([
  "atlas-accounting",              // PR #93 lineage, deployed separately
  "atlas-import-worker",           // supabase/s33 runtime, deployed separately
  "atlas-backup-export-20260806",  // disabled 410 stub
]);

// S96 platform policy. Each rule reports the observed value and whether it
// meets the target. Values are configuration facts, never secrets.
const POLICY = [
  { id: "auth.site_url_is_production", read: (c) => c.auth.site_url, ok: (v) => /^https:\/\/os-vabar\.netlify\.app\/?$/.test(String(v)) },
  { id: "auth.redirects_no_deploy_previews", read: (c) => c.auth.uri_allow_list, ok: (v) => !/deploy-preview-/.test(String(v ?? "")) },
  { id: "auth.signup_disabled_or_captcha", read: (c) => ({ disable_signup: c.auth.disable_signup, captcha: c.auth.security_captcha_enabled }), ok: (v) => v.disable_signup === true || v.captcha === true },
  { id: "auth.audit_log_in_postgres", read: (c) => c.auth.audit_log_disable_postgres, ok: (v) => v === false },
  { id: "auth.session_timebox_set", read: (c) => c.auth.sessions_timebox, ok: (v) => Number(v) > 0 },
  { id: "db.ssl_enforced", read: (c) => c.ssl?.currentConfig?.database, ok: (v) => v === true },
  { id: "db.network_restricted", read: (c) => c.network?.config?.dbAllowedCidrs, ok: (v) => Array.isArray(v) && !v.includes("0.0.0.0/0") },
  { id: "api.legacy_jwt_keys_disabled", read: (c) => (c.apiKeys || []).filter((k) => k.type === "legacy").map((k) => k.name), ok: (v) => v.length === 0 },
  { id: "backup.pitr_enabled", read: (c) => c.backups?.pitr_enabled, ok: (v) => v === true },
  { id: "org.all_members_mfa", read: (c) => (c.members || []).map((m) => m.mfa_enabled), ok: (v) => v.length > 0 && v.every(Boolean) },
  { id: "branches.no_stale_preview_branches", read: (c) => (c.branches || []).filter((b) => !b.is_default).map((b) => `${b.name}:${b.status}`), ok: (v) => v.length === 0 },
  { id: "db.no_40001_raisers", read: (c) => c.catalog.raisers40001, ok: (v) => Array.isArray(v) && v.length === 0 },
  { id: "db.audit_tables_append_only", read: (c) => c.catalog.mutableAuditTables, ok: (v) => Array.isArray(v) && v.length === 0 },
];

// Audit tables that must not be UPDATE/DELETE/TRUNCATE-able by API roles
// (20261010096000_s96_audit_append_only.sql).
const AUDIT_TABLES = [
  "atlas_private.settings_events", "atlas_private.integration_events", "atlas_private.inventory_count_events",
  "atlas_private.item_master_events", "atlas_private.knowledge_events", "atlas_private.shift_events",
  "atlas_private.system_events", "atlas_private.team_message_events", "atlas_private.team_profile_events",
  "atlas_private.operations_events", "atlas_private.marketing_workspace_events", "atlas_private.marketing_content_approvals",
  "atlas_private.marketing_content_revisions", "atlas_private.team_message_revisions", "atlas_private.brain_decisions",
  "atlas_private.brain_outcomes", "atlas_private.ai_tool_calls", "atlas_private.ai_voice_session_events",
  "atlas_private.shift_publications", "atlas_private.shift_month_publications", "public.purchase_order_events",
  "public.inventory_movements", "atlas_private.security_audit_events",
];

// Catalogue fingerprint SQL, identical for production and the replay DB.
// Returns hashes and names only.
const FINGERPRINT_SQL = `
select jsonb_build_object(
  'functions', (select jsonb_object_agg(p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public','atlas_private','private','public_menu_private') and p.prokind in ('f','p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and p.proname <> 'rls_auto_enable'),
  'function_acl', (select md5(string_agg(p.oid::regprocedure::text || ':' || coalesce(array_to_string(p.proacl, ','), ''), '|' order by p.oid::regprocedure::text))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public','atlas_private','private','public_menu_private')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and p.proname <> 'rls_auto_enable'),
  'relation_acl', (select md5(string_agg(n.nspname || '.' || c.relname || ':' || coalesce(array_to_string(c.relacl, ','), '') || ':' || c.relrowsecurity, '|' order by n.nspname, c.relname))
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname in ('public','atlas_private','private','public_menu_private') and c.relkind in ('r','p','v','m')),
  'policies', (select md5(string_agg(schemaname || '.' || tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by schemaname, tablename, policyname))
                from pg_policies where schemaname in ('public','atlas_private','private','public_menu_private','storage')),
  'triggers', (select md5(string_agg(pg_get_triggerdef(t.oid), '|' order by pg_get_triggerdef(t.oid)))
                from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
                where not t.tgisinternal and n.nspname in ('public','atlas_private','private','public_menu_private')),
  'raisers40001', (select coalesce(jsonb_agg(n.nspname || '.' || p.proname order by 1), '[]'::jsonb)
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public','atlas_private','private') and p.prosrc ~ 'errcode\\s*=\\s*''40001'''),
  'mutableAuditTables', (select coalesce(jsonb_agg(t order by t), '[]'::jsonb) from (
                select t from unnest(array[${AUDIT_TABLES.map((t) => `'${t}'`).join(",")}]) t
                where to_regclass(t) is not null and (
                  has_table_privilege('service_role', t, 'UPDATE') or has_table_privilege('service_role', t, 'DELETE')
                  or has_table_privilege('service_role', t, 'TRUNCATE') or has_table_privilege('authenticated', t, 'UPDATE')
                  or has_table_privilege('authenticated', t, 'DELETE')
                  or not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass(t) and g.tgname = 's96_append_only'))) x)
)::text as fingerprint`;

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--json") args.json = true;
    else if (key.startsWith("--")) args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

function fail(message) {
  console.error(`drift-check: ${message}`);
  process.exit(2);
}

async function api(token, pathName, init = {}) {
  const response = await fetch(`${API}${pathName}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${pathName.replace(/\?.*$/, "")} -> HTTP ${response.status}`);
  return body;
}

async function readOnlySql(token, ref, query) {
  // read_only: true makes the Management API run the statement in a
  // read-only transaction as a read-only role.
  return api(token, `/projects/${ref}/database/query`, { method: "POST", body: JSON.stringify({ query, read_only: true }) });
}

function repoFunctionSlugs() {
  const dir = path.join(ROOT, "supabase", "functions");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

function configVerifyJwt() {
  // Minimal parser for [functions.<slug>] verify_jwt = <bool> blocks.
  const text = readFileSync(path.join(ROOT, "supabase", "config.toml"), "utf8");
  const map = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[functions\.([A-Za-z0-9_-]+)\]\s*$/);
    if (header) { current = header[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const setting = current && line.match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/);
    if (setting) map[current] = setting[1] === "true";
  }
  return map;
}

function repoMigrationVersions() {
  return readdirSync(path.join(ROOT, "supabase", "migrations"))
    .map((f) => f.match(/^(\d{14})_.*\.sql$/)?.[1])
    .filter(Boolean)
    .sort();
}

function replayFingerprint(url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) fail("--replay-db must be a loopback database");
  const out = execFileSync("psql", [url, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", FINGERPRINT_SQL.replace(/\s+/g, " ")], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

function diffKeys(a = {}, b = {}) {
  const onlyA = Object.keys(a).filter((k) => !(k in b)).sort();
  const onlyB = Object.keys(b).filter((k) => !(k in a)).sort();
  const changed = Object.keys(a).filter((k) => k in b && a[k] !== b[k]).sort();
  return { onlyA, onlyB, changed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = args.project;
  if (!token) fail("SUPABASE_ACCESS_TOKEN is required (a scoped, read-only PAT is enough)");
  if (!ref || !/^[a-z]{20}$/.test(ref)) fail("--project <20-letter project ref> is required");

  const report = { project: ref, generated_at: new Date().toISOString(), drift: [], policy: [], info: {} };
  const drift = (kind, detail) => report.drift.push({ kind, ...detail });

  // 1. Edge Functions: inventory, verify_jwt, bundle hash.
  const deployed = await api(token, `/projects/${ref}/functions`);
  const repoSlugs = repoFunctionSlugs();
  const verifyJwt = configVerifyJwt();
  const deployedBySlug = Object.fromEntries(deployed.map((f) => [f.slug, f]));
  for (const slug of repoSlugs) {
    if (!deployedBySlug[slug]) drift("function_not_deployed", { slug });
  }
  for (const fn of deployed) {
    if (!repoSlugs.includes(fn.slug) && !KNOWN_OUT_OF_REPO.has(fn.slug)) drift("function_not_in_git", { slug: fn.slug, version: fn.version });
    if (fn.slug in verifyJwt && fn.verify_jwt !== verifyJwt[fn.slug]) drift("verify_jwt_mismatch", { slug: fn.slug, deployed: fn.verify_jwt, git: verifyJwt[fn.slug] });
    if (fn.status !== "ACTIVE") drift("function_not_active", { slug: fn.slug, status: fn.status });
  }
  const functionHashes = {};
  for (const fn of deployed) {
    // Single-function GET includes ezbr_sha256 (bundle hash); no secrets.
    const detail = await api(token, `/projects/${ref}/functions/${encodeURIComponent(fn.slug)}`);
    functionHashes[fn.slug] = { version: detail.version, verify_jwt: detail.verify_jwt, ezbr_sha256: detail.ezbr_sha256 ?? null, entrypoint: path.basename(String(detail.entrypoint_path ?? "")) };
  }
  report.info.functions = functionHashes;

  // 2. Migration ledger vs Git.
  const ledgerRows = await readOnlySql(token, ref, "select version, name from supabase_migrations.schema_migrations order by version");
  const ledger = ledgerRows.map((r) => r.version);
  const repoVersions = repoMigrationVersions();
  report.info.ledger = { production: ledger.length, repo: repoVersions.length };
  for (const v of repoVersions) if (!ledger.includes(v)) drift("migration_not_applied", { version: v });
  for (const v of ledger) if (!repoVersions.includes(v)) drift("migration_not_in_git", { version: v });

  // 3. Catalogue fingerprint (hashes only).
  const [{ fingerprint }] = await readOnlySql(token, ref, FINGERPRINT_SQL);
  const prod = JSON.parse(fingerprint);
  report.info.catalog = { functions: Object.keys(prod.functions || {}).length, relation_acl: prod.relation_acl, policies: prod.policies, triggers: prod.triggers, function_acl: prod.function_acl };
  if (args.replayDb) {
    const replay = replayFingerprint(args.replayDb);
    const f = diffKeys(prod.functions, replay.functions);
    for (const k of f.onlyA) drift("db_function_not_in_git", { function: k });
    for (const k of f.onlyB) drift("db_function_missing_in_production", { function: k });
    for (const k of f.changed) drift("db_function_definition_differs", { function: k });
    for (const key of ["function_acl", "relation_acl", "policies", "triggers"]) {
      if (prod[key] !== replay[key]) drift(`db_${key}_differs`, { production: prod[key], replay: replay[key] });
    }
  }

  // 4. Baseline comparison (release-recorded state).
  if (args.baseline) {
    if (!existsSync(args.baseline)) fail(`baseline not found: ${args.baseline}`);
    const baseline = JSON.parse(readFileSync(args.baseline, "utf8"));
    for (const [slug, now] of Object.entries(functionHashes)) {
      const then = baseline.functions?.[slug];
      if (!then) drift("function_new_since_baseline", { slug });
      else if (then.ezbr_sha256 !== now.ezbr_sha256 || then.verify_jwt !== now.verify_jwt) drift("function_changed_since_baseline", { slug, from_version: then.version, to_version: now.version });
    }
    for (const slug of Object.keys(baseline.functions || {})) if (!functionHashes[slug]) drift("function_removed_since_baseline", { slug });
    for (const key of ["relation_acl", "policies", "triggers", "function_acl"]) {
      if (baseline.catalog?.[key] && baseline.catalog[key] !== prod[key]) drift(`catalog_${key}_changed_since_baseline`, {});
    }
    const bf = diffKeys(baseline.catalog_functions || {}, prod.functions || {});
    for (const k of [...bf.onlyB, ...bf.changed]) drift("db_function_changed_since_baseline", { function: k });
  }
  if (args.writeBaseline) {
    writeFileSync(args.writeBaseline, JSON.stringify({ project: ref, written_at: report.generated_at, functions: functionHashes, catalog: report.info.catalog, catalog_functions: prod.functions }, null, 2) + "\n");
  }

  // 5. Platform policy (configuration facts only).
  const config = {
    auth: await api(token, `/projects/${ref}/config/auth`),
    ssl: await api(token, `/projects/${ref}/ssl-enforcement`).catch(() => null),
    network: await api(token, `/projects/${ref}/network-restrictions`).catch(() => null),
    apiKeys: (await api(token, `/projects/${ref}/api-keys`).catch(() => [])).map((k) => ({ name: k.name, type: k.type })),
    backups: await api(token, `/projects/${ref}/database/backups`).catch(() => null),
    branches: (await api(token, `/projects/${ref}/branches`).catch(() => [])).map((b) => ({ name: b.name, status: b.status, is_default: b.is_default })),
    members: [],
    catalog: prod,
  };
  const project = await api(token, `/projects/${ref}`).catch(() => null);
  if (project?.organization_id) {
    config.members = (await api(token, `/organizations/${project.organization_id}/members`).catch(() => [])).map((m) => ({ role: m.role_name, mfa_enabled: m.mfa_enabled }));
  }
  for (const rule of POLICY) {
    let value;
    try { value = rule.read(config); } catch { value = null; }
    const safeValue = rule.id.startsWith("auth.") && typeof value === "string" ? value.slice(0, 200) : value;
    report.policy.push({ id: rule.id, ok: Boolean(rule.ok(value ?? {})), observed: safeValue });
  }

  const policyFailures = report.policy.filter((p) => !p.ok).length;
  report.summary = { drift: report.drift.length, policy_failures: policyFailures };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`project ${ref}: ${report.drift.length} drift item(s), ${policyFailures} policy failure(s)`);
    for (const d of report.drift) console.log(`  DRIFT  ${d.kind} ${JSON.stringify({ ...d, kind: undefined })}`);
    for (const p of report.policy) console.log(`  ${p.ok ? "OK    " : "POLICY"} ${p.id} ${JSON.stringify(p.observed)}`);
  }
  process.exit(report.drift.length || policyFailures ? 1 : 0);
}

main().catch((error) => fail(error?.message || String(error)));
