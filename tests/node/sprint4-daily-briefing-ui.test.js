import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const moduleSource = readFileSync('apps/web/assets/js/brain-daily-briefing-v2.js', 'utf8');
const css = readFileSync('apps/web/assets/css/brain-daily-briefing.css', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function endpointHost(name, slug) {
  const match = config.match(new RegExp(`${name}:\\s*"https:\\/\\/([a-z0-9]+)\\.supabase\\.co\\/functions\\/v1\\/${slug}"`));
  assert.ok(match, `${name} endpoint is missing`);
  return match[1];
}

test('review, briefing and Phase 3 use one isolated branch graph', () => {
  const hosts = [
    endpointHost('SPRINT3_REVIEW_API', 'atlas-sprint3-review'),
    endpointHost('SPRINT4_BRIEFING_API', 'atlas-sprint4-briefing'),
    endpointHost('PHASE3_BRAIN_API', 'atlas-phase3-brain')
  ];
  assert.equal(new Set(hosts).size, 1);
  assert.notEqual(hosts[0], 'dnefgcmjcgxlynycxkts');
  assert.match(config, /brain-daily-briefing-v2\.js/);
  assert.match(config, /brain-phase3\.js/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config, /SUPABASE_SERVICE_ROLE_KEY/);
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
  assert.ok(moduleSource.includes('state.observer?.disconnect()'));
  assert.ok(moduleSource.includes("if (!shell.querySelector('[data-daily-briefing]')) queueRender();"));
  assert.doesNotMatch(moduleSource, /toLocaleString/);
  assert.ok(moduleSource.includes("replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.')"));
});
