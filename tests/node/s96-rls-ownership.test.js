import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// S96 database/RLS hardening (findings DBRLS-01..06). These assertions pin the SQL text;
// scripts/verify_s96_rls_ownership.sql proves the behaviour on a replayed database
// (run by scripts/verify_s96_previews.sh in the migration-replay workflow).

const MIGRATIONS = 'supabase/migrations';
const ONBOARDING = `${MIGRATIONS}/20261010090000_s96_onboarding_progress_manager_writes.sql`;
const LEGACY = `${MIGRATIONS}/20261010090100_s96_legacy_staff_tables_read_only.sql`;
const LEDGER = `${MIGRATIONS}/20261010090200_s96_purchasing_ledger_integrity.sql`;
const ADMIN_RACE = `${MIGRATIONS}/20261010090300_s96_last_admin_race.sql`;
const VERIFY = 'scripts/verify_s96_rls_ownership.sql';
const GATE = 'scripts/verify_phase1_security_gate.sql';

const read = (path) => readFileSync(path, 'utf8');
const stripComments = (sql) => sql.replace(/--[^\n]*\n/g, '\n');

function policy(sql, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(new RegExp(`create policy "${escaped}"([\\s\\S]*?);`, 'i'));
  assert.ok(match, `Missing policy: ${name}`);
  return match[0];
}

test('S96 migrations sort after every earlier release and use the dbrls block', () => {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  const s96 = files.filter((name) => /^20261010090[0-9]00_s96_/.test(name));
  assert.deepEqual(s96, [
    '20261010090000_s96_onboarding_progress_manager_writes.sql',
    '20261010090100_s96_legacy_staff_tables_read_only.sql',
    '20261010090200_s96_purchasing_ledger_integrity.sql',
    '20261010090300_s96_last_admin_race.sql',
  ]);
  assert.ok(files.indexOf(s96[0]) > files.indexOf('20261005092000_s95c_flavor_seed.sql'));
});

test('DBRLS-01: staff can no longer write their own onboarding progress; completed_by is the caller', () => {
  const sql = stripComments(read(ONBOARDING));
  assert.match(sql, /if to_regclass\('public\.onboarding_progress'\) is null then/);
  assert.match(sql, /drop policy if exists "staff add own onboarding progress" on public\.onboarding_progress;/);
  assert.match(sql, /drop policy if exists "staff update own onboarding progress" on public\.onboarding_progress;/);
  const add = policy(sql, 'active managers add onboarding progress');
  assert.match(add, /for insert to authenticated/);
  assert.match(add, /with check \(\s*\(select private\.is_manager_or_admin\(\)\)\s*and \(completed_by is null or completed_by = \(select auth\.uid\(\)\)\)\s*\)/);
  const update = policy(sql, 'active managers update onboarding progress');
  assert.match(update, /for update to authenticated\s+using \(\(select private\.is_manager_or_admin\(\)\)\)/);
  assert.match(update, /with check \(\s*\(select private\.is_manager_or_admin\(\)\)\s*and \(completed_by is null or completed_by = \(select auth\.uid\(\)\)\)\s*\)/);
  assert.doesNotMatch(sql, /is_self_or_manager/, 'no self-service write path remains');
  assert.doesNotMatch(sql, /drop policy if exists "staff read own onboarding progress"/, 'staff keep reading their own rows');
  assert.doesNotMatch(sql, /security definer/i);
});

test('DBRLS-02: legacy staff tables become read-only for browser roles, reads untouched', () => {
  const sql = stripComments(read(LEGACY));
  for (const table of ['shifts', 'staff_availability', 'staff_details', 'staff_documents', 'document_acknowledgements']) {
    assert.match(sql, new RegExp(`'${table}'`), table);
  }
  assert.match(sql, /if to_regclass\(format\('public\.%I', legacy_table\)\) is not null then/);
  assert.match(sql, /'revoke insert, update, delete, truncate on table public\.%I from public, anon, authenticated'/);
  assert.doesNotMatch(sql, /revoke (all|select)/i, 'SELECT (RLS-filtered) stays; atlas-team-messages reads public.shifts');
  assert.doesNotMatch(sql, /onboarding_(tasks|progress)/, 'onboarding tables are handled by their own migration');
});

test('DBRLS-03: atlas_media rows are written by active managers only', () => {
  const sql = stripComments(read(LEGACY));
  for (const old of ['operational staff add own media', 'owners or managers update media', 'owners or managers delete media']) {
    assert.match(sql, new RegExp(`drop policy if exists "${old}" on public\\.atlas_media;`));
  }
  assert.match(policy(sql, 'active managers add media'), /with check \(\(select private\.is_manager_or_admin\(\)\) and uploaded_by = \(select auth\.uid\(\)\)\)/);
  const update = policy(sql, 'active managers update media');
  assert.match(update, /using \(\(select private\.is_manager_or_admin\(\)\)\)\s+with check \(\(select private\.is_manager_or_admin\(\)\)\)/);
  assert.match(policy(sql, 'active managers delete media'), /using \(\(select private\.is_manager_or_admin\(\)\)\)/);
  assert.doesNotMatch(sql, /is_operational_staff/);
});

