import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const messages = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');
const css = readFileSync('apps/web/assets/css/team-messages.css', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('Checkpoint C loads from the isolated team-message API', () => {
  assert.match(config, /TEAM_MESSAGES_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-team-messages"/);
  assert.match(config, /assets\/js\/team-messages\.js/);
  assert.match(config, /assets\/css\/team-messages\.css/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config + messages, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('initial channels and manager-only announcement state are rendered', () => {
  assert.match(messages, /General/);
  assert.match(messages, /Operations/);
  assert.match(messages, /Shift handover/);
  assert.match(messages, /Announcements/);
  assert.match(messages, /Marketing/);
  assert.match(messages, /Manager posts only/);
  assert.match(messages, /Only managers and administrators can post in Announcements/);
});

test('messages expose unread, read, edit and deletion controls', () => {
  assert.match(messages, /total_unread/);
  assert.match(messages, /unread_count/);
  assert.match(messages, /Read by/);
  assert.match(messages, /data-team-edit/);
  assert.match(messages, /data-team-delete/);
  assert.match(messages, /Message deleted\. Its audit history was preserved/);
  assert.match(messages, /api\('mark-read'/);
  assert.match(messages, /api\('edit'/);
  assert.match(messages, /api\('delete'/);
});

test('composer supports server-verified Atlas record links', () => {
  for (const type of ['inventory_item', 'routine', 'shift', 'brain_recommendation']) {
    assert.match(messages, new RegExp(type));
  }
  assert.match(messages, /api\('targets'/);
  assert.match(messages, /The target is verified by the server before the message is sent/);
  assert.match(messages, /AtlasCheckpointALayout\?\.openRoutine/);
  assert.match(messages, /AtlasPhase3Brain\?\.openRecommendation/);
});

test('polling runs only while Team is visible and pauses during composition', () => {
  assert.match(messages, /teamViewVisible\(\)/);
  assert.match(messages, /document\.hidden/);
  assert.match(messages, /userIsInteracting\(\)/);
  assert.match(messages, /poll_after_ms/);
  assert.match(messages, /stopPolling\(\)/);
  assert.doesNotMatch(messages, /new EventSource|WebSocket|Notification\.requestPermission/);
});

test('browser uses authenticated gateway instead of direct message table access', () => {
  assert.match(messages, /window\.atlasSupabase/);
  assert.match(messages, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(messages, /\.from\s*\(/);
  assert.doesNotMatch(messages, /team_messages|team_channel_reads|team_message_events/);
});

test('Team Messages preserve Atlas design and mobile behavior', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
