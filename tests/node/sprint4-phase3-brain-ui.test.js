import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const moduleSource = readFileSync('apps/web/assets/js/brain-phase3.js', 'utf8');
const css = readFileSync('apps/web/assets/css/brain-phase3.css', 'utf8');

test('Phase 3 loads from the isolated Brain API', () => {
  assert.match(config, /PHASE3_BRAIN_API:\s*"https:\/\/hrhcwshdaigawukctfob\.supabase\.co\/functions\/v1\/atlas-phase3-brain"/);
  assert.match(config, /assets\/js\/brain-phase3\.js/);
  assert.match(config, /assets\/css\/brain-phase3\.css/);
  assert.doesNotMatch(config + moduleSource, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Phase 3 presents recommendations, why explanations, evidence and memory', () => {
  assert.match(moduleSource, /Shadow recommendations/);
  assert.match(moduleSource, /Capability gates/);
  assert.match(moduleSource, /Decision memory/);
  assert.match(moduleSource, /Why Atlas recommends this/);
  assert.match(moduleSource, /Previous decisions and outcomes/);
  assert.match(moduleSource, /function evidenceMarkup/);
  assert.match(moduleSource, /function recommendationDetailMarkup/);
  assert.match(css, /phase3-recommendation-grid/);
  assert.match(css, /phase3-evidence-card/);
  assert.match(css, /phase3-memory-row/);
});

test('Phase 3 decisions and outcomes remain manager-mediated shadow feedback', () => {
  assert.match(moduleSource, /decision.*accept.*reject.*modify.*defer.*reset/s);
  assert.match(moduleSource, /client_request_id:\s*requestId\(\)/);
  assert.match(moduleSource, /No operational record is changed/);
  assert.match(moduleSource, /AI generation off/);
  assert.match(moduleSource, /Automatic ordering off/);
  assert.match(moduleSource, /Historical stock excluded from predictions/);
  assert.doesNotMatch(moduleSource, /\.from\(/);
  assert.doesNotMatch(moduleSource, /inventory_items.*insert/i);
  assert.doesNotMatch(moduleSource, /purchase_orders.*insert/i);
});

test('Phase 3 renderer is loop-safe, responsive and preserves original Atlas styling', () => {
  assert.ok(moduleSource.includes('state.observer?.disconnect()'));
  assert.ok(moduleSource.includes("if (!shell.querySelector('[data-phase3-brain]')) queueRender();"));
  assert.doesNotMatch(moduleSource, /toLocaleString/);
  assert.match(css, /@media\(max-width:1180px\)/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-bg|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
