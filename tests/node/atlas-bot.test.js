// The Atlas AI robot (apps/web/assets/js/atlas-bot.js): the assistant's face
// in AI surfaces. The Atlas logo stays the brand mark; the robot replaces the
// sparkles assistant icon only.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => readFileSync(file, 'utf8');
const index = read('apps/web/index.html');

// A minimal DOM: canvases record the WebGL contexts asked of them. gpu: false
// is WebGL in software (a context only without failIfMajorPerformanceCaveat).
function loadBot({ webgl = true, gpu = true } = {}) {
  const listeners = [];
  const canvases = [];
  const window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (...args) => listeners.push(args),
    navigator: {},
    devicePixelRatio: 1
  };
  const element = () => {
    const canvas = {
      contexts: [], lost: 0, handlers: {}, attributes: {},
      getContext(type, options) {
        this.contexts.push(type);
        if (!webgl || !String(type).startsWith('webgl')) return null;
        if (!gpu && options?.failIfMajorPerformanceCaveat) return null;
        return { getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => { canvas.lost += 1; } } : null) };
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      remove() {}
    };
    canvases.push(canvas);
    return canvas;
  };
  const document = {
    baseURI: 'https://atlas.test/',
    addEventListener: () => {},
    documentElement: { classList: { contains: () => false } },
    createElement: element,
    querySelectorAll: () => []
  };
  vm.runInNewContext(read('apps/web/assets/js/atlas-bot.js'), { window, document, URL, CSS: { escape: String } });
  return Object.assign(window.AtlasBot, { canvases });
}

const host = (key) => {
  const classes = new Set();
  return {
    dataset: { atlasBotLive: key, framing: 'full', state: 'idle' },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    appendChild() {},
    getBoundingClientRect: () => ({ width: 160, height: 160, left: 0, top: 0 }),
    isConnected: true,
    classes
  };
};

test('badge markup: escaped, sized within bounds, unknown states fall back to idle, decorative unless labelled', () => {
  const bot = loadBot();
  const plain = bot.html({ size: 18 });
  assert.match(plain, /^<span class="atlas-bot atlas-bot--small" data-atlas-bot data-state="idle" style="--atlas-bot-size:18px;--atlas-bot-delay:-[\d.]+s" aria-hidden="true"><\/span>$/);
  assert.match(bot.html({ size: 4 }), /--atlas-bot-size:12px/);
  assert.match(bot.html({ size: 900 }), /--atlas-bot-size:128px/);
  // 24 px or less: the small sprite (tighter face, matte visor, larger eyes).
  assert.match(bot.html({ size: 24 }), /class="atlas-bot atlas-bot--small"/);
  assert.match(bot.html({ size: 28 }), /class="atlas-bot" /);
  assert.match(bot.html({ size: 20, className: 'x' }), /class="atlas-bot atlas-bot--small x"/);
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
  assert.match(markup, /class="atlas-bot atlas-bot-live__poster"/, 'the 176 px robot poster uses the large sprite');
  assert.match(bot.liveHtml({ framing: 'weird' }), /data-framing="full"/);
  assert.match(bot.liveHtml({ framing: 'bust' }), /data-framing="bust"/);
});

test('the live robot is lazy, same-origin, paused off screen and when hidden, and keeps one WebGL context per key', () => {
  const source = read('apps/web/assets/js/atlas-bot.js');
  assert.match(source, /const SCENE = 'assets\/atlas-bot\/atlas-mascot-scene\.js\?v=20261003-bot4';/);
  assert.match(source, /const SPRITE = 'assets\/atlas-bot\/atlas-bot\.png\?v=20261003-bot3';/);
  assert.match(source, /const SPRITE_SMALL = 'assets\/atlas-bot\/atlas-bot-small\.png\?v=20261003-bot3';/);
  assert.match(source, /import\(url\)/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /saveData/);
  assert.match(source, /atlas-reduce-motion/);
  assert.match(source, /host\.appendChild\(entry\.canvas\)/, 'a re-render moves the existing canvas');
  assert.match(source, /forceContextLoss|dispose\(\)/);
  assert.match(source, /webglcontextlost/);
  assert.match(source, /webglcontextrestored/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /live\.get\(entry\.key\) !== entry/, 'a robot destroyed while the scene loads opens no context');
  assert.match(source, /setReducedMotion\(motionReduced\)/);
  assert.match(source, /failIfMajorPerformanceCaveat: true/, 'WebGL in software keeps the poster');
  assert.match(source, /requestIdleCallback/, 'the scene is built in a task of its own');
  assert.match(source, /MutationObserver/);
});

