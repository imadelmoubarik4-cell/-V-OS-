#!/usr/bin/env node
// Captures the Atlas User Guide screenshots from the real apps/web code.
//
//   node docs/manual/tools/capture_screenshots.mjs              every screenshot
//   node docs/manual/tools/capture_screenshots.mjs --only home  names containing "home"
//   node docs/manual/tools/capture_screenshots.mjs --only a,b   several filters
//   node docs/manual/tools/capture_screenshots.mjs --list       list the shots
//
// Each screenshot opens a fresh Chromium page through the browser test harness
// (tests/browser/harness.mjs launchAtlas): apps/web is served locally and every
// backend call is answered from the demo venue in manual-fixtures.mjs. Nothing
// reaches production. The page clock is frozen (MANUAL_NOW), motion is reduced,
// transitions and the text caret are switched off and the brand fonts are
// embedded, so two runs give the same pictures.
//
// Run Chromium serialized on shared machines:
//   flock /tmp/claude-0/s94-browser.lock node docs/manual/tools/capture_screenshots.mjs
//
// Requirements (same as the browser tests): Playwright with Chromium, and the
// pinned browser libraries in node_modules or ATLAS_BROWSER_LIBS; see
// tests/browser/README.md. Output: docs/manual/assets/screenshots/*.png plus
// manifest.json (name, module, viewport, role, route, state, caption).
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAtlas, navigateTo, settle, sessionFor, ORIGIN, SUPABASE } from '../../../tests/browser/harness.mjs';
import { manualWorld, DEMO_USERS, MANUAL_NOW, ITEM_IDS, RECIPE_IDS, ORDER_IDS } from './manual-fixtures.mjs';
import { IDS as AI_IDS, fakeMediaInit } from '../../../tests/browser/atlas-ai-fixtures.mjs';

// Native date and time fields follow the browser's own locale: day-first dates
// and a 24-hour clock, as a venue in Iceland or the UK would see them.
process.env.LANG = 'en_GB.UTF-8';
process.env.LANGUAGE = 'en_GB';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../assets/screenshots');
const MANIFEST = path.join(OUT, 'manifest.json');
const MAX_BYTES = 900 * 1024;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 }
};

// ---------- brand fonts ----------
// Production loads IBM Plex Sans, IBM Plex Mono and Fraunces from Google Fonts,
// which the harness blocks. The same files are fetched once (curl honours the
// machine's proxy), cached outside the repository and embedded as @font-face
// rules, so screenshots use the real typography.
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';
const FONT_CACHE = path.join(os.tmpdir(), 'atlas-manual-fonts');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function curl(url, file) {
  execFileSync('curl', ['-sSfL', '--max-time', '60', '-A', UA, '-o', file, url], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function fontFaces() {
  mkdirSync(FONT_CACHE, { recursive: true });
  const cssFile = path.join(FONT_CACHE, 'fonts.css');
  try {
    if (!existsSync(cssFile)) curl(FONT_CSS, cssFile);
  } catch {
    console.warn('! Brand fonts could not be downloaded; screenshots fall back to system fonts.');
    return '';
  }
  const css = readFileSync(cssFile, 'utf8');
  const blocks = css.split(/(?=\/\*\s*[a-z-]+\s*\*\/)/).filter((block) => /\/\*\s*(latin|latin-ext)\s*\*\//.test(block));
  return blocks.map((block) => block.replace(/url\((https:[^)]+)\)/g, (match, url) => {
    const file = path.join(FONT_CACHE, path.basename(new URL(url).pathname));
    if (!existsSync(file)) curl(url, file);
    return `url(data:font/woff2;base64,${readFileSync(file).toString('base64')})`;
  }).replace(/\/\*[^*]*\*\//, '')).join('\n');
}

// Determinism: no caret, no transitions or animations, no scrollbars.
const STILL_CSS = `
*, *::before, *::after { caret-color: transparent !important; transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
* { scrollbar-width: none !important; }
`;

function initScript(fonts, extra = null) {
  const css = JSON.stringify(`${fonts}\n${STILL_CSS}`);
  return `(() => {
    try { sessionStorage.setItem('atlas.signinIntro.played.v1', '1'); } catch {}
    const add = () => { const style = document.createElement('style'); style.id = 'manual-capture-style'; style.textContent = ${css}; (document.head || document.documentElement).appendChild(style); };
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
  })();${extra ? `\n(${extra.toString()})();` : ''}`;
}

// ---------- helpers for shot scripts ----------

const USERS_BY_ROLE = { admin: DEMO_USERS.admin, bartender: DEMO_USERS.bartender, viewer: DEMO_USERS.viewer };

async function visible(page, selector, options = {}) {
  await page.waitForSelector(selector, { state: 'visible', timeout: options.timeout ?? 10000 });
}

async function click(page, selector) {
  await visible(page, selector);
  await page.click(selector);
  await settle(page);
}

async function clickText(page, role, name, options = {}) {
  const locator = page.getByRole(role, { name, exact: options.exact ?? false }).first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click();
  await settle(page);
}

async function ready(page) {
  await settle(page);
  // A sheet focuses its close button for keyboard users; the ring is noise in a still.
  await page.evaluate(() => { if (document.activeElement?.matches?.('.atlas-sheet__close, [data-modal-close], .atlas-dialog__close')) document.activeElement.blur(); });
  await page.evaluate(async () => { await document.fonts.ready; });
  // Images (avatars, logos) decoded before the picture is taken.
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 10000 }).catch(() => {});
  // No loading placeholders left on screen.
  await page.waitForFunction(() => ![...document.querySelectorAll('.is-loading, [aria-busy="true"]')].some((node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  }), null, { timeout: 8000 }).catch(() => console.warn('  ! a loading state is still visible'));
  await settle(page);
}

// The Atlas AI robot (apps/web/assets/js/atlas-bot.js) is a WebGL scene. The
// capture browser draws WebGL in software, where Atlas keeps the still poster;
// the robot is switched on here, as the browser tests do, and the picture
// waits until every robot on screen has drawn its first frame. Motion is
// reduced, so each robot holds one still pose.
async function liveRobot(page) {
  const keys = await page.evaluate(() => [...document.querySelectorAll('[data-atlas-bot-live]')].map((host) => host.dataset.atlasBotLive || 'default'));
  if (!keys.length) return;
  await page.evaluate(() => window.AtlasBot?.animateInSoftware(true));
  await page.waitForFunction((names) => names.every((key) => (window.AtlasBot?.info(key)?.scene?.frames || 0) >= 1
    && document.querySelector(`[data-atlas-bot-live="${key}"]`)?.classList.contains('is-live')), keys, { timeout: 20000 })
    .catch(() => console.warn('  ! the live robot did not draw; the still poster is shown'));
  await page.waitForTimeout(300);
  await settle(page);
}

/** Bounding box (in CSS px) of `selector`, grown by `pad` and kept inside the viewport. */
async function boxOf(page, selector, pad = 16) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + pad));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + pad));
  return { x, y, width: right - x, height: bottom - y };
}

