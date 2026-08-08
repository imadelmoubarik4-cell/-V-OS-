import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('deploy and private-data boundaries are explicit', async () => {
  const [netlify, gitignore] = await Promise.all([
    readFile(new URL('../../netlify.toml', import.meta.url), 'utf8'),
    readFile(new URL('../../.gitignore', import.meta.url), 'utf8'),
  ]);
  assert.match(netlify, /publish\s*=\s*"apps\/web"/);
  for (const path of ['source-data/', 'data/private/', 'tmp/']) assert.match(gitignore, new RegExp(path.replace('/', '\\/')));
  for (const file of ['approved-inventory-extensions.csv', 'inventory-aliases.csv']) {
    assert.match(gitignore, new RegExp(file.replaceAll('.', '\\.')));
  }
});

test('public operational-reference templates contain headers only', async () => {
  const templates = [
    '../../data/templates/approved-inventory-extensions.template.csv',
    '../../data/templates/inventory-aliases.template.csv',
  ];
  for (const template of templates) {
    const lines = (await readFile(new URL(template, import.meta.url), 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `${template} must not contain operational rows`);
  }
});

test('public runtime, seed, and archived examples do not disclose private supplier identities', async () => {
  const paths = [
    '../../apps/web/index.html',
    '../../scripts/build_sprint1_inventory.py',
    '../../supabase/seeds/001_core_suppliers.sql',
    '../../data/archive/atlas-data-0.7/Atlas_DATA_001/data/inventory_master_template.csv',
    '../../data/archive/atlas-data-0.7/Atlas_DATA_002/data/beer_wine_master_template.csv',
    '../../releases/archive/legacy-web/index_atlas_all_fixes.html',
  ];
  const contents = await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const content of contents) assert.doesNotMatch(content, /(?:Ölgerðin|Mekka)/i);
  assert.doesNotMatch(contents[2], /insert\s+into/i);
});

test('release and migration version agree', async () => {
  const [root, version] = await Promise.all([
    readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../releases/alpha-0.8.0/VERSION.md', import.meta.url), 'utf8'),
  ]);
  assert.equal(root.version, '0.8.0');
  assert.match(version, /Version: 0\.8\.0/);
});

test('A.2 staging is review-only for authenticated browser clients', async () => {
  const sql = await readFile(new URL('../../supabase/migrations/20260802090000_phase_a_02_inventory_staging.sql', import.meta.url), 'utf8');
  assert.match(sql, /alter table public\.import_inventory_rows enable row level security/i);
  assert.match(sql, /revoke all on table public\.import_inventory_rows from anon, authenticated/i);
  assert.match(sql, /grant select on table public\.import_inventory_rows to authenticated/i);
  assert.match(sql, /grant update \([\s\S]+?review_status[\s\S]+?\) on table public\.import_inventory_rows to authenticated/i);
  assert.doesNotMatch(sql, /on\s+public\.import_inventory_rows\s+for\s+insert\s+to\s+authenticated/i);
  assert.doesNotMatch(sql, /auth\.role\(\)/i);
});

test('web checkpoint has no missing local asset references', async () => {
  const root = new URL('../../apps/web/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  for (const reference of references) {
    if (/^(?:https?:|#|data:|mailto:)/.test(reference)) continue;
    await assert.doesNotReject(access(new URL(reference.split(/[?#]/)[0], root)), `Missing ${reference}`);
  }
  assert.match(html, /assets\/js\/import-center\.js/);
  assert.match(html, /id="import-queue-file-input"/);
});
