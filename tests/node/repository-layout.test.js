import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const netlify = readFileSync('netlify.toml', 'utf8');

const LEGACY_ROOT_WEB_FILES = [
  'index.html',
  'index_atlas_all_fixes.html',
  'recipes.css',
  'atlas-icon.png'
];

test('Netlify has one canonical deployed web root', () => {
  assert.match(netlify, /publish\s*=\s*"apps\/web"/);
  assert.equal(existsSync('apps/web/index.html'), true, 'apps/web/index.html must remain the canonical entry point');
});

test('legacy root web copies cannot shadow the deployed application', () => {
  for (const path of LEGACY_ROOT_WEB_FILES) {
    assert.equal(existsSync(path), false, `${path} must not be reintroduced at the repository root`);
  }
});