test('WebGL is probed once per page and the probe context is released, however many hosts mount', () => {
  const bot = loadBot();
  for (let index = 0; index < 40; index += 1) {
    const scope = { querySelectorAll: () => [host(`k${index % 3}`), host(`n${index}`)] };
    bot.upgrade(scope);
  }
  const probes = bot.canvases.filter((canvas) => canvas.contexts.length);
  assert.equal(probes.length, 1, 'one probe canvas');
  assert.deepEqual(probes[0].contexts, ['webgl2']);
  assert.equal(probes[0].lost, 1, 'the probe context is released (WEBGL_lose_context)');
  const robots = bot.canvases.filter((canvas) => canvas.attributes['aria-hidden'] === 'true');
  assert.ok(robots.length >= 43, 'robots made their canvases');
  assert.ok(robots.every((canvas) => typeof canvas.handlers.webglcontextlost === 'function' && typeof canvas.handlers.webglcontextrestored === 'function'), 'every robot canvas handles context loss');
});

test('without WebGL every placeholder keeps its poster, still with one probe', () => {
  const bot = loadBot({ webgl: false });
  const hosts = [host('a'), host('b'), host('c')];
  bot.upgrade({ querySelectorAll: () => hosts });
  assert.ok(hosts.every((node) => node.classes.has('is-static')));
  assert.equal(bot.canvases.length, 2, 'a GPU probe, then any WebGL');
  assert.deepEqual(bot.canvases.map((canvas) => canvas.contexts), [['webgl2', 'webgl'], ['webgl2', 'webgl']]);
  assert.equal(bot.info('a'), null);
});

test('WebGL in software (no GPU): probed once, and the poster stays (no scene, no robot context)', () => {
  const bot = loadBot({ gpu: false });
  const hosts = Array.from({ length: 5 }, () => host('soft'));
  hosts.forEach((node) => bot.upgrade({ querySelectorAll: () => [node] }));
  assert.equal(bot.canvases.length, 2, 'the GPU probe and the software probe, nothing else');
  assert.equal(bot.canvases[1].lost, 1, 'the software probe context is released');
  assert.equal(bot.software(), true);
  assert.ok(hosts.every((node) => node.classes.has('is-static')));
  assert.equal(bot.info('soft'), null);
  // Browser tests (SwiftShader) turn the live robot on.
  bot.animateInSoftware(true);
  bot.upgrade({ querySelectorAll: () => [host('soft')] });
  assert.notEqual(bot.info('soft'), null);
  assert.equal(loadBot().software(), false);
});

