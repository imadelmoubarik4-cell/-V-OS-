import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const shell = readFileSync('apps/web/assets/js/phase4-shell.js', 'utf8');
const css = readFileSync('apps/web/assets/css/phase4-claude.css', 'utf8');
const modal = readFileSync('apps/web/assets/js/modal.js', 'utf8');
const combined = `${shell}\n${css}\n${modal}`;

test('Phase 4 has one authenticated entry point instead of a competing renderer', () => {
  assert.match(modal, /assets\/js\/phase4-shell\.js/);
  assert.match(modal, /atlas:profile-ready/);
  assert.match(modal, /window\.atlasCurrentProfile\?\.active/);
  assert.doesNotMatch(modal, /phase4-operations-bootstrap\.js/);
  assert.match(shell, /assets\/css\/phase4-claude\.css/);
  assert.match(shell, /window\.AtlasPhase4Shell/);
  assert.match(shell, /atlas:phase4-ready/);
});

test('Claude navigation architecture reuses the live Atlas destinations once', () => {
  for (const group of ['HOME', 'OPERATIONS', 'GROWTH', 'PEOPLE', 'INSIGHTS', 'SYSTEM']) {
    assert.match(shell, new RegExp(`['"]${group}['"]`));
  }
  for (const destination of [
    'Home', 'Inventory', 'Recipes', 'Purchasing', 'Import Center', 'Marketing',
    'Messages', 'Team', 'Profiles', 'Shifts', 'Knowledge', 'Atlas Brain',
    'Business Intelligence', 'Reports', 'Accounting', 'Settings', 'System'
  ]) assert.match(shell, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.match(shell, /nav\.replaceChildren\(fragment\)/);
  assert.match(shell, /remaining\.forEach/);
  assert.doesNotMatch(shell, /MutationObserver/);
  assert.doesNotMatch(shell, /setInterval\s*\(/);
  assert.doesNotMatch(shell, /innerHTML\s*=\s*.*SUPABASE/i);
});

test('light and dark modes use the approved Claude tokens and Inter type', () => {
  assert.match(css, /--p4-bg:\s*#f6f6f4/);
  assert.match(css, /--p4-accent:\s*#1fa8a0/);
  assert.match(css, /html\[data-atlas-theme="dark"\]/);
  assert.match(css, /--p4-bg:\s*#111113/);
  assert.match(css, /--p4-accent:\s*#3fc7be/);
  assert.match(css, /font-family:\s*Inter/);
  assert.match(shell, /family=Inter:wght@400;500;600;700/);
});

test('Phase 4 includes responsive navigation, reduced motion and accessible focus', () => {
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(shell, /aria-current/);
  assert.match(shell, /aria-label/);
  assert.match(shell, /atlas-sidebar-collapsed/);
});

test('the command palette and real navigation actions remain keyboard operable', () => {
  assert.match(shell, /phase4-command-palette/);
  assert.match(shell, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(shell, /ArrowDown/);
  assert.match(shell, /ArrowUp/);
  assert.match(shell, /entry\.action\(\)/);
});

test('the old global floating action button is retired in favor of contextual actions', () => {
  assert.match(css, /\.fab-wrap\s*\{\s*display:\s*none\s*!important/);
});

test('Phase 4 does not ship the Claude runtime or cross Atlas data boundaries', () => {
  for (const forbidden of [
    /support\.js/i,
    /<x-dc/i,
    /new Function\s*\(/,
    /Babel\.transform/,
    /ReactDOM/,
    /SUPABASE_SERVICE_ROLE_KEY/,
    /service_role/i,
    /\batlasSupabase\b/,
    /\bcreateClient\s*\(/,
    /adjust_inventory/,
  ]) assert.doesNotMatch(combined, forbidden);
});
