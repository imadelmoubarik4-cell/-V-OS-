import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/brain-checkpoint-k.js', 'utf8');
const css = readFileSync('apps/web/assets/css/brain-checkpoint-k.css', 'utf8');

test('Checkpoint K is wired through the authenticated intelligence gateway', () => {
  assert.match(config, /PHASE3_INTELLIGENCE_API:/);
  assert.match(config, /assets\/css\/brain-checkpoint-k\.css/);
  assert.match(config, /assets\/js\/brain-checkpoint-k\.js/);
  assert.match(config, /globalName:\s*'AtlasCheckpointK'/);
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization:\s*`Bearer \$\{activeSession\.access_token\}`/);
  assert.match(ui, /url\.searchParams\.set\('action', 'refresh'\)/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(ui, /\.from\s*\(\s*['"]/);
});

test('Checkpoint K presents all four evidence domains', () => {
  for (const domain of ['shortage', 'purchase', 'menu', 'waste']) {
    assert.match(ui, new RegExp(`${domain}:`));
  }
  assert.match(ui, /Operational intelligence readiness/);
  assert.match(ui, /domains assessed/);
  assert.match(ui, /Evidence blockers/);
  assert.match(ui, /Safety limits/);
});

test('Checkpoint K makes the safety contract visible', () => {
  assert.match(ui, /Historical July stock is excluded from predictions/);
  assert.match(ui, /Negative adjustments are not waste/);
  assert.match(ui, /No automatic orders, menu changes or staff attribution/);
  assert.match(ui, /Shadow scope only · manager review required/);
  assert.doesNotMatch(ui, /automatic_submission:\s*true|auto(?:matic)?Order|changeMenu|assignBlame/i);
});

test('Checkpoint K escapes source-controlled content before rendering', () => {
  assert.match(ui, /function escapeHtml/);
  assert.match(ui, /escapeHtml\(domain\.label\)/);
  assert.match(ui, /escapeHtml\(domain\.enabled_scope/);
  assert.match(ui, /blockers\.map\(\(item\) => `<li>\$\{escapeHtml\(item\)\}<\/li>`/);
  assert.match(ui, /limitations\.map\(\(item\) => `<li>\$\{escapeHtml\(item\)\}<\/li>`/);
});

test('Checkpoint K remains responsive and consistent with Atlas styling', () => {
  assert.match(css, /checkpoint-k-grid/);
  assert.match(css, /checkpoint-k-domain/);
  assert.match(css, /checkpoint-k-confidence/);
  assert.match(css, /@media/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
