import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// S88 redesign (spec §4.7, §4.12): the floating quick-action button and its
// menu are retired. Quick actions are the command palette in Actions mode,
// opened from the top-bar + button; every former menu entry is a canonical
// action (AtlasShell.actions) the palette lists per role.
const shell = readFileSync('apps/web/index.html', 'utf8');
const palette = readFileSync('apps/web/assets/js/atlas-palette.js', 'utf8');
const css = readFileSync('apps/web/assets/css/atlas-shell.css', 'utf8');

test('Quick Actions is the + button that opens the palette in Actions mode', () => {
  assert.match(shell, /id="atlas-quick-actions" aria-haspopup="dialog" aria-label="Quick actions"/);
  assert.match(palette, /trigger\.id === 'atlas-quick-actions' \? 'actions' : 'search'/);
  assert.doesNotMatch(shell, /id="fab-menu"|id="fab-btn"|class="fab-wrap"/);
});

test('every former quick-action entry is a canonical action', () => {
  // S88: Inventory and Purchasing register their own actions from their modules.
  const sources = [shell, readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8'), readFileSync('apps/web/assets/js/atlas-purchasing.js', 'utf8')].join('\n');
  for (const id of ['inventory.item.add', 'purchasing.delivery.receive', 'recipes.new', 'purchasing.supplier.add']) {
    assert.match(sources, new RegExp(`id: ?'${id.replace(/\./g, '\\.')}'`), id);
  }
  // No emoji labels (spec §5.8) and no "Log a restock" name (§4.8).
  assert.doesNotMatch(sources, /📦|🍸|🚚|label: ?'Log a restock'/);
});

test('palette rows show a visible keyboard focus and an active row', () => {
  assert.match(css, /\.atlas-palette__item\.is-active \{ background: var\(--bg-muted, #f1f5f9\); \}/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus-color, #3b82f6\); outline-offset: 2px; \}/);
});