test('the scene takes reduced motion live and has a small look for badges', () => {
  const source = read('scripts/mascot/atlas-mascot-scene.src.mjs');
  assert.match(source, /setReducedMotion\(value\) \{/);
  assert.match(source, /let reducedMotion = Boolean\(reduced\);/);
  assert.match(source, /'badge-small': \{/);
  assert.match(source, /export const EYE_SCALE = Object\.freeze\(\{ normal: 1, small: 1\.5 \}\);/);
  assert.match(source, /dispose\(\{ loseContext = true \} = \{\}\)/);
  const bundle = read('apps/web/assets/atlas-bot/atlas-mascot-scene.js');
  assert.match(bundle, /setReducedMotion/, 'the bundle is rebuilt from this source');
  assert.match(bundle, /badge-small/);
  const render = read('scripts/render_atlas_bot_badges.mjs');
  assert.match(render, /file: 'atlas-bot-small\.png', size: 96, framing: 'badge-small', look: 'small'/);
});

test('the scene bundle and sprite are built from the reviewed sources', () => {
  const bundle = read('apps/web/assets/atlas-bot/atlas-mascot-scene.js');
  assert.match(bundle, /^\/\* Atlas AI mascot scene, built by scripts\/build_atlas_mascot\.mjs from scripts\/mascot\/atlas-mascot-scene\.src\.mjs with three@0\.186\.1 \(MIT/);
  assert.ok(statSync('apps/web/assets/atlas-bot/atlas-mascot-scene.js').size < 700 * 1024, 'scene bundle stays under 700 KiB');
  const png = readFileSync('apps/web/assets/atlas-bot/atlas-bot.png');
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [480, 160], 'three 160 px frames: open, blink, happy');
  assert.ok(png.length < 80 * 1024);
  const small = readFileSync('apps/web/assets/atlas-bot/atlas-bot-small.png');
  assert.equal(small.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual([small.readUInt32BE(16), small.readUInt32BE(20)], [288, 96], 'three 96 px frames: open, blink, happy');
  assert.ok(small.length < 40 * 1024);
  const source = read('scripts/mascot/atlas-mascot-scene.src.mjs');
  assert.match(source, /export const MARK_PATH = 'M133 8 L22 195/, 'the official A mark geometry');
});

test('the robot replaces the assistant icon in AI surfaces; the Atlas logo stays the brand mark', () => {
  assert.match(index, /<script src="assets\/js\/atlas-bot\.js\?v=20261003-bot4"><\/script>/);
  assert.ok(index.indexOf('assets/js/atlas-bot.js') < index.indexOf('assets/js/atlas-ai.js'));
  assert.match(index, /class="nav-item nav-item--ai"[^>]*><span class="atlas-bot atlas-bot--small atlas-bot--nav"/);
  assert.match(index, /class="atlas-tabbar__item atlas-tabbar__item--ai"[^>]*><span class="atlas-bot atlas-bot--small atlas-bot--tab"/);
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
    ['apps/web/assets/js/atlas-inventory.js', /\['ask', 'atlas-bot', 'Ask Atlas about this'\]/],
    ['apps/web/assets/js/knowledge-workspace.js', /data-knowledge-ask>\$\{icon\('atlas-bot'\)\}Ask Atlas about this/],
    ['apps/web/assets/js/marketing-workspace.js', /label: 'Ask Atlas', icon: 'atlas-bot'/],
    ['apps/web/assets/js/recipes.js', /id: 'recipes\.ask', label: 'Ask Atlas about this recipe', icon: 'atlas-bot'/],
    ['apps/web/assets/js/reports-workspace.js', /id: 'reports\.ask', label: 'Ask Atlas about this report', icon: 'atlas-bot'/],
  ]) assert.match(read(file), pattern, file);
  // The Home daily briefing is Atlas speaking to the team: it carries the robot.
  // Not the assistant speaking: the offline quick answer (Atlas AI is off) and
  // Team Messages system notices (the Atlas platform) keep their previous icons.
  const palette = read('apps/web/assets/js/atlas-palette.js');
  assert.match(palette, /\$\{icon\('sparkles', \{ size: 14 \}\)\}Quick answer · Atlas AI is off/);
  const home = read('apps/web/assets/js/home.js');
  assert.match(home, /home-briefing__head">\$\{icon\('atlas-bot'\)\}/);
  assert.match(home, /name === 'atlas-bot' && window\.AtlasBot\) return window\.AtlasBot\.html\(\{ size: 18 \}\)/);
  const team = read('apps/web/assets/js/team-messages.js');
  assert.match(team, /system \? `<span class="atlas-avatar msg-avatar msg-avatar--atlas" aria-hidden="true">\$\{icon\('sparkles'\)\}<\/span>`/);
  assert.doesNotMatch(team, /AtlasBot|atlas-bot|msg-avatar--bot/, 'no assistant speaks in Team Messages');
  // Not an assistant symbol: record types and the cocktail category keep their icons.
  assert.match(ai, /brain_recommendation: \{ icon: 'sparkles', label: 'Decision'/);
  assert.match(read('apps/web/assets/js/recipes.js'), /slug: 'signature-cocktail', name: 'Signature Cocktails', icon: 'sparkles'/);
});

test('robot styles live in the components layer and honour reduced motion', () => {
  const css = read('apps/web/assets/css/atlas-components.css');
  const layer = css.slice(css.indexOf('@layer atlas.components {'));
  assert.ok(layer.includes('.atlas-bot {'), 'inside @layer atlas.components');
  assert.match(css, /html\.atlas-reduce-motion \.atlas-bot \{ animation: none; transition: none; \}/);
  assert.match(css, /url\('\.\.\/atlas-bot\/atlas-bot\.png\?v=20261003-bot3'\)/);
  assert.match(css, /\.atlas-bot--small \{ background-image: url\('\.\.\/atlas-bot\/atlas-bot-small\.png\?v=20261003-bot3'\); \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.atlas-bot \{ animation: none; transition: none; \}\s*:is\(a, button\):hover > \.atlas-bot \{ transform: none; \}/);
  assert.match(read('apps/web/assets/css/atlas-shell.css'), /\.atlas-ai \.ai-empty:not\(\.ai-empty--off\):not\(:has\(\.atlas-bot-live\)\)::before/);
});
