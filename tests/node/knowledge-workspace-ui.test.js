import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacyCss, linkPosition, layerOf } from './helpers/legacy-css.js';

const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const ui = readFileSync('apps/web/assets/js/knowledge-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/knowledge-workspace.css', 'utf8');
const remediationCss = legacyCss('s38-app-remediation');
const finalCss = legacyCss('knowledge-s56');
const bridge = readFileSync('apps/web/assets/js/knowledge-team-link-bridge.js', 'utf8');
const team = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');

test('Checkpoint G loads through the authenticated Knowledge gateway', () => {
  assert.match(config, /KNOWLEDGE_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-knowledge"/);
  assert.match(config, /assets\/css\/knowledge-workspace\.css/);
  assert.match(config, /assets\/js\/knowledge-workspace\.js/);
  assert.match(config, /globalName:\s*'AtlasKnowledge'/);
  assert.match(config, /assets\/js\/knowledge-team-link-bridge\.js/);
  assert.doesNotMatch(config + ui + bridge, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Knowledge assets load deterministically before the final remediation layer', () => {
  const stylesheet = linkPosition('knowledge-workspace.css');
  const remediation = linkPosition('s38-app-remediation');
  const module = index.indexOf('assets/js/knowledge-workspace.js');
  const bridgeModule = index.indexOf('assets/js/knowledge-team-link-bridge.js');
  const remediationModule = index.indexOf('assets/js/s38-app-remediation.js');

  assert.ok(stylesheet >= 0 && stylesheet < remediation);
  // S88: same cascade layer, so link order (not layer order) still decides.
  assert.equal(layerOf('knowledge-workspace.css'), layerOf('legacy/s38-app-remediation--knowledge.css'));
  assert.ok(module >= 0 && module < remediationModule);
  assert.ok(bridgeModule >= 0 && bridgeModule < remediationModule);
});

test('Knowledge exposes the complete requested staff workspace', () => {
  for (const label of ['Library', 'Required reading', 'Training', 'Sources', 'Activity']) {
    assert.match(ui, new RegExp(label));
  }
  assert.match(ui, /Search policies, SOPs, checklists and training/);
  assert.match(ui, /Required reading follows the published version/);
  assert.match(ui, /Team onboarding progress/);
  assert.match(ui, /Google Drive/);
  assert.match(ui, /Knowledge activity/);
});

test('manager workflow keeps drafts private and publishes immutable versions', () => {
  assert.match(ui, /Save private draft/);
  assert.match(ui, /Staff visibility has not changed/);
  assert.match(ui, /Publish version/);
  assert.match(ui, /Existing acknowledgements remain attached to the previous version/);
  assert.match(ui, /Retire/);
  assert.match(ui, /Acknowledgements version-specific/);
});

test('required reading and source governance are interactive', () => {
  assert.match(ui, /Acknowledge version/);
  assert.match(ui, /mark-read/);
  assert.match(ui, /acknowledge/);
  assert.match(ui, /save-source/);
  assert.match(ui, /remove-source/);
  assert.match(ui, /set-task-links|task_ids/);
  assert.match(ui, /Private source URL/);
  assert.match(ui, /The URL remains manager-only/);
});

test('markdown rendering escapes raw HTML before adding limited formatting', () => {
  assert.match(ui, /function escapeHtml/);
  assert.match(ui, /function renderMarkdown/);
  assert.match(ui, /inlineMarkdown/);
  assert.match(ui, /escapeHtml\(value\)/);
  assert.doesNotMatch(ui, /marked\.|markdown-it|dangerouslySetInnerHTML/);
});

test('browser has no direct private database or Drive API access', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /knowledge_articles|knowledge_article_versions|knowledge_acknowledgements/);
  assert.doesNotMatch(ui, /drive\.googleapis\.com|www\.googleapis\.com\/drive/);
  assert.match(ui, /automatic synchronization is not enabled/i);
  assert.match(ui, /Source text is not committed to the public repository/i);
});

test('Team Knowledge links are intercepted before the legacy fallback', () => {
  assert.match(bridge, /data-team-open-link="knowledge_article"/);
  assert.match(bridge, /stopImmediatePropagation/);
  assert.match(bridge, /AtlasKnowledge\?\.openArticle/);
  assert.match(bridge, /data-view="knowledge"/);
  assert.match(team, /data-team-open-link/);
});

test('Knowledge preserves the original Atlas design and responsive layout', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /@media\(max-width:430px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

test('Knowledge navigation uses separate light Atlas cards instead of the legacy beige rail', () => {
  assert.match(remediationCss, /#knowledge-view \.knowledge-tabs\s*\{[^}]*display:grid;[^}]*background:transparent;/s);
  assert.match(remediationCss, /#knowledge-view \.knowledge-tabs button\s*\{[^}]*background:#fff;/s);
  assert.match(remediationCss, /#knowledge-view \.knowledge-tabs button\.is-active\s*\{[^}]*background:var\(--s38-blue-soft\) !important;/s);
  assert.match(remediationCss, /#knowledge-view \.knowledge-footer-contract\s*\{[^}]*background:var\(--s38-blue-soft\);/s);
  assert.doesNotMatch(remediationCss, /\.knowledge-tabs\s*\{[^}]*background:#eeece6;/s);
  assert.equal((remediationCss.match(/{/g) || []).length, (remediationCss.match(/}/g) || []).length);
});

test('Knowledge categories and article properties stay compact until opened', () => {
  assert.match(ui, /<details class="knowledge-category-filter">/);
  assert.match(ui, /<details class="knowledge-editor-properties" data-knowledge-editor-properties>/);
  assert.doesNotMatch(ui, /<details class="knowledge-(?:category-filter|editor-properties)"[^>]*\sopen/);
  assert.match(finalCss, /\.knowledge-category-row\{[\s\S]*flex-wrap:wrap!important/);
  assert.match(finalCss, /@media\(max-width:430px\)/);
});

test('managers can create an article already linked to an unserved training task', () => {
  assert.match(ui, /data-knowledge-link-task/);
  assert.match(ui, /Create linked article/);
  assert.match(ui, /state\.pendingTaskId = taskId/);
  assert.match(ui, /linkedTasks\.add\(state\.pendingTaskId\)/);
  assert.match(ui, /task_ids: taskIds/);
});

test('production loads the final Knowledge assets with a cache key', () => {
  assert.match(index, /legacy\/knowledge-s56--knowledge\.css\?v=20260926-s88/);
  assert.match(index, /knowledge-workspace\.js\?v=20260917-s56/);
});
