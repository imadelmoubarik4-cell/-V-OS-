import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const system = readFileSync('apps/web/assets/js/system-workspace.js', 'utf8');
const settings = readFileSync('apps/web/assets/js/settings-workspace.js', 'utf8');
const review = readFileSync('apps/web/assets/js/sprint3-review.js', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');
const remediationCss = readFileSync('apps/web/assets/css/s38-app-remediation.css', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');

test('System cannot report Healthy without runtime evidence', () => {
  assert.match(system, /function healthEvidence\(\)/);
  assert.match(system, /if \(!services\(\)\.length\) missing\.push\('service checks'\)/);
  assert.match(system, /if \(!sources\(\)\.length\) missing\.push\('runtime-verified data sources'\)/);
  assert.match(system, /if \(!releases\(\)\.length\) missing\.push\('release checkpoint'\)/);
  assert.match(system, /reported === 'healthy' && !healthEvidence\(\)\.complete \? 'unverified'/);
  assert.match(system, /System health is unverified/);
});

test('System exposes missing recovery evidence without inventing references', () => {
  assert.match(system, /Last known healthy release/);
  assert.match(system, /Rollback reference/);
  assert.match(system, /Runtime-verified backup/);
  assert.match(system, /Recovery readiness unverified/);
  assert.match(system, /Not recorded/);
  assert.match(system, /Operational modules may still contain data/);
});

test('production workspaces identify the runtime truthfully', () => {
  assert.match(settings, /if \(mode === 'production'\) return 'Production'/);
  assert.match(review, /\? 'Production' : 'Isolated rehearsal'/);
  assert.doesNotMatch(review, /Isolated PR branch/);
  assert.doesNotMatch(review, /Production remains unchanged/);
});

test('notifications render one editable card per server policy', () => {
  assert.match(settings, /policies\.map\(\(policy\) => `<form class="settings-card settings-notification-card"/);
  assert.match(settings, /data-settings-notification-form/);
  assert.match(settings, /Policy enabled/);
  assert.match(settings, /Channels/);
  assert.match(settings, /Target roles/);
  assert.match(settings, /notification policies active/);
  assert.match(remediationCss, /\.settings-notification-grid \{ display:grid; \}/);
  assert.doesNotMatch(remediationCss, /\.settings-notification-grid \{ display:none/);
  assert.doesNotMatch(settings, /Individual notification-type switches are intentionally removed/);
  assert.doesNotMatch(settings, /New direct messages.*Mentions.*Shift changes.*Assigned tasks.*Purchase-order and delivery updates.*Low-stock alerts/s);
});

test('production cache-busts every corrected workspace bundle', () => {
  for (const bundle of ['sprint3-review.js', 'system-workspace.js', 'settings-workspace.js']) {
    assert.match(config, new RegExp(`${bundle.replace('.', '\\.')}\\?v=20260917-s55`));
  }
  assert.match(config, /system-workspace\.css\?v=20260917-s55/);
  assert.match(config, /settings-workspace\.css\?v=20260917-s55/);
  assert.match(index, /s38-app-remediation\.css\?v=20260917-s55/);
});
