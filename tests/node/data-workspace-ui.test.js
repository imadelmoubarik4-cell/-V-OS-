// S88 Data (spec §7.14): Imports, Issues, Par levels, Import review and the
// catalogue approval queue in one manager page (assets/js/data-workspace.js),
// replacing Import Center (import-center.js) and Real VÁ Data (sprint3-review.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const config = read('apps/web/config.js');
const index = read('apps/web/index.html');
const script = read('apps/web/assets/js/data-workspace.js');
const css = read('apps/web/assets/css/data-workspace.css');
const catalogue = read('supabase/migrations/20260927093000_s89_data_review_catalog_issues.sql');

function configuredUrl(key) {
  const match = config.match(new RegExp(`${key}:\\s*"([^"]+)"`));
  assert.ok(match, `${key} must be configured`);
  return new URL(match[1]);
}

test('import review uses the production manager API; the old pages are gone', () => {
  const reviewApi = configuredUrl('SPRINT3_REVIEW_API');
  assert.equal(reviewApi.pathname, '/functions/v1/atlas-sprint3-review');
  assert.match(script, /cfg\.SPRINT3_REVIEW_API/);
  assert.match(script, /cfg\.ITEM_MASTER_API/);
  for (const file of ['assets/js/import-center.js', 'assets/js/sprint3-review.js', 'assets/css/import-center.css', 'assets/css/sprint3-review.css',
    'assets/css/legacy/import-polish--import-center.css', 'assets/css/legacy/s38-app-remediation--import-center.css', 'assets/css/legacy/review-polish--sprint3-review.css']) {
    assert.ok(!existsSync(resolve(root, 'apps/web', file)), file);
    assert.doesNotMatch(index + config, new RegExp(file.replace(/[.]/g, '\\.')));
  }
  assert.doesNotMatch(index, /id="imports-view"/);
  assert.match(index, /<script src="assets\/js\/data-workspace\.js\?v=20260926-s88"><\/script>/);
  assert.match(index, /\['imports', \{ guard: \(\) => 'data' \}\]/);
});

test('browser uses the Atlas session and never contains a service key', () => {
  assert.match(script, /auth\.getSession\(\)/);
  assert.match(script, /authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(script + config, /service[_-]?role/i);
  assert.doesNotMatch(script, /atlas_private/);
});

test('Data is manager-only with a permission state for direct links', () => {
  assert.match(script, /const MANAGERS = \['admin', 'manager'\]/);
  assert.match(script, /Data is for managers/);
  assert.match(script, /Ask an administrator for access\./);
  assert.match(script, /registerView\('data', \{ root: \(\) => ensureRoot\(\), title: 'Data'/);
});

test('the five tabs and their routes', () => {
  assert.match(script, /\['imports', 'Imports'\],\s*\['issues', 'Issues'\],\s*\['pars', 'Par levels'\],\s*\['import-review', 'Import review'\],\s*\['approvals', 'Waiting for approval'\]/);
  assert.match(script, /#data\/import\/\$\{attr\(encodeURIComponent\(batch\.id\)\)\}/);
  assert.match(script, /aria-label="Import progress"/);
  assert.match(script, /Upload'\)[\s\S]+?'Review'\)[\s\S]+?'Import'\)/);
});

test('every data-review issue code has a readable detail and a fix action', () => {
  const codes = [...catalogue.matchAll(/\('([a-z]+\.[a-z_]+)','(?:inventory_item|recipe|recipe_ingredient|catalog_change_request)'/g)].map((match) => match[1]);
  assert.equal(codes.length, 16);
  for (const code of codes) assert.match(script, new RegExp(`case '${code.replace('.', '\\.')}'`), code);
  for (const fix of ['par_levels', 'recipe', 'catalog_duplicates', 'catalog_queue', 'catalog_codes', 'item_master']) assert.match(script, new RegExp(`case '${fix}'`));
  assert.match(script, /#inventory\/item\//);
  assert.match(script, /#data\/pars\?item=/);
  assert.match(script, /\/edit">Edit recipe/);
});

test('par editor: suggestions only when eligible and cover days are typed; nothing saves until pressed', () => {
  assert.match(script, /rpc\('atlas_par_level_evidence', \{ p_item_ids: null, p_cover_days: cover \}\)/);
  assert.match(script, /rpc\('atlas_apply_par_levels'/);
  assert.match(script, /expected_par_level: row\.par_level \?\? null/);
  assert.match(script, /expected_updated_at: row\.updated_at \|\| null/);
  assert.match(script, /result\?\.status === 'conflict'/);
  assert.match(script, /Nothing was saved: /);
  assert.match(script, /Save \$\{plural\(changes\.length, 'change', 'changes'\)\}/);
  assert.match(script, /Enter days of cover to see a suggestion/);
});

test('approval queue: decide with version and resolution, audit shown, backfill creates pending requests', () => {
  assert.match(script, /'catalog-queue'/);
  assert.match(script, /edge\(cfg\.ITEM_MASTER_API, 'catalog-decide'/);
  assert.match(script, /expected_version: request\.version/);
  for (const mode of ['retire_into', 'not_duplicates', 'different_pack']) assert.match(script, new RegExp(`value="${mode}"`));
  assert.match(script, /'catalog-backfill'/);
  assert.match(script, /Every suggestion waits here for your approval/);
  assert.match(script, /\['Requested', /);
  assert.match(script, /\['Decided', /);
  assert.match(script, /self_approve: true/);
});

test('Home attention row and nav badge for pending approvals', () => {
  assert.match(script, /home\?\.contribute\?\.\('data', \{ order: 60, focusRows \}\)/);
  assert.match(script, /catalog\.pending_approval/);
  assert.match(script, /route: '#data\/approvals'/);
  assert.match(script, /\[data-nav-badge="data"\]/);
});

test('import review: nothing changes live records until approved', () => {
  assert.match(script, /Nothing here changes live records until you approve it\./);
  assert.match(script, /data-data-decide="approve">Approve/);
  assert.match(script, /data-data-decide="reject">Reject/);
  assert.doesNotMatch(script, /Isolated PR branch|Production remains unchanged|Phase A/);
});

test('times use the venue clock; errors never show raw server text', () => {
  assert.match(script, /formatDateTime\?\.\(value/);
  assert.doesNotMatch(script, /toLocaleString|'Atlantic\/Reykjavik'/);
  assert.doesNotMatch(script, /payload\.error|error\.message\b(?! =)/);
  assert.match(script, /function friendlyError/);
});

test('Data stylesheet is module layout in @layer atlas.modules', () => {
  assert.match(css.trim(), /^\/\*[\s\S]*?\*\/\s*@layer atlas\.modules \{[\s\S]*\}$/);
  assert.doesNotMatch(css, /!important|:root|--[a-z-]+\s*:/);
});
