// Knowledge (#knowledge, spec §7.11, §8.6): the S88 rebuild on the design
// system. Covers the gateway, the page structure, staff/manager boundaries,
// authoring, required reading, search, links and the module stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const ui = readFileSync('apps/web/assets/js/knowledge-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/knowledge-workspace.css', 'utf8');
const team = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');
const fn = readFileSync('supabase/functions/atlas-knowledge/index.ts', 'utf8');

test('Knowledge loads through the authenticated Knowledge gateway', () => {
  assert.match(config, /KNOWLEDGE_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-knowledge"/);
  assert.match(config, /assets\/css\/knowledge-workspace\.css/);
  assert.match(config, /assets\/js\/knowledge-workspace\.js/);
  assert.match(config, /globalName:\s*'AtlasKnowledge'/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('the Team link bridge is retired: links resolve through the shell registry', () => {
  assert.ok(!existsSync('apps/web/assets/js/knowledge-team-link-bridge.js'));
  assert.doesNotMatch(config + index, /knowledge-team-link-bridge/);
  assert.match(ui, /shell\.links\?\.register\?\.\('knowledge_article', openArticleFromLink\)/);
  assert.match(ui, /function openArticleFromLink\(articleId\)[\s\S]+?routeTo\('knowledge', \{ article: id \}/);
  assert.match(team, /data-team-open-link/);
  assert.match(team, /if \(window\.AtlasShell\?\.openLink\?\.\(type, key, \{ source: 'team-messages' \}\)\) return true;/);
  assert.match(team, /if \(link\.type === 'knowledge_article'\) return `#knowledge\/\$\{key\}`/);
});

test('page anatomy: header, tabs with routes, search-first library', () => {
  assert.match(ui, /<h1 class="page-head__title">Knowledge<\/h1>/);
  for (const label of ['Library', 'Required reading', 'Training', 'Sources', 'Activity']) assert.match(ui, new RegExp(`label: '${label}'`));
  assert.match(ui, /\{ key: 'sources', label: 'Sources', manager: true \}/);
  assert.match(ui, /\{ key: 'activity', label: 'Activity', manager: true \}/);
  assert.match(ui, /placeholder="Search procedures, recipes, policies" aria-label="Search Knowledge"/);
  assert.match(ui, /Required for you/);
  assert.match(ui, /class="kn-rail" aria-label="Categories"/);
  assert.match(ui, /registerView\('knowledge', \{ root: \(\) => host\(\), title: 'Knowledge', render, onHide: hide \}\)/);
  // No hero, KPI cards or engineering copy.
  assert.doesNotMatch(ui, /knowledge-hero|summary-grid|Checkpoint|snapshot fallback/);
});

test('server full-text search is used, with a truthful fallback', () => {
  assert.match(ui, /api\('search', \{ params: \{ q: query, limit: 25 \} \}\)/);
  assert.match(ui, /SEARCH_DEBOUNCE_MS = 250/);
  assert.match(ui, /Full-text search is unavailable right now, so only titles and summaries are searched\./);
  assert.match(ui, /No articles match “/);
  assert.match(ui, /data-knowledge-ask-search/);
  assert.match(fn, /if \(action === "search"\)/);
  assert.match(fn, /branchRpc\("atlas_knowledge_search", \{\s*p_query: query,\s*p_actor_id: context\.user\.id,\s*p_actor_role: context\.profile\.role,/);
});

test('staff never receive drafts or source links from this page', () => {
  assert.match(ui, /return canManage\(\) \? list : list\.filter\(\(article\) => article\.status === 'published'\)/);
  assert.match(ui, /prefer_draft: canManage\(\) \? 'true' : null/);
  assert.match(ui, /filter\(\(row\) => canManage\(\) \|\| row\.version_state === 'published'\)/);
  assert.match(ui, /filter\(\(source\) => manager \|\| source\.visible_to_staff\)/);
  assert.match(ui, /manager \? source\.source_version : null/);
});

test('manager authoring keeps drafts private and publishes immutable versions', () => {
  assert.match(ui, /Save private draft/);
  assert.match(ui, /Staff visibility has not changed/);
  assert.match(ui, /Publish version/);
  assert.match(ui, /Existing acknowledgements remain attached to the previous version/);
  assert.match(ui, /Retire article/);
  assert.match(ui, /mutate\('save-draft'/);
  assert.match(ui, /mutate\('publish'/);
  assert.match(ui, /mutate\('retire'/);
  assert.match(ui, /Only managers see this\. The team keeps reading the published version until you publish\./);
});

test('required reading and acknowledgements are version-specific', () => {
  assert.match(ui, /Mark as read/);
  assert.match(ui, /mutate\('acknowledge', \{ article_id: detail\.article\.id, version_id: detail\.version\.id \}/);
  assert.match(ui, /api\('mark-read', \{ method: 'POST'/);
  assert.match(ui, /Required reading follows the published version/);
  assert.match(ui, /You’ve read version /);
  assert.match(ui, /Who has read this version/);
});

test('sources and training links remain manager tools', () => {
  assert.match(ui, /mutate\('save-source'/);
  assert.match(ui, /mutate\('remove-source'/);
  assert.match(ui, /task_ids: data\.getAll\('task_ids'\)/);
  assert.match(ui, /Private source URL/);
  assert.match(ui, /The URL remains manager-only\./);
  assert.match(ui, /Team onboarding progress/);
  assert.match(ui, /Google Drive/);
  assert.match(ui, /Knowledge activity/);
  assert.match(ui, /data-knowledge-link-task/);
  assert.match(ui, /if \(!article\.id && options\.taskId\) linkedTasks\.add\(options\.taskId\)/);
});

test('markdown rendering escapes raw HTML before adding limited formatting', () => {
  assert.match(ui, /function escapeHtml/);
  assert.match(ui, /function renderMarkdown/);
  assert.match(ui, /let text = escapeHtml\(value\);/);
  assert.doesNotMatch(ui, /marked\.|markdown-it|dangerouslySetInnerHTML/);
  const start = ui.indexOf('  function escapeHtml(value) {');
  const end = ui.indexOf('  function readingMinutes(text) {');
  const scope = { state: { checks: new Map() } };
  vm.createContext(scope);
  vm.runInContext(ui.slice(start, end), scope);
  const html = scope.renderMarkdown('# Close\n<script>alert(1)</script>\n- [ ] Count the **till**\n- [x] Lock up', 'a:v');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h2>Close<\/h2>/);
  assert.match(html, /<ul class="kn-checks"><li><label class="atlas-check-row kn-check" for="kn-check-1"><input type="checkbox" class="atlas-check" id="kn-check-1" data-kn-check="a:v:0" ><span>Count the <strong>till<\/strong><\/span>/);
  assert.match(html, /data-kn-check="a:v:1" checked/);
});

test('browser has no direct private database or Drive API access', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /knowledge_articles|knowledge_article_versions|knowledge_acknowledgements/);
  assert.doesNotMatch(ui, /drive\.googleapis\.com|www\.googleapis\.com\/drive/);
  assert.match(ui, /Atlas doesn’t sync Drive documents automatically/);
});

test('article reading layout: 720 column, 16/26 body, 17/28 and a sticky bar on phones', () => {
  assert.match(css, /\.kn-reading \{ max-width: var\(--reading-max\); margin: 0 auto; \}/);
  assert.match(css, /\.kn-prose \{ font: 400 16px\/26px var\(--font-sans\);/);
  assert.match(css, /\.kn-article__title \{ margin: 0; font: 600 28px\/34px var\(--font-sans\);/);
  assert.match(css, /\.kn-prose \{ font-size: 17px; line-height: 28px; \}/);
  assert.match(css, /\.kn-bar \{ position: fixed;/);
  assert.match(ui, /AtlasAI\?\.askAbout\?\.\(\{ type: 'knowledge_article', id: detail\.article\.id/);
  assert.match(ui, /setTopBar\?\.\(\{ title: state\.detail\?\.version\?\.title/);
});

test('module stylesheet: one atlas.modules layer, tokens only, nothing under 12 px', () => {
  assert.match(css, /^[\s\S]*?@layer atlas\.modules \{/);
  assert.equal((css.match(/@layer/g) || []).length, 1);
  assert.doesNotMatch(css, /!important|:root|#[0-9a-f]{3,6}\b/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])px/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
  for (const fragment of ['knowledge-s56--knowledge', 's38-app-remediation--knowledge', 'workspaces-polish--knowledge', 'atlas-glass--knowledge']) {
    assert.ok(!existsSync(`apps/web/assets/css/legacy/${fragment}.css`), `${fragment} is merged and deleted`);
    assert.doesNotMatch(index, new RegExp(fragment));
  }
});

test('production loads the Knowledge assets with a cache key', () => {
  assert.match(index, /knowledge-workspace\.js\?v=20260926-s88/);
  assert.match(index, /assets\/css\/knowledge-workspace\.css/);
});
