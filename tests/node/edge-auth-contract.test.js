// S89 platform contract: every Edge Function authenticates through
// supabase/functions/_shared/auth.mjs (resolveActor / requireRole), none calls
// /auth/v1/user itself or ships a hard-coded Auth project or publishable key,
// and no function builds a staff label from an email address (S87 identity
// rule: display name, otherwise a neutral label). The behavioural half runs
// each gateway through the Node harness with a role matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEdgeFunction, json } from './helpers/edge-function-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FUNCTIONS = path.join(ROOT, 'supabase/functions');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function functionDirs() {
  return fs.readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .map((entry) => entry.name)
    .sort();
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ALL_SOURCES = sourceFiles(FUNCTIONS);

test('every Edge Function imports the shared gateway check', () => {
  const dirs = functionDirs();
  assert.ok(dirs.length >= 20, `expected the Atlas gateways, found ${dirs.length}`);
  for (const name of dirs) {
    const files = sourceFiles(path.join(FUNCTIONS, name));
    const importing = files.filter((file) => /from\s+["']\.\.\/_shared\/auth\.mjs["']/.test(fs.readFileSync(file, 'utf8')));
    assert.ok(importing.length > 0, `${name} must import ../_shared/auth.mjs`);
    const text = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.match(text, /\bresolveActor\b/, `${name} must resolve the caller with resolveActor`);
  }
});

test('no function calls /auth/v1/user or reads profiles for auth outside _shared/auth.mjs', () => {
  for (const file of ALL_SOURCES) {
    if (rel(file) === 'supabase/functions/_shared/auth.mjs') continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /auth\/v1\/user/, `${rel(file)} calls /auth/v1/user directly`);
    assert.doesNotMatch(source, /function bearerToken\(/, `${rel(file)} parses bearer tokens itself`);
  }
});

test('Auth configuration comes from the environment only (no hard-coded project or key)', () => {
  for (const file of ALL_SOURCES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /dnefgcmjcgxlynycxkts/, `${rel(file)} hard-codes the production project`);
    assert.doesNotMatch(source, /sb_publishable_[A-Za-z0-9]{8,}/, `${rel(file)} hard-codes a publishable key`);
    assert.doesNotMatch(source, /Deno\.env\.get\("ATLAS_AUTH_(?:PROJECT_URL|PUBLISHABLE_KEY)"\)\s*\?\?/, `${rel(file)} has an Auth fallback`);
    assert.doesNotMatch(source, /globalThis\.fetch\s*=/, `${rel(file)} replaces the global fetch`);
  }
});

// A label (actor/sender/decided-by/reviewer/staff) must never fall back to,
// or be assigned from, an email address.
test('no function builds an actor or sender label from an email address', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const where = `${rel(file)}:${index + 1}: ${line.trim()}`;
      // "... || x.email" / "... ?? x.email": an email used as a fallback value.
      if (/(\|\||\?\?)\s*[\w.?()[\]"']*\bemail\b/.test(line)) offenders.push(where);
      // "label: ...email" / "p_decided_by_label: ...email" / "reviewerLabel = ...email".
      if (/label\w*["']?\s*[:=]\s*[^,;\n]*\bemail\b/i.test(line)) offenders.push(where);
    });
  }
  assert.deepEqual(offenders, []);
});

test('stored decided-by / recorded-by / reviewer labels use the canonical actorLabel', () => {
  const brain = read('supabase/functions/atlas-phase3-brain/index.ts');
  assert.match(brain, /p_decided_by_label: context\.label,/);
  assert.match(brain, /p_recorded_by_label: context\.label,/);
  assert.match(brain, /label: actorLabel\(actor\.profile\)/);
  const review = read('supabase/functions/atlas-sprint3-review/index.ts');
  assert.match(review, /const reviewerLabel = actorLabel\(context\.profile\);/);
  const shared = read('supabase/functions/_shared/auth.mjs');
  assert.match(shared, /export function actorLabel\(/);
  assert.match(shared, /label: actorLabel\(profile\)/);
});

test('config.toml declares exactly the deployable function directories and their entrypoints', () => {
  const config = read('supabase/config.toml');
  const declared = [...config.matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((match) => match[1]).sort();
  assert.deepEqual(declared, functionDirs(), 'every stanza has a directory and every directory a stanza');
  assert.doesNotMatch(config, /atlas-import-worker/);
  const entrypoints = [...config.matchAll(/^\[functions\.([a-z0-9-]+)\]\n(?:[^[]*?)entrypoint = "\.\/functions\/([^"]+)"/gm)];
  const byName = Object.fromEntries(entrypoints.map((match) => [match[1], match[2]]));
  assert.equal(byName['atlas-stock-counts'], 'atlas-stock-counts/entrypoint.ts');
  assert.equal(byName['atlas-reports'], 'atlas-reports/entrypoint.ts');
  for (const target of Object.values(byName)) assert.ok(fs.existsSync(path.join(FUNCTIONS, target)), target);
  // One implementation per function: the dead second stock-count handler is gone.
  assert.ok(!fs.existsSync(path.join(FUNCTIONS, 'atlas-stock-counts/index.ts')));
});

test('every endpoint key in config.js is read by a browser module', () => {
  const config = read('apps/web/config.js');
  const keys = [...config.matchAll(/^\s+([A-Z0-9_]+_API):/gm)].map((match) => match[1]);
  assert.ok(keys.length >= 15);
  const web = path.join(ROOT, 'apps/web');
  const browser = sourceFiles(path.join(web, 'assets/js')).concat(
    fs.readdirSync(web).filter((name) => name.endsWith('.html')).map((name) => path.join(web, name)),
  ).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const key of keys) assert.match(browser, new RegExp(`\\b${key}\\b`), `${key} is configured but never read`);
  assert.doesNotMatch(config, /SPRINT4_BRIEFING_API|INVENTORY_SCANNER_API/);
});

// ---- behaviour: role matrix through the Node harness ---------------------

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
// Functions whose sources load in Node (no npm: imports). `managerOnly` is the
// role rule each gateway had before the migration (S88 differential probe).
const GATEWAYS = [
  { file: 'atlas-inventory-scanner/index.ts', managerOnly: false },
  { file: 'atlas-item-master/index.ts', managerOnly: true },
  { file: 'atlas-knowledge/index.ts', managerOnly: false },
  { file: 'atlas-marketing-workspace/index.ts', managerOnly: false },
  { file: 'atlas-operations-checkpoint-a/index.ts', managerOnly: false },
  { file: 'atlas-phase3-brain/index.ts', managerOnly: true },
  { file: 'atlas-phase3-intelligence/index.ts', managerOnly: true },
  { file: 'atlas-reports/index.ts', managerOnly: false },
  { file: 'atlas-settings/index.ts', managerOnly: false },
  { file: 'atlas-sprint3-review/index.ts', managerOnly: true },
  { file: 'atlas-sprint4-briefing/index.ts', managerOnly: true },
  { file: 'atlas-stock-counts/entrypoint.ts', managerOnly: false },
  { file: 'atlas-system/index.ts', managerOnly: true },
  { file: 'atlas-team-messages/index.ts', managerOnly: false },
  { file: 'atlas-team-profile-photos/index.ts', managerOnly: false },
];

function backend(profile, calls) {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.href, body: typeof init.body === 'string' ? init.body : '' });
    if (url.pathname === '/auth/v1/user') return json({ id: USER_ID, email: 'person@example.test' });
    if (url.pathname === '/rest/v1/profiles' && (url.searchParams.get('id') || '').startsWith('eq.')) {
      return json(profile ? [{ id: USER_ID, email: 'person@example.test', updated_at: '2026-09-01T00:00:00Z', ...profile }] : []);
    }
    if (url.pathname === '/rest/v1/profiles') {
      return json([{ id: '22222222-2222-4222-8222-222222222222', email: 'other@example.test', display_name: null, role: 'bartender', active: true }]);
    }
    return (init.method || 'GET').toUpperCase() === 'GET' ? json([]) : json({});
  };
}

