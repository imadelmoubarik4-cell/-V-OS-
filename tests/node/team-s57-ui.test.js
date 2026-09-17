import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync('apps/web/index.html', 'utf8');
const css = readFileSync('apps/web/assets/css/team-s57.css', 'utf8');
const messages = readFileSync('apps/web/assets/js/team-messages.js', 'utf8');

test('conversation Pin is a compact named icon action', () => {
  assert.match(messages, /data-team-star[^>]*aria-pressed=/);
  assert.match(messages, /aria-label="\$\{channel\?\.starred \? 'Unpin' : 'Pin'\}/);
  assert.match(css, /\[data-team-star\]\{[^}]*width:34px!important;[^}]*height:34px!important/);
  assert.match(css, /\[data-team-star\]>span\{[^}]*position:absolute!important;[^}]*clip:rect\(0,0,0,0\)!important/);
});

test('narrow message history owns scrolling and composer remains visible', () => {
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /\.team-conversation-panel\{[^}]*height:clamp\(500px,72dvh,720px\)!important;[^}]*overflow:hidden!important/);
  assert.match(css, /\.team-message-list\{[^}]*flex:1 1 auto!important;[^}]*min-height:0!important;[^}]*overflow-y:auto!important/);
  assert.match(css, /\.team-composer\{[^}]*position:relative!important;[^}]*padding-bottom:max\(12px,env\(safe-area-inset-bottom\)\)!important/);
  assert.match(css, /body\.s38-team-active \.fab-wrap\{display:none!important\}/);
});

test('S57 overrides load after the prior Team remediation', () => {
  assert.match(index, /assets\/css\/team-s57\.css\?v=20260917-s57/);
  assert.ok(index.indexOf('assets/css/team-s57.css') > index.indexOf('assets/css/s38-app-remediation.css'));
});
