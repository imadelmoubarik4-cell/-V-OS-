import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const badge = readFileSync('apps/web/assets/js/team-unread-badge.js', 'utf8');
const messages = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');

test('Team unread worker is loaded after the message workspace', () => {
  assert.match(config, /assets\/js\/team-messages\.js/);
  assert.match(config, /assets\/js\/team-unread-badge\.js/);
  assert.ok(config.indexOf('assets/js/team-unread-badge.js') > config.indexOf('assets/js/team-messages.js'));
  assert.match(config, /AtlasTeamUnreadBadge/);
});

test('zero badges are removed instead of rendered as a visible zero', () => {
  assert.match(badge, /if \(total <= 0\) \{\s*badge\?\.remove\(\)/);
  assert.match(badge, /cleanLegacyZeroBadges/);
  assert.match(badge, /if \(badge\.hidden \|\| total <= 0\) badge\.remove\(\)/);
  assert.doesNotMatch(badge, /badge\.textContent\s*=\s*['"]0['"]/);
});

test('unread total refreshes outside Team without racing its read cursor', () => {
  assert.match(badge, /const POLL_MS = 8000/);
  assert.match(badge, /action', 'snapshot/);
  assert.match(badge, /payload\?\.snapshot\?\.summary\?\.total_unread/);
  assert.match(badge, /teamIsVisible\(\)/);
  assert.match(badge, /AtlasTeamMessages\.unreadCount/);
  assert.match(badge, /document\.hidden/);
  assert.match(badge, /window\.addEventListener\('focus'/);
  assert.match(badge, /onAuthStateChange/);
});

test('badge observer is narrowly scoped and avoids self-triggering rewrites', () => {
  assert.match(badge, /observe\(container, \{ childList: true \}\)/);
  assert.match(badge, /scheduleZeroCleanup/);
  assert.doesNotMatch(badge, /subtree:\s*true/);
  assert.doesNotMatch(badge, /attributes:\s*true/);
});

test('unread worker uses authenticated API only', () => {
  assert.match(badge, /window\.atlasSupabase/);
  assert.match(badge, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(badge, /SUPABASE_SERVICE_ROLE_KEY|\.from\s*\(/);
  assert.match(messages, /total_unread/);
});
