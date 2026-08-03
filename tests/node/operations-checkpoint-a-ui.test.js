import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const moduleSource = readFileSync('apps/web/assets/js/operations-checkpoint-a.js', 'utf8');
const css = readFileSync('apps/web/assets/css/operations-checkpoint-a.css', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('Checkpoint A loads from the isolated Phase 3 branch', () => {
  assert.match(config, /OPERATIONS_CHECKPOINT_A_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-operations-checkpoint-a"/);
  assert.match(config, /assets\/js\/operations-checkpoint-a\.js/);
  assert.match(config, /assets\/css\/operations-checkpoint-a\.css/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config + moduleSource, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Checkpoint A presents day-aware routines and daily temperature evidence', () => {
  assert.match(moduleSource, /Checkpoint A · Daily routines/);
  assert.match(moduleSource, /Sunday inventory, Monday deep cleaning and Tuesday storage organisation/);
  assert.match(moduleSource, /Daily temperature log/);
  assert.match(moduleSource, /Corrective action is required for an out-of-range temperature/);
  assert.match(moduleSource, /Manage routines/);
  assert.match(moduleSource, /function routineMarkup/);
  assert.match(moduleSource, /function temperaturePointMarkup/);
  assert.match(css, /checkpoint-a-routine-list/);
  assert.match(css, /checkpoint-a-temperature-list/);
});

test('Tripadvisor is treated as a bounded reputation connection', () => {
  assert.match(moduleSource, /Tripadvisor boundary/);
  assert.match(moduleSource, /Management Center/);
  assert.match(moduleSource, /No social-post publishing, incentivized reviews, review gating or guest-identity guessing/);
  assert.match(moduleSource, /publishing remains locked/);
});

test('Checkpoint A uses the manager API and never writes browser tables directly', () => {
  assert.match(moduleSource, /post\('set-item'/);
  assert.match(moduleSource, /post\('log-temperature'/);
  assert.match(moduleSource, /post\('update-template'/);
  assert.match(moduleSource, /post\('update-temperature-point'/);
  assert.doesNotMatch(moduleSource, /\.from\(/);
  assert.doesNotMatch(moduleSource, /inventory_items.*insert/i);
  assert.doesNotMatch(moduleSource, /temperature_logs.*insert/i);
});

test('Checkpoint A remains responsive and preserves the original Atlas visual system', () => {
  assert.match(css, /@media\(max-width:1180px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(max-width:400px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-bg|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
