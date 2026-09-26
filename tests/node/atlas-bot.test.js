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
// clock: a fake time and timers (performance.now, setTimeout), advanced by
// bot.advance(ms); followers: elements the controller paints.
function loadBot({ webgl = true, gpu = true, followers = [] } = {}) {
  const listeners = [];
  const canvases = [];
  const clock = { t: 1000, timers: new Map(), next: 1 };
  const window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (...args) => listeners.push(args),
    navigator: {},
    devicePixelRatio: 1,
    performance: { now: () => clock.t },
    setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.set(id, { fn, at: clock.t + Math.max(0, ms) }); return id; },
    clearTimeout: (id) => { clock.timers.delete(id); }
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
  const documentListeners = {};
  const document = {
    baseURI: 'https://atlas.test/',
    hidden: false,
    addEventListener: (type, handler) => { (documentListeners[type] ||= []).push(handler); },
    documentElement: { classList: { contains: () => false } },
    createElement: element,
    querySelectorAll: (selector) => (selector === '[data-atlas-bot-follow]' ? followers : [])
  };
  vm.runInNewContext(read('apps/web/assets/js/atlas-bot.js'), { window, document, URL, CSS: { escape: String } });
  // Moves the fake clock on, firing timers in order.
  const advance = (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const due = [...clock.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > end) break;
      clock.t = due[1].at;
      clock.timers.delete(due[0]);
      due[1].fn();
    }
    clock.t = end;
  };
  const fire = (type, event = {}) => (documentListeners[type] || []).forEach((handler) => handler(event));
  return Object.assign(window.AtlasBot, { canvases, clock, advance, document, fire, listeners, documentListeners });
}
const follower = (attributes = {}) => ({ dataset: { state: 'idle' }, hasAttribute: (name) => name in attributes, querySelector: () => null });

const host = (key) => {
  const classes = new Set();
  return {
    dataset: { atlasBotLive: key, framing: 'full', state: 'idle' },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    appendChild() {},
    hasAttribute: () => false,
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 160, height: 160, left: 0, top: 0 }),
    isConnected: true,
    classes
  };
};

test('badge markup: escaped, sized within bounds, unknown states fall back to idle, decorative unless labelled', () => {
  const bot = loadBot();
  const plain = bot.html({ size: 18 });
  assert.match(plain, /^<span class="atlas-bot atlas-bot--small" data-atlas-bot data-state="idle" style="--atlas-bot-size:18px;--atlas-bot-delay:-[\d.]+s;--atlas-bot-clock:-[\d.]+s" aria-hidden="true"><\/span>$/);
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
  assert.match(source, /const SCENE = 'assets\/atlas-bot\/atlas-mascot-scene\.js\?v=20261004-bot5';/);
  assert.match(source, /const SPRITE = 'assets\/atlas-bot\/atlas-bot\.png\?v=20261004-bot5';/);
  assert.match(source, /const SPRITE_SMALL = 'assets\/atlas-bot\/atlas-bot-small\.png\?v=20261004-bot5';/);
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
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 160], 'four 160 px frames: open, blink, sleep, happy');
  assert.ok(png.length < 80 * 1024);
  const small = readFileSync('apps/web/assets/atlas-bot/atlas-bot-small.png');
  assert.equal(small.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual([small.readUInt32BE(16), small.readUInt32BE(20)], [384, 96], 'four 96 px frames: open, blink, sleep, happy');
  assert.ok(small.length < 40 * 1024);
  const source = read('scripts/mascot/atlas-mascot-scene.src.mjs');
  assert.match(source, /export const MARK_PATH = 'M133 8 L22 195/, 'the official A mark geometry');
});

