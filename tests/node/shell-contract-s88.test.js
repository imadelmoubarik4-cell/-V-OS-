// S88 shell contract. AtlasShell (apps/web/assets/js/atlas-shell.js) is the one
// owner of navigation and view lifecycle. These checks keep modules from going
// back to wrapping the shell's globals or the browser's APIs, hold the number
// of MutationObservers and capture-phase listeners to a documented ceiling, make
// sure every event somebody listens for is actually emitted, and unit-test the
// shell API in node:vm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ROOT = new URL('../../', import.meta.url);
const WEB = new URL('apps/web/', ROOT);
const read = (relative) => fs.readFileSync(new URL(relative, ROOT), 'utf8');
const shellSource = read('apps/web/assets/js/atlas-shell.js');
const index = read('apps/web/index.html');

// Every script that ships: assets/js/*.js, the gzip Team Profiles bundle (its
// .source.js twin is identical and not loaded), index.html's inline scripts
// and config.js.
function shippedSources() {
  const dir = new URL('assets/js/', WEB);
  const sources = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.source.js')) continue;
    if (name.endsWith('.js')) sources.push([`assets/js/${name}`, fs.readFileSync(new URL(name, dir), 'utf8')]);
    if (name.endsWith('.js.gz')) sources.push([`assets/js/${name}`, zlib.gunzipSync(fs.readFileSync(new URL(name, dir))).toString('utf8')]);
  }
  const inline = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n');
  sources.push(['index.html', inline]);
  sources.push(['config.js', read('apps/web/config.js')]);
  return sources;
}
const SOURCES = shippedSources();

// Balanced argument list of a call whose "(" is at `start`.
function callArguments(source, start) {
  let depth = 0; let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) { if (char === '\\') { i += 1; continue; } if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) { depth -= 1; if (depth === 0) return source.slice(start + 1, i); }
  }
  return '';
}

function topLevelSplit(text) {
  const parts = []; let depth = 0; let quote = null; let currentPart = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { currentPart += char; if (char === '\\') { currentPart += text[i + 1]; i += 1; continue; } if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; currentPart += char; continue; }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) { parts.push(currentPart.trim()); currentPart = ''; continue; }
    currentPart += char;
  }
  if (currentPart.trim()) parts.push(currentPart.trim());
  return parts;
}

function countPerFile(pattern, predicate = () => true) {
  const counts = {};
  for (const [file, source] of SOURCES) {
    for (const match of source.matchAll(pattern)) {
      if (!predicate(source, match)) continue;
      counts[file] = (counts[file] || 0) + 1;
    }
  }
  return counts;
}

function isCapture(source, match) {
  const args = topLevelSplit(callArguments(source, match.index + match[0].length - 1));
  const options = args[2] || '';
  return options === 'true' || /capture\s*:\s*true/.test(options);
}

const total = (counts) => Object.values(counts).reduce((sum, value) => sum + value, 0);
// Values created inside the vm context come from another realm; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('no module reassigns the shell globals or wraps browser APIs', () => {
  const forbidden = [
    [/(^|[^.\w$])(setActiveView|loadAll|renderAtlasHome)\s*=(?!=)/m, 'reassigns a shell global'],
    [/\b(viewMap|titleMap)(\.[\w$]+|\[[^\]]+\])\s*=(?!=)/, 'writes into the base shell view tables'],
    [/delete\s+(viewMap|titleMap)\b/, 'deletes from the base shell view tables'],
    [/document\.addEventListener\s*=(?!=)/, 'replaces document.addEventListener'],
    [/window\.MutationObserver\s*=(?!=)/, 'replaces window.MutationObserver'],
    [/__atlas\w*Patched|__sprint3ReviewPatched|__checkpointAPatched/, 'marks a patch chain'],
    [/\.open\s*=\s*guardedOpen|api\.open\s*=/, 'wraps another module\'s API']
  ];
  for (const [file, source] of SOURCES) {
    for (const [pattern, reason] of forbidden) assert.doesNotMatch(source, pattern, `${file} ${reason}`);
  }
  // Legitimate browser-API guards, each owned by exactly one file.
  const fetchWrappers = SOURCES.filter(([, source]) => /window\.fetch\s*=(?!=)|root\.fetch\s*=(?!=)/.test(source)).map(([file]) => file);
  assert.deepEqual(fetchWrappers, ['assets/js/rehearsal-boundary.js', 'index.html'], 'only the rehearsal boundary and the index.html session watch wrap fetch');
  // S91: index.html owns the one other fetch guard, the Supabase 401 watch
  // (one consistent signed-out state); it only observes responses.
  assert.equal((index.match(/window\.fetch\s*=(?!=)/g) || []).length, 1, 'index.html wraps fetch once');
  assert.match(index, /function watchSupabaseAuth\(\)/);
  const iconGuards = SOURCES.filter(([, source]) => /createIcons\s*=(?!=)/.test(source)).map(([file]) => file);
  assert.deepEqual(iconGuards, ['config.js'], 'only config.js guards lucide.createIcons');
});