// ---------- the shots ----------
// Each entry: name, module, viewport, role, route, state, caption, and
// optional `run(page)` (drives the UI after the route opens) and
// `clip(page)` (returns a clip box; default is the whole viewport).

const SHOTS = [];
const shot = (definition) => SHOTS.push({ viewport: 'desktop', role: 'admin', ...definition });

// Discovery set (only with --discover): one screenshot per main route.
const DISCOVER = process.argv.includes('--discover');
if (DISCOVER) for (const [name, module, route] of [
  ['home', 'Home', '#home'], ['ai', 'Atlas AI', '#ai'], ['messages', 'Messages', '#messages'], ['operations', 'Operations', '#operations'],
  ['inventory', 'Inventory', '#inventory'], ['counts', 'Stock count', '#inventory/counts'], ['recipes', 'Recipes', '#recipes'],
  ['purchasing', 'Purchasing', '#purchasing'], ['shifts', 'Shifts', '#shifts'], ['team', 'Team', '#team'], ['knowledge', 'Knowledge', '#knowledge'],
  ['reports', 'Reports', '#reports'], ['marketing', 'Marketing', '#marketing'], ['data', 'Data', '#data'], ['settings', 'Settings', '#settings']
]) shot({ name: `discover-${name}`, module, route, state: 'discovery', caption: '' });

const signIn = async (page) => {
  await page.waitForFunction(() => document.documentElement.dataset.atlasSignin === 'shown', null, { timeout: 10000 });
  await visible(page, '#email');
};
// Scrolls the element's own scroll container (never the whole window, which
// would shift the fixed shell) so `selector` sits at the top or centre.
const scrollTo = (selector, block = 'start') => async (page) => {
  await visible(page, selector);
  await page.evaluate(([target, where]) => {
    const element = document.querySelector(target);
    let parent = element.parentElement;
    const scrolls = (node) => node.scrollHeight > node.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(node).overflowY);
    while (parent && parent !== document.body && !scrolls(parent)) parent = parent.parentElement;
    if (!parent || parent === document.body) parent = document.scrollingElement;
    const top = parent === document.scrollingElement ? 0 : parent.getBoundingClientRect().top;
    const delta = element.getBoundingClientRect().top - top;
    parent.scrollTop += where === 'center' ? delta - (parent.clientHeight - element.offsetHeight) / 2 : delta - 12;
  }, [selector, block]);
  await settle(page);
};

// ----- Getting started and the shell -----
shot({ name: 'signin-desktop', module: 'Getting started', role: 'signed-out', route: '', run: signIn,
  state: 'Sign-in screen before any details are entered.',
  caption: 'Sign in with the email address and password your manager set up for you.' });
shot({ name: 'signin-phone', module: 'Getting started', viewport: 'phone', role: 'signed-out', route: '', run: signIn,
  state: 'Sign-in screen on a phone.',
  caption: 'Atlas works in the phone browser too — the same account signs in on every device.' });
// The page a new team member opens from a setup link or an email invitation
// (apps/web/invitation.html). The one-time token is checked against the mocked
// auth service, then the password fields are filled so the rules show as met.
const NEW_MEMBER = { ...DEMO_USERS.viewer, id: 'c0ffee00-0000-4000-8000-0000000000e1', email: 'elin@harbourroom.example', display_name: 'Elín Hauksdóttir' };
shot({ name: 'signin-invitation-setup', module: 'Getting started', role: 'signed-out', route: '', storage: { 'atlas.venue.v1': JSON.stringify({ line: 'Harbour Room · Reykjavík' }) },
  run: async (page) => {
    await page.route(`${SUPABASE}/auth/v1/verify**`, (route) => route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
      : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(sessionFor(NEW_MEMBER)) }));
    // The harness serves the npm build of supabase-js, whose bytes differ from
    // the CDN's minified file, so the page's integrity hash is left out of this
    // local copy only. Nothing else on the page changes.
    const html = readFileSync(path.resolve(here, '../../../apps/web/invitation.html'), 'utf8').replace(/\s(integrity|crossorigin)="[^"]*"/g, '');
    await page.route(`${ORIGIN}/invitation.html`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(`${ORIGIN}/invitation.html#token_hash=manual-demo`, { waitUntil: 'load' });
    await visible(page, '#accept-invitation');
    await page.fill('#new-password', 'harbour-room-2026');
    await page.fill('#confirm-password', 'harbour-room-2026');
    await page.evaluate(() => document.activeElement?.blur());
  },
  clip: async (page) => { const box = await boxOf(page, '.atlas-auth__column', 48); return { ...box, height: Math.min(900 - box.y, box.height + 80) }; },
  state: 'The Set up your Atlas login page opened from a setup link, with the new password typed twice.',
  caption: 'A setup link opens Set up your Atlas login: choose a password of at least 10 characters, then Create login.' });
shot({ name: 'home-admin', module: 'Home', route: '#home',
  state: 'Home for the owner 20 minutes before opening: Needs attention, Today’s briefing and Tonight.',
  caption: 'Home puts what needs doing before service first, with a plain-language briefing of the day underneath.' });
shot({ name: 'home-timeline-glance', module: 'Home', route: '#home', run: scrollTo('.home-briefing'),
  state: 'Home scrolled to the briefing, the day’s timeline and the at-a-glance tiles.',
  caption: 'Scroll down for the day’s timeline and quick counts for stock, recipes and purchasing.' });
const unreadBadge = (page) => visible(page, '[data-nav-badge="more"]:not([hidden])');
shot({ name: 'home-admin-phone', module: 'Home', viewport: 'phone', route: '#home', run: unreadBadge,
  state: 'Home on a phone for the owner, with the tab bar at the bottom.',
  caption: 'On a phone, Home keeps the same order: what needs attention first, then the briefing.' });
shot({ name: 'home-bartender-phone', module: 'Home', viewport: 'phone', role: 'bartender', route: '#home',
  state: 'Home on a phone for a bartender.',
  caption: 'Bartenders see the tasks that are theirs to do tonight — costs and approvals stay with managers.' });
shot({ name: 'shell-sidebar', module: 'Getting started', route: '#home',
  run: async (page) => visible(page, '.atlas-sidebar [data-nav-badge="messages"]:not([hidden])'),
  clip: async () => ({ x: 0, y: 0, width: 240, height: 640 }),
  state: 'The sidebar: Home, Atlas AI, Messages, then the Venue, People and Business groups.',
  caption: 'The sidebar groups every part of Atlas by what it is for. The badge shows unread messages.' });
