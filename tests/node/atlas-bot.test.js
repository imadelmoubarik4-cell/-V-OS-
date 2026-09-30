// Alcedo, the assistant's face (apps/web/assets/js/atlas-bot.js): the mascot in
// AI surfaces. The Atlas logo stays the brand mark; the mascot replaces the
// sparkles assistant icon only. The interactive form is the approved Blender
// GLB (assets/atlas-bot/alcedo-mascot.glb) loaded and animated by the built
// scene bundle (assets/atlas-bot/atlas-mascot-scene.js, three + GLTFLoader
// bundled); the fallback is a static render of the GLB idle pose.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (file) => readFileSync(file, 'utf8');

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

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

test('badge markup: escaped, sized within bounds, unknown states fall back to idle, decorative unless labelled', () => {
  const bot = loadBot();
  const plain = bot.html({ size: 18 });
  assert.match(plain, /^<span class="atlas-bot atlas-bot--small" data-atlas-bot data-state="idle" style="--atlas-bot-size:18px;--atlas-bot-delay:-[\d.]+s;--atlas-bot-clock:-[\d.]+s" aria-hidden="true"><\/span>$/);
  assert.match(bot.html({ size: 4 }), /--atlas-bot-size:12px/);
  assert.match(bot.html({ size: 900 }), /--atlas-bot-size:128px/);
  // 24 px or less: the small head-crop poster (.atlas-bot--small).
  assert.match(bot.html({ size: 24 }), /class="atlas-bot atlas-bot--small"/);
  assert.match(bot.html({ size: 28 }), /class="atlas-bot" /);
  assert.match(bot.html({ size: 20, className: 'x' }), /class="atlas-bot atlas-bot--small x"/);
  assert.match(bot.html({ state: 'thinking' }), /data-state="thinking"/);
  assert.match(bot.html({ state: '"><script>' }), /data-state="idle"/);
  const hostile = bot.html({ className: '"><img src=x onerror=alert(1)>', label: '<b>Alcedo</b>' });
  assert.doesNotMatch(hostile, /<img|<b>/);
  assert.match(hostile, /role="img" aria-label="&lt;b&gt;Alcedo&lt;\/b&gt;"/);
});

test('live placeholder carries the key, framing and state, with the badge as its poster; labelled Alcedo', () => {
  const bot = loadBot();
  const markup = bot.liveHtml({ key: 'ai-empty', framing: 'full', size: 176 });
  assert.match(markup, /class="atlas-bot-live" data-atlas-bot-live="ai-empty" data-framing="full" data-state="idle" style="--atlas-bot-live-size:176px" role="img" aria-label="Alcedo, your assistant"/);
  assert.match(markup, /class="atlas-bot atlas-bot-live__poster"/, 'the 176 px poster uses the large sprite');
  assert.match(bot.liveHtml({ framing: 'weird' }), /data-framing="full"/);
  assert.match(bot.liveHtml({ framing: 'bust' }), /data-framing="bust"/);
});

// ---------------------------------------------------------------------------
// The live mascot: lazy WebGL upgrade, guards, one context per key
// ---------------------------------------------------------------------------

