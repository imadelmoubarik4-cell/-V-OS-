// AtlasShell.registerLazyView loader behaviours, exercised against the real shell
// source in a node:vm with a small DOM mock so script load/error can be driven
// deterministically. Covers: a lazy view downloads once despite repeated/rapid
// navigation; navigating away before the module arrives does not reopen it; and a
// failed download renders an error with a working retry that re-attempts the load.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shellSource = fs.readFileSync(new URL('../../apps/web/assets/js/atlas-shell.js', import.meta.url), 'utf8');

function fakeElement(tag = 'div') {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, attributes: {},
    className: '', textContent: '', type: '', src: '', rel: '', href: '', children: [], removed: false,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return name === 'src' ? this.src : this.attributes[name]; },
    appendChild(node) { this.children.push(node); return node; },
    querySelector() { return null; },
    remove() { this.removed = true; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) { this._html = v; if (v === '') this.children = []; }
  });
  return el;
}

function loadShell() {
  const scripts = [];
  const elementsById = {};
  const getHost = (id) => (elementsById[id] ||= fakeElement('div'));
  const location = { hash: '', pathname: '/index.html', search: '' };
  const errors = [];
  const context = {
    console, Date, JSON, Promise, Map, Set, Array, Object, String, Number, Boolean, Error, Symbol, Infinity, NaN,
    location, setTimeout, clearTimeout,
    history: { pushState() {}, replaceState() {}, state: null },
    localStorage: { getItem: () => null, setItem() {} },
    reportError: (error) => errors.push(error),
    addEventListener() {}, dispatchEvent() { return true; },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Element: class {},
    document: {
      addEventListener() {},
      querySelectorAll: (selector) => (selector === 'script[src]' ? scripts.filter((s) => !s.removed) : []),
      querySelector: () => null,
      getElementById: (id) => getHost(id),
      createElement: (tag) => fakeElement(tag),
      body: { dataset: {}, appendChild(node) { scripts.push(node); return node; } },
      head: { appendChild(node) { scripts.push(node); return node; } }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(shellSource, context);
  return { shell: context.AtlasShell, context, scripts, elementsById, getHost, errors };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const bookingScripts = (scripts) => scripts.filter((s) => String(s.src).includes('bookings-workspace'));

test('a lazy view downloads once despite repeated and rapid navigation', async () => {
  const { shell, scripts } = loadShell();
  shell.registerLazyView('bookings', { js: 'assets/js/bookings-workspace.js?v=1', global: 'AtlasBookings', root: 'bookings-view' });
  assert.equal(shell.show('bookings'), false, 'unregistered lazy view does not open synchronously');
  shell.show('bookings'); // rapid repeat
  shell.show('bookings');
  assert.equal(bookingScripts(scripts).length, 1, 'exactly one bookings script was appended');
});

test('a registered lazy view is never re-downloaded on return', async () => {
  const { shell, scripts, context } = loadShell();
  shell.registerLazyView('bookings', { js: 'assets/js/bookings-workspace.js?v=1', global: 'AtlasBookings', root: 'bookings-view' });
  shell.show('bookings');
  // The module arrives: it installs its global and registers the view.
  context.AtlasBookings = {};
  shell.registerView('bookings', { root: () => context.getHost, render() {} });
  assert.equal(shell.current(), 'bookings');
  const after = bookingScripts(scripts).length;
  shell.show('bookings'); // navigate away and back would do the same: already registered
  shell.show('bookings');
  assert.equal(bookingScripts(scripts).length, after, 'no second download once registered');
});

test('navigating away before the module arrives does not reopen the lazy view', async () => {
  const { shell, context } = loadShell();
  shell.registerView('elsewhere', { render() {} });
  shell.registerLazyView('bookings', { js: 'assets/js/bookings-workspace.js?v=1', global: 'AtlasBookings', root: 'bookings-view' });
  shell.show('bookings');              // pending = bookings, module loading
  assert.equal(shell.show('elsewhere'), true); // user navigates away; pending cleared
  assert.equal(shell.current(), 'elsewhere');
  // The bookings module finally arrives and registers — it must NOT steal focus.
  context.AtlasBookings = {};
  shell.registerView('bookings', { render() {} });
  assert.equal(shell.current(), 'elsewhere', 'late registration did not reopen bookings');
});

test('a failed download shows an error with a retry that re-attempts the load', async () => {
  const { shell, scripts, getHost } = loadShell();
  shell.registerLazyView('bookings', { js: 'assets/js/bookings-workspace.js?v=1', global: 'AtlasBookings', root: 'bookings-view' });
  shell.show('bookings');
  assert.equal(bookingScripts(scripts).length, 1);
  // Simulate the download failing.
  bookingScripts(scripts).at(-1).fire('error');
  await tick();
  const host = getHost('bookings-view');
  const alert = host.children.find((c) => c.dataset.lazyError === 'bookings');
  assert.ok(alert, 'an error alert replaced the loading placeholder');
  const retry = alert.children.find((c) => c.dataset.lazyRetry === 'bookings');
  assert.ok(retry, 'the error offers a retry control');
  assert.match(retry.textContent, /try again/i);
  // Clicking retry re-attempts the download (the loading flag was cleared on failure).
  retry.fire('click');
  assert.equal(bookingScripts(scripts).length, 2, 'retry issued a fresh download');
});

test('the error is not surfaced if the user already navigated away', async () => {
  const { shell, scripts, getHost, context } = loadShell();
  shell.registerView('elsewhere', { render() {} });
  shell.registerLazyView('bookings', { js: 'assets/js/bookings-workspace.js?v=1', global: 'AtlasBookings', root: 'bookings-view' });
  shell.show('bookings');
  shell.show('elsewhere'); // navigate away while loading
  bookingScripts(scripts).at(-1).fire('error');
  await tick();
  const host = getHost('bookings-view');
  assert.equal(host.children.find((c) => c.dataset.lazyError === 'bookings'), undefined, 'no error shown in the abandoned view');
  assert.equal(shell.current(), 'elsewhere');
});