shot({ name: 'shell-notifications', module: 'Getting started', route: '#home',
  run: async (page) => { await click(page, '#atlas-notifications-btn'); await visible(page, '#atlas-notifications'); },
  state: 'Notifications panel open over Home.',
  caption: 'The bell collects what changed and what needs you, each with a button that takes you straight there.' });
shot({ name: 'shell-palette', module: 'Getting started', route: '#home',
  run: async (page) => { await click(page, '#atlas-omni'); await page.keyboard.type('campari'); await settle(page); },
  state: 'Search or ask Atlas open with the query “campari”.',
  caption: 'Press Ctrl K (⌘K on a Mac) and type: items, recipes, orders, people and actions appear as you type.' });
shot({ name: 'shell-account-menu', module: 'Getting started', route: '#home',
  run: async (page) => { await click(page, '#atlas-account-btn'); await visible(page, '#atlas-account-menu'); },
  clip: (page) => boxOf(page, '#atlas-account-menu', 12),
  state: 'Account menu open from the sidebar.',
  caption: 'Your account menu holds your preferences and Sign out.' });
shot({ name: 'phone-more-admin', module: 'Getting started', viewport: 'phone', route: '#home',
  run: async (page) => { await unreadBadge(page); await click(page, '#atlas-more-btn'); await visible(page, '#atlas-more'); },
  state: 'Phone More sheet for an administrator.',
  caption: 'On a phone, the tab bar holds the everyday pages; More opens everything else.' });
shot({ name: 'phone-more-bartender', module: 'Getting started', viewport: 'phone', role: 'bartender', route: '#home',
  run: async (page) => { await click(page, '#atlas-more-btn'); await visible(page, '#atlas-more'); },
  state: 'Phone More sheet for a bartender — fewer pages than for a manager.',
  caption: 'A bartender’s More sheet only lists the pages their role can use.' });

// ----- Atlas AI -----
// A picture of a paper delivery note, drawn in a scratch page and attached the
// way a phone photo would be.
async function deliveryNotePhoto(page) {
  const scratch = await page.context().newPage();
  await scratch.setViewportSize({ width: 480, height: 360 });
  await scratch.setContent(`<body style="margin:0;background:#6b5b4b;display:grid;place-items:center;height:360px;font-family:monospace">
    <div style="background:#fbfaf6;width:360px;padding:18px 22px;transform:rotate(-3deg);box-shadow:0 6px 18px rgba(0,0,0,.35);font-size:13px;color:#222">
    <b style="font-size:16px">ÖLGERÐIN — FYLGISEÐILL</b><br>Harbour Room · 24.09.2026<hr>
    Fever-Tree Tonic 200ml ....... 48<br>Ginger beer 200ml ............ 24<br>Gull Lager 33cl .............. 24<hr>Samtals: 3 línur</div></body>`);
  const buffer = await scratch.screenshot();
  await scratch.close();
  return buffer;
}
async function openLiveVoice(page) {
  await page.context().route('https://api.openai.com/**', (route) => (route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } })
    : route.fulfill({ status: 201, contentType: 'application/sdp', headers: { 'access-control-allow-origin': '*' }, body: 'v=0 manual-answer' })));
  await click(page, '[data-ai-live]');
  await visible(page, '.voice[data-state="listening"]');
}

shot({ name: 'ai-empty', module: 'Atlas AI', route: '#ai/new', run: async (page) => visible(page, '.ai-empty'),
  state: 'A new Atlas AI conversation with suggested prompts and the conversation list.',
  caption: 'Start with a suggestion or type your own question. Earlier conversations stay in the list on the left.' });
shot({ name: 'ai-empty-phone', module: 'Atlas AI', viewport: 'phone', route: '#ai/new', run: async (page) => visible(page, '.ai-empty'),
  state: 'A new Atlas AI conversation on a phone.',
  caption: 'On a phone, Atlas AI sits in the middle of the tab bar — tap it, then type, talk or add a photo.' });
shot({ name: 'ai-conversation', module: 'Atlas AI', route: `#ai/c/${AI_IDS.convNegroni}`, run: async (page) => { await visible(page, '.msg-ai'); await scrollTo('.msg-user')(page); },
  state: 'A conversation: the question, Atlas’s answer with the records it used, and a proposal waiting for approval.',
  caption: 'Every answer shows where it came from — tap a record to open it in Atlas.' });
shot({ name: 'ai-approval-card', module: 'Atlas AI', route: `#ai/c/${AI_IDS.convNegroni}`,
  run: scrollTo('[data-ai-approval]', 'center'),
  clip: (page) => boxOf(page, '[data-ai-approval]', 12),
  state: 'Close-up of a proposal card: a draft purchase order for Northwind with what will and will not change.',
  caption: 'Atlas never acts on its own. It prepares the change, tells you exactly what will happen, and waits for you to approve.' });
shot({ name: 'ai-decisions', module: 'Atlas AI', route: '#ai/decisions', run: async (page) => visible(page, '.ai-dec-row:not(.ai-dec-row--head)'),
  state: 'The Decisions list with open recommendations and past decisions.',
  caption: 'Decisions keeps Atlas’s open recommendations and a record of what was approved or dismissed, and by whom.' });
shot({ name: 'ai-attachment', module: 'Atlas AI', route: '#ai/new',
  run: async (page) => {
    await visible(page, '#ai-composer-input');
    await page.setInputFiles('[data-ai-file-any]', { name: 'delivery-note.png', mimeType: 'image/png', buffer: await deliveryNotePhoto(page) });
    await visible(page, '[data-ai-att] .file-chip__meta');
  },
  state: 'A delivery-note photo attached in the composer, with photo prompts offered.',
  caption: 'Add a photo — a delivery note, a shelf, an invoice — and ask about it. Atlas suggests questions that fit.' });
shot({ name: 'ai-voice-note', module: 'Atlas AI', route: '#ai/new', extraInit: fakeMediaInit,
  run: async (page) => { await visible(page, '#ai-composer-input'); await click(page, '[data-ai-voice-note]'); await visible(page, '[data-ai-rec-stop]'); },
  state: 'Recording a voice note in the composer.',
  caption: 'Hold a thought with a voice note: Atlas writes it out so you can check it before sending.' });
shot({ name: 'ai-live-voice-intro', module: 'Atlas AI', route: `#ai/c/${AI_IDS.convNegroni}`, extraInit: fakeMediaInit,
  run: async (page) => { await click(page, '[data-ai-live]'); await visible(page, '.ai-dialog'); },
  state: 'The first-time explanation shown before live voice starts.',
  caption: 'Before live voice starts, Atlas explains that it listens only while the panel is open and that anything it prepares waits for your approval.' });
