// S88 Reports (spec §7.12): Overview absorbs Business Intelligence; the
// comparison period comes from AtlasVenueClock.compareRange; Ask Atlas opens
// Atlas AI with report context; sales stay "not connected".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const shell = readFileSync('apps/web/index.html', 'utf8');
const ui = readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8');
const overview = readFileSync('apps/web/assets/js/reports-overview.js', 'utf8');
const css = readFileSync('apps/web/assets/css/reports-workspace.css', 'utf8');

test('Reports loads through the authenticated Reports gateway', () => {
  assert.match(config, /REPORTS_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-reports"/);
  assert.match(config, /assets\/css\/reports-workspace\.css/);
  assert.match(config, /assets\/js\/reports-workspace\.js/);
  assert.match(config, /globalName:\s*'AtlasReports'/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('the spec tabs and #reports/<report> routes', () => {
  assert.match(ui, /\['overview', 'Overview'\], \['inventory', 'Stock'\], \['purchasing', 'Purchasing'\],\s*\['recipes', 'Recipes'\], \['waste', 'Waste'\], \['labour', 'Labour'\]/);
  assert.match(ui, /const ROUTE_NAMES = \{ inventory: 'stock' \}/);
  assert.match(ui, /href="#reports\/\$\{ROUTE_NAMES\[key\] \|\| key\}"/);
  assert.match(ui, /SECTION_ALIASES = \{ stock: 'inventory', suppliers: 'purchasing', business: 'overview' \}/);
  assert.match(ui, /window\.AtlasShell\.onView\?\.\('reports', \{ show: onShow \}\)/);
});

test('period and comparison: venue-zone dates and compareRange (month-spanning bug fixed)', () => {
  assert.match(ui, /clock\(\)\.compareRange\(range\)/);
  assert.match(ui, /url\.searchParams\.set\('comparison_start_date', compare\.start\)/);
  assert.match(ui, /url\.searchParams\.set\('preset', 'custom'\)/);
  assert.doesNotMatch(ui, /setUTCDate\(start\.getUTCDate\(\)/, 'the old month-spanning comparison is gone');
  assert.doesNotMatch(ui, /'Atlantic\/Reykjavik'|timeZone:/);
  for (const label of ['Today', 'Last 7 days', 'Last 30 days', 'This month', 'Last month', 'Year to date', 'Custom dates', 'vs previous period', 'No comparison']) {
    assert.match(ui, new RegExp(label));
  }
});

test('Overview has the former Business Intelligence figures, unknown stays unknown', () => {
  for (const label of ['Inventory value', 'Purchasing spend', 'Waste', 'Recipe margin', 'Needs attention', 'Data completeness', 'Suggested order', 'Average cost per serve']) {
    assert.match(ui, new RegExp(label));
  }
  assert.match(overview, /function inventoryValue\(\)[\s\S]+?: NaN;/);
  assert.match(overview, /AtlasStockTruth/);
  assert.match(overview, /supplierConcentration/);
  assert.match(overview, /AtlasOperations\?\.orderSuggestions/);
  assert.match(ui, /Not enough data yet/);
  assert.match(ui, /#data\/issues/);
});

test('sales are shown as not connected; no revenue is invented', () => {
  assert.match(ui, /Not connected — no point-of-sale system sends sales to Atlas/);
  assert.match(ui, /Realised margin needs sales|realised margin need sales/i);
  assert.doesNotMatch(ui, /Math\.random\(\)|sampleSales|fakeRevenue/i);
});

test('Ask Atlas opens Atlas AI with the report context; the report ask endpoint UI is retired', () => {
  assert.match(ui, /window\.AtlasAI\?\.askAbout\?\.\(\{ type: 'report'/);
  assert.doesNotMatch(ui, /api\('ask'|action=ask|'ask', \{ method: 'POST'|reports-ask-panel|reports-ask-fab/);
  assert.match(ui, /class="atlas-btn atlas-btn--ghost" data-reports-ask/);
});

test('export stays: CSV, print and copy summary', () => {
  assert.match(ui, /Download CSV/);
  assert.match(ui, /Print or save as PDF/);
  assert.match(ui, /Copy summary/);
});

test('browser uses the session gateway without direct private-table access', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /\.from\s*\(\s*['"]/);
  assert.doesNotMatch(ui, /atlas_private\.|inventory_movements|knowledge_acknowledgements/);
});

test('errors never show raw server text and loading reaches a terminal state', () => {
  assert.match(ui, /Reports couldn\\?'t be loaded\./);
  assert.doesNotMatch(ui, /payload\.error/);
  assert.match(ui, /REQUEST_TIMEOUT_MS/);
  assert.match(ui, /data-reports-retry/);
});

test('Reports stylesheet is module layout only; Business Intelligence files are gone', () => {
  assert.match(css.trim(), /^\/\*[\s\S]*?\*\/\s*@layer atlas\.modules \{[\s\S]*\}$/);
  assert.doesNotMatch(css, /!important|:root|--[a-z-]+\s*:/);
  for (const file of ['assets/js/business.js', 'assets/css/business.css', 'assets/css/legacy/atlas-glass--business.css', 'assets/css/legacy/polish-pass2--reports.css', 'assets/css/legacy/workspaces-polish--reports.css', 'assets/css/legacy/accessibility-responsive-s61--reports.css']) {
    assert.ok(!existsSync(`apps/web/${file}`), file);
    assert.doesNotMatch(shell, new RegExp(file.replace(/[.]/g, '\\.')));
  }
  assert.match(shell, /reports-overview\.js\?v=20260928-s89t/);
});
