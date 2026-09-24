// Brand v1.0 (docs/brand/README.md).
//
// 1. The committed Atlas Brand Identity Kit is intact: every file matches its
//    sha256 in ASSET_MANIFEST.csv (read with CR stripped) and nothing is added.
// 2. Every brand asset shipped in apps/web is a byte-identical copy of a kit
//    file (no redraws, no re-exports), and the pages use them instead of the
//    retired atlas-icon.png or a typed "A" tile / "Atlas" wordmark.
// 3. The design tokens take the kit palette and meet WCAG AA: text and button
//    text >= 4.5:1, focus ring and indicators >= 3:1 against adjacent colours.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const KIT = 'docs/brand/Atlas_Brand_Identity_Kit_v1.0';
const WEB = 'apps/web';
const BRAND = path.join(WEB, 'assets/brand');

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

test('the brand kit in docs/brand matches ASSET_MANIFEST.csv file for file', () => {
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

test('every brand asset shipped in apps/web is byte-identical to its kit source', () => {
  const kitByName = new Map();
  for (const file of manifest().keys()) {
    const name = path.posix.basename(file);
    if (!kitByName.has(name)) kitByName.set(name, []);
    kitByName.get(name).push(file);
  }
  const shipped = walk(BRAND).filter((file) => !file.startsWith(path.join(BRAND, 'motion')));
  assert.ok(shipped.length >= 14, 'the web brand assets are present');
  for (const file of shipped) {
    const sources = kitByName.get(path.basename(file)) || [];
    assert.equal(sources.length, 1, `${file} has exactly one kit source with the same name`);
    assert.equal(sha256(file), sha256(path.join(KIT, sources[0])), `${file} must be a byte-exact copy of ${sources[0]}`);
  }
  // No logo SVG anywhere else in the web bundle (no redrawn marks).
  const strays = walk(WEB).filter((file) => file.endsWith('.svg') && !file.startsWith(BRAND));
  assert.deepEqual(strays, []);
  // Lockups the shell and sign-in pages rely on.
  for (const name of ['Atlas_Primary_Horizontal_Midnight.svg', 'Atlas_Primary_Horizontal_White.svg', 'Atlas_Primary_Stacked_Midnight.svg', 'Atlas_Mark_Midnight.svg', 'Atlas_Mark_White.svg', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'favicon-192x192.png', 'favicon-512x512.png']) {
    assert.ok(existsSync(path.join(BRAND, name)), `${name} is shipped`);
  }
});

test('pages use the kit logos, favicons and manifest; no typed wordmark or "A" tile remains', () => {
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  for (const pattern of [
    /<link rel="icon" href="assets\/brand\/favicon\.ico"/,
    /<link rel="icon" type="image\/svg\+xml" href="assets\/brand\/favicon\.svg">/,
    /<link rel="apple-touch-icon" sizes="180x180" href="assets\/brand\/apple-touch-icon\.png">/,
    /<link rel="manifest" href="site\.webmanifest">/,
    /class="atlas-brand__lockup" src="assets\/brand\/Atlas_Primary_Horizontal_Midnight\.svg" alt="Atlas"/,
    /class="atlas-brand__mark" src="assets\/brand\/Atlas_Mark_Midnight\.svg" alt="Atlas"/,
    /class="atlas-topbar__mark"[^>]*><img src="assets\/brand\/Atlas_Mark_Midnight\.svg"/,
    /class="atlas-auth__lockup" src="assets\/brand\/Atlas_Primary_Stacked_Midnight\.svg" alt="Atlas"/
  ]) assert.match(index, pattern);
  for (const page of ['invitation.html', 'recovery.html']) {
    const html = readFileSync(path.join(WEB, page), 'utf8');
    assert.match(html, /class="atlas-auth__lockup" src="assets\/brand\/Atlas_Primary_Stacked_Midnight\.svg" alt="Atlas"/, page);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="assets\/brand\/favicon\.svg">/, page);
  }
  // menu.html is the venue's public menu: its own brand, no Atlas favicon.
  assert.doesNotMatch(readFileSync(path.join(WEB, 'menu.html'), 'utf8'), /assets\/brand\//);
  for (const file of walk(WEB).filter((name) => /\.(html|js|css)$/.test(name))) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /atlas-icon\.png|assets\/logo\//, `${file} still references the retired icon`);
    assert.doesNotMatch(text, /atlas-brand__mark" aria-hidden="true">A<|atlas-auth__wordmark|atlas-brand__name/, `${file} types the brand instead of using the kit files`);
  }
  assert.equal(existsSync(path.join(WEB, 'atlas-icon.png')), false);
  assert.equal(existsSync(path.join(WEB, 'assets/logo')), false);

  const site = JSON.parse(readFileSync(path.join(WEB, 'site.webmanifest'), 'utf8'));
  assert.equal(site.name, 'Atlas');
  assert.equal(site.theme_color, '#0B0F14');
  assert.equal(site.background_color, '#F8FAFC');
  assert.equal(site.display, 'standalone');
  assert.equal(site.start_url, './');
  for (const icon of site.icons) assert.ok(existsSync(path.join(WEB, icon.src)), icon.src);
});

test('the sign-in motion is the owner-approved clip only, on the sign-in screen only', () => {
  // Owner-approved exception to guideline rule 05 (docs/brand/README.md): one
  // motion asset, sign-in only. Source kept byte-exact; web encodes pinned.
  assert.equal(sha256('docs/brand/motion/Atlas_Logo_Rotation_source.mp4'), 'b3279e9de8e04c1d74cb750b19f42641e781496f3095936eb2e49e70b5b307dc');
  assert.deepEqual(readdirSync(path.join(BRAND, 'motion')).sort(), ['atlas-signin-intro.mp4', 'atlas-signin-intro.webm']);
  assert.equal(sha256(path.join(BRAND, 'motion/atlas-signin-intro.mp4')), 'a72029a8ba157c0c0b9f2d5e89f3ab5f9b3e5cc7cdaefbda1f13aa668b6b3fd0');
  assert.equal(sha256(path.join(BRAND, 'motion/atlas-signin-intro.webm')), '4422c8c674914aa4fc33e3e75a390666f53fe19b9b81a18dcf7e1b9b2b8b850b');
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const videos = [...index.matchAll(/<video\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(videos.length, 1, 'one video, the sign-in intro');
  for (const attribute of ['muted', 'playsinline', 'disablepictureinpicture', 'aria-hidden="true"', 'preload="none"']) assert.ok(videos[0].includes(attribute), attribute);
  for (const forbidden of ['loop', 'controls', 'autoplay']) assert.ok(!new RegExp(`\\s${forbidden}\\b`).test(videos[0]), `${forbidden} is not set in markup (the script decides)`);
  assert.match(index, /<div id="login-screen"[\s\S]*data-atlas-signin-intro[\s\S]*<div id="app-screen">/, 'the intro sits inside the sign-in screen');
  for (const page of ['invitation.html', 'recovery.html', 'menu.html']) assert.doesNotMatch(readFileSync(path.join(WEB, page), 'utf8'), /<video|brand\/motion/, page);
  // The service worker never caches the clip (it has no fetch handler at all).
  const worker = readFileSync(path.join(WEB, 'service-worker.js'), 'utf8');
  assert.doesNotMatch(worker, /addEventListener\('fetch'|caches\.|brand\/motion/);
  const script = readFileSync(path.join(WEB, 'assets/js/atlas-signin-intro.js'), 'utf8');
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.match(script, /atlas-reduce-motion/);
  assert.match(script, /saveData/);
  assert.match(script, /sessionStorage/);
  assert.doesNotMatch(script, /\.loop = true/);
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

test('tokens carry the kit palette verbatim', () => {
  const token = tokens();
  const kit = readFileSync(path.join(KIT, '07_Developer/atlas-brand-tokens.css'), 'utf8');
  for (const [, name, value] of kit.matchAll(/(--atlas-[a-z]+):\s*(#[0-9A-Fa-f]{6});/g)) assert.equal(token(name), value.toLowerCase(), name);
  assert.equal(token('--text'), '#0b0f14');
  assert.equal(token('--bg-subtle'), '#f8fafc');
  assert.equal(token('--line-strong'), '#cbd5e1');
  assert.equal(token('--accent-brand'), '#3b82f6');
  assert.equal(token('--accent'), '#2563eb');
  assert.equal(token('--accent-hover'), '#1d4ed8');
  assert.equal(token('--focus-color'), '#3b82f6');
  // Legacy names still resolve to the new system.
  for (const [legacy, modern] of [['--atlas-accent', '--accent'], ['--atlas-text', '--text'], ['--atlas-muted', '--text-2'], ['--atlas-line', '--line'], ['--s38-blue', '--accent'], ['--color-primary', '--accent'], ['--atlas-sidebar', '--bg-subtle'], ['--atlas-danger', '--danger']]) {
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
  const nonText = [
    ['--focus-color', ['--bg', '--bg-subtle', '--bg-muted', '--surface', '--accent-soft', '--ink']],
    ['--accent-brand', ['--bg', '--bg-subtle', '--bg-muted']],
    ['--warning-icon', ['--bg']]
  ];
  for (const [fg, backgrounds] of nonText) {
    for (const bg of backgrounds) {
      const ratio = contrast(token(fg), token(bg));
      if (ratio < 3) failures.push(`${fg} against ${bg}: ${ratio.toFixed(2)}:1 (needs 3:1)`);
    }
  }
  assert.deepEqual(failures, []);
  // The documented reason --accent is not Atlas Blue: white on #3B82F6 fails AA.
  assert.ok(contrast('#ffffff', token('--accent-brand')) < 4.5);
});
