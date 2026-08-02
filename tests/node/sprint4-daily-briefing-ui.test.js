import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const moduleSource = readFileSync('apps/web/assets/js/brain-daily-briefing-v2.js', 'utf8');
const css = readFileSync('apps/web/assets/css/brain-daily-briefing.css', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('Sprint 4 config loads the hardened module from the Sprint 4 branch API', () => {
  assert.match(config, /SPRINT4_BRIEFING_API:\s*"https:\/\/cwazoxupbwxnixpmmlhx\.supabase\.co\/functions\/v1\/atlas-sprint4-briefing"/);
  assert.match(config, /brain-daily-briefing-v2\.js/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config, /service[_-]?role/i);
});

test('Daily Briefing presents confidence, source attribution and evidence cards', () => {
  assert.match(moduleSource, /function confidenceMarkup/);
  assert.match(moduleSource, /function sourceLabel/);
  assert.match(moduleSource, /function evidenceMarkup/);
  assert.match(moduleSource, /Evidence-backed priorities/);
  assert.match(moduleSource, /Source attribution/);
  assert.match(moduleSource, /Trust contract active/);
  assert.match(css, /daily-confidence\.is-verified/);
  assert.match(css, /daily-source-card/);
  assert.match(css, /daily-evidence-values/);
});

test('Daily Briefing does not expose secrets or mutate operational data', () => {
  assert.doesNotMatch(moduleSource, /service[_-]?role/i);
  assert.doesNotMatch(moduleSource, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(moduleSource, /\.from\(/);
  assert.doesNotMatch(moduleSource, /method:\s*['"]POST['"]/);
});

test('Daily Briefing rendering avoids observer loops and locale-dependent grouping', () => {
  assert.match(moduleSource, /state\.observer\?\.disconnect\(\)/);
  assert.match(moduleSource, /if \(!shell\.querySelector\('\[data-daily-briefing\]'\)\) queueRender\(\)/);
  assert.doesNotMatch(moduleSource, /toLocaleString/);
  assert.match(moduleSource, /replace\(\/\\B\(\?=\(\\d\{3\}\)\+\(\?!\\d\)\)\/g, '\.'\)/);
});
