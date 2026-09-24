import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacyCss, linkPosition, layerOf } from './helpers/legacy-css.js';

const shell = readFileSync('apps/web/index.html', 'utf8');
const glass = legacyCss('atlas-glass');

test('Quick Actions keeps the existing Atlas action surface', () => {
  assert.match(shell, /id="fab-menu"/);
  assert.match(shell, /id="fab-add-item"/);
  assert.match(shell, /id="fab-log-restock"/);
  assert.match(shell, /id="fab-add-recipe"/);
  assert.match(shell, /id="fab-add-supplier"/);
});

test('Quick Actions uses dark foregrounds on the light glass menu', () => {
  assert.match(glass, /#fab-menu\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*\.9\)/s);
  assert.match(glass, /#fab-menu button\s*\{[^}]*color:\s*var\(--atlas-text\)/s);
  assert.match(glass, /#fab-menu button:hover,[\s\S]*#fab-menu button:focus-visible\s*\{[^}]*background:\s*var\(--blue-100\)[^}]*color:\s*var\(--atlas-text\)/s);
});

test('Quick Actions exposes a visible keyboard focus indicator', () => {
  assert.match(glass, /#fab-menu button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--blue-600\)[^}]*outline-offset:\s*2px/s);
});
