// The runtime module guard must keep its guarantee when a required module is lazy:
// a required module can never silently become unavailable. Runs the real guard
// source in a node:vm with a mock window/document, driving AtlasShell.isLazyView to
// prove: a confirmed lazy module is left for navigation (not force-loaded); a lazy
// module the shell did NOT register is force-loaded eagerly (fail-safe); eager
// required modules always load; and a missing shell falls back to eager loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const guardSource = fs.readFileSync(new URL('../../apps/web/assets/js/runtime-module-guard.js', import.meta.url), 'utf8');

function fakeElement(tag = 'div') {
  return { tagName: String(tag).toUpperCase(), dataset: {}, rel: '', href: '', src: '',
    setAttribute() {}, appendChild() {} };
}

// Run the guard with a given AtlasShell mock; return the scriptPaths it asked
// AtlasShell.load to load (its eager-install path).
function runGuard({ atlasShell } = {}) {
  const loaded = [];
  const appended = [];
  const win = {
    AtlasShell: atlasShell,
    addEventListener() {}, // guard only uses this when readyState !== 'complete'
    console,
  };
  const context = {
    window: win, console,
    document: {
      readyState: 'complete', // run ensure() immediately on eval
      body: { dataset: {}, appendChild: (n) => appended.push(n) },
      head: { appendChild: (n) => appended.push(n) },
      querySelector: () => null,
      createElement: (tag) => fakeElement(tag),
    },
  };
  context.window.document = context.document;
  vm.createContext(context);
  if (atlasShell) atlasShell.load = (src) => { loaded.push(src); return Promise.resolve(); };
  vm.runInContext(guardSource, context);
  return { loaded, appended, api: win.AtlasRuntimeModules };
}

const scriptOf = (src) => src.split('?')[0];

test('the guard leaves a confirmed lazy required module for navigation to load', () => {
  // Shell reports shifts (the lazy entry) as a registered lazy view.
  const { loaded } = runGuard({ atlasShell: { isLazyView: (k) => k === 'shifts', load: null } });
  const paths = loaded.map(scriptOf);
  assert.ok(!paths.includes('assets/js/shifts-workspace.js'), 'shifts is not force-loaded when registered lazy');
  // Eager required modules still load.
  assert.ok(paths.includes('assets/js/team-messages.js'), 'eager team-messages still loads');
  assert.ok(paths.includes('assets/js/knowledge-workspace.js'), 'knowledge (still eager) loads');
  assert.ok(paths.includes('assets/js/notifications.js'), 'notifications loads');
});

test('the guard force-loads a lazy required module the shell did not register (fail-safe)', () => {
  // Shell is present but has NOT registered shifts lazily (reduced/broken deploy).
  const { loaded } = runGuard({ atlasShell: { isLazyView: () => false, load: null } });
  assert.ok(loaded.map(scriptOf).includes('assets/js/shifts-workspace.js'),
    'shifts is force-loaded when its lazy registration is missing');
});

test('with no shell at all, every required module (including the lazy one) loads eagerly', () => {
  // No AtlasShell.load path: the guard uses its <script> fallback for every entry.
  const { loaded, appended } = runGuard({ atlasShell: undefined });
  // AtlasShell.load was never available, so nothing went through that path…
  assert.equal(loaded.length, 0);
  // …and the DOM fallback appended a script for the lazy module too (availability kept).
  const srcs = appended.map((n) => scriptOf(String(n.src || '')));
  assert.ok(srcs.includes('assets/js/shifts-workspace.js'), 'shifts still made available via the script fallback');
  assert.ok(srcs.includes('assets/js/knowledge-workspace.js'), 'knowledge still made available');
});

test('the guard still exposes its frozen manifest API', () => {
  const { api } = runGuard({ atlasShell: { isLazyView: () => true, load: null } });
  assert.equal(typeof api.ensure, 'function');
  assert.equal(typeof api.manifest, 'function');
  const manifest = api.manifest();
  const shifts = manifest.find((entry) => String(entry[1]).includes('shifts-workspace.js'));
  assert.equal(shifts[3], 'shifts', 'shifts entry carries its lazy view key');
});
