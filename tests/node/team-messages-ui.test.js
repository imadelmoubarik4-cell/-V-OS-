// Messages (#messages, spec §7.3, §8.5): the S88 rebuild on the design system.
// Also carries the former team-s57 checks (named pin action; the thread owns
// scrolling and the composer stays visible on phones).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const config = readFileSync('apps/web/config.js', 'utf8');
const index = readFileSync('apps/web/index.html', 'utf8');
const messages = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');
const css = readFileSync('apps/web/assets/css/team-messages.css', 'utf8');
const migration = readFileSync('supabase/migrations/20260803125226_atlas_team_messages_checkpoint_c.sql', 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('Messages load from the isolated team-message API', () => {
  assert.match(config, /TEAM_MESSAGES_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-team-messages"/);
  assert.match(config, /assets\/js\/team-messages\.js/);
  assert.match(config, /assets\/css\/team-messages\.css/);
  assert.equal(count(config, 'SUPABASE_ANON_KEY'), 1);
  assert.doesNotMatch(config + messages, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('routes: #messages list and #messages/<conversationId> thread (view id stays team)', () => {
  // A full-height page (AtlasShell fullHeight + .page--full-height, spec §7.3).
  assert.match(messages, /shell\.registerView\('team', \{ root: \(\) => host\(\), title: 'Messages', fullHeight: true, render: show, onHide: hide \}\)/);
  assert.match(messages, /element\.classList\.add\('msg-host', 'page--full-height'\)/);
  // AtlasShell.show() writes the address (#messages/general → #messages too): no local hash workaround.
  assert.match(messages, /function routeTo\(view, params = \{\}\) \{\n    window\.AtlasShell\?\.show\?\.\(view, params, \{ source: 'route' \}\);\n  \}/);
  assert.doesNotMatch(messages, /window\.location\.hash = target/);
  assert.match(messages, /const requested = params\.conversation \? String\(params\.conversation\) : null;/);
  assert.match(messages, /href="#messages\/\$\{encodeURIComponent\(channel\.key\)\}"/);
  assert.match(messages, /routeTo\('team', \{ conversation: key \}/);
  // Phone: list screen → channel screen with a back chevron and no tab bar.
  assert.match(messages, /chrome\?\.setTopBar\?\.\(\{ title: channel \? channel\.name : 'Messages', back: \(\) => routeTo\('team', \{\}\), actions \}\)/);
  assert.match(messages, /chrome\?\.setTabBarHidden\?\.\('messages', inThread\)/);
});

test('channels are seeded and announcements are manager-only to post', () => {
  for (const channel of ['general', 'operations', 'shift-handover', 'announcements', 'marketing']) {
    assert.match(migration, new RegExp(`\\('${channel}'`));
  }
  assert.match(migration, /'announcements'.*true,true,40/);
  assert.match(messages, /Only managers can post in Announcements\. You can read everything here\./);
  assert.match(messages, /You can read messages\. Ask a manager if you need to post\./);
  assert.match(messages, /Messages are visible to everyone in this channel\./);
});

test('thread: grouping, day dividers, unread divider, log semantics', () => {
  assert.match(messages, /const GROUP_WINDOW_MS = 5 \* 60 \* 1000;/);
  assert.match(messages, /class="msg-divider" role="separator"/);
  assert.match(messages, /msg-divider--new" role="separator"><span>New<\/span>/);
  assert.match(messages, /role="log" aria-live="polite"/);
  assert.match(messages, /No messages yet/);
  assert.match(messages, /Say hello to the team\./);
  assert.match(messages, /new \$\{state\.pendingNew === 1 \? 'message' : 'messages'\}/);
});

test('unread, read, edit and deletion controls', () => {
  assert.match(messages, /total_unread/);
  assert.match(messages, /unread_count/);
  assert.match(messages, /Read by \$\{count\}/);
  assert.match(messages, /data-team-edit/);
  assert.match(messages, /data-team-delete/);
  assert.match(messages, /api\('mark-read'/);
  assert.match(messages, /api\('edit'/);
  assert.match(messages, /api\('delete'/);
  assert.match(messages, /field: deletingAnother \? \{ label: 'Reason', required: true/);
  assert.doesNotMatch(messages, /window\.(prompt|confirm|alert)\(/);
});

test('failed sends stay in the thread with Not sent · Retry, retried idempotently', () => {
  assert.match(messages, /Not sent/);
  assert.match(messages, /data-msg-retry/);
  assert.match(messages, /The same client request id makes a retry safe to repeat\./);
  assert.match(messages, /sendBody\(entry\.body, entry\.link, entry\.id, channelKey\)/);
});

test('composer links server-verified Atlas records; recommendations are manager-only', () => {
  for (const type of ['inventory_item', 'routine', 'shift', 'brain_recommendation']) assert.match(messages, new RegExp(type));
  assert.match(messages, /api\('targets', \{ params: \{ type: current, q: query \} \}\)/);
  assert.match(messages, /const types = LINK_TYPES\.filter\(\(entry\) => !entry\.managerOnly \|\| state\.staff\?\.can_link_brain_recommendations\);/);
  assert.match(messages, /Atlas recommendation \\u00b7 managers only|Atlas recommendation · managers only/);
  assert.match(messages, /if \(link\.type === 'inventory_item'\) return `#inventory\/item\/\$\{key\}`;/);
  // Brain and Checkpoint A are retired: recommendation links open Atlas AI decisions.
  assert.doesNotMatch(messages, /AtlasCheckpointALayout|AtlasPhase3Brain/);
  // …with that recommendation selected (AtlasAI.openDecision route).
  assert.match(messages, /if \(link\.type === 'brain_recommendation'\) return link\.key \? `#ai\/decisions\?recommendation=\$\{encodeURIComponent\(link\.key\)\}` : '#ai\/decisions';/);
});

test('handover template posts the three sections to the Handover channel', () => {
  assert.match(messages, /const HANDOVER_CHANNEL = 'shift-handover';/);
  assert.match(messages, /Write handover/);
  for (const label of ['What happened', 'Stock issues', 'For the next shift']) assert.match(messages, new RegExp(label));
});

test('polling runs only while Messages is visible and pauses while editing', () => {
  assert.match(messages, /teamViewVisible\(\)/);
  assert.match(messages, /document\.hidden/);
  assert.match(messages, /userIsInteracting\(\)/);
  assert.match(messages, /poll_after_ms/);
  assert.match(messages, /stopPolling\(\)/);
  assert.doesNotMatch(messages, /new EventSource|WebSocket|Notification\.requestPermission/);
});

test('unread per conversation is exposed for the shell feed', () => {
  assert.match(messages, /unread,\n    snapshot: \(\) => state\.snapshot/);
  assert.match(messages, /window\.AtlasShell\?\.emit\?\.\('messages:unread', detail\)/);
});

test('identity: sender_id → display name → safe label → former member; never email', () => {
  const start = messages.indexOf('  function safePersonLabel(value) {');
  const end = messages.indexOf('  function avatarTint(key) {');
  const scope = { state: { members: [{ id: 'a', label: 'Sara Jónsdóttir', role: 'bartender' }, { id: 'b', label: 'gunnar.k@example.test', role: 'bartender' }] } };
  vm.createContext(scope);
  vm.runInContext(messages.slice(start, end), scope);
  assert.equal(scope.senderIdentity({ sender_id: 'a', sender_label: 'old@example.test' }).name, 'Sara Jónsdóttir');
  assert.equal(scope.senderIdentity({ sender_id: 'b' }).name, 'Gunnar K');
  assert.equal(scope.senderIdentity({ sender_id: 'gone', sender_label: 'jon.gudmundsson@example.test' }).name, 'Jon Gudmundsson');
  assert.equal(scope.senderIdentity({ sender_id: null, sender_label: '' }).name, 'Former team member');
  assert.match(messages, /window\.AtlasTeamProfilePhotos\?\.photoFor\?\.\(identity\.id\)/);
});

test('times use the venue clock (same-day check in the venue zone)', () => {
  assert.match(messages, /venueDateOf\(value\) === venueDateOf\(new Date\(\)\) \? vc\.formatTime\(value\) : vc\.formatDateTime\(value\)/);
  assert.doesNotMatch(messages, /getFullYear\(\)|getMonth\(\)|getDate\(\)|Atlantic\/Reykjavik/);
});

test('browser uses the authenticated gateway instead of table access', () => {
  assert.match(messages, /window\.atlasSupabase/);
  assert.match(messages, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(messages, /\.from\s*\(/);
  assert.doesNotMatch(messages, /team_messages|team_channel_reads|team_message_events/);
});

test('pin is a compact, named icon action', () => {
  assert.match(messages, /class="atlas-icon-btn" data-team-star aria-pressed="\$\{channel\.starred \? 'true' : 'false'\}" aria-label="\$\{channel\.starred \? 'Unpin' : 'Pin'\}/);
});

test('layout: full-height list + thread; the thread scrolls and the composer stays visible', () => {
  assert.equal((css.match(/@layer/g) || []).length, 1);
  assert.match(css, /@layer atlas\.modules \{/);
  assert.doesNotMatch(css, /!important|:root|#[0-9a-f]{3,6}\b/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])px/);
  assert.match(css, /\.msg \{ display: grid; grid-template-columns: 280px minmax\(0, 1fr\);/);
  assert.match(css, /\.msg-thread__scroll \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
  assert.match(css, /\.msg-log \{ width: 100%; max-width: calc\(720px \+ 2 \* var\(--s-6\)\);/);
  assert.match(css, /\.msg-composer \{ position: sticky; bottom: 0;/);
  assert.match(css, /\.msg\[data-msg-view="thread"\] \.msg-side, \.msg\[data-msg-view="list"\] \.msg-thread \{ display: none; \}/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
  for (const fragment of ['team-s57--team-messages', 's38-app-remediation--team-messages', 'polish-pass2--team-messages', 'workspaces-polish--team-messages', 'accessibility-responsive-s61--team-messages']) {
    assert.ok(!existsSync(`apps/web/assets/css/legacy/${fragment}.css`), `${fragment} is deleted`);
    assert.doesNotMatch(index, new RegExp(fragment));
  }
});
