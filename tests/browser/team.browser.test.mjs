// S87 Team Messages identity: names and photos resolve from sender_id against
// the current roster; stored sender labels are only a fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, openView, USERS } from './harness.mjs';
import { emptyFunctions } from './fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';
const FORMER = 'aaaaaaaa-0000-4000-8000-00000000dead';
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function message(id, sender, label, extra = {}) {
  return { id, sender_id: sender, sender_label: label, sender_role: 'bartender', body: `Message ${id}`, message_type: 'user', created_at: '2026-09-24T12:00:00Z', is_own: false, ...extra };
}

function teamFixtures({ members, messages, photos = [] }) {
  return {
    ...emptyFunctions(),
    'atlas-team-messages': (entry) => entry.action === 'snapshot' || entry.method === 'POST' ? {
      snapshot: { channels: [{ key: 'general', name: 'General', unread_count: 0 }], messages, selected_channel_key: 'general', summary: { total_unread: 0, active_members: members.length } },
      members,
      staff: { id: USERS.admin.id, label: USERS.admin.display_name, role: 'admin' }
    } : {},
    'atlas-team-profile-photos': { photos, staff: { id: USERS.admin.id, can_manage_team: true } }
  };
}

async function openTeam(fixtures) {
  const app = await launchAtlas({ fixtures: { functions: teamFixtures(fixtures) } });
  await openView(app.page, 'team');
  await app.page.waitForSelector('[data-team-message]');
  await app.page.waitForTimeout(400);
  const rows = await app.page.$$eval('[data-team-message]', (nodes) => nodes.map((node) => ({
    id: node.dataset.teamMessage,
    name: node.querySelector('.team-message-content header strong')?.textContent.trim(),
    role: node.querySelector('.team-message-content header span')?.textContent.trim(),
    avatar: node.querySelector('.team-message-avatar')?.textContent.trim(),
    photo: node.querySelector('.team-message-avatar img')?.getAttribute('src') || null
  })));
  return { ...app, rows };
}

test('messages show the current display name, never an email address', { skip }, async () => {
  const { rows, close } = await openTeam({
    members: [{ id: USERS.admin.id, label: 'Imad El Moubarik', role: 'admin' }, { id: USERS.bartender.id, label: 'sara.jonsdottir@example.test', role: 'bartender' }],
    messages: [
      message('1', USERS.admin.id, 'owner@example.test', { is_own: true, sender_role: 'admin' }),
      message('2', USERS.bartender.id, 'sara.jonsdottir@example.test')
    ]
  });
  try {
    assert.equal(rows[0].name, 'Imad El Moubarik', 'old email label replaced by the current profile name');
    assert.equal(rows[1].name, 'Sara Jonsdottir', 'email-only profile shows a readable name');
    assert.ok(rows.every((row) => !row.name.includes('@')));
    assert.equal(rows[0].avatar, 'IE');
  } finally { await close(); }
});

test("another person's message shows their identity, not the viewer's", { skip }, async () => {
  const { rows, close } = await openTeam({
    members: [{ id: USERS.admin.id, label: 'Imad El Moubarik', role: 'admin' }, { id: USERS.bartender.id, label: 'Sara Jónsdóttir', role: 'bartender' }],
    messages: [message('9', USERS.bartender.id, 'Sara')],
    photos: [{ profile_id: USERS.admin.id, signed_url: PHOTO, version: 1 }]
  });
  try {
    assert.equal(rows[0].name, 'Sara Jónsdóttir');
    assert.equal(rows[0].photo, null, "the viewer's photo is not used for someone else");
    assert.equal(rows[0].avatar, 'SJ');
  } finally { await close(); }
});

test('a current profile photo is used for that sender', { skip }, async () => {
  const { rows, close } = await openTeam({
    members: [{ id: USERS.bartender.id, label: 'Sara Jónsdóttir', role: 'bartender' }],
    messages: [message('3', USERS.bartender.id, 'Sara')],
    photos: [{ profile_id: USERS.bartender.id, signed_url: PHOTO, version: 2 }]
  });
  try {
    assert.equal(rows[0].photo, PHOTO);
  } finally { await close(); }
});

test('a former member falls back safely to the historical label', { skip }, async () => {
  const { rows, close } = await openTeam({
    members: [{ id: USERS.admin.id, label: 'Imad El Moubarik', role: 'admin' }],
    messages: [message('4', FORMER, 'jon.gudmundsson@example.test'), message('5', null, '')]
  });
  try {
    assert.equal(rows[0].name, 'Jon Gudmundsson');
    assert.match(rows[0].role, /no longer active/);
    assert.equal(rows[1].name, 'Former team member');
  } finally { await close(); }
});

test('system messages stay distinct', { skip }, async () => {
  const { page, close } = await openTeam({
    members: [{ id: USERS.admin.id, label: 'Imad El Moubarik', role: 'admin' }],
    messages: [message('6', null, 'Atlas', { message_type: 'system' })]
  });
  try {
    assert.equal(await page.$eval('[data-team-message="6"]', (node) => node.classList.contains('is-system')), true);
    assert.match(await page.textContent('[data-team-message="6"] header span'), /System update/);
  } finally { await close(); }
});
