import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/marketing-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/marketing-workspace.css', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const migration = readFileSync('supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql', 'utf8');
const occurrences = readFileSync('supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql', 'utf8');

test('Checkpoint D loads from the isolated Marketing API', () => {
  assert.match(config, /MARKETING_WORKSPACE_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-marketing-workspace"/);
  assert.match(config, /assets\/js\/marketing-workspace\.js/);
  assert.match(config, /assets\/css\/marketing-workspace\.css/);
  assert.match(config, /AtlasMarketingWorkspace/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('S88: Marketing is a shell view with the spec tabs and no injected navigation', () => {
  assert.match(ui, /window\.AtlasShell\.registerView\('marketing', \{ root: host, title: 'Marketing', onShow \}\)/);
  assert.doesNotMatch(ui, /GROWTH|nav-group|handleNavigationCapture|new MutationObserver/);
  assert.match(ui, /\['overview', 'Overview'\], \['calendar', 'Calendar'\], \['posts', 'Posts'\], \['campaigns', 'Campaigns'\], \['history', 'History'\]/);
  assert.match(ui, /Coming up/);
  assert.match(ui, /Waiting for approval/);
  assert.match(ui, /Nothing planned yet/);
  assert.match(ui, /label: 'New post draft', icon: 'plus', variant: 'primary'/);
  assert.match(ui, /label: 'Ask Atlas', icon: 'atlas-bot', variant: 'ghost'/);
  assert.match(ui, /window\.AtlasAI\?\.askAbout\?\.\(\{ type: 'marketing'/);
  assert.doesNotMatch(ui, /Marketing chat|data-marketing-team-channel|Planning mode|marketing-stats/);
});

test('publishing is manual and connections live in Settings', () => {
  assert.match(ui, /Publishing is manual until a social account is connected\./);
  assert.match(ui, /#settings\/integrations/);
  assert.doesNotMatch(ui, /graph\.facebook\.com|open-api\.tiktok\.com|mybusinessbusinessinformation\.googleapis\.com/);
  assert.match(ui, /Marked as published\. Nothing was posted by Atlas\./);
});

test('post editor: channels, text, schedule, preview and the approval footer', () => {
  for (const label of ['Post', 'Story', 'Reel', 'Campaign task', 'Event promotion', 'Google post']) assert.match(ui, new RegExp(label));
  for (const platform of ['Instagram', 'Facebook', 'TikTok', 'Google Business Profile']) assert.match(ui, new RegExp(platform));
  assert.match(ui, /atlas-sheet atlas-sheet--wide/);
  assert.match(ui, /aria-label="Preview"/);
  assert.match(ui, /Save draft/);
  assert.match(ui, /Submit for approval/);
  assert.match(ui, /Request changes/);
  assert.match(ui, /data-mk-decide="approved">Approve</);
});

test('suggestions are labelled as suggestions and never get an invented time', () => {
  assert.match(ui, /<span class="atlas-pill">Suggestion<\/span>/);
  assert.match(ui, /nothing is posted automatically/i);
  assert.doesNotMatch(ui, /'12:00'/);
});

test('venue-zone datetime inputs: localInputValue / fromLocalInput, never the browser offset', () => {
  assert.match(ui, /clock\(\)\?\.localInputValue/);
  assert.match(ui, /clock\(\)\?\.fromLocalInput/);
  assert.doesNotMatch(ui, /getTimezoneOffset|new Date\(value\)\.toISOString|getDate\(\)|setDate\(|'Atlantic\/Reykjavik'/);
  assert.match(ui, /c\.monthKey\(c\.addDays/);
});

test('Atlas recommendations reproduce the approved VÁ marketing briefs', () => {
  assert.match(migration, /Suggested Instagram Story for today/);
  assert.match(migration, /Promote Happy Hour from 15:00–18:00/);
  assert.match(migration, /Three-frame vertical Story/);
  assert.match(migration, /Suggested Sunday Reel/);
  assert.match(occurrences, /occurrence_date/);
  assert.match(occurrences, /available_for_today/);
});

test('browser uses authenticated gateway and never writes private tables directly', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /marketing_content_items|marketing_content_approvals|integration_connections/);
});

test('Marketing stylesheet is module layout in @layer atlas.modules without legacy fragments', () => {
  assert.match(css.trim(), /^\/\*[\s\S]*?\*\/\s*@layer atlas\.modules \{[\s\S]*\}$/);
  assert.doesNotMatch(css, /!important|:root|--[a-z-]+\s*:/);
  for (const fragment of ['atlas-glass--marketing', 'workspaces-polish--marketing', 'polish-pass2--marketing']) {
    assert.ok(!existsSync(`apps/web/assets/css/legacy/${fragment}.css`), fragment);
    assert.doesNotMatch(index, new RegExp(fragment));
  }
});