shot({ name: 'ai-live-voice', module: 'Atlas AI', route: `#ai/c/${AI_IDS.convNegroni}`, extraInit: fakeMediaInit, storage: { 'atlas.ai.voice.explained.v1': 'yes' },
  run: async (page) => {
    await openLiveVoice(page);
    await page.evaluate(() => window.__dc.serverEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Six bottles of Tanqueray and two Campari on the back bar.' }));
    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'Got it — six Tanqueray and two Campari. Shall I save that as a count for review?' }));
    await settle(page);
  },
  state: 'Live voice conversation in progress, with the transcript shown.',
  caption: 'Talk to Atlas hands-free while you count. The transcript stays on screen, and Mute or End are one tap away.' });

// ----- Messages -----
const OPENING = '00000000-0000-4000-8000-000000000001';
shot({ name: 'messages-channel', module: 'Messages', route: '#messages', run: async (page) => visible(page, '[data-msg-log]'),
  state: 'The General channel: channel list with unread badges, named senders with photos or initials, a linked item and read receipts.',
  caption: 'Messages keeps the team in one place. Each message shows who sent it, and a line marks where new messages start.' });
shot({ name: 'messages-list-phone', module: 'Messages', viewport: 'phone', route: '#messages',
  state: 'Channel list on a phone with unread counts.',
  caption: 'On a phone, Messages opens on the channel list; a blue badge counts what you have not read.' });
shot({ name: 'messages-thread-phone', module: 'Messages', viewport: 'phone', route: '#messages/general', run: async (page) => visible(page, '[data-msg-log]'),
  state: 'The General thread on a phone.',
  caption: 'A thread on a phone: your own messages sit on the right, everyone else’s on the left with their name.' });
shot({ name: 'messages-announcements', module: 'Messages', route: '#messages/announcements', run: async (page) => visible(page, '[data-msg-log]'),
  state: 'The Announcements channel with an Atlas notice and a manager announcement.',
  caption: 'Announcements are for official notices. Only managers can post here; Atlas adds notices such as newly published required reading.' });
shot({ name: 'messages-read-receipts', module: 'Messages', route: '#messages',
  run: async (page) => { await visible(page, '[data-msg-log]'); },
  clip: (page) => boxOf(page, '.msg-item:has-text("Read by")', 16),
  state: 'Close-up of an own message with a linked inventory item and its read receipt.',
  caption: 'Link a record to a message so the team can open it in one tap. “Read by” shows how many have seen it.' });
shot({ name: 'messages-handover', module: 'Messages', route: '#messages/shift-handover',
  run: async (page) => {
    await click(page, '[data-msg-handover]');
    await visible(page, '#msg-handover-form');
    const fields = page.locator('#msg-handover-form textarea');
    await fields.nth(0).fill('Quiet start, busy from 21:00 with the quiz. Till balanced at close.');
    await fields.nth(1).fill('Tequila is out, so no Margaritas until the Northwind delivery.');
    await fields.nth(2).fill('Ice machine is noisy again — please call the service company in the morning.');
    await page.evaluate(() => document.activeElement?.blur());
  },
  state: 'The Write handover sheet opened from the Shift handover channel.',
  caption: 'At the end of a shift, Write handover posts a short note for the next team in Shift handover.' });

// ----- Operations -----
shot({ name: 'operations-today', module: 'Operations', route: '#operations',
  state: 'Today’s checklists and routines with progress.',
  caption: 'Operations lists today’s checklists and routines with how far each has got.' });
shot({ name: 'operations-checklist-phone', module: 'Operations', viewport: 'phone', route: `#operations/${OPENING}`, run: async (page) => visible(page, '[data-ops-tick]'),
  state: 'The opening checklist on a phone.',
  caption: 'Work through the checklist on your phone — tap an item to tick it off.' });
shot({ name: 'operations-tick-item', module: 'Operations', route: `#operations/${OPENING}`,
  run: async (page) => {
    await visible(page, '[data-ops-tick="00000000-0000-4000-8000-000000000015"]');
    await page.click('[data-ops-tick="00000000-0000-4000-8000-000000000015"]');
    await page.waitForSelector('[data-ops-tick="00000000-0000-4000-8000-000000000015"][aria-checked="true"]');
  },
  state: 'The opening checklist after ticking “Polish and stock service glassware”: now 5 of 9, with your name and the time.',
  caption: 'Tick an item and Atlas saves it straight away with your name and the time.' });
shot({ name: 'operations-temperature', module: 'Operations', route: '#operations/temperature',
  state: 'Temperature log: one fridge logged, one waiting, and one point without a range set.',
  caption: 'The temperature log shows which fridges are logged today and flags readings outside the safe range.' });

// ----- Inventory and stock count -----
// A calmer stand-in for the phone camera than the test harness's grey frame:
// a bottle on a dark back bar, and a barcode reader that returns what the
// shot pushes to window.__fakeBarcodes.
function manualCamera() {
  const canvas = document.createElement('canvas');
  canvas.width = 720; canvas.height = 960;
  const g = canvas.getContext('2d');
  const draw = () => {
    const bg = g.createLinearGradient(0, 0, 0, 960); bg.addColorStop(0, '#2b2622'); bg.addColorStop(1, '#14110f');
    g.fillStyle = bg; g.fillRect(0, 0, 720, 960);
    g.fillStyle = '#3a312a'; g.fillRect(0, 700, 720, 30);
    g.fillStyle = '#d9c9a3'; g.beginPath(); g.moveTo(320, 180); g.lineTo(400, 180); g.lineTo(400, 300); g.quadraticCurveTo(470, 330, 470, 400); g.lineTo(470, 700); g.lineTo(250, 700); g.lineTo(250, 400); g.quadraticCurveTo(250, 330, 320, 300); g.closePath(); g.fill();
    g.fillStyle = '#f7f1e3'; g.fillRect(265, 440, 190, 170);
    g.fillStyle = '#5b3a1e'; g.font = 'bold 34px Georgia'; g.textAlign = 'center'; g.fillText('GIFFARD', 360, 500);
    g.font = 'italic 26px Georgia'; g.fillText('Vanille', 360, 540); g.font = '16px Georgia'; g.fillText('SIROP · 1 L', 360, 580);
  };
  draw(); setInterval(draw, 200);
  window.__fakeBarcodes = [];
  navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(10);
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['ean_13', 'ean_8', 'code_128', 'qr_code']; }
    async detect() { const next = window.__fakeBarcodes.shift(); return next ? [{ rawValue: next, format: 'ean_13' }] : []; }
  };
}
const COUNT_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const dialog = '.atlas-dialog, .atlas-sheet';

shot({ name: 'inventory-list', module: 'Inventory', route: '#inventory', run: async (page) => visible(page, '[data-inv-row]'),
  state: 'The Items list with search, Status, Category and Supplier filters; out, almost out and below-par items first.',
  caption: 'Inventory lists every active item with what is on hand against par. Problems sort to the top.' });
