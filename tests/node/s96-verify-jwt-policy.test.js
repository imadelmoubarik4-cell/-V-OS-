// S96 (edgea): every Edge Function has an explicit verify_jwt setting, and
// every function that turns platform verification off proves its own caller
// in code before doing any work (shared resolveActor with a role check, or
// the publisher's constant-time worker secret). A new function cannot be
// added with verify_jwt = false without landing in this list with a reason.
//
// S96 decision (config.toml is checksum-pinned by the S42 cutover, so the
// rationale lives here): browser gateways keep verify_jwt = false and prove
// the caller through _shared/auth.mjs resolveActor before any backend call
// (production probes without a session, with the public anon key and with a
// forged alg=none token all returned 401). Platform verify_jwt would add no
// authorization: the public legacy anon JWT passes it (probed on
// atlas-notifications ?action=dispatch), Supabase documents it as legacy-key
// only, a signing-key rotation can break it, and the isolated branch
// deployments this config also serves cannot verify production tokens.
// atlas-marketing-publisher has no browser caller and must stay false.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FUNCTIONS = path.join(ROOT, 'supabase/functions');
const CONFIG = fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');

function settings() {
  const out = new Map();
  for (const match of CONFIG.matchAll(/^\[functions\.([a-z0-9-]+)\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
    const value = match[2].match(/^verify_jwt\s*=\s*(true|false)\s*$/m);
    out.set(match[1], value ? value[1] === 'true' : undefined);
  }
  return out;
}

// verify_jwt = false and the reason the function is still authenticated.
const SELF_AUTHENTICATED = {
  'atlas-sprint3-review': 'resolveActor+requireRole(MANAGER)',
  'atlas-sprint4-briefing': 'resolveActor+requireRole(MANAGER)',
  'atlas-phase3-brain': 'resolveActor+manager',
  'atlas-phase3-intelligence': 'resolveActor+manager',
  'atlas-operations-checkpoint-a': 'resolveActor+role per action',
  'atlas-inventory-scanner': 'resolveActor+role per action',
  'atlas-stock-counts': 'resolveActor+role per action',
  'atlas-item-master': 'resolveActor+requireRole(MANAGER)',
  'atlas-team-messages': 'resolveActor+role per action',
  'atlas-marketing-workspace': 'resolveActor+role per action',
  'atlas-team-profiles': 'resolveActor+role per action',
  'atlas-team-profile-photos': 'resolveActor+self-or-manager',
  'atlas-shifts': 'resolveActor+role per action',
  'atlas-knowledge': 'resolveActor+role per action',
  'atlas-training': 'resolveActor+role per action (S98; verify in code, manager-gated authoring, service-role RPCs)',
  'atlas-bookings': 'resolveActor+role per action (S99; verify in code, manager-gated config, service-role RPCs)',
  'atlas-reports': 'resolveActor+role-shaped data',
  'atlas-system': 'resolveActor+requireRole(MANAGER)',
  'atlas-settings': 'resolveActor+role per action',
  'atlas-integrations': 'resolveActor except the signed OAuth callback',
  'atlas-ai': 'resolveActor, or the service-secret header for maintenance',
  'atlas-inventory-recognition': 'resolveActor',
  'atlas-accounting': 'resolveActor+active admin (S92/PR#93; verify in code, admin-only)',
  'atlas-marketing-media': 'resolveActor+manager',
  'atlas-marketing-publisher': 'constant-time x-atlas-publisher-secret; no browser surface',
};

function sourcesOf(name) {
  const dir = path.join(FUNCTIONS, name);
  return fs.readdirSync(dir).filter((file) => /\.(ts|mjs)$/.test(file)).map((file) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
}

test('every function directory has an explicit verify_jwt setting', () => {
  const config = settings();
  const dirs = fs.readdirSync(FUNCTIONS).filter((name) => name !== '_shared' && fs.statSync(path.join(FUNCTIONS, name)).isDirectory());
  for (const name of dirs) assert.equal(typeof config.get(name), 'boolean', `${name} needs [functions.${name}] verify_jwt`);
});

test('verify_jwt = false only for functions that authenticate in code', () => {
  for (const [name, verify] of settings()) {
    if (verify !== false) continue;
    assert.ok(Object.hasOwn(SELF_AUTHENTICATED, name), `${name} turns platform JWT verification off without a recorded reason`);
    const source = sourcesOf(name);
    if (name === 'atlas-marketing-publisher') {
      assert.match(source, /secretMatches\(provided, expected\)/);
      assert.match(source, /if \(!secretConfigured\(expected\)\) return json\(503/);
      assert.doesNotMatch(source, /access-control-allow-origin/i, 'the worker exposes no CORS surface');
    } else {
      assert.match(source, /resolveActor/, `${name} must resolve the caller through _shared/auth.mjs`);
    }
  }
});

test('atlas-notifications keeps platform verification on', () => {
  assert.equal(settings().get('atlas-notifications'), true);
});
