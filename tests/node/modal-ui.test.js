import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modal = readFileSync('apps/web/assets/js/modal.js', 'utf8');

test('shared modal layer preserves the Atlas modal contract', () => {
  assert.match(modal, /\[data-atlas-modal\]\.is-open/);
  assert.match(modal, /\[data-modal-close\]/);
  assert.match(modal, /closeOnBackdrop/);
  assert.match(modal, /document\.addEventListener\('keydown', closeTopModal\)/);
});

test('legacy overlays share X, Cancel, Escape and backdrop dismissal', () => {
  assert.match(modal, /legacyOverlaySelector = '\.overlay:not\(\[data-atlas-modal\]\)'/);
  assert.match(modal, /\.modal-close/);
  assert.match(modal, /\[id\^="cancel-"\]\[id\$="-btn"\]/);
  assert.match(modal, /visibleLegacyOverlays\(\)\.at\(-1\)/);
  assert.match(modal, /event\.target !== root/);
});

test('legacy dismissal clears interaction state and form contents', () => {
  assert.match(modal, /root\.style\.display = 'none'/);
  assert.match(modal, /root\.hasAttribute\('aria-hidden'\).*root\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(modal, /root\.querySelectorAll\('form'\)\.forEach\(\(form\) => form\.reset\(\)\)/);
  assert.match(modal, /atlas:modal-close/);
});