shot({ name: 'inventory-list-phone', module: 'Inventory', viewport: 'phone', route: '#inventory', run: async (page) => visible(page, '[data-inv-body]'),
  state: 'The Items list on a phone.',
  caption: 'On a phone, each item shows its status and quantity at a glance; tap it for details.' });
shot({ name: 'inventory-filter-menu', module: 'Inventory', route: '#inventory',
  run: async (page) => { await click(page, '[data-inv-menu-trigger="status"]'); },
  clip: async () => ({ x: 240, y: 190, width: 1200, height: 400 }),
  state: 'The Status filter menu open on the Items list.',
  caption: 'Filter by status to see only what is out, almost out or below par.' });
shot({ name: 'inventory-item-detail', module: 'Inventory', route: `#inventory/item/${ITEM_IDS.campari}`, run: async (page) => visible(page, '.inv-detail'),
  state: 'Item details for Campari: on hand, par, supplier, cost, location and recipes that use it.',
  caption: 'Open an item to see everything about it — stock, supplier, cost and which recipes depend on it.' });
shot({ name: 'inventory-edit-item', module: 'Inventory', route: `#inventory/item/${ITEM_IDS.campari}`,
  run: async (page) => { await click(page, '[data-inv-edit]'); await visible(page, '#inv-edit-form'); },
  state: 'The Edit details form for Campari.',
  caption: 'Managers edit an item’s name, category, unit, supplier, par level and cost from Edit details.' });
shot({ name: 'inventory-add-item', module: 'Inventory', route: '#inventory',
  run: async (page) => { await click(page, '[data-inv-add]'); await visible(page, '[data-inv-item-form]'); },
  state: 'The Add item form.',
  caption: 'Add item creates a new product. Atlas checks for likely duplicates before it is saved.' });
