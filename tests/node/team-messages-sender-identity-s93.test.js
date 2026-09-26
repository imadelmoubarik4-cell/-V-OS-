// S93: Messages showed "Team member" for senders and no photo on the owner's
// own messages. The Team name ("Name shown in Atlas") lived only in
// atlas_private.team_profile_details.preferred_name while every label comes
// from public.profiles.display_name (S87), which nothing wrote. The migration
// syncs and backfills display_name; the gateway resolves each message's live
// name by sender_id and never lets an email-shaped stored label out.
// The SQL side is proven by scripts/verify_s93_messages_sender_identity_preview.sql
// against a replayed database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';
import { FORMER_MEMBER_LABEL, realName, rosterLabels, senderName, withSenderNames } from '../../supabase/functions/atlas-team-messages/identity.mjs';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const MIGRATION = read('supabase/migrations/20261002090000_s93_messages_sender_identity.sql');
const PREVIEW = read('scripts/verify_s93_messages_sender_identity_preview.sql');
const GATEWAY = read('supabase/functions/atlas-team-messages/index.ts');
const PHOTOS = read('apps/web/assets/js/team-profile-photos.js');

const ADMIN = 'b9a22f65-e180-429b-8531-008fd08d31aa';
const SARA = '7d3c1f10-0000-4000-8000-000000000002';
const NONAME = 'c0ffee00-0000-4000-8000-000000000003';
const GONE = 'aaaaaaaa-0000-4000-8000-00000000dead';
const ROSTER = [
  { id: ADMIN, email: 'owner@example.test', display_name: 'Imad El Moubarik', role: 'admin', active: true },
  { id: SARA, email: 'sara@example.test', display_name: 'Sara Jónsdóttir', role: 'bartender', active: true },
  { id: NONAME, email: 'noname@example.test', display_name: null, role: 'bartender', active: true },
];

test('realName: blank, email-shaped and neutral labels are not names', () => {
  assert.equal(realName('  Sara   Jónsdóttir '), 'Sara Jónsdóttir');
  assert.equal(realName('sara@example.test'), null);
  assert.equal(realName('Team member'), null);
  assert.equal(realName('former team member'), null);
  assert.equal(realName(''), null);
  assert.equal(realName(null), null);
});

test('senderName: live roster name → stored name → Team member / Former team member; system is Atlas', () => {
  const labels = rosterLabels(ROSTER);
  assert.equal(labels.get(NONAME), 'Team member', 'a profile without a name is the neutral label (S87)');
  assert.equal(senderName({ sender_id: SARA, sender_label: 'Team member' }, labels), 'Sara Jónsdóttir');
  assert.equal(senderName({ sender_id: ADMIN, sender_label: 'owner@example.test' }, labels), 'Imad El Moubarik');
  assert.equal(senderName({ sender_id: NONAME, sender_label: 'Kári' }, labels), 'Kári', 'a stored real name beats the neutral roster label');
  assert.equal(senderName({ sender_id: NONAME, sender_label: 'Team member' }, labels), 'Team member');
  assert.equal(senderName({ sender_id: GONE, sender_label: 'Jón Guðmundsson' }, labels), 'Jón Guðmundsson');
  assert.equal(senderName({ sender_id: GONE, sender_label: 'jon@example.test' }, labels), FORMER_MEMBER_LABEL);
  assert.equal(senderName({ sender_label: 'Team member' }, labels), 'Team member', 'an older preview without sender_id');
  assert.equal(senderName({ sender_id: null, message_type: 'system', sender_label: 'Atlas' }, labels), 'Atlas');
});

test('withSenderNames names messages, read receipts and previews and drops email-shaped stored labels', () => {
  const snapshot = {
    channels: [
      { key: 'general', last_message: { id: 'm2', sender_id: SARA, sender_label: 'sara@example.test', body: 'Hi' } },
      { key: 'marketing', last_message: null },
    ],
    messages: [
      { id: 'm1', sender_id: ADMIN, sender_label: 'owner@example.test', message_type: 'user', read_by: [{ user_id: SARA, user_label: 'Team member' }] },
      { id: 'm2', sender_id: GONE, sender_label: 'gone@example.test', message_type: 'user', read_by: [] },
      { id: 'a1', sender_id: null, sender_label: 'Atlas', message_type: 'system' },
    ],
  };
  const named = withSenderNames(snapshot, ROSTER);
  assert.deepEqual(named.messages.map((m) => [m.id, m.sender_name, m.sender_active]), [
    ['m1', 'Imad El Moubarik', true], ['m2', FORMER_MEMBER_LABEL, false], ['a1', 'Atlas', true],
  ]);
  assert.equal(named.messages[0].read_by[0].user_name, 'Sara Jónsdóttir');
  assert.equal(named.channels[0].last_message.sender_name, 'Sara Jónsdóttir');
  assert.equal(named.channels[1].last_message, null);
  assert.doesNotMatch(JSON.stringify(named), /@/, 'no address leaves the gateway');
  assert.equal(snapshot.messages[0].sender_label, 'owner@example.test', 'the input is not mutated');
});

const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};

