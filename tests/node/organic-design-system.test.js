import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('apps/web/assets/css/organic-design-system.css', 'utf8');
const config = readFileSync('apps/web/config.js', 'utf8');

const requiredTokens = [
  '--color-bg: #f5ead8',
  '--color-surface: #ebddc5',
  '--color-text: #201e1d',
  '--color-accent: #c67139',
  '--color-accent-2: #7a8a5e',
  '--font-heading: "Caprasimo"',
  '--font-body: "Figtree"',
  '--radius-md: 16px',
  '--radius-lg: 28px'
];

test('organic design tokens match the approved portable system', () => {
  requiredTokens.forEach((token) => assert.ok(css.includes(token), token));
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

test('portable component primitives are available', () => {
  [
    '.btn-primary', '.btn-secondary', '.btn-ghost', '.input', '.card',
    '.tag-accent', '.tag-accent-2', '.tag-neutral', '.tag-outline',
    '.nav-brand', '.table', '.dialog-backdrop', '.dialog-title', '.washed'
  ].forEach((selector) => assert.ok(css.includes(selector), selector));
});

test('theme integrates the Atlas shell and intelligence surfaces', () => {
  [
    '.atlas-sidebar', '.atlas-topbar', '.nav-item.active', '.service-toggle',
    '.brain-hero', '.daily-briefing-shell', '.daily-confidence.is-verified',
    '.daily-source-card', '.review-hero', '.review-row.selected', '.service-card'
  ].forEach((selector) => assert.ok(css.includes(selector), selector));
  assert.ok(css.includes('--atlas-bg: var(--color-bg)'));
  assert.ok(css.includes('--atlas-accent: var(--color-accent)'));
});

test('Caprasimo, Figtree and the organic stylesheet load last', () => {
  assert.match(config, /Caprasimo:wght@400&family=Figtree:wght@400;600;700/);
  assert.match(config, /assets\/css\/organic-design-system\.css/);
  assert.match(config, /document\.documentElement\.dataset\.atlasTheme = 'organic'/);
  assert.ok(config.indexOf('loadAtlasOrganicDesignSystem') > config.indexOf('loadAtlasDailyBriefing'));
});

test('responsive and accessibility safeguards remain present', () => {
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('@media (max-width: 760px)'));
  assert.ok(css.includes('@media (max-width: 480px)'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});
