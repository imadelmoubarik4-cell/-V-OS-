// Redesign 2026: the ALCEDO icon set (apps/web/assets/js/alcedo-icons.js) is
// the app's only icon source. It keeps the lucide API the modules call
// (lucide.createIcons, lucide.icons) and draws Phosphor-based glyphs. These
// checks make sure every icon name the app can ask for has a glyph, and that
// the renderer keeps the classes and attributes CSS and tests rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';

const WEB = 'apps/web';
const SOURCE = readFileSync(`${WEB}/assets/js/alcedo-icons.js`, 'utf8');

function load() {
  const warnings = [];
  const context = { console: { warn: (message) => warnings.push(String(message)) } };
  context.window = context;
  vm.runInNewContext(SOURCE, context);
  return { icons: context.AlcedoIcons, lucide: context.lucide, warnings };
}

function appSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(name) && !name.endsWith('alcedo-icons.js')) out.push([full, readFileSync(full, 'utf8')]);
      else if (name.endsWith('.bundle.js.gz')) out.push([full, gunzipSync(readFileSync(full)).toString('utf8')]);
    }
  };
  walk(WEB);
  return out;
}

// Every literal icon name in the app: data-lucide="…" in markup, icon('…')
// helper calls, and icon / iconName fields that helpers render later.
function literalNames() {
  const names = new Map();
  const add = (name, file) => { if (!names.has(name)) names.set(name, new Set()); names.get(name).add(file); };
  for (const [file, text] of appSources()) {
    for (const match of text.matchAll(/data-lucide="([a-z0-9-]+)"/g)) add(match[1], file);
    for (const match of text.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) add(match[1], file);
    for (const match of text.matchAll(/\b(?:icon|iconName|glyph)\s*:\s*'([a-z0-9-]+)'/g)) add(match[1], file);
  }
  return names;
}

test('every data-lucide name and icon(…) literal in apps/web resolves to an ALCEDO glyph', () => {
  const { icons, warnings } = load();
  const names = literalNames();
  assert.ok(names.size > 120, `found ${names.size} icon names`);
  const missing = [...names].filter(([name]) => !icons.has(name)).map(([name, files]) => `${name} (${[...files].join(', ')})`);
  assert.deepEqual(missing, [], `icon names without a glyph:\n${missing.join('\n')}`);
  assert.deepEqual(warnings, []);
});

test('names computed at run time (status, record and category icons) resolve too', () => {
  const { icons } = load();
  // Ternaries and lookup tables in modules, plus icon names stored in the
  // database seeds (recipe categories, knowledge categories, team channels).
  const computed = ['circle-alert', 'triangle-alert', 'info', 'circle-check', 'circle', 'check', 'x', 'minus', 'eye', 'eye-off',
    'pin', 'pin-off', 'mic', 'mic-off', 'film', 'image', 'file-text', 'receipt-text', 'link-2', 'hash', 'repeat-2', 'megaphone',
    'clapperboard', 'gallery-vertical-end', 'list-checks', 'package-plus', 'copy', 'flag', 'barcode', 'tag', 'octagon-alert',
    'sparkles', 'martini', 'snowflake', 'wine', 'citrus', 'coffee', 'flame', 'utensils', 'cake-slice', 'layers-3', 'beer',
    'glass-water', 'shield-check', 'workflow', 'door-open', 'hand-heart', 'briefcase-business', 'graduation-cap', 'book-open',
    'messages-square', 'message-circle', 'gauge', 'send', 'file', 'history', 'zap', 'arrow-right', 'clock', 'bell',
    'circle-user-round', 'user-round', 'atlas-bot', 'alcedo', 'home', 'loader-circle', 'square', 'audio-lines', 'phone-off'];
  assert.deepEqual(computed.filter((name) => !icons.has(name)), []);
});

test('the rendered svg keeps the lucide classes, adds alcedo-icon, and is a filled 256-grid glyph', () => {
  const { icons } = load();
  const markup = icons.svg('package', { size: 20, className: 'extra' });
  assert.match(markup, /^<svg class="alcedo-icon lucide lucide-package extra" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="20" height="20" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"><path d="M[^"]+"\/><\/svg>$/);
  assert.doesNotMatch(markup, /stroke/);
  assert.match(icons.svg('house', { label: 'Home' }), /role="img" aria-label="Home"/);
  assert.match(icons.svg('"><script>'), /lucide-script/, 'names are reduced to [a-z0-9-]');
});

test('createIcons replaces placeholders, copies their attributes and never re-renders an svg', () => {
  const { lucide } = load();
  const NS = 'http://www.w3.org/2000/svg';
  const made = [];
  const element = (tag, ns, attributes) => {
    const node = {
      tagName: tag, namespaceURI: ns, children: [], attrs: { ...attributes },
      get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); },
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      appendChild(child) { this.children.push(child); }
    };
    return node;
  };
  const parent = { replaced: [], replaceChild(next, previous) { this.replaced.push([next, previous]); } };
  const placeholder = element('I', 'http://www.w3.org/1999/xhtml', { 'data-lucide': 'messages-square', class: 'nav-icon', 'data-test': 'x', 'aria-hidden': 'true' });
  placeholder.parentNode = parent;
  const rendered = element('svg', NS, { 'data-lucide': 'house' });
  rendered.parentNode = parent;
  const unknown = element('I', 'http://www.w3.org/1999/xhtml', { 'data-lucide': 'not-a-real-icon' });
  unknown.parentNode = parent;
  const doc = {
    querySelectorAll: () => [placeholder, rendered, unknown],
    createElementNS: (ns, tag) => { const node = element(tag, ns, {}); made.push(node); return node; }
  };
  placeholder.ownerDocument = doc; rendered.ownerDocument = doc; unknown.ownerDocument = doc;
  const context = { console: { warn: () => {} } };
  context.window = context; context.document = doc;
  vm.runInNewContext(SOURCE, context);
  context.lucide.createIcons();
  assert.equal(parent.replaced.length, 2, 'the existing svg is left alone');
  const [svg] = parent.replaced[0];
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.attrs.class, 'lucide lucide-messages-square alcedo-icon nav-icon');
  assert.equal(svg.attrs['data-lucide'], 'messages-square');
  assert.equal(svg.attrs['data-test'], 'x');
  assert.equal(svg.attrs.viewBox, '0 0 256 256');
  assert.equal(svg.attrs.fill, 'currentColor');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.ok(svg.children[0].attrs.d.startsWith('M'));
  const [fallback] = parent.replaced[1];
  assert.equal(fallback.attrs.class, 'lucide lucide-not-a-real-icon alcedo-icon', 'an unknown name still renders, with the fallback glyph');
  assert.equal(typeof lucide.createIcons, 'function');
});

test('lucide.icons serves lucide-shaped nodes that draw the same glyph in a 24-unit box', () => {
  const { lucide, icons } = load();
  const node = lucide.icons.ChartNoAxesColumn;
  assert.ok(Array.isArray(node));
  assert.equal(node[0], 'svg');
  assert.equal(node[2][0][0], 'path');
  assert.equal(node[2][0][1].d, icons.path('chart-no-axes-column'));
  assert.equal(node[2][0][1].transform, 'scale(.09375)');
  assert.equal(lucide.icons.Trash2[2][0][1].d, icons.path('trash-2'));
  assert.equal(lucide.icons.NotAnIcon, undefined);
});

test('unknown names warn once and never throw', () => {
  const { icons, warnings } = load();
  assert.doesNotThrow(() => { icons.svg('nope'); icons.svg('nope'); icons.path(undefined); });
  assert.equal(warnings.filter((message) => message.includes('"nope"')).length, 1);
});