function backend(self = ROSTER[0]) {
  const rpc = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === 'https://auth.test/auth/v1/user') return json({ id: self.id, email: self.email });
    if (url.origin === 'https://auth.test' && url.pathname === '/rest/v1/profiles') {
      return json(url.searchParams.get('id') ? [self] : ROSTER);
    }
    if (url.origin === 'https://branch.test' && url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').pop();
      const body = init.body ? JSON.parse(init.body) : {};
      rpc.push({ name, body });
      if (name === 'atlas_team_conversation_stars_snapshot') return json([]);
      if (name === 'atlas_push_notification_enqueue_many') return json({ queued: 1 });
      if (name === 'atlas_team_messages_send') return json({ duplicate: false, message_id: 'new-1' });
      if (name === 'atlas_team_messages_snapshot') {
        return json({
          selected_channel_key: 'general',
          channels: [{ key: 'general', last_message: { id: 'm2', sender_id: SARA, sender_label: 'Team member', body: 'Hi' } }],
          messages: [
            { id: 'm1', sender_id: ADMIN, sender_label: 'owner@example.test', message_type: 'user', read_by: [{ user_id: SARA, user_label: 'Team member' }] },
            { id: 'm2', sender_id: SARA, sender_label: 'Team member', message_type: 'user', read_by: [] },
          ],
        });
      }
    }
    throw new Error(`Unexpected request in test: ${url.href}`);
  };
  return { rpc, fetchImpl };
}

test('gateway snapshot: live names for own and others, roster labels from display_name, no address in the response', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-team-messages/index.ts', ENV);
  const { fetchImpl } = backend();
  const response = await handler(new Request('https://fn.test/atlas-team-messages?action=snapshot&channel=general', { headers: { authorization: 'Bearer jwt' } }), fetchImpl);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /@/);
  const body = JSON.parse(text);
  assert.deepEqual(body.snapshot.messages.map((m) => m.sender_name), ['Imad El Moubarik', 'Sara Jónsdóttir']);
  assert.equal(body.snapshot.messages[0].read_by[0].user_name, 'Sara Jónsdóttir');
  assert.equal(body.snapshot.channels[0].last_message.sender_name, 'Sara Jónsdóttir');
  assert.deepEqual(body.members.map((m) => m.label), ['Imad El Moubarik', 'Sara Jónsdóttir', 'Team member']);
  assert.equal(body.staff.label, 'Imad El Moubarik');
  assert.equal(body.staff.id, ADMIN);
});

test('gateway send stores the sender display name (never an address) and the push says who wrote', async () => {
  const handler = await loadEdgeFunction('supabase/functions/atlas-team-messages/index.ts', ENV);
  const { rpc, fetchImpl } = backend(ROSTER[1]);
  const response = await handler(new Request('https://fn.test/atlas-team-messages?action=send', {
    method: 'POST',
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: JSON.stringify({ channel_key: 'general', body: 'Ice delivered', client_request_id: '7d1c1d8e-2b1f-4b7a-9d0e-3f5a2c1b4e66' }),
  }), fetchImpl);
  assert.equal(response.status, 200);
  const send = rpc.find((call) => call.name === 'atlas_team_messages_send');
  assert.equal(send.body.p_sender_label, 'Sara Jónsdóttir');
  assert.equal(send.body.p_sender_id, SARA);
  assert.equal(rpc.find((call) => call.name === 'atlas_push_notification_enqueue_many').body.p_body, 'Sara Jónsdóttir: Ice delivered');
});

test('gateway wires the identity module into every snapshot it returns', () => {
  assert.match(GATEWAY, /import \{ withSenderNames \} from "\.\/identity\.mjs";/);
  assert.match(GATEWAY, /const snapshot = withSenderNames\(rawSnapshot, members\);/);
  assert.equal((GATEWAY.match(/await messageSnapshot\(/g) || []).length, 4, 'snapshot, mark-read, star and writes all go through messageSnapshot');
});

test('migration: Team name → profiles.display_name (trigger + idempotent backfill), preview carries sender_id', () => {
  assert.match(MIGRATION, /create or replace function atlas_private\.safe_staff_name\(p_value text\)/);
  assert.match(MIGRATION, /position\('@' in cleaned\) > 0 then null/);
  assert.match(MIGRATION, /security definer\s+set search_path = ''/);
  assert.match(MIGRATION, /drop trigger if exists team_profile_details_sync_display_name on atlas_private\.team_profile_details;/);
  assert.match(MIGRATION, /after insert or update of preferred_name on atlas_private\.team_profile_details/);
  assert.match(MIGRATION, /and profile\.display_name is distinct from atlas_private\.safe_staff_name\(details\.preferred_name\);/);
  assert.match(MIGRATION, /'last_message',\(\s*select jsonb_build_object\(\s*'id',message\.id,\s*'sender_id',message\.sender_id,\s*'sender_label',message\.sender_label,\s*'sender_role',message\.sender_role,/);
  assert.match(MIGRATION, /revoke all on function atlas_private\.team_profile_details_sync_display_name\(\) from public, anon, authenticated;/);
  assert.match(MIGRATION, /grant execute on function atlas_private\.team_messages_snapshot\(uuid,text,uuid\[\],text,integer\) to service_role;/);
  assert.doesNotMatch(MIGRATION, /update atlas_private\.team_messages/i, 'stored audit labels are not rewritten');
  const files = fs.readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
  assert.equal(files.at(-1), '20261002090000_s93_messages_sender_identity.sql', 'the newest migration');
  assert.match(PREVIEW, /rollback;\s*$/);
  assert.match(PREVIEW, /s93_messages_sender_identity/);
});

test('photos: Messages can ask for a fresh snapshot (never loaded, near expiry, or a failed image)', () => {
  assert.match(PHOTOS, /function ensureFresh\(options = \{\}\) \{/);
  assert.match(PHOTOS, /if \(!state\.lastLoadedAt \|\| Date\.now\(\) - state\.lastLoadedAt > REFRESH_MS\) loadSnapshot\(\{ force: true, silent: true \}\);/);
  assert.match(PHOTOS, /if \(Date\.now\(\) - staleRequestedAt < 60000\) return;/);
  assert.match(PHOTOS, /ensureFresh,/);
});