test('no bootstrap rewrites or Blob-evaluates another script', () => {
  const blobScripts = SOURCES.filter(([, source]) => /createObjectURL\(new Blob\(\[source\]/.test(source)).map(([file]) => file).sort();
  // team-profiles-bootstrap installs the repository-owned gzip bundle (the
  // settings-workspace-bootstrap.js orphan was deleted in the S88 CSS split).
  assert.deepEqual(blobScripts, ['assets/js/team-profiles-bootstrap.js']);
  assert.ok(!/settings-workspace-bootstrap/.test(index + read('apps/web/config.js')), 'the orphan bootstrap stays unloaded');
  // S88 Team B: the scanner and stock-count bootstraps were deleted; their
  // modules load as plain scripts from index.html.
  for (const file of ['stock-count-bootstrap.js', 'inventory-scanner-bootstrap.js']) {
    assert.ok(!fs.existsSync(`apps/web/assets/js/${file}`), `${file} stays deleted`);
    assert.ok(!(index + read('apps/web/config.js')).includes(file), `${file} stays unloaded`);
  }
});

// Ratchet ceilings (S88). A new observer or capture listener needs a reason and
// an entry here; the ceilings may only go down.
//
// MutationObservers (was 27 at the S87 audit; the stock-count L1 observer went with
// the S88 Team B count rewrite and the badge observer with Team D): none allowed.
const OBSERVER_ALLOWLIST = {};

// Capture-phase listeners (was 34 textual + 4 forced by the scanner bootstrap):
//   atlas-shell.js (1)             the single navigation listener; must see sidebar/tab clicks first.
//   rehearsal-boundary.js (1)      offline write boundary: blocks form submits before any module sees them.
const CAPTURE_ALLOWLIST = {
  'assets/js/atlas-shell.js': 1,
  'assets/js/rehearsal-boundary.js': 1
};
// S88 Team D: the Month calendar merged into shifts-workspace.js (bubbling
// listeners only), the photo gallery shim and the badge observer were retired;
// S88 Team B: the stock-count L1 observer and capture listeners went with the count rewrite.
const OBSERVER_CEILING = 0;
const CAPTURE_CEILING = 2;

test('MutationObservers stay within the documented ratchet ceiling', () => {
  const counts = countPerFile(/new\s+(?:window\.)?MutationObserver\s*\(/g);
  for (const [file, count] of Object.entries(counts)) {
    assert.ok(count <= (OBSERVER_ALLOWLIST[file] || 0), `${file} has ${count} MutationObserver(s); allowed ${OBSERVER_ALLOWLIST[file] || 0}`);
  }
  assert.ok(total(counts) <= OBSERVER_CEILING, `${total(counts)} MutationObservers > ceiling ${OBSERVER_CEILING}`);
  for (const file of ['assets/js/s38-app-remediation.js', 'assets/js/operations-checkpoint-a-layout.js', 'assets/js/settings-mount-bridge.js', 'assets/js/inventory-scanner-bootstrap.js', 'index.html']) {
    assert.ok(!counts[file], `${file} must not observe the DOM`);
  }
});

test('capture-phase listeners stay within the documented ratchet ceiling', () => {
  const counts = countPerFile(/addEventListener\s*\(/g, isCapture);
  for (const [file, count] of Object.entries(counts)) {
    assert.ok(count <= (CAPTURE_ALLOWLIST[file] || 0), `${file} has ${count} capture listener(s); allowed ${CAPTURE_ALLOWLIST[file] || 0}`);
  }
  assert.ok(total(counts) <= CAPTURE_CEILING, `${total(counts)} capture listeners > ceiling ${CAPTURE_CEILING}`);
  const stopImmediate = SOURCES.filter(([, source]) => /stopImmediatePropagation/.test(source)).map(([file]) => file).sort();
  assert.deepEqual(stopImmediate, ['assets/js/rehearsal-boundary.js']);
});

// Events the shell emits itself (atlas-shell.js) or from index.html's lifecycle.
const SHELL_CORE_EVENTS = new Set([
  'view:before-show', 'view:hide', 'view:show', 'view:registered', 'view:unregistered', 'data:loaded',
  'profile:ready', 'home:rendered', 'actions:changed', 'action:run', 'action:denied',
  'notify:changed', 'notify:open', 'notify:close'
]);

test('every event a module listens for is actually emitted', () => {
  const all = SOURCES.map(([, source]) => source).join('\n');
  // Window events (atlas:*), including those the shell mirrors from its own events.
  const mirrored = new Set([...shellSource.matchAll(/'[a-z:-]+': '(atlas:[a-z-]+)'/g)].map((match) => match[1]));
  const windowListened = new Set([...all.matchAll(/addEventListener\('(atlas:[a-z-]+)'/g)].map((match) => match[1]));
  for (const type of windowListened) {
    const emitted = mirrored.has(type) || new RegExp(`new (?:Custom)?Event\\('${type}'`).test(all);
    assert.ok(emitted, `${type} is listened for but never dispatched`);
  }
  assert.ok(mirrored.has('atlas:view-change'), 'atlas:view-change is emitted by the shell');
  // AtlasShell events.
  const shellListened = new Set([...all.matchAll(/\.on\??\.?\(?'([a-z0-9-]+:[a-z-]+)'/g)].map((match) => match[1]));
  for (const type of shellListened) {
    const emitted = SHELL_CORE_EVENTS.has(type) || new RegExp(`emit\\??\\.?\\(?'${type}'`).test(all);
    assert.ok(emitted, `AtlasShell event ${type} is listened for but never emitted`);
  }
  // S88 Team A: Operations, Brain and Checkpoint A no longer re-attach to each
  // other's renders; Home listens for operations:changed and data:error.
  // S88 Team D: Messages reports unread counts through messages:unread.
  for (const type of ['operations:changed', 'data:error', 'team-profiles:rendered', 'messages:unread']) {
    assert.ok(shellListened.has(type), `${type} has a listener`);
  }
});

test('index.html keeps setActiveView, loadAll and renderAtlasHome as thin shell calls', () => {
  assert.match(index, /<script src="assets\/js\/atlas-shell\.js\?v=20261003-bot1"><\/script>\s*<script src="config\.js"><\/script>/);
  assert.ok(index.indexOf('assets/js/atlas-shell.js') < index.indexOf('assets/js/runtime-module-guard.js'));
  assert.match(index, /function setActiveView\(view\) \{\s+return window\.AtlasShell\.show\(view\);\s+\}/);
  assert.match(index, /async function loadAll\(\) \{\s+await loadAtlasData\(\);\s+window\.AtlasShell\.dataLoaded\(\{ online: navigator\.onLine, health: window\.AtlasData\.health\(\) \}\);\s+\}/);
  assert.match(index, /function renderAtlasHome\(\)\{\s+return window\.AtlasShell\.renderHome\(\);\s+\}/);
  // Home is one module section (assets/js/home.js), not index.html's renderHomeCore.
  assert.doesNotMatch(index, /renderHomeCore|registerHomeSection\(/);
  assert.match(index, /window\.AtlasShell\.profileReady\(window\.atlasCurrentProfile\)/);
  // Modules register instead of patching.
  const registrations = {
    'operations.js': /atlas\.registerView\('operations'[\s\S]+?atlas\.home\?\.contribute\?\.\('operations', \{ focusRows, order: 20 \}\)[\s\S]+?atlas\.onDataLoaded/,
    'home.js': /atlas\.registerHomeSection\('home', render, 0\)[\s\S]+?atlas\.notify\.contribute\('messages', messageItems\)/,
    // S88 Team B: Inventory, Stock count and Purchasing contribute their own Home rows.
    'atlas-inventory.js': /shell\.home\?\.contribute\?\.\('inventory', \{ focusRows: homeRows, order: 10 \}\)/,
    'stock-count-workspace.js': /home\?\.contribute\?\.\('stock-count'/,
    'atlas-purchasing.js': /home\?\.contribute\?\.\('purchasing'/,
    // S88 Team C: Business Intelligence is Reports › Overview; Import Center and
    // Real VÁ Data are the Data page (home.contribute replaces a DOM Home section).
    'data-workspace.js': /registerView\('data'[\s\S]+?registerView\('sprint3-review'[\s\S]+?home\?\.contribute\?\.\('data'/,
    'recipes.js': /home\?\.contribute\?\.\('recipes'/,
    'settings-workspace.js': /registerView\?\.\('settings'/,
    'marketing-workspace.js': /registerView\('marketing'/,
    'system-workspace.js': /window\.AtlasSystem = \{\s+mount,/,
    'team-profiles-bootstrap.js': /registerView\('team-profiles'/
  };
  for (const [file, pattern] of Object.entries(registrations)) assert.match(read(`apps/web/assets/js/${file}`), pattern, file);
});

test('changed scripts carry the S88 cache key', () => {
  // S90 UX acceptance remediation (shell, design system and page fixes).
  for (const file of ['data-workspace.js', 'atlas-capture.js', 'atlas-search.js']) {
    assert.ok(index.includes(`<script src="assets/js/${file}?v=20260929-s90u"></script>`), file);
  }
  // S90 follow-up: workflow integrity, native date/time pickers, one open-order
  // truth in Atlas AI and the UX leftovers changed these after the s90u key.
  for (const file of ['s38-app-remediation.js', 'shifts-workspace.js',
    'atlas-venue-clock.js', 'modal.js', 'atlas-stock-truth.js']) {
    assert.ok(index.includes(`<script src="assets/js/${file}?v=20260929-s90f"></script>`), file);
  }
  // Engineering re-acceptance follow-up (clearer waste/delivery retry message)
  // and the UX acceptance round 2 fixes (toast placement, order lines on the
  // phone, one inventory value in Reports, hours validation in place).
  for (const file of ['stock-count-workspace.js', 'atlas-purchasing.js', 'operations.js', 'reports-overview.js']) {
    assert.ok(index.includes(`<script src="assets/js/${file}?v=20260930-s90g"></script>`), file);
  }
  // The Atlas AI robot (atlas-bot.js) replaced the sparkles assistant icon in
  // these scripts; atlas-ai.js also carries the S91b live voice lease.
  for (const file of ['atlas-ai.js', 'atlas-chrome.js', 'atlas-inventory.js', 'atlas-shell.js',
    'knowledge-workspace.js', 'recipes.js']) {
    assert.ok(index.includes(`<script src="assets/js/${file}?v=20261003-bot1"></script>`), file);
  }
  // Robot review follow-up: one WebGL probe, context loss, live reduced
  // motion, idle pause (atlas-bot.js); the offline quick answer keeps the
  // sparkles icon (atlas-palette.js).
  for (const file of ['atlas-palette.js']) {
    assert.ok(index.includes(`<script src="assets/js/${file}?v=20261003-bot2"></script>`), file);
  }
  // The big robot looks down at a pointer below it and up at one above
  // (atlas-bot.js loads the rebuilt scene).
  assert.ok(index.includes('<script src="assets/js/atlas-bot.js?v=20261003-bot3"></script>'), 'atlas-bot.js');
  assert.ok(index.includes('<script src="assets/js/atlas-ai-voice.js?v=20260926-s91c"></script>'), 'atlas-ai-voice.js');
  // S91a phone UI fixes: the Recipes category menu and tile category.

  assert.ok(index.includes('<link rel="stylesheet" href="assets/css/recipes.css?v=20260926-s91a">'), 'recipes.css');
  const config = read('apps/web/config.js');
  // The Atlas AI robot replaced the assistant icon in these lazily loaded scripts.
  for (const file of ['marketing-workspace.js', 'reports-workspace.js']) {
    assert.ok(config.includes(`scriptPath: 'assets/js/${file}?v=20261003-bot1'`), file);
  }
  // S92: every message shows its sender's real name and photo (own on the
  // right with the viewer's name and avatar); photos load when Messages opens.
  for (const file of ['team-messages.js', 'team-unread-badge.js', 'team-profile-photos.js']) {
    assert.ok(config.includes(`scriptPath: 'assets/js/${file}?v=20261002-s93m'`), file);
  }
  // The guarded stylesheet keeps one href in index.html, config.js and the guard.
  assert.ok(index.includes('<link rel="stylesheet" href="assets/css/team-messages.css?v=20261002-s93m">'), 'team-messages.css');
  assert.ok(config.includes("stylesheetPath: 'assets/css/team-messages.css?v=20261002-s93m'"), 'team-messages.css loader');
  assert.ok(read('apps/web/assets/js/runtime-module-guard.js').includes("'assets/css/team-messages.css?v=20261002-s93m'"), 'team-messages.css guard');
  assert.ok(index.includes('<script src="assets/js/runtime-module-guard.js?v=20261002-s93m"></script>'), 'runtime-module-guard.js');
  // S93: the Home/bell message item names the sender by the live name; the
  // daily briefing header shows the Atlas AI robot.
  assert.ok(index.includes('<script src="assets/js/home.js?v=20261003-bot3"></script>'), 'home.js');
  for (const file of ['team-profiles-bootstrap.js', 'system-workspace.js', 'shifts-workspace.js']) {
    assert.ok(config.includes(`scriptPath: 'assets/js/${file}?v=20260929-s90f'`), file);
  }
  // S91: the Settings sign-in message; S91b: owner copy for integrations
  // that are not set up, with admin-only setup details.
  assert.ok(config.includes("scriptPath: 'assets/js/settings-workspace.js?v=20260926-s91c'"), 'settings-workspace.js');
  assert.match(config, /window\.AtlasShell\.load\(scriptPath/);
});

// ---------- AtlasShell API (node:vm) ----------

function fakeElement(tag = 'div') {
  const listeners = {};
  return {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, attributes: {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    getAttribute(name) { return name === 'src' ? this.src : this.attributes[name]; },
    remove() { this.removed = true; }
  };
}

function loadShell({ hash = '', storage = {} } = {}) {
  const windowListeners = {};
  const documentListeners = [];
  const dispatched = [];
  const errors = [];
  const scripts = [];
  const location = { hash, pathname: '/index.html', search: '' };
  const history = {
    calls: [], state: null,
    pushState(state, title, url) { this.calls.push(['push', url]); location.hash = url; },
    replaceState(state, title, url) { this.calls.push(['replace', url]); location.hash = url; }
  };
  const store = { ...storage };
  const context = {
    console, Date, JSON, Promise, Map, Set, Array, Object, String, Number, Boolean, Error, Symbol, Infinity, NaN,
    location, history, setTimeout, clearTimeout,
    localStorage: { getItem: (key) => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } },
    reportError: (error) => errors.push(error),
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    dispatchEvent(event) { dispatched.push(event); return true; },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Element: class {},
    document: {
      addEventListener(type, fn, capture) { documentListeners.push({ type, capture: capture === true }); },
      querySelectorAll: (selector) => (selector === 'script[src]' ? scripts.filter((script) => !script.removed) : []),
      getElementById: () => null,
      createElement: (tag) => fakeElement(tag),
      body: { dataset: {}, appendChild(node) { scripts.push(node); } },
      head: { appendChild(node) { scripts.push(node); } }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(shellSource, context);
  const fireWindow = (type) => (windowListeners[type] || []).forEach((fn) => fn({ type }));
  return { shell: context.AtlasShell, context, location, history, dispatched, errors, scripts, store, documentListeners, fireWindow };
}

test('AtlasShell installs one capture-phase navigation listener and nothing global', () => {
  const { shell, documentListeners, context } = loadShell();
  // S88 redesign: the bubbling Service Mode card listener is gone with Service Mode.
  assert.deepEqual(documentListeners, [{ type: 'click', capture: true }]);
  assert.equal(typeof context.MutationObserver, 'undefined');
  for (const name of ['registerView', 'show', 'current', 'on', 'off', 'emit', 'registerHomeSection', 'onDataLoaded', 'parseRoute', 'load']) {
    assert.equal(typeof shell[name], 'function', name);
  }
  for (const [namespace, members] of Object.entries({ home: ['contribute', 'rows', 'render'], actions: ['register', 'run', 'list', 'get'],
    notify: ['push', 'contribute', 'items', 'unreadCount', 'markRead', 'markAllRead', 'open', 'close', 'setPanel'], links: ['register', 'open'], modules: ['ensure'] })) {
    for (const member of members) assert.equal(typeof shell[namespace][member], 'function', `${namespace}.${member}`);
  }
});

test('show() runs one lifecycle in a fixed order and emits real events', () => {
  const { shell, dispatched } = loadShell();
  const log = [];
  shell.setLayout((view, entry, context) => log.push(`layout:${view}:${context.source}`));
  shell.registerView('a', { render: () => log.push('render:a'), onShow: () => log.push('onShow:a'), onHide: () => log.push('onHide:a') });
  shell.registerView('b', { render: (params) => log.push(`render:b:${params.section || ''}`), onShow: () => log.push('onShow:b') });
  for (const type of ['view:before-show', 'view:hide', 'view:show']) shell.on(type, (detail) => log.push(`${type}:${detail.view}`));
  assert.equal(shell.show('a'), true);
  log.length = 0;
  shell.show('b', { section: 'x' }, { source: 'nav' });
  assert.deepEqual(log, ['view:before-show:b', 'layout:b:nav', 'onHide:a', 'view:hide:a', 'render:b:x', 'onShow:b', 'view:show:b']);
  assert.equal(shell.current(), 'b');
  assert.deepEqual({ ...shell.params() }, { section: 'x' });
  const change = dispatched.filter((event) => event.type === 'atlas:view-change').at(-1);
  assert.equal(change.detail.view, 'b');
  assert.equal(change.detail.previous, 'a');
  // Re-showing the same view renders once more but does not hide it.
  log.length = 0;
  shell.show('b');
  assert.deepEqual(log.filter((entry) => entry.startsWith('onHide') || entry.startsWith('view:hide')), []);
  assert.equal(shell.debug().renders.b, 2);
});

test('guards redirect, unknown views wait for registration, nested shows end the outer lifecycle', () => {
  const { shell } = loadShell();
  const log = [];
  shell.registerView('dashboard', { onShow: () => log.push('home') });
  shell.registerView('locked', { guard: () => 'dashboard', onShow: () => log.push('locked') });
  shell.show('locked');
  assert.equal(shell.current(), 'dashboard');
  assert.deepEqual(log, ['home']);
  // 'home' is an alias of the internal dashboard view.
  shell.show('home');
  assert.equal(shell.current(), 'dashboard');
  // A destination whose module loads later opens on registration.
  assert.equal(shell.show('later', { section: 'y' }), false);
  shell.registerView('later', { onShow: (params) => log.push(`later:${params.section}`) });
  assert.equal(shell.current(), 'later');
  assert.equal(log.at(-1), 'later:y');
  // A hook that navigates elsewhere ends the outer show before its view:show.
  const shown = [];
  shell.on('view:show', (detail) => shown.push(detail.view));
  shell.registerView('bounce', { render: () => shell.show('dashboard') });
  shell.show('bounce');
  assert.equal(shell.current(), 'dashboard');
  assert.deepEqual(shown, ['dashboard']);
});

test('a failing hook is reported without breaking the lifecycle', () => {
  const { shell, errors } = loadShell();
  const seen = [];
  shell.registerView('x', { render: () => { throw new Error('boom'); }, onShow: () => seen.push('onShow') });
  shell.on('view:show', () => seen.push('event'));
  shell.show('x');
  assert.deepEqual(seen, ['onShow', 'event']);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].message), /boom/);
});

test('on/off/once/onView and the window mirrors behave', () => {
  const { shell, dispatched } = loadShell();
  const seen = [];
  const handler = (detail) => seen.push(detail.n);
  shell.on('custom:thing', handler);
  shell.once('custom:thing', (detail) => seen.push(`once${detail.n}`));
  shell.emit('custom:thing', { n: 1 });
  shell.off('custom:thing', handler);
  shell.emit('custom:thing', { n: 2 });
  assert.deepEqual(seen, [1, 'once1']);
  shell.registerView('v', {});
  shell.registerView('w', {});
  const hooks = [];
  const remove = shell.onView('v', { show: (params) => hooks.push(`show:${params.k || ''}`), hide: () => hooks.push('hide') });
  shell.show('v', { k: '1' });
  shell.show('w');
  remove();
  shell.show('v');
  assert.deepEqual(hooks, ['show:1', 'hide']);
  shell.profileReady({ id: 'u', role: 'manager' });
  shell.dataLoaded({ online: true });
  assert.ok(dispatched.some((event) => event.type === 'atlas:profile-ready' && event.detail.role === 'manager'));
  assert.ok(dispatched.some((event) => event.type === 'atlas:data-loaded'));
  assert.equal(shell.profile().role, 'manager');
  let loaded = 0;
  shell.onDataLoaded(() => { loaded += 1; });
  shell.dataLoaded();
  assert.equal(loaded, 1);
});

test('Home is composed from ordered sections and ordered attention rows', () => {
  const { shell } = loadShell();
  const order = [];
  shell.registerHomeSection('late', () => order.push('late'), 50);
  shell.registerHomeSection('core', () => order.push('core'), 0);
  shell.home.contribute('ops', { render: () => order.push('ops'), order: 10 });
  shell.registerHomeSection('tie', () => order.push('tie'), 10);
  assert.deepEqual([...shell.renderHome()], ['core', 'ops', 'tie', 'late']);
  assert.deepEqual(order, ['core', 'ops', 'tie', 'late']);
  assert.equal(shell.debug().home.core, 1);
  shell.profileReady({ role: 'bartender' });
  shell.home.contribute('stock', { focusRows: () => [
    { id: 'info', severity: 'info', title: 'All counted' },
    { id: 'late', severity: 'warning', title: 'Count overdue', due: '2026-09-26T18:00:00Z' },
    { id: 'soon', severity: 'warning', title: 'Delivery due', due: '2026-09-26T09:00:00Z' },
    { id: 'out', severity: 'danger', title: 'Campari is out' },
    { id: 'managers', severity: 'danger', title: 'Approve order', roles: ['admin', 'manager'] }
  ] });
  assert.deepEqual(plain(shell.home.rows().map((row) => row.id)), ['stock:out', 'stock:soon', 'stock:late', 'stock:info']);
  assert.equal(shell.home.rows({ role: 'admin' })[0].id, 'stock:out');
  assert.equal(shell.home.rows({ role: 'admin' }).length, 5);
});

test('routes follow the spec table, keep legacy aliases working and round-trip through href', () => {
  const { shell } = loadShell();
  const route = (hash) => { const parsed = shell.parseRoute(hash); return [parsed.view, { ...parsed.params }]; };
  assert.deepEqual(route(''), ['dashboard', {}]);
  assert.deepEqual(route('#home'), ['dashboard', {}]);
  assert.deepEqual(route('#messages'), ['team', {}]);
  assert.deepEqual(route('#team'), ['team-profiles', {}]);
  assert.deepEqual(route('#team/p1'), ['team-profiles', { profile: 'p1' }]);
  assert.deepEqual(route('#inventory'), ['inventory', {}]);
  assert.deepEqual(route('#inventory?item=abc'), ['inventory', { item: 'abc' }]);
  assert.deepEqual(route('#inventory/item/abc'), ['inventory', { item: 'abc' }]);
  assert.deepEqual(route('#inventory/counts'), ['inventory', { section: 'stock-count' }]);
  assert.deepEqual(route('#inventory/movements'), ['movements', {}]);
  assert.deepEqual(route('#inventory?filter=below-par'), ['inventory', { filter: 'below-par' }]);
  assert.deepEqual(route('#purchasing/deliveries'), ['suppliers', { section: 'deliveries' }]);
  assert.deepEqual(route('#purchasing/order/42'), ['suppliers', { section: 'orders', order: '42' }]);
  assert.deepEqual(route('#reports/stock'), ['reports', { section: 'stock' }]);
  assert.deepEqual(route('#settings/notifications'), ['settings', { section: 'notifications' }]);
  assert.deepEqual(route('#recipes/r1/edit'), ['recipes', { recipe: 'r1', edit: '1' }]);
  assert.deepEqual(route('#knowledge/required'), ['knowledge', { section: 'required' }]);
  assert.deepEqual(route('#knowledge/a1'), ['knowledge', { article: 'a1' }]);
  // Legacy aliases.
  assert.deepEqual(route('#dashboard'), ['dashboard', {}]);
  assert.deepEqual(route('#suppliers'), ['suppliers', { section: 'suppliers' }]);
  assert.deepEqual(route('#waste'), ['waste', {}]);
  assert.deepEqual(route('#team-profiles'), ['team-profiles', {}]);
  // Aliases whose target page does not exist yet resolve to the registered page.
  assert.deepEqual(route('#imports'), ['data', {}], 'no page registered: first candidate');
  shell.registerView('imports', {});
  shell.registerView('brain', {});
  shell.registerView('system', {});
  shell.registerView('sprint3-review', {});
  assert.deepEqual(route('#imports'), ['imports', {}]);
  assert.deepEqual(route('#data'), ['imports', {}]);
  assert.deepEqual(route('#data/import-review'), ['sprint3-review', {}]);
  assert.deepEqual(route('#brain'), ['brain', {}]);
  assert.deepEqual(route('#settings/system'), ['system', {}]);
  shell.unregisterView('brain');
  shell.registerView('dashboard', {});
  assert.deepEqual(route('#brain'), ['dashboard', {}], 'a retired page falls back to its successor');
  assert.equal(shell.parseRoute('#notifications').panel, 'notifications');
  // href writes spec routes and parses back to the same view and parameters.
  const cases = [
    ['dashboard', {}, '#home'], ['team', {}, '#messages'], ['team-profiles', { profile: 'p1' }, '#team/p1'],
    ['suppliers', { section: 'deliveries' }, '#purchasing/deliveries'], ['inventory', { section: 'stock-count' }, '#inventory/counts'],
    ['inventory', { item: 'abc' }, '#inventory/item/abc'], ['movements', {}, '#inventory/movements'], ['imports', {}, '#data'],
    ['sprint3-review', {}, '#data/import-review'], ['system', {}, '#settings/system'], ['reports', { section: 'waste' }, '#reports/waste'],
    ['settings', { section: 'notifications' }, '#settings/notifications'], ['inventory', { filter: 'below-par' }, '#inventory?filter=below-par']
  ];
  for (const [view, params, expected] of cases) {
    assert.equal(shell.href(view, params), expected);
    const parsed = shell.parseRoute(expected);
    assert.equal(parsed.view, view, expected);
    for (const [key, value] of Object.entries(params)) assert.equal(parsed.params[key], value, `${expected} ${key}`);
  }
});

test('routing writes history once per navigation and Back/Forward re-show the view', () => {
  const { shell, history, location, fireWindow } = loadShell();
  const shown = [];
  for (const view of ['dashboard', 'inventory', 'reports']) shell.registerView(view, { onShow: (params) => shown.push(`${view}:${params.section || ''}`) });
  shell.show('dashboard');
  assert.deepEqual(history.calls, [], 'no history writes before sign-in starts routing');
  shell.startRouting();
  shell.show('dashboard');
  assert.deepEqual(plain(history.calls), [], 'the bare app URL already is Home');
  shell.show('inventory', {}, { source: 'nav' });
  shell.show('inventory');
  shell.show('reports', { section: 'stock' });
  assert.deepEqual(plain(history.calls), [['push', '#inventory'], ['push', '#reports/stock']]);
  // Back: the browser restores the hash and fires popstate/hashchange.
  shown.length = 0;
  location.hash = '#inventory';
  fireWindow('popstate');
  fireWindow('hashchange');
  assert.equal(shell.current(), 'inventory');
  assert.deepEqual(shown, ['inventory:'], 'popstate and hashchange for one step show the view once');
  assert.equal(history.calls.length, 2, 'restoring a route writes no new history');
  location.hash = '#reports/stock';
  fireWindow('popstate');
  assert.equal(shell.current(), 'reports');
  assert.equal(shell.params().section, 'stock');
});

test('typed links resolve through the registry', () => {
  const { shell } = loadShell();
  const opened = [];
  const remove = shell.links.register('knowledge_article', (key, context) => opened.push([key, context.source]));
  assert.equal(shell.openLink('knowledge_article', 'a1', { source: 'team-messages' }), true);
  assert.equal(shell.links.open('unknown', 'x'), false);
  remove();
  assert.equal(shell.openLink('knowledge_article', 'a2'), false);
  assert.deepEqual(opened, [['a1', 'team-messages']]);
});

test('the module loader appends each script once and reuses scripts already in the page', async () => {
  const { shell, scripts, context } = loadShell();
  const first = shell.load('assets/js/example.js?v=1', { global: 'AtlasExample', requireGlobal: true });
  const second = shell.modules.ensure({ js: 'assets/js/example.js?v=2', global: 'AtlasExample' });
  assert.equal(first, second, 'same path, any cache key: one load');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].async, false);
  context.AtlasExample = { ready: true };
  scripts[0].fire('load');
  assert.equal((await first).ready, true);
  assert.equal((await shell.load('assets/js/example.js', { global: 'AtlasExample' })).ready, true);
  // A static tag (no loader state) counts as loaded.
  const staticTag = fakeElement('script');
  staticTag.src = 'assets/js/static.js?v=9';
  scripts.push(staticTag);
  assert.equal(await shell.load('assets/js/static.js'), true);
  assert.equal(scripts.length, 2);
  // A script that loads without installing its global is rejected when required.
  const missing = shell.load('assets/js/missing.js', { global: 'AtlasMissing', requireGlobal: true });
  scripts.at(-1).fire('load');
  await assert.rejects(missing, /without installing AtlasMissing/);
});

test('canonical actions have one permission check and one implementation', async () => {
  const { shell } = loadShell();
  const runs = [];
  shell.actions.register({ id: 'inventory.count.start', label: 'Start stock count', icon: 'list-checks', keywords: ['stocktake'], roles: ['admin', 'manager', 'bartender'], contexts: ['home', 'inventory'], run: (ctx) => { runs.push(['count', ctx.context]); return 'opened'; } });
  shell.actions.register({ id: 'purchasing.order.new', label: 'New order', roles: ['admin', 'manager'], contexts: ['purchasing'], run: () => runs.push(['order']), denied: () => runs.push(['order-denied']) });
  shell.actions.register({ id: 'ai.ask', label: 'Ask Atlas', run: () => runs.push(['ask']), when: (ctx) => Boolean(ctx.query) });
  shell.profileReady({ role: 'bartender' });
  const ids = (context) => plain(shell.actions.list(context).map((action) => action.id));
  assert.deepEqual(ids(), ['inventory.count.start']);
  assert.deepEqual(ids({ query: 'stocktake' }), ['inventory.count.start']);
  assert.deepEqual(ids({ role: 'manager', context: 'purchasing', suggested: true }), ['purchasing.order.new']);
  assert.deepEqual(ids({ query: 'ask' }), ['ai.ask'], 'the when() predicate sees the query context');
  assert.deepEqual({ ...(await shell.actions.run('inventory.count.start', { context: 'home' })) }, { ok: true, result: 'opened' });
  assert.deepEqual({ ...(await shell.actions.run('purchasing.order.new')) }, { ok: false, reason: 'forbidden' });
  assert.deepEqual({ ...(await shell.actions.run('purchasing.order.new', { role: 'admin' })) }, { ok: true, result: 3 }, 'run returns the implementation result (Array#push length here)');
  assert.deepEqual(runs.map((entry) => entry[0]), ['count', 'order-denied', 'order']);
  await assert.rejects(shell.actions.run('does.not.exist'), /Unknown Atlas action/);
  assert.equal(shell.actions.get('ai.ask').label, 'Ask Atlas');
});

test('the notifications feed merges pushed, contributed and Home items and tracks read state', async () => {
  const { shell, store } = loadShell();
  const changes = [];
  shell.on('notify:changed', () => changes.push(1));
  shell.registerView('suppliers', {});
  shell.profileReady({ role: 'manager' });
  shell.notify.push({ id: 'msg-1', type: 'message', title: 'Sara: delivery is here', time: '2026-09-26T10:00:00Z', action: { label: 'Open', route: '#purchasing/deliveries' } });
  shell.notify.contribute('shifts', () => [{ id: 'shift-1', type: 'shift', severity: 'info', title: 'Shift published', time: '2026-09-26T09:00:00Z' }]);
  shell.home.contribute('stock', { focusRows: () => [{ id: 'out', severity: 'danger', title: 'Campari is out' }] });
  assert.ok(changes.length >= 3);
  assert.deepEqual(plain(shell.notify.items().map((item) => item.id)).sort(), ['home:stock:out', 'msg-1', 'shift-1']);
  assert.deepEqual(plain(shell.notify.items({ filter: 'needs-action' }).map((item) => item.id)).sort(), ['home:stock:out', 'msg-1']);
  assert.equal(shell.notify.unreadCount(), 3);
  const result = await shell.notify.activate('msg-1');
  assert.equal(result.ok, true);
  assert.equal(shell.current(), 'suppliers');
  assert.equal(shell.params().section, 'deliveries');
  assert.equal(shell.notify.unreadCount(), 2);
  assert.match(store['atlas.notifications.read.v1'], /msg-1/);
  shell.notify.markAllRead();
  assert.equal(shell.notify.unreadCount(), 0);
  // The panel UI plugs in through setPanel; open/close are events either way.
  const panel = [];
  assert.equal(shell.notify.open(), false, 'no panel registered yet');
  shell.notify.close();
  shell.notify.setPanel({ open: () => panel.push('open'), close: () => panel.push('close') });
  shell.notify.toggle();
  assert.equal(shell.notify.isOpen(), true);
  shell.notify.toggle();
  assert.deepEqual(panel, ['open', 'close']);
  assert.equal(shell.navigate('#notifications'), true, '#notifications opens the panel');
});