test('DBRLS-04: purchase receipts cannot lift an order over the approval threshold unapproved', () => {
  const sql = stripComments(read(LEDGER));
  const fn = sql.match(/create or replace function private\.purchase_order_receipt_price_guard\(\)[\s\S]+?\$function\$;/);
  assert.ok(fn, 'guard function');
  assert.match(fn[0], /returns trigger\s+language plpgsql\s+security definer\s+set search_path = ''/);
  assert.match(fn[0], /new\.unit_cost <= new\.ordered_unit_cost then\s+return new;/, 'receiving at or below the ordered cost is never blocked');
  assert.match(fn[0], /select max\(r\.unit_cost\) from public\.purchase_order_receipts r/, 're-prices with the highest cost received so far');
  assert.match(fn[0], /private\.purchase_order_approval_needed\(repriced, policy\)/);
  assert.match(fn[0], /ord\.approved_by is null\s+or private\.purchase_order_total\(repriced\) > private\.purchase_order_total\(ord\.lines\)/);
  assert.match(fn[0], /using errcode = '42501'/);
  assert.match(sql, /revoke all on function private\.purchase_order_receipt_price_guard\(\) from public, anon, authenticated;/);
  assert.match(sql, /create trigger purchase_order_receipts_s96_price_guard\s+before insert on public\.purchase_order_receipts\s+for each row execute function private\.purchase_order_receipt_price_guard\(\);/);
});

test('DBRLS-05: browser roles cannot insert stock-ledger rows', () => {
  const sql = stripComments(read(LEDGER));
  assert.match(sql, /^revoke insert on table public\.inventory_movements from anon, authenticated;$/m);
  assert.match(sql, /drop policy if exists "active managers add inventory movements" on public\.inventory_movements;/);
  assert.doesNotMatch(sql, /revoke select/i, 'manager reads are unchanged');
  const gate = read(GATE);
  assert.match(gate, /not has_table_privilege\('authenticated', 'public\.inventory_movements', 'INSERT'\)/);
  assert.match(gate, /and browser_movement_insert_revoked\s+as adjust_inventory_safe/);
  assert.doesNotMatch(gate, /manager_movement_insert_policy/);
});

test('the replay verification covers every S96 finding plus the regression controls and rolls back', () => {
  const sql = read(VERIFY);
  for (const id of ['DBRLS-01', 'DBRLS-02', 'DBRLS-03', 'DBRLS-04', 'DBRLS-05']) {
    assert.match(sql, new RegExp(`insert into s96_rls values \\('${id}:`), id);
  }
  for (const control of [
    'a sign-up with role/active metadata becomes an inactive viewer',
    'bartender cannot change own role or another profile',
    "IDOR: bartender cannot change or delete another user''s media row",
    "IDOR: bartender cannot write another user''s onboarding progress",
    'no public function is executable by anon',
    'authenticated executes only the 17 reviewed public RPCs (16 invoker + the S99 atlas_auth_policy definer read)',
    'every SECURITY DEFINER function in public/atlas_private/private pins search_path',
    'every public table has RLS enabled',
    'every public view granted to browser roles is security_invoker',
  ]) {
    assert.ok(sql.includes(control), control);
  }
  assert.match(sql, /set session authorization s96_rls_probe;/, 'probes run with a non-postgres session_user');
  assert.match(sql, /'s96_rls_ownership', case when bool_and\(result in \('ok','not_applicable'\)\) then 'passed' else 'failed' end/);
  assert.match(sql, /rollback;\s*$/);
  const runner = read('scripts/verify_s96_previews.sh');
  assert.match(runner, /verify_s96_rls_ownership\.sql/);
  assert.match(runner, /case "\$PGHOST" in 127\.0\.0\.1\|localhost\|::1\)/);
  assert.match(read('.github/workflows/migration-replay.yml'), /run: bash scripts\/verify_s96_previews\.sh/);
});

test('DBRLS-06: removing an administrator is serialised before the last-admin count', () => {
  const sql = stripComments(read(ADMIN_RACE));
  const fn = sql.match(/create or replace function private\.preserve_active_admin\(\)[\s\S]+?\$function\$;/);
  assert.ok(fn, 'trigger function');
  assert.match(fn[0], /returns trigger\s+language plpgsql\s+security definer\s+set search_path = ''/);
  const lock = fn[0].indexOf("pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('atlas:preserve_active_admin', 0))");
  const count = fn[0].indexOf('into other_admins');
  assert.ok(lock > 0 && count > lock, 'the advisory lock is taken before counting the other administrators');
  assert.match(fn[0], /raise exception 'Atlas must retain at least one active administrator';/);
  assert.match(sql, /revoke all on function private\.preserve_active_admin\(\) from public, anon, authenticated;/);
  const races = read('scripts/verify_s96_races.sh');
  assert.match(races, /case "\$PGHOST" in 127\.0\.0\.1\|localhost\|::1\)/);
  for (const name of [
    'DBRLS-06: concurrent mutual admin deactivation leaves one active administrator',
    'concurrent approvals record one approval',
    'concurrent waste never drives stock negative',
    'one request id sent twice at once posts one movement',
  ]) assert.ok(races.includes(name), name);
  assert.match(read('scripts/verify_s96_previews.sh'), /bash "\$ROOT\/scripts\/verify_s96_races\.sh"/);
});
