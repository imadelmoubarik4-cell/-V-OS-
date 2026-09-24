import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync('apps/web/index.html', 'utf8');
const month = readFileSync('apps/web/assets/js/shifts-month-calendar.js', 'utf8');
const css = readFileSync('apps/web/assets/css/accessibility-responsive-s61.css', 'utf8');
const sources = [
  shell,
  readFileSync('apps/web/assets/js/recipes.js', 'utf8'),
  readFileSync('apps/web/assets/js/stock-count-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/sprint3-review.js', 'utf8'),
  readFileSync('apps/web/assets/js/item-master-workspace.js', 'utf8'),
  readFileSync('apps/web/assets/js/team-messages.js', 'utf8'),
  readFileSync('apps/web/assets/js/knowledge-workspace.js', 'utf8'),
].join('\n');

test('audited search and stock-count filter controls have explicit accessible names', () => {
  for (const label of [
    'Search recipes', 'Search suppliers', 'Search import files', 'Search stock-count items',
    'Filter stock-count lines', 'Search review records', 'Search item master',
    'Search available Atlas records', 'Search Knowledge'
  ]) assert.match(sources, new RegExp(`aria-label="${label}"`));
});

test('every empty Month cell names the exact date in its Add shift action', () => {
  assert.match(month, /class="shift-month-empty"[\s\S]+?aria-label="Add shift on \$\{escapeHtml\(formatDay\(date/);
  assert.match(month, /aria-label="Add shift on \$\{escapeHtml\(formatDay\(state\.selectedDate/);
  assert.match(month, /aria-label="Add first shift on \$\{escapeHtml\(formatDay\(state\.selectedDate/);
});

test('narrow layouts reserve space for the single owning floating action', () => {
  assert.match(css, /#reports-view[\s\S]+?\.fab-wrap[\s\S]+?display:\s*none !important/);
  assert.match(css, /padding-bottom:\s*calc\(96px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /max-height:\s*calc\(100dvh - 104px\)/);
  assert.match(shell, /accessibility-responsive-s61\.css\?v=20260917-s61/);
  assert.match(shell, /shifts-month-calendar\.js\?v=20260926-s88/);
});
