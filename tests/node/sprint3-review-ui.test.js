import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const config = readFileSync(resolve(root, 'apps/web/config.js'), 'utf8');
const script = readFileSync(resolve(root, 'apps/web/assets/js/sprint3-review.js'), 'utf8');
const css = readFileSync(resolve(root, 'apps/web/assets/css/sprint3-review.css'), 'utf8');

function configuredUrl(key) {
  const match = config.match(new RegExp(`${key}:\\s*"([^"]+)"`));
  assert.ok(match, `${key} must be configured`);
  return new URL(match[1]);
}

test('review center loads from an isolated branch-scoped manager API', () => {
  const reviewApi = configuredUrl('SPRINT3_REVIEW_API');
  assert.equal(reviewApi.pathname, '/functions/v1/atlas-sprint3-review');
  assert.notEqual(reviewApi.hostname, 'dnefgcmjcgxlynycxkts.supabase.co');

  const briefingMatch = config.match(/SPRINT4_BRIEFING_API:\s*"([^"]+)"/);
  if (briefingMatch) {
    const briefingApi = new URL(briefingMatch[1]);
    assert.equal(reviewApi.origin, briefingApi.origin, 'Sprint 4 review and briefing must use the same isolated branch');
  }

  assert.match(config, /assets\/js\/sprint3-review\.js/);
  assert.match(config, /assets\/css\/sprint3-review\.css/);
});

test('browser uses Atlas session and never contains a service key', () => {
  assert.match(script, /auth\.getSession\(\)/);
  assert.match(script, /authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(script + config, /service[_-]?role/i);
  assert.doesNotMatch(script + config, /atlas_private/);
});

test('review UI is manager-gated and promotion-free', () => {
  assert.match(script, /\['admin', 'manager'\]\.includes\(profile\.role\)/);
  assert.match(script, /approve/);
  assert.match(script, /reject/);
  assert.match(script, /reset/);
  assert.doesNotMatch(script, /inventory_items.*insert/i);
  assert.doesNotMatch(script, /recipes.*insert/i);
});

test('review UI supports responsive layouts and private-data states', () => {
  assert.match(css, /@media\(max-width:1180px\)/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:500px\)/);
  assert.match(css, /review-status-badge\.pending/);
  assert.match(css, /review-status-badge\.approved/);
  assert.match(css, /review-status-badge\.rejected/);
});