test('the live mascot is lazy, same-origin, paused off screen and when hidden, and keeps one WebGL context per key', () => {
  const source = read('apps/web/assets/js/atlas-bot.js');
  // The scene bundle path is preserved (atlas-mascot-scene.js); the assets are
  // the GLB-derived poster + head crop; all on the new cache token.
  assert.match(source, /const SCENE = 'assets\/atlas-bot\/atlas-mascot-scene\.js\?v=20260930-glb';/);
  assert.match(source, /const SPRITE = 'assets\/atlas-bot\/alcedo-mascot-poster\.png\?v=20260930-glb';/);
  assert.match(source, /const SPRITE_SMALL = 'assets\/atlas-bot\/alcedo-mascot-head\.png\?v=20260930-glb';/);
  // The real WebGL lazy-upgrade is in place (not the static no-op placeholder).
  assert.match(source, /if \(!canGoLive\(\)\) \{ host\.classList\.add\('is-static'\); return; \}/);
  assert.match(source, /entry = createLive\(key, framing\)/);
  assert.match(source, /if \(!entry\.scene && !entry\.failed\) start\(entry\)/);
  assert.match(source, /const \{ createMascotScene \} = await loadScene\(\)/);
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
  assert.match(source, /live\.get\(entry\.key\) !== entry/, 'a mascot destroyed while the scene loads opens no context');
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
  const mascots = bot.canvases.filter((canvas) => canvas.attributes['aria-hidden'] === 'true');
  assert.ok(mascots.length >= 43, 'mascots made their canvases');
  assert.ok(mascots.every((canvas) => typeof canvas.handlers.webglcontextlost === 'function' && typeof canvas.handlers.webglcontextrestored === 'function'), 'every mascot canvas handles context loss');
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

test('WebGL in software (no GPU): probed once, and the poster stays (no scene, no mascot context)', () => {
  const bot = loadBot({ gpu: false });
  const hosts = Array.from({ length: 5 }, () => host('soft'));
  hosts.forEach((node) => bot.upgrade({ querySelectorAll: () => [node] }));
  assert.equal(bot.canvases.length, 2, 'the GPU probe and the software probe, nothing else');
  assert.equal(bot.canvases[1].lost, 1, 'the software probe context is released');
  assert.equal(bot.software(), true);
  assert.ok(hosts.every((node) => node.classes.has('is-static')));
  assert.equal(bot.info('soft'), null);
  // Browser tests (SwiftShader) turn the live mascot on.
  bot.animateInSoftware(true);
  bot.upgrade({ querySelectorAll: () => [host('soft')] });
  assert.notEqual(bot.info('soft'), null);
  assert.equal(loadBot().software(), false);
});

// ---------------------------------------------------------------------------
// The scene source, the built bundle and the GLB / poster assets
// ---------------------------------------------------------------------------

test('the GLB scene source exports the mascot contract and rigs the GLB by its named pivots', () => {
  const source = read('scripts/mascot/alcedo-glb-scene.src.mjs');
  assert.match(source, /export function createMascotScene\(canvas,/);
  assert.match(source, /export const BASE_STATES = Object\.freeze\(\['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error'\]\);/);
  assert.match(source, /export const MOMENTS = Object\.freeze\(\['greet', 'success', 'error', 'react', 'wake'\]\);/);
  assert.match(source, /const BASE_ALIASES = Object\.freeze\(\{ speaking: 'answering' \}\);/);
  assert.match(source, /import \{ GLTFLoader \} from 'three\/examples\/jsm\/loaders\/GLTFLoader\.js';/);
  assert.match(source, /'\.\/alcedo-mascot\.glb'/, 'fetches the GLB by a runtime-relative URL');
  assert.match(source, /setReducedMotion\(value\) \{/);
  assert.match(source, /dispose\(\{ loseContext = true \} = \{\}\)/);
  // Rig by named pivots (no skeleton).
  for (const node of ['Head_preparation_pivot', 'Left_oval_eye', 'Right_oval_eye', 'Small_central_orange_beak', 'Left_wing_preparation_pivot', 'Right_wing_preparation_pivot']) assert.ok(source.includes(node), node);
  // Head yaw is capped so the concealed head/body seam stays hidden.
  assert.match(source, /const YAW_MAX = 0\.36;/);
  // No red anywhere in the fallback palette / materials.
  assert.doesNotMatch(source, /0xff0000|'red'/i);
});

test('the scene bundle is built from the GLB source, bundles GLTFLoader, and stays under 700 KiB', () => {
  const bundle = read('apps/web/assets/atlas-bot/atlas-mascot-scene.js');
  assert.match(bundle, /^\/\* Alcedo mascot scene, built by scripts\/build_atlas_mascot\.mjs from scripts\/mascot\/alcedo-glb-scene\.src\.mjs with three@0\.186\.1 \(MIT/);
  assert.match(bundle, /createMascotScene/, 'the bundle exports the scene factory');
  assert.match(bundle, /alcedo-mascot\.glb/, 'the bundle fetches the GLB at runtime');
  assert.match(bundle, /GLTFLoader/, 'GLTFLoader is bundled in');
  assert.match(bundle, /Head_preparation_pivot/, 'rigged by the named pivots');
  assert.match(bundle, /setReducedMotion/);
  assert.ok(statSync('apps/web/assets/atlas-bot/atlas-mascot-scene.js').size < 700 * 1024, 'scene bundle stays under 700 KiB');
});

test('the build script points at the GLB source and the shipped bundle path', () => {
  const build = read('scripts/build_atlas_mascot.mjs');
  assert.match(build, /entryPoints: \[path\.join\(ROOT, 'scripts\/mascot\/alcedo-glb-scene\.src\.mjs'\)\]/);
  assert.match(build, /outfile: path\.join\(ROOT, 'apps\/web\/assets\/atlas-bot\/atlas-mascot-scene\.js'\)/);
  assert.match(build, /if \(threeVersion !== '0\.186\.1'\)/);
});

test('the GLB asset and the GLB-derived poster/head assets are present and well-formed', () => {
  const glb = readFileSync('apps/web/assets/atlas-bot/alcedo-mascot.glb');
  assert.equal(glb.subarray(0, 4).toString('ascii'), 'glTF', 'a binary glTF (GLB) container');
  assert.ok(glb.length > 100 * 1024, 'the model has geometry');
  for (const file of ['alcedo-mascot-poster.png', 'alcedo-mascot-head.png']) {
    const png = readFileSync(`apps/web/assets/atlas-bot/${file}`);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${file} is a PNG`);
    const ihdr = png.indexOf(Buffer.from('IHDR'));
    assert.equal(png[ihdr + 13], 6, `${file} is RGBA (transparent)`);
  }
});

test('cache tokens agree inside atlas-bot.js and every keyed asset exists', () => {
  const bot = read('apps/web/assets/js/atlas-bot.js');
  const constants = Object.fromEntries([...bot.matchAll(/const (SPRITE|SPRITE_SMALL|SCENE) = '([^']+)';/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(constants).sort(), ['SCENE', 'SPRITE', 'SPRITE_SMALL']);
  // One shared token, and each referenced file exists on disk.
  const tokens = new Set(Object.values(constants).map((u) => u.split('?v=')[1]));
  assert.deepEqual([...tokens], ['20260930-glb'], 'one cache token for the mascot assets');
  for (const url of Object.values(constants)) statSync(`apps/web/${url.split('?')[0]}`);
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
  assert.match(bot.html({ follow: true, state: 'error' }), /data-atlas-bot-follow data-state="answering"/);
  assert.match(bot.liveHtml({ key: 'x', follow: true }), /data-state="answering" data-atlas-bot-follow/);
  assert.match(bot.liveHtml({ key: 'x' }), /<span class="atlas-bot-z" aria-hidden="true"><i>z<\/i><i>z<\/i><i>z<\/i><\/span><\/div>$/, 'one Z element per mascot, decorative');
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
  bot.robot.active(true);
  assert.equal(bot.robot.state, 'awake');
  assert.equal(bot.robot.info().sleepAfter, 90000);
  bot.advance(8100);
  assert.equal(bot.robot.state, 'idle', 'awake returns to idle by itself');
  bot.advance(90000 - 8100 - 1000);
  assert.equal(bot.robot.state, 'idle');
  bot.advance(2000);
  assert.equal(bot.robot.state, 'sleeping');
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

test('controller: wake triggers wake a sleeping or idle mascot at once; typing only keeps it awake; busy states stay', () => {
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
  for (const reason of ['composer', 'typing', 'hover', 'tap', 'voice']) {
    bot.robot.set('error');
    bot.advance(500);
    bot.robot.wake(reason);
    assert.equal(bot.robot.state, 'awake', `${reason} ends an error at once (no waiting out the 4 s)`);
  }
  bot.robot.set('error');
  bot.robot.wake('new-conversation', { clear: true });
  assert.equal(bot.robot.state, 'awake', 'a new conversation clears an error');
  bot.robot.set('attention');
  bot.robot.wake('new-conversation', { clear: true });
  assert.equal(bot.robot.state, 'awake');
});

test('controller: thinking → answering is one continuous state; success returns to idle; attention lasts; an error returns to idle after 4 s', () => {
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
  bot.robot.set('thinking');
  bot.robot.set('error');
  assert.equal(bot.robot.table.error.after, 4000);
  bot.advance(3900);
  assert.equal(bot.robot.state, 'error', 'the error shows for about 4 s');
  bot.advance(200);
  assert.equal(bot.robot.state, 'idle', 'thinking → error → idle by itself');
  assert.equal(bot.robot.info().timers, 1, 'one timer: the idle mascot can fall asleep again');
  bot.robot.set('error');
  bot.robot.set('thinking');
  bot.advance(600000);
  assert.equal(bot.robot.state, 'thinking', 'a new question during the error takes over; the error timer does not end it');
});

test('controller: hovering or tapping an item that carries a following mascot wakes it; other items do not', () => {
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