const call = (handler, fetchImpl, authorization = 'Bearer token-abc') => handler(
  new Request('https://fn.test/gateway', { headers: authorization ? { authorization } : {} }),
  fetchImpl,
);

for (const gateway of GATEWAYS) {
  test(`${gateway.file}: shared caller check, same role rule, no email labels`, async () => {
    const handler = await loadEdgeFunction(`supabase/functions/${gateway.file}`, ENV);
    const calls = [];

    assert.equal((await call(handler, backend(null, calls), null)).status, 401, 'no session');
    assert.equal((await call(handler, backend(null, calls))).status, 403, 'no profile');
    assert.equal((await call(handler, backend({ role: 'manager', active: false, display_name: 'Old' }, calls))).status, 403, 'inactive');
    assert.equal((await call(handler, backend({ role: 'owner', active: true, display_name: 'X' }, calls))).status, 403, 'unknown role');

    const bartender = await call(handler, backend({ role: 'bartender', active: true, display_name: null }, calls));
    if (gateway.managerOnly) assert.equal(bartender.status, 403, 'bartender refused');
    else assert.ok(![401, 403].includes(bartender.status), `bartender allowed (${bartender.status})`);

    const managerCalls = [];
    const manager = await call(handler, backend({ role: 'manager', active: true, display_name: null }, managerCalls));
    assert.ok(![401, 403].includes(manager.status), `manager allowed (${manager.status})`);
    const text = await manager.text();
    assert.doesNotMatch(text, /"(?:label|[a-z_]*_label)":"[^"]*@/, 'no email label in the response');
    assert.doesNotMatch(text, /person@example\.test/, 'the caller email is not echoed');
    for (const entry of managerCalls) assert.doesNotMatch(entry.body, /"p_[a-z_]*label":"[^"]*@/, 'no stored email label');

    // Unconfigured: fails closed before any network request.
    const bare = await loadEdgeFunction(`supabase/functions/${gateway.file}`, {
      SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY,
    });
    const bareCalls = [];
    const refused = await call(bare, backend({ role: 'admin', active: true, display_name: 'Ada' }, bareCalls));
    assert.equal(refused.status, 500);
    assert.deepEqual(await refused.json(), { error: 'Atlas authentication is not configured.' });
    assert.equal(bareCalls.length, 0);
  });
}
