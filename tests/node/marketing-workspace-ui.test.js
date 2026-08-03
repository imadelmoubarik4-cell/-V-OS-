import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/marketing-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/marketing-workspace.css', 'utf8');
const migration = readFileSync('supabase/migrations/20260803142123_atlas_marketing_workspace_checkpoint_d.sql', 'utf8');
const occurrences = readFileSync('supabase/migrations/20260803142450_atlas_marketing_recommendation_occurrences.sql', 'utf8');

test('Checkpoint D loads from the isolated Marketing API', () => {
  assert.match(config, /MARKETING_WORKSPACE_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-marketing-workspace"/);
  assert.match(config, /assets\/js\/marketing-workspace\.js/);
  assert.match(config, /assets\/css\/marketing-workspace\.css/);
  assert.match(config, /AtlasMarketingWorkspace/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('Marketing injects a Growth navigation entry and complete planning sections', () => {
  assert.match(ui, /GROWTH/);
  assert.match(ui, /data-view=\"marketing\"/);
  for (const section of ['Overview', 'Calendar', 'Content', 'Campaigns', 'Connections', 'History']) {
    assert.match(ui, new RegExp(section));
  }
  assert.match(ui, /Content calendar/);
  assert.match(ui, /Campaign planning/);
  assert.match(ui, /Approval workflow/);
  assert.match(ui, /Published \/ completed/);
});

test('requested content formats, reminders and workflow controls are present', () => {
  for (const label of ['Post', 'Story', 'Reel', 'Campaign task', 'Event promotion', 'Content idea', 'Google post']) {
    assert.match(ui, new RegExp(label));
  }
  assert.match(ui, /Reminder/);
  assert.match(ui, /Draft caption/);
  assert.match(ui, /Suggested format/);
  assert.match(ui, /Send for approval/);
  assert.match(ui, /Request changes/);
  assert.match(ui, /Mark published/);
  assert.match(ui, /Content marked published\. No platform API was called\./);
});

test('Atlas recommendations reproduce the approved VÁ marketing briefs', () => {
  assert.match(migration, /Suggested Instagram Story for today/);
  assert.match(migration, /Promote Happy Hour from 15:00–18:00/);
  assert.match(migration, /Three-frame vertical Story/);
  assert.match(migration, /Atmosphere/);
  assert.match(migration, /cocktails from 1,990 ISK/i);
  assert.match(migration, /location\/booking/i);
  assert.match(migration, /Suggested Sunday Reel/);
  assert.match(migration, /2-for-1 beer offer from 18:00–20:00/);
  assert.match(occurrences, /occurrence_date/);
  assert.match(occurrences, /available_for_today/);
});

test('connection cards expose every requested state without pretending to connect', () => {
  for (const status of [
    'Not connected',
    'Waiting for authorization',
    'Connected',
    'Missing publishing permission',
    'Missing analytics permission',
    'Connection expired'
  ]) {
    assert.match(ui, new RegExp(status));
  }
  for (const platform of ['Instagram', 'Facebook', 'TikTok', 'Google Business Profile']) {
    assert.match(ui, new RegExp(platform));
  }
  assert.match(ui, /Publishing and analytics remain disabled/);
  assert.match(ui, /A platform is never shown as connected without a valid server-side authorization check/);
  assert.doesNotMatch(ui, /graph\.facebook\.com|open-api\.tiktok\.com|mybusinessbusinessinformation\.googleapis\.com/);
});

test('browser uses authenticated gateway and never writes private tables directly', () => {
  assert.match(ui, /window\.atlasSupabase/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /marketing_content_items|marketing_content_approvals|integration_connections/);
  assert.match(ui, /actual publishing/i);
  assert.match(ui, /No automatic publishing/);
});

test('Marketing preserves the original Atlas design and responsive behavior', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
