// S96 (webstore): the public menu renders recipe names and types from the
// public_menu view, which any manager can change. Every database value must
// be escaped before it reaches innerHTML, in text and in attributes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('apps/web/menu.html', 'utf8');
// The menu script is inline today; patch 02 moves it to assets/js/public-menu.js.
const script = existsSync('apps/web/assets/js/public-menu.js')
  ? readFileSync('apps/web/assets/js/public-menu.js', 'utf8')
  : (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];

function renderWith(rows) {
  const nodes = {};
  const element = (id) => (nodes[id] ||= { id, innerHTML: '' });
  const document = {
    getElementById: element,
    querySelectorAll: () => []
  };
  const client = { from: () => ({ select: async () => ({ data: rows, error: null }) }) };
  const context = { window: { VABAR_CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' }, supabase: { createClient: () => client } }, document, console };
  context.window.document = document;
  vm.createContext(context);
  vm.runInContext(`var window = this.window; ${script}`, context);
  return new Promise((resolve) => setImmediate(() => resolve(nodes)));
}

test('public menu escapes recipe type in the tab attribute and label', async () => {
  const nodes = await renderWith([
    { id: 1, name: 'Plain', type: 'a"b<i>c</i>', menu_price: 1000 }
  ]);
  const tabs = nodes['menu-tabs'].innerHTML;
  assert.ok(!tabs.includes('<i>'), `type markup reached the tabs: ${tabs}`);
  assert.ok(!/data-type="a"b/.test(tabs), 'type broke out of the data-type attribute');
  assert.ok(tabs.includes('data-type="a&quot;b&lt;i&gt;c&lt;/i&gt;"'));
});

test('public menu escapes recipe names', async () => {
  const nodes = await renderWith([{ id: 1, name: '<b>Negroni</b>', type: 'cocktail', menu_price: 2500 }]);
  assert.ok(!nodes['menu-list'].innerHTML.includes('<b>'));
  assert.ok(nodes['menu-list'].innerHTML.includes('&lt;b&gt;Negroni&lt;/b&gt;'));
});
