// The Atlas AI robot (apps/web/assets/js/atlas-bot.js): the assistant's face
// in AI surfaces. The Atlas logo stays the brand mark; the robot replaces the
// sparkles assistant icon only.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => readFileSync(file, 'utf8');
const index = read('apps/web/index.html');

function loadBot() {
  const listeners = [];
  const window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (...args) => listeners.push(args),
    navigator: {},
    devicePixelRatio: 1
  };
  const document = {
    addEventListener: () => {},
    documentElement: { classList: { contains: () => false } },
    createElement: () => ({ getContext: () => null }),
    querySelectorAll: () => []
  };
  vm.runInNewContext(read('apps/web/assets/js/atlas-bot.js'), { window, document, URL, CSS: { escape: String } });
  return window.AtlasBot;
}

test('badge markup: escaped, sized within bounds, unknown states fall back to idle, decorative unless labelled', () => {
  const bot = loadBot();
  const plain = bot.html({ size: 18 });
  assert.match(plain, /^<span class="atlas-bot" data-atlas-bot data-state="idle" style="--atlas-bot-size:18px;--atlas-bot-delay:-[\d.]+s" aria-hidden="true"><\/span>$/);
  assert.match(bot.html({ size: 4 }), /--atlas-bot-size:12px/);
  assert.match(bot.html({ size: 900 }), /--atlas-bot-size:128px/);
  assert.match(bot.html({ state: 'thinking' }), /data-state="thinking"/);
  assert.match(bot.html({ state: '"><script>' }), /data-state="idle"/);
  const hostile = bot.html({ className: '"><img src=x onerror=alert(1)>', label: '<b>Atlas</b>' });
  assert.doesNotMatch(hostile, /<img|<b>/);
  assert.match(hostile, /role="img" aria-label="&lt;b&gt;Atlas&lt;\/b&gt;"/);
});

test('live placeholder carries the key, framing and state, with the badge as its poster', () => {
  const bot = loadBot();
  const markup = bot.liveHtml({ key: 'ai-empty', framing: 'full', size: 176 });
  assert.match(markup, /class="atlas-bot-live" data-atlas-bot-live="ai-empty" data-framing="full" data-state="idle" style="--atlas-bot-live-size:176px" role="img" aria-label="Atlas, your assistant"/);
  assert.match(markup, /class="atlas-bot atlas-bot-live__poster"/);
  assert.match(bot.liveHtml({ framing: 'weird' }), /data-framing="full"/);
  assert.match(bot.liveHtml({ framing: 'bust' }), /data-framing="bust"/);
});

test('the live robot is lazy, same-origin, paused off screen and when hidden, and keeps one WebGL context per key', () => {
  const source = read('apps/web/assets/js/atlas-bot.js');
  assert.match(source, /const SCENE = 'assets\/atlas-bot\/atlas-mascot-scene\.js\?v=20261003-bot1';/);
  assert.match(source, /import\(url\)/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /saveData/);
  assert.match(source, /atlas-reduce-motion/);
  assert.match(source, /host\.appendChild\(entry\.canvas\)/, 'a re-render moves the existing canvas');
  assert.match(source, /forceContextLoss|dispose\(\)/);
});

