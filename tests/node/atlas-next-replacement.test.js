import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const html = readFileSync('apps/web/next.html', 'utf8');
const css = readFileSync('apps/web/assets/css/atlas-next.css', 'utf8');
const app = readFileSync('apps/web/assets/js/atlas-next.js', 'utf8');
const combined = `${html}\n${css}\n${app}`;

test('replacement route has one authentication screen and one application shell', () => {
  assert.equal((html.match(/id="auth-screen"/g) || []).length, 1);
  assert.equal((html.match(/id="app-shell"/g) || []).length, 1);
  assert.equal((html.match(/id="atlas-boot"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="login-screen"/);
  assert.doesNotMatch(html, /phase4-shell\.js|phase4-operations\.js/);
});

test('boot always has bounded session and data requests', () => {
  assert.match(app, /bootTimeoutMs:\s*15000/);
  assert.match(app, /requestTimeoutMs:\s*12000/);
  assert.match(app, /withTimeout\(/);
  assert.match(app, /finally\s*\{\s*state\.bootFinished\s*=\s*true/);
  assert.match(app, /showAuth\(/);
});

test('replacement runtime has no mutation observer or polling renderer', () => {
  assert.doesNotMatch(app, /MutationObserver/);
  assert.doesNotMatch(app, /setInterval\s*\(/);
  assert.doesNotMatch(app, /requestAnimationFrame\([^)]*reorganize/i);
});

test('initial replacement is read-only outside authentication', () => {
  assert.match(app, /\.from\('profiles'\)\.select/);
  assert.match(app, /\.from\('inventory_items'\)\.select/);
  for (const forbidden of [/\.insert\s*\(/, /\.update\s*\(/, /\.delete\s*\(/, /\.upsert\s*\(/, /\.rpc\s*\(/, /adjust_inventory/]) {
    assert.doesNotMatch(app, forbidden);
  }
});

test('Claude design runtime and private credentials are absent', () => {
  for (const forbidden of [/<x-dc/i, /support\.js/i, /Babel\.transform/, /ReactDOM/, /new Function\s*\(/, /SUPABASE_SERVICE_ROLE_KEY/, /service_role/i]) {
    assert.doesNotMatch(combined, forbidden);
  }
});

test('approved design system and responsive states are present', () => {
  assert.match(css, /--atlas-bg:\s*#f6f6f4/);
  assert.match(css, /--atlas-accent:\s*#1fa8a0/);
  assert.match(css, /html\[data-atlas-theme="dark"\]/);
  assert.match(css, /--atlas-bg:\s*#111113/);
  assert.match(css, /--atlas-accent:\s*#3fc7be/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});

test('normal inventory view exposes no quantity editor', () => {
  assert.doesNotMatch(html, /qty-input|step-btn|data-line-step/);
  assert.match(html, /Controlled inventory boundary/);
  assert.match(app, /No stock change was performed/);
});
