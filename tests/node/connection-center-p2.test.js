import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const browser = readFileSync('apps/web/assets/js/connection-center.js', 'utf8');
const loader = readFileSync('apps/web/assets/js/settings-mount-bridge.js', 'utf8');
const edge = readFileSync('supabase/functions/atlas-connections/index.ts', 'utf8');
const migration = [
  'supabase/migrations/20260806190000_atlas_connections_p2_registry.sql',
  'supabase/migrations/20260806190100_atlas_connections_p2_evidence.sql',
  'supabase/migrations/20260806190200_atlas_connections_p2_snapshot.sql',
  'supabase/migrations/20260806190250_atlas_connections_p2_checks.sql',
  'supabase/migrations/20260806190275_atlas_connections_p2_capabilities.sql',
  'supabase/migrations/20260806190300_atlas_connections_p2_seeds_api.sql'
].map((path) => readFileSync(path, 'utf8')).join('\n');
const css = readFileSync('apps/web/assets/css/connection-center.css', 'utf8');

test('P2.0 uses one canonical connection registry and eight truthful states', () => {
  assert.match(migration, /atlas_private\.integration_connections/);
  assert.doesNotMatch(migration, /create table if not exists atlas_private\.connection_registry/i);
  for (const state of [
    'not_configured', 'authorization_required', 'verifying', 'healthy',
    'degraded', 'expired', 'blocked', 'intentionally_disabled'
  ]) assert.match(migration, new RegExp(state));
});

test('healthy state requires controlled verification evidence', () => {
  assert.match(migration, /atlas\.allow_connection_verified/);
  assert.match(migration, /Healthy connection state requires a passed verification check/);
  assert.match(migration, /unique \(connection_key,request_id\)/);
  assert.match(edge, /SMTP health requires both invitation and password-reset delivery evidence/);
});

test('connection event history and finished checks are immutable', () => {
  assert.match(migration, /connection_events_append_only/);
  assert.match(migration, /connection_checks_immutable_after_finish/);
  assert.match(migration, /before update or delete on atlas_private\.connection_events/i);
  assert.match(migration, /before update or delete on atlas_private\.connection_health_checks/i);
});

test('capabilities remain human approved and automatic side effects stay off', () => {
  assert.match(migration, /automatic_execution_allowed is false/);
  assert.match(migration, /purchase\.submit/);
  assert.match(migration, /orders\.write/);
  assert.match(migration, /deploy\.production\.write/);
  assert.match(browser, /Automatic execution off/);
  assert.match(browser, /value === 'granted' && !canGrant \? 'disabled'/);
});

test('shared Connection Center mounts into Settings and System without direct database access', () => {
  assert.match(browser, /#settings-view \.settings-integrations/);
  assert.match(browser, /#system-view \.system-integrations/);
  assert.match(browser, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(browser, /\.from\s*\(/);
  assert.match(loader, /connection-center\.js/);
  assert.match(loader, /connection-center\.css/);
  assert.match(css, /connection-center/);
});

test('gateway revalidates the production user and returns a stable envelope', () => {
  assert.match(edge, /\/auth\/v1\/user/);
  assert.match(edge, /\/rest\/v1\/profiles/);
  assert.match(edge, /x-atlas-request-id/);
  assert.match(edge, /request_id: id/);
  assert.match(edge, /provider: "atlas-connections"/);
  assert.doesNotMatch(browser + loader, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Brain receives a derived evidence projection rather than provider truth duplication', () => {
  assert.match(migration, /connection_brain_projection/);
  assert.match(migration, /evidence_gate_not_provider_registry/);
  assert.match(migration, /canonical_connection_state/);
});
