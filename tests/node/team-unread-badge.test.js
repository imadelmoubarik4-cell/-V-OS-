import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const badge = readFileSync('apps/web/assets/js/team-unread-badge.js', 'utf8');
const messages = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');
const chrome = readFileSync('apps/web/assets/js/atlas-chrome.js', 'utf8');

test('the unread worker is loaded after Messages', () => {
  assert.match(config, /assets\/js\/team-messages\.js/);
  assert.match(config, /assets\/js\/team-unread-badge\.js/);
  assert.ok(config.indexOf('assets/js/team-unread-badge.js') > config.indexOf('assets/js/team-messages.js'));
  assert.match(config, /AtlasTeamUnreadBadge/);
});

test('the shell chrome renders the badge; the worker writes no badge markup', () => {
  // S88: atlas-chrome.js draws the Messages badge from count(); a zero is never shown.
  assert.match(chrome, /window\.AtlasTeamUnreadBadge\?\.count\?\.\(\)/);
  assert.match(chrome, /badge\.hidden = count <= 0;/);
  assert.doesNotMatch(badge, /createElement\('span'\)|team-nav-unread|team-bell-unread|MutationObserver/);
});

test('unread total and per-conversation counts refresh outside Messages without racing its read cursor', () => {
  assert.match(badge, /const POLL_MS = 8000/);
  assert.match(badge, /action', 'snapshot/);
  assert.match(badge, /payload\?\.snapshot\?\.summary\?\.total_unread/);
  assert.match(badge, /conversationsFrom\(payload\?\.snapshot\?\.channels\)/);
  assert.match(badge, /teamIsVisible\(\)/);
  assert.match(badge, /AtlasTeamMessages\.unreadCount/);
  assert.match(badge, /document\.hidden/);
  assert.match(badge, /window\.addEventListener\('focus'/);
  assert.match(badge, /onAuthStateChange/);
});

test('read API for the notifications feed: count, conversations, announcements on the shell', () => {
  assert.match(badge, /conversations: \(\) => state\.conversations\.map/);
  assert.match(badge, /route: `#messages\/\$\{encodeURIComponent\(String\(channel\.key \|\| ''\)\)\}`/);
  assert.match(badge, /window\.AtlasShell\?\.emit\?\.\('messages:unread', \{ total: next, conversations: list \}\)/);
  assert.match(messages, /window\.AtlasShell\?\.emit\?\.\('messages:unread', detail\)/);
});

test('the notifications feed on Home reads per-conversation unread from the worker', () => {
  const home = readFileSync('apps/web/assets/js/home.js', 'utf8');
  assert.match(badge, /lastMessage: lastMessageOf\(channel\.last_message\)/);
  // S92: the gateway's live sender_name first; an address is never a name.
  assert.match(badge, /sender: message\.message_type === 'system' \? 'Alcedo' : senderOf\(message\)/);
  assert.match(badge, /return safePersonLabel\(message\.sender_name\) \|\| safePersonLabel\(message\.sender_label\) \|\| 'Team member';/);
  assert.doesNotMatch(badge, /split\('@'\)/);
  assert.match(badge, /loaded: \(\) => state\.loaded/);
  assert.match(home, /badge\?\.loaded\?\.\(\) && typeof badge\.conversations === 'function'/);
  assert.match(home, /atlas\.on\('messages:unread', \(detail\) => \{ if \(Array\.isArray\(detail\?\.conversations\)\) applyConversations\(detail\.conversations\); \}\);/);
  assert.match(messages, /sender: channel\.last_message\.message_type === 'system' \? 'Alcedo' : senderIdentity\(channel\.last_message\)\.name/);
});

test('unread worker uses authenticated API only', () => {
  assert.match(badge, /window\.atlasSupabase/);
  assert.match(badge, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(badge, /SUPABASE_SERVICE_ROLE_KEY|\.from\s*\(/);
  assert.match(messages, /total_unread/);
});

// Audit M11: a failing gateway is not hit every 8 s from every tab, and focus
// does not add a fetch per window switch. Behaviour is proven in
// tests/browser/team-unread-badge.browser.test.mjs on fake timers.
test('polling is a setTimeout chain with capped backoff, throttled focus and a push refresh', () => {
  assert.match(badge, /const BACKOFF_MAX_MS = 180000;/);
  assert.match(badge, /const FOCUS_MIN_GAP_MS = 15000;/);
  assert.doesNotMatch(badge, /setInterval\(\(\) => refreshUnread/, 'no fixed-interval poll');
  assert.match(badge, /Math\.min\(BACKOFF_MAX_MS, POLL_MS \* \(2 \*\* state\.failures\)\)/);
  assert.match(badge, /state\.failures = 0;/);
  assert.match(badge, /window\.addEventListener\('focus', handleFocus\)/);
  assert.match(badge, /now - state\.lastFocusRefreshAt < FOCUS_MIN_GAP_MS/);
  assert.match(badge, /event\.data\?\.type === 'atlas:push' && event\.data\?\.route === 'team'/);
});
