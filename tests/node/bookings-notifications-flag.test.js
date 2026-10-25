// The production staff inbox is explicitly enabled independently of guest-booking
// activation. The worker itself still fails closed without its flag. While off it must be completely
// inert — no atlas-bookings request from any page — so Accounting / Home / Team
// and every other page stay free of unexpected booking requests or console errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = readFileSync(path.join(ROOT, 'apps/web/config.js'), 'utf8');
const worker = readFileSync(path.join(ROOT, 'apps/web/assets/js/bookings-notifications.js'), 'utf8');

test('the production staff inbox is explicitly enabled with a 60-second refresh', () => {
  assert.match(config, /BOOKING_NOTIFICATIONS_ENABLED:\s*true/);
  assert.match(config, /BOOKING_NOTIFICATIONS_REFRESH_SECONDS:\s*60/);
});

test('the staff inbox flag is independent of public guest-booking activation', () => {
  // The staff inbox is on while public guest-booking remains off in the staff app.
  assert.match(config, /PUBLIC_BOOKING_ENABLED:\s*false/);
  assert.match(config, /BOOKING_NOTIFICATIONS_ENABLED:\s*true/);
});

test('the worker gates on the flag before doing anything', () => {
  // A live enabled() check reading VABAR_CONFIG.
  assert.match(worker, /function enabled\(\)\s*\{[\s\S]*BOOKING_NOTIFICATIONS_ENABLED === true/);
  // init() returns early when disabled (no listeners, no contributor registered).
  assert.match(worker, /if \(!enabled\(\)\) return;/);
  // refresh() also refuses to fetch when disabled.
  assert.match(worker, /if \(!enabled\(\)[^)]*\) return;/);
});

test('the worker has no polling interval and no MutationObserver (performance/guard preserved)', () => {
  assert.doesNotMatch(worker, /setInterval\s*\(/);
  assert.doesNotMatch(worker, /new\s+(?:window\.)?MutationObserver\s*\(/);
});
