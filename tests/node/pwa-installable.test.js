// PWA Tier 1: Alcedo installs to the home screen and works offline. The service
// worker precaches the app shell and serves it offline; pwa.js registers the
// worker on every load and offers an install affordance; the manifest and head
// metas make the install full-screen and themed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WEB = 'apps/web';
const read = (rel) => readFileSync(`${WEB}/${rel}`, 'utf8');

test('service worker precaches the app shell and serves it offline, keeping push', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /const CACHE = 'alcedo-shell-v\d+';/);
  for (const shell of ["'./'", "'./index.html'", "'./config.js'", "'./site.webmanifest'"]) {
    assert.ok(worker.includes(shell), `precache ${shell}`);
  }
  assert.match(worker, /addEventListener\('install'/);
  assert.match(worker, /addEventListener\('activate'/);
  assert.match(worker, /addEventListener\('fetch'/);
  assert.match(worker, /caches\.open\(CACHE\)/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /self\.clients\.claim\(\)/);
  // Same-origin only: the Supabase API is never cached.
  assert.match(worker, /if \(url\.origin !== self\.location\.origin\) return;/);
  // Navigations are network-first with the cached shell as the offline fallback.
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /cache\.match\('\.\/index\.html'\)/);
  // Push + notification routing survive.
  assert.match(worker, /addEventListener\('push'/);
  assert.match(worker, /addEventListener\('notificationclick'/);
});

test('pwa.js registers the worker on load and offers install / add-to-home', () => {
  const pwa = read('assets/js/pwa.js');
  assert.match(pwa, /window\.addEventListener\('load'/);
  assert.match(pwa, /navigator\.serviceWorker\.register\('service-worker\.js', \{ scope: '\.\/' \}\)/);
  assert.match(pwa, /addEventListener\('beforeinstallprompt'/);
  assert.match(pwa, /deferredPrompt\.prompt\(\)/);
  assert.match(pwa, /addEventListener\('appinstalled'/);
  assert.match(pwa, /iphone\|ipad\|ipod/);
  assert.match(pwa, /display-mode: standalone/);
  // Remembers a dismissal so it never nags.
  assert.match(pwa, /alcedo\.pwa\.installDismissed/);
});

test('index.html loads pwa.js and carries the PWA head metadata', () => {
  const index = read('index.html');
  assert.match(index, /<script src="assets\/js\/pwa\.js\?v=20261002-pwa1"><\/script>/);
  assert.match(index, /<link rel="manifest" href="site\.webmanifest">/);
  assert.match(index, /<meta name="theme-color" content="#08495C">/);
  assert.match(index, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(index, /<meta name="apple-mobile-web-app-title" content="Alcedo">/);
});

test('manifest is installable (standalone) with a maskable icon', () => {
  const manifest = JSON.parse(read('site.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => /\b512x512\b/.test(icon.sizes) && !icon.purpose), 'a plain 512 icon');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'a maskable icon');
});

test('the install prompt meets the 44 px touch target and sits off-screen in tests', () => {
  const css = read('assets/css/atlas-components.css');
  assert.match(css, /\.pwa-install \{[^}]*position: fixed;/);
  assert.match(css, /\.pwa-install__action \{[^}]*min-height: 44px;/);
  assert.match(css, /\.pwa-install__close \{[^}]*width: 44px; height: 44px;/);
});
