import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync('apps/web/index.html', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-workspace.js', 'utf8');
const sources = [
  shell,
  readFileSync('apps/web/assets/js/recipes.js', 'utf8'),
  readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/data-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/atlas-inventory.js', 'utf8'),
  readFileSync('apps/web/assets/js/atlas-purchasing.js', 'utf8'),
  readFileSync('apps/web/assets/js/team-messages.js', 'utf8'),
  readFileSync('apps/web/assets/js/knowledge-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/team-profiles.source.js', 'utf8'),
].join('\n');

test('audited search and stock-count filter controls have explicit accessible names', () => {
  for (const label of [
    // S88: Item Master is part of Inventory; the count flow has one search.
    'Search recipes or ingredients', 'Search suppliers', 'Search files', 'Search this count',
    'Search records', 'Search items, suppliers or codes',
    'Search conversations', 'Search people', 'Search Knowledge'
  ]) assert.match(sources, new RegExp(`aria-label="${label}"`));
});

test('every Shifts add control and Month day names the exact date', () => {
  // S88: the Month calendar is part of shifts-workspace.js (one canonical module).
  assert.match(month, /aria-label="Add a shift for \$\{escapeHtml\(person\.display_name\)\} on \$\{escapeHtml\(longDate\(key\)\)\}"/);
  assert.match(month, /const labelParts = \[longDate\(key\)/);
  assert.match(month, /class="shifts-month__cell[\s\S]+?aria-label="\$\{escapeHtml\(labelParts\.join/);
});

test('narrow layouts reserve space for the phone tab bar, not a floating action', () => {
  // S88 redesign (spec §4.12): the floating + button is retired; the phone tab
  // bar owns the bottom edge and pages pad above it.
  assert.doesNotMatch(shell, /class="fab-wrap"|id="fab-btn"/);
  // Messages (the page that used this rule) now pads its own list above the tab bar
  // and keeps the composer above the safe area (S88 module stylesheet).
  const messagesCss = readFileSync('apps/web/assets/css/team-messages.css', 'utf8');
  assert.match(messagesCss, /calc\(var\(--tabbar-h\) \+ var\(--s-10\)\)/);
  assert.match(messagesCss, /env\(safe-area-inset-bottom\)/);
  // S88: every S61 fragment moved into its module sheet (Reports, Messages); none is linked.
  assert.doesNotMatch(shell, /legacy\/accessibility-responsive-s61--/);
  assert.match(shell, /shifts-workspace\.js\?v=20260926-s88/);
  assert.doesNotMatch(shell, /shifts-month-calendar\.js|shifts-month-tab-bridge\.js/);
});
