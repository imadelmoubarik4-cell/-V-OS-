import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legacyCss, linkPosition, layerOf } from './helpers/legacy-css.js';

const index = readFileSync('apps/web/index.html', 'utf8');
const css = legacyCss('team-s57');
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

test('S57 overrides load after the prior Team remediation, in the same cascade layer', () => {
  assert.match(index, /assets\/css\/legacy\/team-s57--team-messages\.css\?v=20260926-s88/);
  assert.ok(linkPosition('team-s57') > linkPosition('s38-app-remediation', 'last'));
  assert.equal(layerOf('legacy/team-s57--team-messages.css'), 'atlas.legacy');
  assert.equal(layerOf('legacy/s38-app-remediation--team-messages.css'), 'atlas.legacy');
});
