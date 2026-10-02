// ALCEDO rebrand (docs/brand/ALCEDO_REBRAND_INVENTORY.md).
//
// 1. The committed Atlas Brand Identity Kit in docs/brand is still intact: every
//    file matches its sha256 in ASSET_MANIFEST.csv (historical source of record).
// 2. Every brand asset shipped in apps/web now carries the ALCEDO kit
//    (apps/web/assets/brand/alcedo/): the swapped files are byte-identical copies
//    of their alcedo source, and the two horizontal lockups are composed from the
//    ALCEDO symbol + wordmark. Filenames are unchanged (internal paths).
// 3. The design tokens take the ALCEDO palette and meet WCAG AA: text and button
//    text >= 4.5:1, focus ring and indicators >= 3:1 against adjacent colours.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const KIT = 'docs/brand/Atlas_Brand_Identity_Kit_v1.0';
const WEB = 'apps/web';
const BRAND = path.join(WEB, 'assets/brand');
const ALCEDO = path.join(BRAND, 'alcedo');

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
function manifest() {
  const lines = readFileSync(path.join(KIT, 'ASSET_MANIFEST.csv'), 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  assert.equal(lines[0], 'file,sha256');
  return new Map(lines.slice(1).map((line) => {
    const [file, hash] = line.split(',');
    return [file, hash];
  }));
}

test('the historical Atlas brand kit in docs/brand still matches ASSET_MANIFEST.csv file for file', () => {
  const entries = manifest();
  assert.equal(entries.size, 77);
  for (const [file, hash] of entries) {
    const full = path.join(KIT, file);
    assert.ok(existsSync(full), `${file} is missing from the kit`);
    assert.equal(sha256(full), hash, `${file} differs from the kit master`);
  }
  const present = walk(KIT).map((file) => path.relative(KIT, file).split(path.sep).join('/')).filter((file) => file !== 'ASSET_MANIFEST.csv');
  assert.deepEqual(present.filter((file) => !entries.has(file)), [], 'files added to the kit that the manifest does not list');
});

// The shipped brand files (Atlas_* / favicon* names kept as internal paths) whose
// bytes are a straight copy of an ALCEDO kit source.
const SWAPS = {
  'favicon.ico': 'favicon.ico',
  'favicon-16x16.png': 'icon-16.png',
  'favicon-32x32.png': 'icon-32.png',
  'favicon-48x48.png': 'icon-48.png',
  'favicon-192x192.png': 'icon-192.png',
  'favicon-512x512.png': 'icon-512.png',
  'apple-touch-icon.png': 'icon-180.png',
  'Atlas_Mark_Midnight.svg': 'symbol-color.svg',
  'Atlas_Mark_White.svg': 'symbol-white.svg',
  'Atlas_Primary_Stacked_Midnight.svg': 'logo-color.svg',
  'favicon.svg': 'symbol-color.svg'
};

test('shipped brand assets are byte-identical copies of their ALCEDO kit source', () => {
  for (const [shipped, source] of Object.entries(SWAPS)) {
    const shippedPath = path.join(BRAND, shipped);
    const sourcePath = path.join(ALCEDO, source);
    assert.ok(existsSync(shippedPath), `${shipped} is shipped`);
    assert.ok(existsSync(sourcePath), `${source} is in the ALCEDO kit`);
    assert.equal(sha256(shippedPath), sha256(sourcePath), `${shipped} must be a byte-exact copy of alcedo/${source}`);
  }
});

test('the horizontal lockups are composed from the ALCEDO symbol and wordmark', () => {
  // No horizontal lockup exists in the kit, so these two are composed in-repo
  // (symbol left + ALCEDO wordmark right). Verify they carry both parts.
  for (const [name, ink] of [['Atlas_Primary_Horizontal_Midnight.svg', '#08495c'], ['Atlas_Primary_Horizontal_White.svg', '#ffffff']]) {
    const svg = readFileSync(path.join(BRAND, name), 'utf8');
    assert.match(svg, /aria-label="Alcedo"/, `${name} names Alcedo`);
    assert.match(svg, /M 75,310 Q 150,255/, `${name} has the kingfisher symbol path`);
    assert.match(svg, /264\.32251,453\.98535/, `${name} has the ALCEDO wordmark paths`);
    assert.ok(svg.includes(ink), `${name} is drawn in ${ink}`);
  }
  // The teal midnight lockup keeps the orange beak accent from the kit symbol.
  assert.ok(readFileSync(path.join(BRAND, 'Atlas_Primary_Horizontal_Midnight.svg'), 'utf8').includes('#e8732a'));
});

test('pages use the swapped logos, favicons and manifest; no typed wordmark or "A" tile remains', () => {
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  for (const pattern of [
    /<link rel="icon" href="assets\/brand\/favicon\.ico"/,
    /<link rel="icon" type="image\/svg\+xml" href="assets\/brand\/favicon\.svg">/,
    /<link rel="apple-touch-icon" sizes="180x180" href="assets\/brand\/apple-touch-icon\.png">/,
    /<link rel="manifest" href="site\.webmanifest">/,
    /class="atlas-brand__lockup" src="assets\/brand\/Atlas_Primary_Horizontal_Midnight\.svg" alt="Alcedo"/,
    /class="atlas-brand__mark" src="assets\/brand\/Atlas_Mark_Midnight\.svg" alt="Alcedo"/,
    /class="atlas-topbar__mark"[^>]*><img src="assets\/brand\/Atlas_Mark_Midnight\.svg"/,
    /class="atlas-auth__lockup" src="assets\/brand\/Atlas_Primary_Stacked_Midnight\.svg" alt="Alcedo"/
  ]) assert.match(index, pattern);
  for (const page of ['invitation.html', 'recovery.html']) {
    const html = readFileSync(path.join(WEB, page), 'utf8');
    assert.match(html, /class="atlas-auth__lockup" src="assets\/brand\/Atlas_Primary_Stacked_Midnight\.svg" alt="Alcedo"/, page);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="assets\/brand\/favicon\.svg">/, page);
  }
  // menu.html is the venue's public menu: its own brand, no app favicon.
  assert.doesNotMatch(readFileSync(path.join(WEB, 'menu.html'), 'utf8'), /assets\/brand\//);
  for (const file of walk(WEB).filter((name) => /\.(html|js|css)$/.test(name))) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /atlas-icon\.png|assets\/logo\//, `${file} still references the retired icon`);
    assert.doesNotMatch(text, /atlas-brand__mark" aria-hidden="true">A<|atlas-auth__wordmark|atlas-brand__name/, `${file} types the brand instead of using the kit files`);
  }
  assert.equal(existsSync(path.join(WEB, 'atlas-icon.png')), false);
  assert.equal(existsSync(path.join(WEB, 'assets/logo')), false);

  const site = JSON.parse(readFileSync(path.join(WEB, 'site.webmanifest'), 'utf8'));
  assert.equal(site.name, 'Alcedo');
  assert.equal(site.short_name, 'Alcedo');
  assert.equal(site.theme_color, '#08495C');
  assert.equal(site.background_color, '#F8F5ED');
  assert.equal(site.display, 'standalone');
  assert.equal(site.start_url, './');
  assert.equal(site.id, './');
  assert.equal(site.scope, './');
  for (const icon of site.icons) assert.ok(existsSync(path.join(WEB, icon.src)), icon.src);
});

test('the sign-in screen shows the static ALCEDO lockup only — stale Atlas motion removed', () => {
  // ALCEDO rebrand: the stale Atlas sign-in motion clip was removed from the
  // login (it rendered the old Atlas logo rotation). The sign-in screen now
  // settles immediately on the static ALCEDO stacked lockup — no <video>.
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const indexNoComments = index.replace(/<!--[\s\S]*?-->/g, '');
  const videos = [...indexNoComments.matchAll(/<video\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(videos.length, 0, 'no sign-in motion video in index.html');
  assert.doesNotMatch(indexNoComments, /brand\/motion/, 'index.html no longer references brand/motion');
  // The login screen still carries the static ALCEDO lockup image.
  assert.match(index, /<div id="login-screen"[\s\S]*class="atlas-auth__lockup"[\s\S]*<div id="app-screen">/, 'static lockup sits inside the sign-in screen');
  const lockup = index.match(/<img class="atlas-auth__lockup"[^>]*>/);
  assert.ok(lockup, 'the static lockup img is present');
  assert.match(lockup[0], /alt="Alcedo"/, 'the lockup is labelled Alcedo');
  for (const page of ['invitation.html', 'recovery.html', 'menu.html']) assert.doesNotMatch(readFileSync(path.join(WEB, page), 'utf8'), /<video|brand\/motion/, page);
  const worker = readFileSync(path.join(WEB, 'service-worker.js'), 'utf8');
  // The PWA service worker caches the app shell for offline use, but must never
  // cache the removed brand/motion clip.
  assert.doesNotMatch(worker, /brand\/motion/);
});

// ---------- tokens and contrast ----------

function tokens() {
  const css = readFileSync(path.join(WEB, 'assets/css/atlas-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
  const raw = new Map([...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
  const resolve = (value, depth = 0) => {
    assert.ok(depth < 10, 'token cycle');
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? resolve(raw.get(ref[1]), depth + 1) : value;
  };
  return (name) => {
    assert.ok(raw.has(name), `${name} is defined`);
    return resolve(raw.get(name)).toLowerCase();
  };
}
function luminance(hex) {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  assert.match(a, /^#[0-9a-f]{6}$/, `${a} is a solid hex colour`);
  assert.match(b, /^#[0-9a-f]{6}$/, `${b} is a solid hex colour`);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('tokens carry the ALCEDO palette', () => {
  const token = tokens();
  const kit = JSON.parse(readFileSync(path.join(ALCEDO, 'brand-tokens.json'), 'utf8'));
  assert.equal(kit.brand, 'ALCEDO');
  // The kit anchors flow into the named tokens.
  assert.equal(token('--atlas-blue'), kit.colors.teal.toLowerCase());   // #08495c
  assert.equal(token('--atlas-snow'), kit.colors.ivory.toLowerCase());  // #f8f5ed
  assert.equal(token('--atlas-midnight'), kit.colors.ink.toLowerCase()); // #10201f
  assert.equal(token('--highlight'), kit.colors.orange.toLowerCase());  // #e8732a
  assert.equal(token('--accent-brand'), '#08495c');
  assert.equal(token('--accent'), '#08495c');
  assert.equal(token('--accent-hover'), '#063a49');
  assert.equal(token('--accent-press'), '#052e3a');
  assert.equal(token('--focus-color'), '#08495c');
  assert.equal(token('--text'), '#10201f');
  assert.equal(token('--bg-subtle'), '#f8f5ed');
  assert.equal(token('--line-strong'), '#cbd5e1');
  // Legacy names still resolve to the new system.
  for (const [legacy, modern] of [['--atlas-accent', '--accent'], ['--atlas-text', '--text'], ['--atlas-muted', '--text-2'], ['--atlas-line', '--line'], ['--s38-blue', '--accent'], ['--color-primary', '--accent'], ['--atlas-sidebar', '--bg-subtle'], ['--atlas-danger', '--danger'], ['--blue-500', '--accent']]) {
    assert.equal(token(legacy), token(modern), legacy);
  }
});

test('text and button colours meet WCAG AA (4.5:1); focus and indicators meet 3:1', () => {
  const token = tokens();
  const text = [
    ['--text', ['--bg', '--bg-subtle', '--bg-muted', '--surface', '--accent-soft']],
    ['--text-2', ['--bg', '--bg-subtle', '--bg-muted', '--bg-hover', '--accent-soft']],
    ['--text-3', ['--bg', '--bg-subtle', '--bg-muted', '--bg-hover']],
    ['--accent-text', ['--bg', '--bg-subtle', '--accent-soft']],
    ['--text-on-accent', ['--accent', '--accent-hover', '--accent-press', '--danger', '--ink']],
    ['--positive', ['--bg', '--positive-soft']],
    ['--warning', ['--bg', '--warning-soft']],
    ['--danger', ['--bg', '--danger-soft']]
  ];
  const failures = [];
  for (const [fg, backgrounds] of text) {
    for (const bg of backgrounds) {
      const ratio = contrast(token(fg), token(bg));
      if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
  }
  // Non-text indicators. Teal focus/accent-brand is verified on light surfaces;
  // dark --ink surfaces (toasts, tooltips) carry a light indicator instead
  // (white text on --ink is checked above at ~14.7:1) because dark teal cannot
  // reach 3:1 on a dark surface.
  const nonText = [
    ['--focus-color', ['--bg', '--bg-subtle', '--bg-muted', '--surface', '--accent-soft']],
    ['--accent-brand', ['--bg', '--bg-subtle', '--bg-muted']],
    ['--warning-icon', ['--bg']],
    // ALCEDO: orange is used in-app as a FILL that carries ink text (primary
    // buttons/badges, checked below at >= 4.5:1) and as a non-text accent on the
    // deep-teal panels (dots/rules/icons) — never as a thin graphic that must be
    // read against the warm ivory canvas or cream cards. So it is verified as an
    // accent against the teal panel (3:1), not against the light surfaces.
    ['--highlight', ['--accent', '--accent-hover']]
  ];
  for (const [fg, backgrounds] of nonText) {
    for (const bg of backgrounds) {
      const ratio = contrast(token(fg), token(bg));
      if (ratio < 3) failures.push(`${fg} against ${bg}: ${ratio.toFixed(2)}:1 (needs 3:1)`);
    }
  }
  assert.deepEqual(failures, []);
  // ALCEDO teal is dark, so unlike Atlas Blue it doubles as a text-bearing fill:
  // ivory/white on --accent passes AA.
  assert.ok(contrast('#ffffff', token('--accent')) >= 4.5);
  // Orange is a fill that carries INK text (primary CTA / count badges): ink on
  // orange is >= 4.5:1 (AA text). It still fails AA as coloured text on a light
  // surface (orange-on-white < 4.5:1), which is why orange is never used as body
  // text — only as a fill under ink or as a >= 3:1 accent on the teal panels.
  assert.ok(contrast(token('--text'), token('--highlight')) >= 4.5);
  assert.ok(contrast(token('--highlight'), '#ffffff') < 4.5);
});
