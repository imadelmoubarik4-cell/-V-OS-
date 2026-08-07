import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const operations = readFileSync('apps/web/assets/js/phase4-operations.js', 'utf8');
const bootstrap = readFileSync('apps/web/assets/js/phase4-operations-bootstrap.js', 'utf8');
const css = readFileSync('apps/web/assets/css/phase4-operations.css', 'utf8');
const modal = readFileSync('apps/web/assets/js/modal.js', 'utf8');
const combined = `${operations}\n${bootstrap}\n${css}\n${modal}`;

test('Phase 4B loads after the shared Phase 4 shell', () => {
  assert.match(modal, /assets\/js\/phase4-shell\.js/);
  assert.match(modal, /assets\/js\/phase4-operations-bootstrap\.js/);
  assert.match(bootstrap, /assets\/js\/phase4-operations\.js/);
  assert.match(bootstrap, /createFilteredObserver/);
  assert.match(bootstrap, /phase4-operations-role-guard/);
  assert.match(operations, /assets\/css\/phase4-operations\.css/);
  assert.match(operations, /window\.AtlasPhase4Operations/);
  assert.match(operations, /atlas:phase4b-ready/);
});

test('Home becomes the operational hub without duplicating the old Operations destination', () => {
  assert.match(operations, /phase4-home-operations/);
  assert.match(operations, /operations-center/);
  assert.match(operations, /operationsButton\.remove\(\)/);
  assert.match(operations, /view === 'operations' \? 'dashboard'/);
  assert.match(css, /\.phase4-home-legacy\s*\{\s*display:\s*none\s*!important/);
});

test('Inventory links to the real L1, L2 and scanner workspaces', () => {
  assert.match(operations, /AtlasStockCounts\?\.open/);
  assert.match(operations, /AtlasItemMaster\?\.open/);
  assert.match(operations, /AtlasInventoryScanner\?\.open/);
  for (const label of ['Items', 'Stock count', 'Item master', 'Movements', 'Waste']) {
    assert.match(operations, new RegExp(label));
  }
});

test('live stock is display-only outside controlled workflows', () => {
  assert.match(operations, /input\.readOnly = true/);
  assert.match(operations, /aria-readonly/);
  assert.match(operations, /Stock count or another controlled adjustment/);
  assert.match(css, /#items-body \.step-btn\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /pointer-events:\s*none/);
});

test('purchasing remains an evidence-backed draft with no supplier submission', () => {
  assert.match(operations, /AtlasOperations\?\.orderSuggestions/);
  assert.match(operations, /Replenishment drafts/);
  assert.match(operations, /no supplier submission/i);
  assert.match(operations, /no automatic ordering/i);
  assert.doesNotMatch(operations, /Mark ordered/);
});

test('waste remains explicit evidence and does not silently mutate stock', () => {
  assert.match(operations, /Explicitly recorded waste events only/);
  assert.match(operations, /controlled waste-write gateway is not enabled/);
  assert.match(operations, /No stock was changed/);
  assert.doesNotMatch(operations, /p_movement_type/);
});

test('recipes and Service Mode follow the Claude interaction model', () => {
  assert.match(operations, /AtlasRecipes\?\.openEditor/);
  assert.match(operations, /Atlas Brain/);
  for (const label of ['Quick stock check', 'Start stock count', 'Scan barcode', 'Recipe lookup', 'Checklists', 'Daily brief', 'Waste review']) {
    assert.match(operations, new RegExp(label));
  }
  assert.match(operations, /86 board/);
  assert.match(operations, /Not configured/);
});

test('Phase 4B includes mobile, dark-mode and reduced-motion treatment', () => {
  assert.match(css, /html\[data-atlas-theme="dark"\]/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /inventory-scanner-panel/);
  assert.match(css, /stock-count-workspace/);
  assert.match(css, /item-master-workspace/);
});

test('Phase 4B does not bypass server or database safety boundaries', () => {
  for (const forbidden of [
    /SUPABASE_SERVICE_ROLE_KEY/,
    /service_role/i,
    /adjust_inventory/,
    /\.from\s*\(/,
    /new\s+Function\s*\(/,
    /Babel\.transform/,
    /support\.js/i,
  ]) assert.doesNotMatch(combined, forbidden);
});
