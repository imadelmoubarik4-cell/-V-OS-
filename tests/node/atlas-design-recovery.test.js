import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const nextHtml = readFileSync('apps/web/next.html', 'utf8');
const loginHtml = readFileSync('apps/web/login.html', 'utf8');
const loginJs = readFileSync('apps/web/assets/js/atlas-login.js', 'utf8');
const bridge = readFileSync('apps/web/assets/js/atlas-next-gateway-bridge.js', 'utf8');

test('recovery starts from the polished single-shell route', () => {
  assert.equal((nextHtml.match(/id="app-shell"/g) || []).length, 1);
  assert.match(nextHtml, /assets\/css\/atlas-next\.css/);
  assert.match(nextHtml, /assets\/css\/atlas-next-stock-counts\.css/);
  assert.match(nextHtml, /assets\/js\/atlas-next-stock-counts\.js/);
  assert.doesNotMatch(nextHtml, /atlas-next-workspaces|atlas-next-purchasing|recipes\.css|recipes\.js|app\.html/);
  assert.doesNotMatch(nextHtml, /Recipe Intelligence|Atlas Alpha 0\.3/);
});

test('isolated login loads no connected workspace renderer', () => {
  assert.equal((loginHtml.match(/id="login-screen"/g) || []).length, 1);
  assert.match(loginHtml, /assets\/js\/atlas-login\.js/);
  assert.match(loginHtml, /@supabase\/supabase-js/);
  for (const forbidden of [
    /atlas-next-workspaces/,
    /atlas-next-purchasing/,
    /inventory-scanner/,
    /item-master-workspace/,
    /recipes\.js/,
    /operations-checkpoint/,
    /team-messages/,
    /brain\.js/,
  ]) assert.doesNotMatch(loginHtml, forbidden);
});

test('successful isolated login hands off directly to next.html', () => {
  assert.match(loginJs, /new URL\('next\.html', window\.location\.href\)/);
  assert.doesNotMatch(loginJs, /new URL\('app\.html'/);
  assert.match(loginJs, /requestTimeoutMs:\s*12000/);
  assert.match(loginJs, /sessionTimeoutMs:\s*15000/);
  assert.match(loginJs, /signOutTimeoutMs:\s*4000/);
  assert.match(loginJs, /force_signout/);
  assert.match(loginJs, /\.from\('profiles'\)\.select/);
});

test('recovery boundary prevents indefinite startup without replacing the gateway', () => {
  assert.match(bridge, /RECOVERY_TIMEOUT_MS\s*=\s*18000/);
  assert.match(bridge, /redirectToLogin/);
  assert.match(bridge, /inspectClientSession/);
  assert.match(bridge, /force_signout/);
  assert.match(bridge, /window\.AtlasGatewayBridge\s*=\s*Object\.freeze/);
  assert.match(bridge, /GATEWAY_HOST\s*=\s*'uhbamqetppqmygesoeeh\.supabase\.co'/);
  assert.doesNotMatch(bridge, /MutationObserver|setInterval\s*\(/);
  assert.doesNotMatch(bridge, /service_role|SUPABASE_SERVICE_ROLE_KEY/);
});
