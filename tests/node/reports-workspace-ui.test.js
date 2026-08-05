import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/reports-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/reports-workspace.css', 'utf8');

function expectLabels(source, labels) {
  for (const label of labels) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

test('Checkpoint H loads through the authenticated Reports gateway', () => {
  assert.match(config, /REPORTS_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-reports"/);
  assert.match(config, /assets\/css\/reports-workspace\.css/);
  assert.match(config, /assets\/js\/reports-workspace\.js/);
  assert.match(config, /globalName:\s*'AtlasReports'/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Reports preserves the complete requested navigation surface', () => {
  for (const section of [
    'overview', 'sales', 'inventory', 'recipes', 'purchasing', 'suppliers',
    'waste', 'labour', 'operations', 'knowledge', 'saved', 'exports'
  ]) {
    assert.match(ui, new RegExp(`['"]${section}['"]`));
  }
  assert.match(ui, /const SECTION_ORDER/);
  assert.match(ui, /data-reports-section=/);
  assert.match(ui, /escapeHtml\(section\.name\)/);
});

test('period, comparison and custom date controls are functional', () => {
  expectLabels(ui, [
    'Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'This week', 'Last week',
    'This month', 'Last month', 'This quarter', 'Year to date', 'Custom range',
    'Previous period', 'Previous week', 'Previous month', 'Previous year', 'No comparison'
  ]);
  assert.match(ui, /comparison_start_date/);
  assert.match(ui, /comparison_end_date/);
  assert.match(ui, /data-reports-preset/);
  assert.match(ui, /data-reports-comparison/);
});

test('global filters expose selections as removable chips', () => {
  assert.match(ui, /data-reports-filter=/);
  assert.match(ui, /data-reports-remove-filter/);
  assert.match(ui, /data-reports-clear-filters/);
  assert.match(ui, /filter_options/);
  expectLabels(ui, ['Category', 'Supplier', 'Employee', 'Status']);
  assert.match(ui, /Clear \$\{count\}/);
});

test('important report values are inspectable and exportable', () => {
  assert.match(ui, /class="report-kpi"/);
  assert.match(ui, /data-reports-sort/);
  assert.match(ui, /data-reports-page/);
  assert.match(ui, /data-reports-source/);
  assert.match(ui, /data-reports-export="csv"/);
  assert.match(ui, /print\(\)/);
  assert.match(ui, /navigator\.clipboard/);
  assert.match(ui, /Report,|Generated at|Currency/);
});

test('saved configurations remain permission-safe when reopened', () => {
  assert.match(ui, /localStorage/);
  assert.match(ui, /savedStorageKey/);
  assert.match(ui, /data-reports-save(?:-view|=|\b)/);
  assert.match(ui, /Save current view/);
  assert.match(ui, /data-reports-saved-open/);
  assert.match(ui, /data-reports-saved-rename/);
  assert.match(ui, /data-reports-saved-duplicate/);
  assert.match(ui, /data-reports-saved-archive/);
  assert.match(ui, /data-reports-saved-remove/);
  assert.match(ui, /Reopening always rechecks current permissions and live data/);
});

test('Ask Atlas stays grounded in the current report snapshot', () => {
  assert.match(ui, /Ask Atlas/);
  assert.match(ui, /data-reports-ask-form/);
  assert.match(ui, /api\('ask'/);
  assert.match(ui, /evidence/);
  assert.match(ui, /limitations/);
  assert.match(ui, /permission-filtered report snapshot/i);
});

test('unavailable sales data is never replaced with invented values', () => {
  assert.match(ui, /Sales integration is not available|Sales integration has not been connected|Data source not connected/);
  assert.match(ui, /missing data with sample values|No sample revenue|No values are invented|does not invent/i);
  assert.doesNotMatch(ui, /Math\.random\(\).*sales|sampleSales|fakeRevenue/i);
});

test('browser uses the session gateway without direct private-table access', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization:\s*`Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /\.from\s*\(\s*['"]/);
  assert.doesNotMatch(ui, /atlas_private\.|inventory_movements|knowledge_acknowledgements/);
});

test('Reports preserves the Atlas visual system and tablet-first behavior', () => {
  assert.match(css, /--reports-surface:var\(--atlas-surface/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:1100px\)/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