shot({ name: 'inventory-waste', module: 'Inventory', route: '#inventory/waste',
  run: async (page) => {
    await click(page, '[data-inv-waste]');
    await visible(page, '#inv-waste-form');
    const pick = (selector, text) => page.evaluate(([target, wanted]) => {
      const select = document.querySelector(target);
      const option = [...select.options].find((entry) => entry.textContent.trim().toLowerCase().startsWith(wanted));
      if (option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
    }, [selector, text]);
    await pick('#inv-w-item', 'fresh mint');
    await page.fill('#inv-w-qty', '1');
    await pick('#inv-w-reason', 'spoil');
    await page.fill('#inv-w-note', 'Wilted in the walk-in');
    await page.evaluate(() => document.activeElement?.blur());
  },
  state: 'The Record waste dialog filled in for one bunch of wilted mint.',
  caption: 'Record waste with a reason — spoilage, breakage or a spill — so stock and reports stay accurate.' });
shot({ name: 'inventory-movements', module: 'Inventory', route: '#inventory/movements',
  state: 'The Movements tab: deliveries, waste and adjustments with who recorded them.',
  caption: 'Movements is the history of every stock change between counts: deliveries in, waste and adjustments out.' });
shot({ name: 'inventory-identify', module: 'Inventory', viewport: 'phone', route: '#inventory', extraInit: manualCamera,
  run: async (page) => {
    await page.evaluate(() => window.AtlasInventory.openIdentify());
    await visible(page, '.atlas-capture');
    await page.evaluate(() => window.__fakeBarcodes.push('3180290000000'));
    await visible(page, '[data-capture-result]');
  },
  state: 'Identify item on a phone: the camera recognised Giffard Vanille Syrup with high confidence.',
  caption: 'Point the camera at a bottle or its barcode and Atlas tells you which item it is. Identifying never changes stock.' });
shot({ name: 'count-start', module: 'Stock count', route: '#inventory/counts', world: { countStatus: 'verified' },
  run: async (page) => { await click(page, 'button[data-inv-count]'); await visible(page, dialog); },
  state: 'The Start stock count sheet: choose an area or the whole bar.',
  caption: 'Start a count for one area, such as the back bar, or for everything.' });
shot({ name: 'count-counting', module: 'Stock count', route: `#inventory/counts/${COUNT_SESSION}`, run: async (page) => visible(page, '[data-count-qty]'),
  state: 'Counting the back bar: 2 of 6 items counted, entering the next quantity.',
  caption: 'Count item by item. Enter what you see on the shelf; Atlas moves to the next item when you save.' });
shot({ name: 'count-counting-phone', module: 'Stock count', viewport: 'phone', route: `#inventory/counts/${COUNT_SESSION}`, run: async (page) => visible(page, '[data-count-qty]'),
  state: 'Counting on a phone, one item at a time.',
  caption: 'On a phone the count shows one item at a time with a large number field — made for counting at the shelf.' });
shot({ name: 'count-review', module: 'Stock count', route: `#inventory/counts/${COUNT_SESSION}`, world: { countStatus: 'submitted' },
  run: async (page) => visible(page, '[data-count-verify]'),
  state: 'A submitted count waiting for a manager to verify or send back.',
  caption: 'When the count is submitted, a manager reviews the differences and verifies it — only then does stock update.' });

shot({ name: 'count-list', module: 'Stock count', route: '#inventory/counts',
  run: async (page) => { await click(page, '[data-count-filter="all"]'); await visible(page, '[data-count-filter="all"][aria-pressed="true"]'); },
  state: 'The Counts tab with All selected: the back-bar count in progress and earlier verified and cancelled counts.',
  caption: 'The Counts tab lists every count with its status, who counted and how far it got.' });
shot({ name: 'count-finish', module: 'Stock count', route: `#inventory/counts/${COUNT_SESSION}`, world: { countStatus: 'finishing' },
  run: async (page) => {
    await visible(page, '[data-count-menu-trigger]');
    await click(page, '[data-count-menu-trigger]');
    await click(page, '[data-count-menu-action="finish"]');
    await visible(page, '.sc-finish');
  },
  state: 'Finish count for the back bar: four counted, one skipped, one not counted yet, and one big difference.',
  caption: 'Finish count shows what is counted, skipped and not counted yet, and any big differences to recount before you submit.' });

// ----- Recipes -----
shot({ name: 'recipes-gallery', module: 'Recipes', route: '#recipes', run: async (page) => visible(page, '.recipe-tile'),
  state: 'The recipe gallery with availability from current stock.',
  caption: 'Recipes shows every drink with whether it can be made tonight, based on what is in stock.' });
shot({ name: 'recipes-gallery-phone', module: 'Recipes', viewport: 'phone', route: '#recipes', run: async (page) => visible(page, '.recipe-tile'),
  state: 'The recipe gallery on a phone.',
  caption: 'Behind the bar, open Recipes on your phone to check a spec or see what is unavailable.' });
shot({ name: 'recipes-detail', module: 'Recipes', route: `#recipes/${RECIPE_IDS.negroni}`,
  state: 'Recipe detail for the Negroni: ingredients with amounts, cost, margin, glass, garnish and method.',
  caption: 'Each recipe shows the specification, the cost per serve and the margin at the menu price.' });
shot({ name: 'recipes-edit', module: 'Recipes', route: `#recipes/${RECIPE_IDS.negroni}/edit`, run: async (page) => visible(page, '#recipe-photo-label'),
  state: 'Editing the Negroni: name, category, ingredients linked to stock, price and method.',
  caption: 'Edit a recipe to change its ingredients, amounts, menu price or method. Ingredients link to inventory items.' });

// ----- Purchasing -----
shot({ name: 'purchasing-orders', module: 'Purchasing', route: '#purchasing', run: async (page) => visible(page, '[data-po-open]'),
  state: 'Orders list with one order in each status: Draft, Needs approval, Approved, Ordered, Overdue, Received and Cancelled.',
  caption: 'Purchasing lists every order with its status, total and expected delivery. Overdue deliveries stand out.' });
shot({ name: 'purchasing-suggested-order', module: 'Purchasing', route: '#purchasing',
  run: async (page) => { await click(page, '[data-po-suggestions]'); await visible(page, '[data-po-suggest-qty]'); },
  clip: (page) => boxOf(page, '.atlas-sheet', 0),
  state: 'The Suggested order sheet: below-par items grouped by supplier with an order quantity for each.',
  caption: 'Review suggestions groups what is below par by supplier. Change quantities, then create the draft orders.' });
shot({ name: 'purchasing-order-draft', module: 'Purchasing', route: `#purchasing/order/${ORDER_IDS.draft}`, run: async (page) => visible(page, '[data-po-cmd]'),
  state: 'A draft order to Greenleaf, not yet sent for approval.',
  caption: 'A draft order can still be changed. Submit it when it is ready.' });
shot({ name: 'purchasing-order-approval', module: 'Purchasing', route: `#purchasing/order/${ORDER_IDS.approval}`, run: async (page) => visible(page, '[data-po-cmd="approve"]'),
  state: 'An order to Northwind waiting for manager approval.',
  caption: 'Orders over the approval limit wait here until a manager approves or rejects them.' });
shot({ name: 'purchasing-receive', module: 'Purchasing', route: `#purchasing/order/${ORDER_IDS.ordered}`,
  run: async (page) => {
    await click(page, '[data-po-receive]');
    await visible(page, '[data-po-rqty]');
    const fields = page.locator('[data-po-rqty]');
    await fields.nth(0).fill('48');
    await fields.nth(1).fill('12');
    await fields.nth(2).fill('24');
    await page.evaluate(() => document.activeElement?.blur());
  },
  state: 'Receiving the Bay Drinks delivery: ginger beer arrived short (12 of 24).',
  caption: 'Enter what actually arrived. A short delivery keeps the rest of the order open.' });
shot({ name: 'purchasing-order-partial', module: 'Purchasing', route: `#purchasing/order/${ORDER_IDS.partial}`, run: async (page) => visible(page, '[data-po-cmd]'),
  state: 'A partly received Northwind order: bourbon and two bottles of vodka still to come.',
  caption: 'A partly received order shows what has arrived and what is still outstanding.' });
shot({ name: 'purchasing-suppliers', module: 'Purchasing', route: '#purchasing/suppliers',
  state: 'The Suppliers list.',
  caption: 'Suppliers keeps contact details, items and open orders for each supplier together.' });

// ----- Shifts -----
shot({ name: 'shifts-week', module: 'Shifts', route: '#shifts', run: async (page) => visible(page, '.shifts-grid'),
  state: 'The week schedule for 21–27 September with one unpublished change and a change request.',
  caption: 'The week view shows who works when. Dashed shifts are not published yet; Publish week sends them to the team.' });
shot({ name: 'shifts-bartender-phone', module: 'Shifts', viewport: 'phone', role: 'bartender', route: '#shifts', run: async (page) => visible(page, '.shifts-days, .shifts-grid, .shifts-list'),
  state: 'A bartender’s own week on a phone: Mine view, shifts waiting for confirmation.',
  caption: 'Staff see their own shifts first, with who they are working with. Shifts marked Needs confirmation are waiting for them.' });
shot({ name: 'shifts-month', module: 'Shifts', route: '#shifts',
  run: async (page) => { await click(page, '[data-shifts-mode="month"]'); await visible(page, '.shifts-month__cell'); },
  state: 'The month view for September.',
  caption: 'Switch to Month to see the whole month at once.' });
shot({ name: 'shifts-day', module: 'Shifts', route: '#shifts',
  run: async (page) => { await click(page, '[data-shifts-mode="month"]'); await click(page, '[data-shifts-day="2026-09-24"]'); await visible(page, '#shifts-day'); },
  state: 'One day opened from the month view.',
  caption: 'Open a day to see everyone working it, and add a shift from there.' });
shot({ name: 'shifts-add', module: 'Shifts', route: '#shifts',
  run: async (page) => {
    await click(page, '.shifts-toolbar [data-shifts-add]');
    await visible(page, '#shifts-editor-form');
    await page.selectOption('#shift-person', 'p-jon');
    await page.fill('#shift-start', '19:00');
    await page.fill('#shift-end', '02:00');
    await page.evaluate(() => document.activeElement?.blur());
  },
  state: 'Adding a shift for Jón Gunnarsson, 19:00–02:00.',
  caption: 'Add shift: choose the person, the day and the times. Atlas warns if they said they are not free.' });

// ----- Team -----
const GUNNAR = 'c0ffee00-0000-4000-8000-000000000003';
shot({ name: 'team-directory', module: 'Team', route: '#team', run: async (page) => visible(page, '.team-table, .team-list'),
  state: 'The team directory with roles, today’s shifts, training and emergency contacts.',
  caption: 'Team lists everyone with their role, whether they are on today, and what is missing from their profile.' });
shot({ name: 'team-profile', module: 'Team', route: `#team/${GUNNAR}`, run: async (page) => visible(page, '.team-detail__name'),
  state: 'Gunnar Karlsson’s profile with profile photo, preferred name, contact details and training.',
  caption: 'A profile holds the person’s photo, preferred name, contact details, emergency contacts and training.' });
shot({ name: 'team-profile-edit', module: 'Team', route: `#team/${GUNNAR}`,
  run: async (page) => { await click(page, `[data-team-profile-edit="${GUNNAR}"]`); await visible(page, '#team-edit-form'); },
  state: 'Editing Gunnar’s profile details.',
  caption: 'Edit profile sets the name shown in Atlas — the name everyone sees in Messages and Shifts — plus job title and phone.' });

shot({ name: 'team-profile-access', module: 'Team', route: `#team/${GUNNAR}`,
  run: async (page) => { await visible(page, '[data-team-profile-access-form]'); await scrollTo('[data-team-profile-access-form]', 'center')(page); },
  clip: (page) => boxOf(page, '.atlas-sheet', 0),
  state: 'The Access section of Gunnar’s profile as an administrator sees it: Role, Atlas access, New setup link and Save access.',
  caption: 'Managers set a person’s role and switch their Atlas access on or off in the Access section of their profile.' });

// ----- Knowledge -----
shot({ name: 'knowledge-library', module: 'Knowledge', route: '#knowledge', run: async (page) => visible(page, '.kn-list'),
  state: 'The Knowledge library with categories, required reading and a draft.',
  caption: 'Knowledge holds the venue’s procedures and standards, grouped by category and searchable.' });
shot({ name: 'knowledge-library-phone', module: 'Knowledge', viewport: 'phone', role: 'bartender', route: '#knowledge', run: async (page) => visible(page, '.kn-list'),
  state: 'The library on a bartender’s phone with required reading due.',
  caption: 'Required reading is marked so staff know what to read first.' });
shot({ name: 'knowledge-article', module: 'Knowledge', route: '#knowledge/k-opening', run: async (page) => visible(page, '.kn-article__title'),
  state: 'The “Opening the bar” article, version 3.',
  caption: 'Articles are easy to read on any screen, with steps, checklists and the version history.' });
shot({ name: 'knowledge-acknowledge', module: 'Knowledge', role: 'bartender', route: '#knowledge/k-standards', run: async (page) => visible(page, '[data-knowledge-acknowledge]'),
  state: 'A bartender reading required article “Cocktail standards” with the acknowledge button.',
  caption: 'For required reading, staff tap Mark as read when they have read it — managers see who has.' });
shot({ name: 'knowledge-edit', module: 'Knowledge', route: '#knowledge/k-opening',
  run: async (page) => { await click(page, '[data-knowledge-edit]'); await visible(page, '#kn-editor-form'); },
  state: 'Editing “Opening the bar” in the article editor.',
  caption: 'Managers edit an article and publish a new version; staff always see the latest published version.' });

// ----- Reports -----
shot({ name: 'reports-overview', module: 'Reports', route: '#reports', run: async (page) => visible(page, '[data-reports-preset]'),
  state: 'Reports overview for the last 30 days compared with the previous period.',
  caption: 'The overview puts the month’s key numbers first, then what needs attention and where the money went.' });
shot({ name: 'reports-overview-charts', module: 'Reports', route: '#reports', run: scrollTo('#reports-money'),
  state: 'Reports overview scrolled to the Money section with spend by supplier.',
  caption: 'Charts compare suppliers, categories and periods. Sections without a data source say so instead of guessing.' });
shot({ name: 'reports-stock', module: 'Reports', route: '#reports/inventory', run: async (page) => visible(page, '.reports-chart'),
  state: 'The Stock report: value by category and items below par.',
  caption: 'The Stock report shows stock value by category and which items are below par or not counted.' });
shot({ name: 'reports-date-range', module: 'Reports', route: '#reports',
  run: async (page) => { await visible(page, '[data-reports-preset]'); await page.selectOption('[data-reports-preset]', 'custom').catch(() => page.click('[data-reports-preset]')); await settle(page); },
  clip: async (page) => {
    const stats = await page.locator('.reports-stats').first().boundingBox();
    return { x: 240, y: 64, width: 1200, height: Math.ceil(stats.y + stats.height + 16 - 64) };
  },
  state: 'The period control set to a custom date range.',
  caption: 'Choose a preset period or your own dates, and what to compare it with.' });

// ----- Marketing (the module as it is on main) -----
shot({ name: 'marketing-overview', module: 'Marketing', route: '#marketing',
  state: 'Marketing overview: coming up, waiting for approval and suggestions; publishing is manual.',
  caption: 'Marketing plans posts and campaigns. Publishing is done by hand — Atlas reminds you and records what went out.' });
shot({ name: 'marketing-calendar', module: 'Marketing', route: '#marketing/calendar',
  state: 'The Marketing calendar for September.',
  caption: 'The calendar shows planned posts by day.' });
shot({ name: 'marketing-editor', module: 'Marketing', route: '#marketing',
  run: async (page) => {
    await click(page, 'button[data-mk-new]');
    await visible(page, '[data-mk-form]');
    await page.fill('#mk-title', 'Autumn menu tasting night');
    await page.locator('[data-mk-form] label:has-text("Instagram") input').check();
    await page.fill('#mk-caption', 'Six new drinks for autumn. Come and taste them first — Thursday 1 October from 18:00.');
    await page.fill('#mk-when', '2026-09-30T12:00');
    await page.evaluate(() => document.activeElement?.blur());
  },
  state: 'The New post draft editor filled in, with the preview beside it.',
  caption: 'Write a draft with its caption, channels and planned time, then send it for approval.' });

// ----- Data -----
shot({ name: 'data-imports', module: 'Data', route: '#data',
  state: 'Imports list: a failed invoice PDF, a stock count ready to review and a completed price list.',
  caption: 'Data › Imports lists every uploaded file and where it is in review. Nothing changes live records until it is reviewed.' });
shot({ name: 'data-import-review', module: 'Data', route: '#data/import-review', run: async (page) => visible(page, '[data-data-review-open]'),
  state: 'Import review queue: rows with a possible duplicate and a held supplier row.',
  caption: 'Import review lists each row that needs a decision, with the issue Atlas found.' });
shot({ name: 'data-import-review-row', module: 'Data', route: '#data/import-review',
  run: async (page) => { await click(page, 'button[data-data-review-open]'); await visible(page, dialog); },
  state: 'One import row opened: the file’s values beside the matched Campari item, flagged as a possible duplicate.',
  caption: 'Compare what the file says with the record it matches, then approve, change or reject the row.' });
shot({ name: 'data-issues', module: 'Data', route: '#data/issues',
  state: 'Record issues: missing costs, unlinked suppliers, possible duplicates.',
  caption: 'Issues gathers gaps in your records — a missing cost, an unlinked supplier, a likely duplicate — with a way to fix each.' });
shot({ name: 'data-pars', module: 'Data', route: '#data/pars',
  run: async (page) => { await page.fill('#data-cover-days', '7'); await click(page, '[data-data-cover-form] button[type="submit"]'); },
  state: 'Par levels with suggestions for 7 days of cover, from usage in verified counts.',
  caption: 'Par levels shows how fast each item is used, based on verified counts, so you can set pars on evidence.' });
shot({ name: 'data-approvals', module: 'Data', route: '#data/approvals',
  state: 'Catalogue changes waiting for approval.',
  caption: 'Changes proposed by staff or Atlas AI — a new item, an alias, a merge — wait here for a manager.' });

// ----- Settings -----
for (const [key, label, caption] of [
  ['venue', 'Venue', 'Venue holds the business details Atlas uses on documents, in Atlas AI and for your team.'],
  ['hours', 'Opening hours', 'Opening hours drive the day in Atlas: when checklists are due, what counts as tonight, and last orders.'],
  ['team-access', 'Team access', 'Team access sets what each role can see and do.'],
  ['notifications', 'Notifications', 'Choose which events notify the team, and turn on notifications for this device.'],
  ['ai', 'Atlas AI', 'Atlas AI settings: switch it on or off for the venue and set daily limits for questions, voice and uploads.'],
  ['integrations', 'Integrations', 'Integrations lists the services Atlas can connect to. Here none is connected yet.'],
  ['system', 'System health', 'System health shows whether Atlas and its data sources are working. Until a check has run, it says so instead of reporting healthy.'],
]) {
  shot({ name: `settings-${key}`, module: 'Settings', route: `#settings/${key}`, state: `Settings › ${label}.`, caption });
}
shot({ name: 'settings-phone', module: 'Settings', viewport: 'phone', route: '#settings',
  state: 'Settings on a phone: the list of sections.',
  caption: 'On a phone, Settings opens as a list of sections.' });

// ----- Roles and permissions -----
shot({ name: 'role-bartender-inventory', module: 'Roles', role: 'bartender', route: '#inventory', run: async (page) => visible(page, '[data-inv-body]'),
  state: 'Inventory for a bartender: quantities and status, but no costs or suppliers.',
  caption: 'Bartenders see stock levels and can count, but not costs or suppliers.' });
shot({ name: 'role-bartender-decisions', module: 'Roles', role: 'bartender', route: '#ai/decisions', run: async (page) => visible(page, '[data-ai-decisions]:not([hidden])'),
  state: 'Atlas AI Decisions opened by a bartender.',
  caption: 'Decisions are for managers; staff see a short explanation instead.' });
shot({ name: 'role-viewer-home', module: 'Roles', role: 'viewer', route: '#home',
  state: 'Home for a viewer (read-only role).',
  caption: 'The viewer role is read-only: Home shows the same picture of the day, with no purchasing, data or settings.' });
shot({ name: 'role-viewer-inventory', module: 'Roles', role: 'viewer', route: '#inventory', run: async (page) => visible(page, '[data-inv-body]'),
  state: 'Inventory for a viewer: read-only, no Add item or Start stock count.',
  caption: 'For a viewer, Inventory is read-only: no Add item and no stock count.' });

// ---------- runner ----------

function parseArgs(argv) {
  const args = { only: null, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--only') args.only = argv[++index].split(',').map((value) => value.trim()).filter(Boolean);
    else if (argv[index] === '--list') args.list = true;
  }
  return args;
}

async function capture(definition, fonts) {
  const user = USERS_BY_ROLE[definition.role] || DEMO_USERS.admin;
  const signedIn = definition.role !== 'signed-out';
  const fixtures = manualWorld(user, definition.world || {});
  const { page, record, close } = await launchAtlas({
    user, fixtures, signedIn, waitReady: signedIn ? true : 'none',
    viewport: VIEWPORTS[definition.viewport], fixedTime: MANUAL_NOW, timezoneId: 'Atlantic/Reykjavik',
    initScript: initScript(fonts, definition.extraInit), storage: definition.storage || null,
    contextOptions: { deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-GB', ...(definition.viewport === 'phone' ? { hasTouch: true, isMobile: true } : {}) }
  });
  try {
    if (signedIn && definition.route) await navigateTo(page, definition.route);
    await ready(page);
    // The unread count arrives a moment after the page: wait for it, so the
    // Messages badge (the More tab's on a phone) shows the same in every shot
    // where there is something unread.
    if (signedIn) {
      const badge = definition.viewport === 'phone' ? '[data-nav-badge="more"]:not([hidden])' : '.atlas-sidebar [data-nav-badge="messages"]:not([hidden])';
      await page.evaluate(() => window.AtlasTeamUnreadBadge?.refresh?.()).catch(() => {});
      await page.waitForSelector(badge, { state: 'visible', timeout: 4000 }).catch(() => {});
    }
    if (definition.run) await definition.run(page, { record, fixtures });
    await ready(page);
    await liveRobot(page);
    const clip = definition.clip ? await definition.clip(page) : undefined;
    const file = path.join(OUT, `${definition.name}.png`);
    await page.screenshot({ path: file, clip, animations: 'disabled', caret: 'hide' });
    const bytes = statSync(file).size;
    const problems = [];
    if (bytes > MAX_BYTES) problems.push(`${Math.round(bytes / 1024)} KB`);
    if (record.pageErrors.length) problems.push(`page errors: ${record.pageErrors.slice(0, 2).join(' | ')}`);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.atlas-toast')].filter((node) => node.offsetParent).map((node) => node.textContent.trim()).join(' | '));
    if (toast && !definition.allowToast) problems.push(`toast: ${toast}`);
    console.log(`${problems.length ? '!' : '✓'} ${definition.name} (${Math.round(bytes / 1024)} KB)${problems.length ? ` — ${problems.join('; ')}` : ''}`);
    return { bytes };
  } finally {
    await close();
  }
}

const args = parseArgs(process.argv.slice(2));
const selected = SHOTS.filter((entry) => !args.only || args.only.some((filter) => entry.name.includes(filter)));
if (args.list) {
  selected.forEach((entry) => console.log(`${entry.name}\t${entry.module}\t${entry.viewport}\t${entry.role}\t${entry.route || ''}`));
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
const fonts = fontFaces();
const failures = [];
for (const definition of selected) {
  try { await capture(definition, fonts); } catch (error) {
    failures.push(definition.name);
    console.error(`✗ ${definition.name}: ${error.message.split('\n')[0]}`);
  }
}

// The manifest always lists every defined shot whose file exists, so a
// partial run (--only) keeps the rest of the manifest intact.
const manifest = SHOTS.filter((entry) => !entry.name.startsWith('discover-') && existsSync(path.join(OUT, `${entry.name}.png`))).map((entry) => ({
  file: `${entry.name}.png`, name: entry.name, module: entry.module, viewport: entry.viewport === 'phone' ? 'phone 390×844' : 'desktop 1440×900',
  clipped: Boolean(entry.clip), role: entry.role, route: entry.route || '', state: entry.state, caption: entry.caption
}));
writeFileSync(MANIFEST, `${JSON.stringify({ generated_from: 'apps/web (main ef7c907) via tests/browser/harness.mjs', clock: MANUAL_NOW, device_scale_factor: 2, screenshots: manifest }, null, 2)}\n`);
console.log(`${selected.length - failures.length}/${selected.length} captured → ${path.relative(process.cwd(), OUT)}`);
if (failures.length) process.exitCode = 1;
