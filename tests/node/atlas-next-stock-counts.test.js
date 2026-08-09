import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('apps/web/next.html', 'utf8');
const bridge = readFileSync('apps/web/assets/js/atlas-next-gateway-bridge.js', 'utf8');
const counts = readFileSync('apps/web/assets/js/atlas-next-stock-counts.js', 'utf8');
const styles = readFileSync('apps/web/assets/css/atlas-next-stock-counts.css', 'utf8');
const combined = `${bridge}\n${counts}`;

test('L1 loads inside the existing single Atlas shell in the required order', () => {
  assert.equal((html.match(/id="auth-screen"/g) || []).length, 1);
  assert.equal((html.match(/id="app-shell"/g) || []).length, 1);
  assert.match(html, /atlas-next-stock-counts\.css/);
  const bridgeIndex = html.indexOf('atlas-next-gateway-bridge.js');
  const coreIndex = html.indexOf('assets/js/atlas-next.js');
  const countIndex = html.indexOf('atlas-next-stock-counts.js');
  assert.ok(bridgeIndex > 0 && coreIndex > bridgeIndex && countIndex > coreIndex);
});

test('gateway bridge reuses the production Auth client and forwards only its session bearer token', () => {
  assert.match(bridge, /AUTH_PROJECT_URL\s*=\s*'https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co'/);
  assert.match(bridge, /GATEWAY_HOST\s*=\s*'uhbamqetppqmygesoeeh\.supabase\.co'/);
  assert.match(bridge, /originalCreateClient\.apply/);
  assert.match(bridge, /supabase\.createClient\s*=\s*originalCreateClient/);
  assert.match(bridge, /client\.auth\.getSession\(\)/);
  assert.match(bridge, /authorization:\s*`Bearer \$\{session\.access_token\}`/);
  assert.match(bridge, /functions\\\/v1\\\/atlas-/);
  assert.doesNotMatch(bridge, /sb_secret_|SUPABASE_SERVICE_ROLE_KEY|atlas_private/i);
});

test('L1 uses the existing stock-count Edge Function and never accesses private tables directly', () => {
  assert.match(counts, /atlas-stock-counts/);
  for (const action of ['snapshot', 'detail', 'start', 'save-line', 'submit', 'verify', 'reject', 'cancel', 'prepare-publication', 'publish']) {
    assert.match(counts, new RegExp(`['"]${action}['"]`));
  }
  assert.match(counts, /AtlasGatewayBridge\.request/);
  assert.doesNotMatch(counts, /(?:client|supabase|sb|atlasSupabase)\s*\.\s*(?:from|rpc)\s*\(|atlas_private|inventory_items/i);
  assert.doesNotMatch(counts, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
});

test('manual L1 capture preserves original units and explicit evidence', () => {
  for (const unit of ['bottle', 'case', 'unit', 'litre', 'millilitre', 'kilogram', 'gram']) {
    assert.match(counts, new RegExp(`${unit}:`));
  }
  assert.match(counts, /observed_input_quantity/);
  assert.match(counts, /observed_input_unit/);
  assert.match(counts, /capture_surface:\s*'atlas_next_count_line'/);
  assert.match(counts, /client_recorded_at/);
  assert.match(counts, /supported_count_units/);
});

test('publication remains separate and double gated', () => {
  assert.match(counts, /publication_environment_enabled/);
  assert.match(counts, /production_apply_enabled/);
  assert.match(counts, /Prepare publication/);
  assert.match(counts, /Publish verified count/);
  assert.match(counts, /only L1 action that may change live stock/i);
  assert.match(counts, /window\.confirm/);
});

test('phone scanner remains outside the L1 reconnection', () => {
  for (const forbidden of [/navigator\.mediaDevices/, /BarcodeDetector/, /ZXing/i, /decodeFromVideoDevice/, /getUserMedia/]) {
    assert.doesNotMatch(counts, forbidden);
  }
  assert.match(counts, /data-action=\\?"start-count\\?"/);
  assert.match(counts, /data-service-action=\\?"count\\?"/);
});

test('replacement route keeps deterministic rendering without observers or polling', () => {
  assert.doesNotMatch(combined, /MutationObserver/);
  assert.doesNotMatch(combined, /setInterval\s*\(/);
  assert.match(styles, /atlas-counts-workspace/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(max-width: 600px\)/);
  assert.match(styles, /var\(--atlas-surface\)/);
  assert.doesNotMatch(styles, /Fraunces|IBM Plex/);
});