test('the scene bundle and sprite are built from the reviewed sources', () => {
  const bundle = read('apps/web/assets/atlas-bot/atlas-mascot-scene.js');
  assert.match(bundle, /^\/\* Atlas AI mascot scene, built by scripts\/build_atlas_mascot\.mjs from scripts\/mascot\/atlas-mascot-scene\.src\.mjs with three@0\.186\.1 \(MIT/);
  assert.ok(statSync('apps/web/assets/atlas-bot/atlas-mascot-scene.js').size < 700 * 1024, 'scene bundle stays under 700 KiB');
  const png = readFileSync('apps/web/assets/atlas-bot/atlas-bot.png');
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [480, 160], 'three 160 px frames: open, blink, happy');
  assert.ok(png.length < 80 * 1024);
  const source = read('scripts/mascot/atlas-mascot-scene.src.mjs');
  assert.match(source, /export const MARK_PATH = 'M133 8 L22 195/, 'the official A mark geometry');
});

test('the robot replaces the assistant icon in AI surfaces; the Atlas logo stays the brand mark', () => {
  assert.match(index, /<script src="assets\/js\/atlas-bot\.js\?v=20261003-bot1"><\/script>/);
  assert.ok(index.indexOf('assets/js/atlas-bot.js') < index.indexOf('assets/js/atlas-ai.js'));
  assert.match(index, /class="nav-item nav-item--ai"[^>]*><span class="atlas-bot atlas-bot--nav"/);
  assert.match(index, /class="atlas-tabbar__item atlas-tabbar__item--ai"[^>]*><span class="atlas-bot atlas-bot--tab"/);
  assert.doesNotMatch(index, /nav-item--ai"[^>]*><i data-lucide="sparkles"/);
  assert.match(index, /<img class="atlas-brand__lockup" src="assets\/brand\/Atlas_Primary_Horizontal_Midnight\.svg"/);
  assert.match(index, /<img class="atlas-brand__mark" src="assets\/brand\/Atlas_Mark_Midnight\.svg"/);

  const ai = read('apps/web/assets/js/atlas-ai.js');
  assert.match(ai, /liveHtml\(\{ key: 'ai-empty', framing: 'full', size: 176 \}\)/);
  assert.match(ai, /liveHtml\(\{ key: 'ai-voice', framing: 'bust'/);
  assert.match(ai, /state: streaming \? 'thinking' : message\.error \? 'error' : 'idle'/);
  assert.match(ai, /id: 'ai\.ask', label: 'Ask Atlas', icon: 'atlas-bot'/);
  // Live voice: the robot mirrors the call.
  const mapping = ai.match(/function liveBotState\(status\) \{[\s\S]*?\n  \}/)[0];
  const liveBotState = vm.runInNewContext(`(${mapping.replace('function liveBotState', 'function')})`);
  assert.deepEqual(['listening', 'interrupted', 'thinking', 'speaking', 'error', 'disconnected', 'replaced', 'connecting', 'muted'].map(liveBotState),
    ['listening', 'listening', 'thinking', 'speaking', 'error', 'error', 'error', 'idle', 'idle']);

  for (const [file, pattern] of [
    ['apps/web/assets/js/atlas-chrome.js', /if \(name === 'atlas-bot' && window\.AtlasBot\)/],
    ['apps/web/assets/js/atlas-palette.js', /id: 'ask', kind: 'ask', icon: 'atlas-bot'/],
    ['apps/web/assets/js/home.js', /home-briefing__head">\$\{icon\('atlas-bot'\)\}/],
    ['apps/web/assets/js/atlas-inventory.js', /\['ask', 'atlas-bot', 'Ask Atlas about this'\]/],
    ['apps/web/assets/js/knowledge-workspace.js', /data-knowledge-ask>\$\{icon\('atlas-bot'\)\}Ask Atlas about this/],
    ['apps/web/assets/js/marketing-workspace.js', /label: 'Ask Atlas', icon: 'atlas-bot'/],
    ['apps/web/assets/js/recipes.js', /id: 'recipes\.ask', label: 'Ask Atlas about this recipe', icon: 'atlas-bot'/],
    ['apps/web/assets/js/reports-workspace.js', /id: 'reports\.ask', label: 'Ask Atlas about this report', icon: 'atlas-bot'/],
    ['apps/web/assets/js/team-messages.js', /className: 'msg-avatar msg-avatar--bot'/]
  ]) assert.match(read(file), pattern, file);
  // Not an assistant symbol: record types and the cocktail category keep their icons.
  assert.match(ai, /brain_recommendation: \{ icon: 'sparkles', label: 'Decision'/);
  assert.match(read('apps/web/assets/js/recipes.js'), /slug: 'signature-cocktail', name: 'Signature Cocktails', icon: 'sparkles'/);
});

test('robot styles live in the components layer and honour reduced motion', () => {
  const css = read('apps/web/assets/css/atlas-components.css');
  const layer = css.slice(css.indexOf('@layer atlas.components {'));
  assert.ok(layer.includes('.atlas-bot {'), 'inside @layer atlas.components');
  assert.match(css, /html\.atlas-reduce-motion \.atlas-bot \{ animation: none; transition: none; \}/);
  assert.match(css, /url\('\.\.\/atlas-bot\/atlas-bot\.png\?v=20261003-bot1'\)/);
  assert.match(read('apps/web/assets/css/atlas-shell.css'), /\.atlas-ai \.ai-empty:not\(\.ai-empty--off\):not\(:has\(\.atlas-bot-live\)\)::before/);
});
