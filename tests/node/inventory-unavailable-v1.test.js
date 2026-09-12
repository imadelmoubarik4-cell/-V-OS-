import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('apps/web/index.html', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/stock-count-bootstrap.js', 'utf8');

test('Movements and Waste navigate to dedicated V1 views', () => {
  assert.match(app, /data-view="movements" data-subview="Inventory movements"/);
  assert.match(app, /data-view="waste" data-subview="Waste"/);
  assert.match(app, /movements: document\.getElementById\('movements-view'\)/);
  assert.match(app, /waste: document\.getElementById\('waste-view'\)/);
  assert.match(app, /movements:'Inventory movements'/);
  assert.match(app, /waste:'Waste'/);
});

test('both views persistently disclose that operational data is unavailable', () => {
  assert.match(app, /id="movements-view"[^>]*data-unavailable-view="movements"/);
  assert.match(app, /Movement history is not available in this V1 preview\./);
  assert.match(app, /No movement records are shown or inferred here\./);
  assert.match(app, /id="waste-view"[^>]*data-unavailable-view="waste"/);
  assert.match(app, /Waste tracking is not available in this V1 preview\./);
  assert.match(app, /No waste records are shown or fabricated here\./);
  assert.doesNotMatch(bootstrap, /showUnavailable/);
  assert.doesNotMatch(bootstrap, /target\.closest\('\[data-subview="Inventory movements"\]'\)/);
});

test('navigation search recognizes Movements and Waste as commands', () => {
  assert.match(app, /q\.includes\('movement'\)\)setActiveView\('movements'\)/);
  assert.match(app, /q\.includes\('waste'\).*setActiveView\('waste'\)/);
});