test('the robot replaces the assistant icon in AI surfaces; the Atlas logo stays the brand mark', () => {
  assert.match(index, /<script src="assets\/js\/atlas-bot\.js\?v=20261004-bot5"><\/script>/);
  assert.ok(index.indexOf('assets/js/atlas-bot.js') < index.indexOf('assets/js/atlas-ai.js'));
  assert.match(index, /class="nav-item nav-item--ai"[^>]*><span class="atlas-bot atlas-bot--small atlas-bot--nav" data-atlas-bot data-atlas-bot-follow data-state="idle" aria-hidden="true">/);
  assert.match(index, /class="atlas-tabbar__item atlas-tabbar__item--ai"[^>]*><span class="atlas-bot atlas-bot--small atlas-bot--tab" data-atlas-bot data-atlas-bot-follow data-state="idle" aria-hidden="true">/);
  assert.doesNotMatch(index, /nav-item--ai"[^>]*><i data-lucide="sparkles"/);
  assert.match(index, /<img class="atlas-brand__lockup" src="assets\/brand\/Atlas_Primary_Horizontal_Midnight\.svg"/);
  assert.match(index, /<img class="atlas-brand__mark" src="assets\/brand\/Atlas_Mark_Midnight\.svg"/);

  const ai = read('apps/web/assets/js/atlas-ai.js');
  assert.match(ai, /liveHtml\(\{ key: 'ai-empty', framing: 'full', size: 176, follow: true \}\)/);
  assert.match(ai, /liveHtml\(\{ key: 'ai-voice', framing: 'bust'/);
  // The answer being written follows the assistant's state (thinking, then
  // answering); a finished one is still (idle, or error).
  assert.match(ai, /html\(streaming \? \{ size: 24, follow: true, className: 'ai-mark-bot' \} : \{ size: 24, state: message\.error \? 'error' : 'idle', className: 'ai-mark-bot' \}\)/);
  // atlas-ai.js reports what Atlas does to the one controller.
  for (const call of ["robotBot()?.set('thinking')", "robotBot()?.set('answering')", "robotBot()?.wake('composer')", "robotBot()?.wake('typing')", "robotBot()?.wake('new-conversation', { clear: true })", "robotBot()?.wake('voice')", "robotBot()?.set(liveBotState(next))", 'robotBot()?.active(true)', 'robotBot()?.active(false)', "robotBot()?.set('success')", "robotBot()?.set('error')"]) {
    assert.ok(ai.includes(call), call);
  }
  assert.match(ai, /robotBot\(\)\?\.set\(reply\.status === 'complete' \? \(reply\.proposals\.length \? 'attention' : 'success'\) : reply\.status === 'stopped' \? 'idle' : 'error'\)/);
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
  assert.match(home, /home-briefing__head">\$\{bot\}/);
  assert.match(home, /const bot = window\.AtlasBot \? window\.AtlasBot\.html\(\{ size: 18, state: preparing \? 'thinking' : 'idle' \}\) : icon\('atlas-bot'\);/);
  assert.match(home, /const preparing = !facts\.lines\.length && !dataLoaded\(\);/);
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
  assert.match(css, /url\('\.\.\/atlas-bot\/atlas-bot\.png\?v=20261004-bot5'\) 0 0 \/ 400% 100% no-repeat/);
  assert.match(css, /\.atlas-bot--small \{ background-image: url\('\.\.\/atlas-bot\/atlas-bot-small\.png\?v=20261004-bot5'\); \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.atlas-bot \{ animation: none; transition: none; \}\s*:is\(a, button\):hover > \.atlas-bot \{ transform: none; \}/);
  assert.match(read('apps/web/assets/css/atlas-shell.css'), /\.atlas-ai \.ai-empty:not\(\.ai-empty--off\):not\(:has\(\.atlas-bot-live\)\)::before/);
  // Robot refinement cache keys: every changed stylesheet and script.
  for (const asset of ['css/atlas-components.css', 'css/atlas-shell.css', 'css/atlas-ai.css']) assert.ok(index.includes(`href="assets/${asset}?v=20261004-bot5"`), asset);
  for (const asset of ['atlas-bot.js', 'atlas-ai.js', 'home.js']) assert.ok(index.includes(`src="assets/js/${asset}?v=20261004-bot5"`), asset);
  assert.match(read('apps/web/assets/css/atlas-shell.css'), /\.atlas-tabbar__item \.atlas-bot--tab::after \{ bottom: calc\(100% - var\(--atlas-bot-size\) \* \.7\); \}/, 'the tab robot keeps its ZZZ inside the tab bar');
});

// ---------------------------------------------------------------------------
// The one state controller (AtlasBot.robot), on a fake clock.
// ---------------------------------------------------------------------------

test('controller: one table of states; old names map to new ones; badges render every state', () => {
  const bot = loadBot();
  assert.deepEqual(Object.keys(bot.robot.table), ['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'success', 'attention', 'error']);
  assert.equal(bot.robot.table.awake.then, 'idle', 'awake is transient');
  assert.equal(bot.robot.table.success.then, 'idle', 'success is transient');
  assert.equal(bot.robot.table.success.moment, 'success');
  for (const state of ['listening', 'thinking', 'answering', 'attention', 'error', 'sleeping']) assert.equal(bot.robot.table[state].calm, undefined, `${state} never falls asleep`);
  for (const state of Object.keys(bot.robot.table)) assert.match(bot.html({ state }), new RegExp(`data-state="${state}"`));
  assert.match(bot.html({ state: 'speaking' }), /data-state="answering"/, 'speaking is answering');
  assert.match(bot.html({ state: 'happy' }), /data-state="happy"/);
  assert.equal(bot.robot.set('speaking'), 'answering');
  // A following badge or live robot shows the controller's state, whatever it is asked for.
  assert.match(bot.html({ follow: true, state: 'error' }), /data-atlas-bot-follow data-state="answering"/);
  assert.match(bot.liveHtml({ key: 'x', follow: true }), /data-state="answering" data-atlas-bot-follow/);
  assert.match(bot.liveHtml({ key: 'x' }), /<span class="atlas-bot-z" aria-hidden="true"><i>z<\/i><i>z<\/i><i>z<\/i><\/span><\/div>$/, 'one Z element per robot, decorative');
  assert.equal(bot.setRobotState('thinking'), 'thinking');
});

test('controller: idle falls asleep after the quiet spell (5 min, or 90 s while Atlas AI is open), on one timer', () => {
  const bot = loadBot();
  assert.equal(bot.robot.info().timers, 1, 'the quiet spell starts with the page');
  assert.equal(bot.robot.info().sleepAfter, 300000);
  bot.advance(299000);
  assert.equal(bot.robot.state, 'idle');
  bot.advance(2000);
  assert.equal(bot.robot.state, 'sleeping');
  assert.equal(bot.robot.info().timers, 0, 'no timer while asleep');
  // Opening Atlas AI wakes it; there the spell is 90 s.
  bot.robot.active(true);
  assert.equal(bot.robot.state, 'awake');
  assert.equal(bot.robot.info().sleepAfter, 90000);
  bot.advance(8100);
  assert.equal(bot.robot.state, 'idle', 'awake returns to idle by itself');
  bot.advance(90000 - 8100 - 1000);
  assert.equal(bot.robot.state, 'idle');
  bot.advance(2000);
  assert.equal(bot.robot.state, 'sleeping');
  // Test hook: shorter delays.
  bot.robot.setDelays({ active: 500, awake: 100 });
  bot.robot.wake('hover');
  bot.advance(120);
  assert.equal(bot.robot.state, 'idle');
  bot.advance(500);
  assert.equal(bot.robot.state, 'sleeping');
});

test('controller: never more than one timer, whatever happens; the hidden tab holds none', () => {
  const bot = loadBot();
  const seen = new Set();
  const check = () => { const { timers } = bot.robot.info(); seen.add(timers); assert.ok(timers <= 1, `timers ${timers}`); assert.ok(bot.clock.timers.size <= 1, `pending ${bot.clock.timers.size}`); };
  for (let round = 0; round < 30; round += 1) {
    bot.robot.active(round % 2 === 0); check();
    bot.robot.wake('composer'); check();
    bot.robot.wake('typing'); check();
    bot.robot.set(['thinking', 'answering', 'success', 'idle', 'attention', 'error', 'listening', 'awake'][round % 8]); check();
    bot.fire('pointerover', { target: null }); check();
    bot.document.hidden = round % 3 === 0; bot.fire('visibilitychange'); check();
    if (bot.document.hidden) assert.equal(bot.robot.info().timers, 0, 'no timer while the tab is hidden');
    bot.advance(round * 700); check();
  }
  bot.document.hidden = false;
  bot.fire('visibilitychange');
  bot.robot.set('idle');
  assert.equal(bot.robot.info().timers, 1);
  assert.ok(seen.has(0) && seen.has(1));
});

test('controller: wake triggers wake a sleeping or idle robot at once; typing only keeps it awake; busy states stay', () => {
  const followers = [follower({ 'data-atlas-bot-follow': '' })];
  const bot = loadBot({ followers });
  bot.robot.set('sleeping');
  assert.equal(followers[0].dataset.state, 'sleeping', 'following badges are painted');
  bot.robot.wake('hover');
  assert.equal(bot.robot.state, 'awake');
  assert.equal(followers[0].dataset.state, 'awake', 'the Z goes with the sleeping state at once');
  const steps = bot.robot.info().history.length;
  for (let key = 0; key < 25; key += 1) { bot.robot.wake('typing'); bot.advance(300); }
  assert.equal(bot.robot.state, 'awake', 'typing keeps it awake');
  assert.equal(bot.robot.info().history.length, steps, 'no new state (and no movement) per key');
  bot.robot.set('thinking');
  bot.robot.wake('hover');
  assert.equal(bot.robot.state, 'thinking', 'hover never interrupts thinking');
  bot.robot.set('error');
  bot.robot.wake('composer');
  assert.equal(bot.robot.state, 'error');
  bot.robot.wake('new-conversation', { clear: true });
  assert.equal(bot.robot.state, 'awake', 'a new conversation clears an error');
  bot.robot.set('attention');
  bot.robot.wake('new-conversation', { clear: true });
  assert.equal(bot.robot.state, 'awake');
});

test('controller: thinking → answering is one continuous state; success returns to idle; attention and error last', () => {
  const bot = loadBot();
  bot.robot.set('thinking');
  bot.advance(50);
  bot.robot.set('answering');
  const since = bot.robot.info().since;
  for (let piece = 0; piece < 40; piece += 1) { bot.advance(16); bot.robot.set('answering'); }
  assert.equal(bot.robot.info().since, since, 'streamed pieces never restart the state');
  bot.robot.set('success');
  assert.equal(bot.robot.state, 'success');
  bot.advance(1700);
  assert.equal(bot.robot.state, 'idle');
  const path = Array.from(bot.robot.info().history, (step) => step.to);
  assert.deepEqual(path.slice(-4), ['thinking', 'answering', 'success', 'idle']);
  bot.robot.set('attention');
  bot.advance(600000);
  assert.equal(bot.robot.state, 'attention', 'attention waits for the person');
  bot.robot.set('error');
  bot.advance(600000);
  assert.equal(bot.robot.state, 'error');
  bot.robot.set('idle');
  assert.equal(bot.robot.state, 'idle', 'thinking → error → idle');
});

test('controller: hovering or tapping an item that carries a following robot wakes it; other items do not', () => {
  const bot = loadBot();
  const badge = { hasAttribute: (name) => name === 'data-atlas-bot-follow' };
  const link = { hasAttribute: () => false, querySelector: (selector) => (selector === ':scope > [data-atlas-bot-follow]' ? badge : null) };
  const other = { hasAttribute: () => false, querySelector: () => null };
  const target = (node) => ({ closest: () => node });
  bot.robot.set('sleeping');
  bot.fire('pointerover', { target: target(other) });
  assert.equal(bot.robot.state, 'sleeping');
  bot.fire('pointerover', { target: target(link) });
  assert.equal(bot.robot.state, 'awake');
  bot.robot.set('sleeping');
  bot.fire('pointerdown', { target: target(badge) });
  assert.equal(bot.robot.state, 'awake', 'a tap wakes it');
});

test('the scene poses every state from the one pose system: sleep draws at 10 fps, the full robot is grounded by a soft shadow, no red', () => {
  const source = read('scripts/mascot/atlas-mascot-scene.src.mjs');
  assert.match(source, /export const BASE_STATES = Object\.freeze\(\['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error'\]\);/);
  assert.match(source, /export const MOMENTS = Object\.freeze\(\['greet', 'success', 'error', 'react', 'wake'\]\);/);
  assert.match(source, /const BASE_ALIASES = Object\.freeze\(\{ speaking: 'answering' \}\);/);
  for (const state of ['awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error']) assert.match(source, new RegExp(`case '${state}':`), state);
  assert.match(source, /if \(status\.base === 'sleeping'\) return 1000 \/ 10;/, 'sleeping draws at most 10 frames a second');
  assert.match(source, /if \(value === status\.base\) return;/, 'setting the same state again never restarts it');
  assert.match(source, /robot\.shadow\.visible = frame === frames\.full;/, 'the shadow grounds the full robot only (not the bust or badges)');
  // Pointer tracking keeps its signs (x right = look right, y down = look down).
  assert.match(source, /out\.headYaw = MathUtils\.clamp\(status\.pointer\.x \* 0\.5, -0\.5, 0\.5\);/);
  assert.match(source, /out\.headPitch = MathUtils\.clamp\(status\.pointer\.y \* 0\.25, -0\.22, 0\.22\);/);
  // No red anywhere in the robot's palette.
  assert.doesNotMatch(source, /#(?:f|e|d)[0-9a-f](?:[0-4][0-9a-f]){2}\b|0xff0000|'red'/i);
  const bundle = read('apps/web/assets/atlas-bot/atlas-mascot-scene.js');
  assert.match(bundle, /sleeping/);
  assert.match(bundle, /attention/);
  const render = read('scripts/render_atlas_bot_badges.mjs');
  assert.match(render, /sleep: \{ happy: 0, sleepy: 1/);
  const css = read('apps/web/assets/css/atlas-components.css');
  assert.match(css, /\.atlas-bot\[data-state="sleeping"\] \{ background-position: 66\.667% 0; animation: none;/);
  assert.match(css, /@keyframes atlas-bot-z-reveal/);
  for (const name of ['atlas-bot-z1', 'atlas-bot-z2', 'atlas-bot-z3']) assert.match(css, new RegExp(`@keyframes ${name} \\{`));
  assert.match(css, /html\.atlas-reduce-motion \.atlas-bot-live\[data-state\] > \.atlas-bot-z > i \{ animation: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.atlas-bot-live\[data-state\] > \.atlas-bot-z > i:nth-child\(n\) \{ animation: none; \}/);
  const ai = read('apps/web/assets/css/atlas-ai.css');
  assert.match(ai, /\.atlas-ai \.ai-empty__bot \{ margin-bottom: -18px; \}/, 'the robot sits close to the greeting');
  assert.match(ai, /\.atlas-ai \.ai-empty__bot \.atlas-bot-live \{ width: 176px; height: 176px; \}/, 'the approved size');
});
