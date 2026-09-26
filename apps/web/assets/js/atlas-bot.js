// Atlas AI robot: the assistant's face (not the Atlas logo, which stays the
// brand mark everywhere). Two forms of one model (scripts/mascot/):
//
//   AtlasBot.html({ size, state })      a small badge: the pre-rendered robot
//     (assets/atlas-bot/atlas-bot.png, frames open · blink · happy)
//     animated in CSS (.atlas-bot, atlas-components.css): it blinks, smiles
//     on hover, bobs and glows while thinking, pulses while listening. Use it
//     wherever the assistant is the symbol (nav, Ask Atlas, message labels).
//
//   AtlasBot.liveHtml({ key, framing, state }) + AtlasBot.upgrade(root)
//     the interactive 3D robot (assets/atlas-bot/atlas-mascot-scene.js, Three.js
//     bundled, loaded on first use). It greets once, follows the pointer on
//     desktop, reacts to a tap and shows idle · thinking · listening ·
//     speaking · error. The badge is its poster: it stays when WebGL is
//     missing, the scene fails to load, the connection asks to save data, or
//     until the first frame is drawn. Reduced motion: one still frame.
//
// A live robot is kept by key: a re-render that draws the same key moves the
// existing canvas into the new placeholder instead of opening another WebGL
// context. Drawing stops while it is off screen or the tab is hidden.
(function atlasBot(root) {
  'use strict';

  const SPRITE = 'assets/atlas-bot/atlas-bot.png?v=20261003-bot1';
  const SCENE = 'assets/atlas-bot/atlas-mascot-scene.js?v=20261003-bot1';
  const STATES = ['idle', 'thinking', 'listening', 'speaking', 'error', 'happy'];
  const live = new Map();
  let scenePromise = null;

  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const stateOf = (value) => (STATES.includes(value) ? value : 'idle');
  const media = (query) => Boolean(root.matchMedia?.(query).matches);
  // The system setting or Atlas's own Reduce motion preference.
  const reducedMotion = () => media('(prefers-reduced-motion: reduce)') || document.documentElement.classList.contains('atlas-reduce-motion');

  // Badges blink at slightly different moments so a list of them never blinks
  // in step.
  let blinkSeed = 0;
  function html({ size = 20, state = 'idle', className = '', label = '' } = {}) {
    blinkSeed = (blinkSeed + 1) % 7;
    const px = Math.max(12, Math.min(128, Math.round(Number(size) || 20)));
    const a11y = label ? ` role="img" aria-label="${escape(label)}"` : ' aria-hidden="true"';
    return `<span class="atlas-bot${className ? ` ${escape(className)}` : ''}" data-atlas-bot data-state="${stateOf(state)}" style="--atlas-bot-size:${px}px;--atlas-bot-delay:-${blinkSeed * 0.9}s"${a11y}></span>`;
  }

  function liveHtml({ key = 'default', framing = 'full', state = 'idle', size = 160, label = 'Atlas, your assistant' } = {}) {
    const px = Math.max(48, Math.min(320, Math.round(Number(size) || 160)));
    return `<div class="atlas-bot-live" data-atlas-bot-live="${escape(key)}" data-framing="${framing === 'bust' ? 'bust' : 'full'}" data-state="${stateOf(state)}" style="--atlas-bot-live-size:${px}px" role="img" aria-label="${escape(label)}">${html({ size: Math.round(px * 0.72), state, className: 'atlas-bot-live__poster' })}</div>`;
  }

  function webglAvailable() {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      return false;
    }
  }

  function canGoLive() {
    if (root.navigator?.connection?.saveData) return false;
    return webglAvailable();
  }

  function loadScene() {
    if (!scenePromise) {
      const url = new URL(SCENE, document.baseURI).href;
      scenePromise = import(url).catch((error) => { scenePromise = null; throw error; });
    }
    return scenePromise;
  }

  // Moments the scene knows; a base state that is also a badge state.
  const MOMENTS = ['greet', 'success', 'error', 'react'];
  const BASES = ['idle', 'thinking', 'listening', 'speaking', 'error'];

  function createLive(key, framing) {
    const entry = {
      key, framing, state: 'idle', host: null, scene: null, canvas: null, failed: false,
      visible: false, frame: 0, lastDraw: 0, greeted: false, observer: null, pending: []
    };
    const canvas = document.createElement('canvas');
    canvas.className = 'atlas-bot-live__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    entry.canvas = canvas;

    const fine = media('(hover: hover) and (pointer: fine)');
    const onPointer = (event) => {
      if (!entry.scene || !entry.host) return;
      const box = entry.host.getBoundingClientRect();
      const x = ((event.clientX - (box.left + box.width / 2)) / Math.max(240, root.innerWidth / 2));
      const y = ((event.clientY - (box.top + box.height * 0.35)) / Math.max(240, root.innerHeight / 2));
      entry.scene.pointer(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)), true);
      wake(entry);
    };
    const onLeave = () => { entry.scene?.pointer(0, 0, false); wake(entry); };
    entry.listen = () => {
      if (fine) {
        root.addEventListener('pointermove', onPointer, { passive: true });
        document.documentElement.addEventListener('pointerleave', onLeave);
      }
    };
    entry.unlisten = () => {
      root.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
    canvas.addEventListener('pointerdown', () => play(key, 'react'));
    return entry;
  }

  function resize(entry) {
    if (!entry.scene || !entry.host) return;
    const box = entry.host.getBoundingClientRect();
    const ratio = Math.min(root.devicePixelRatio || 1, media('(pointer: coarse)') ? 1.5 : 2);
    entry.scene.resize(Math.round(box.width), Math.round(box.height), ratio);
  }

  function loop(entry) {
    entry.frame = 0;
    if (!entry.scene || !entry.visible || document.hidden || !entry.host?.isConnected) return;
    if (reducedMotion()) { entry.scene.renderStatic(); return; }
    entry.frame = root.requestAnimationFrame((now) => {
      if (now - entry.lastDraw >= entry.scene.frameInterval() - 2) {
        entry.lastDraw = now;
        entry.scene.step(now);
      }
      loop(entry);
    });
  }

  function wake(entry) {
    if (!entry.frame) loop(entry);
  }

  function stop(entry) {
    if (entry.frame) root.cancelAnimationFrame(entry.frame);
    entry.frame = 0;
  }

  function observe(entry) {
    entry.observer?.disconnect();
    if (!('IntersectionObserver' in root)) { entry.visible = true; return; }
    entry.observer = new root.IntersectionObserver(([record]) => {
      entry.visible = Boolean(record?.isIntersecting);
      if (entry.visible) {
        if (!entry.greeted && entry.scene) { entry.greeted = true; entry.scene.play('greet'); }
        wake(entry);
      } else stop(entry);
    });
    entry.observer.observe(entry.host);
  }

  async function start(entry) {
    try {
      const { createMascotScene } = await loadScene();
      if (entry.scene || entry.failed) return;
      entry.scene = createMascotScene(entry.canvas, {
        reducedMotion: reducedMotion(),
        finePointer: media('(hover: hover) and (pointer: fine)'),
        framing: entry.framing
      });
      applyState(entry);
      resize(entry);
      entry.scene.renderStatic();
      entry.host?.classList.add('is-live');
      entry.listen();
      entry.pending.splice(0).forEach((moment) => entry.scene.play(moment));
      if (entry.visible && !entry.greeted) { entry.greeted = true; entry.scene.play('greet'); }
      wake(entry);
    } catch {
      // The poster badge stays; the robot is decoration, never a blocker.
      entry.failed = true;
      entry.host?.classList.add('is-static');
    }
  }

  function applyState(entry) {
    if (!entry.scene) return;
    entry.scene.setBase(BASES.includes(entry.state) ? entry.state : 'idle');
    wake(entry);
  }

  // Mounts (or moves) the live robot into every placeholder under `scope`.
  function upgrade(scope = document) {
    const hosts = scope.querySelectorAll?.('[data-atlas-bot-live]') || [];
    hosts.forEach((host) => {
      if (host.dataset.atlasBotMounted === '1') return;
      host.dataset.atlasBotMounted = '1';
      if (!canGoLive()) { host.classList.add('is-static'); return; }
      const key = host.dataset.atlasBotLive || 'default';
      const framing = host.dataset.framing === 'bust' ? 'bust' : 'full';
      let entry = live.get(key);
      if (!entry || entry.framing !== framing) {
        if (entry) destroy(key);
        entry = createLive(key, framing);
        live.set(key, entry);
      }
      entry.host = host;
      entry.state = stateOf(host.dataset.state);
      host.appendChild(entry.canvas);
      if (entry.scene) { host.classList.add('is-live'); resize(entry); applyState(entry); entry.scene.renderStatic(); }
      else if (entry.failed) host.classList.add('is-static');
      observe(entry);
      if (!entry.scene && !entry.failed) start(entry);
    });
  }

  function setState(key, state) {
    const entry = live.get(key);
    const value = stateOf(state);
    document.querySelectorAll(`[data-atlas-bot-live="${CSS.escape(key)}"]`).forEach((host) => {
      host.dataset.state = value;
      host.querySelector('.atlas-bot')?.setAttribute('data-state', value);
    });
    if (!entry) return;
    entry.state = value;
    applyState(entry);
  }

  function play(key, moment) {
    if (!MOMENTS.includes(moment)) return;
    const entry = live.get(key);
    if (!entry) return;
    if (!entry.scene) { entry.pending.push(moment); return; }
    entry.scene.play(moment);
    wake(entry);
  }

  function destroy(key) {
    const entry = live.get(key);
    if (!entry) return;
    stop(entry);
    entry.observer?.disconnect();
    entry.unlisten?.();
    entry.scene?.dispose();
    entry.canvas.remove();
    live.delete(key);
  }

  document.addEventListener('visibilitychange', () => {
    live.forEach((entry) => { if (document.hidden) stop(entry); else wake(entry); });
  });
  root.addEventListener('resize', () => live.forEach((entry) => { resize(entry); wake(entry); }), { passive: true });

  root.AtlasBot = {
    html,
    liveHtml,
    upgrade,
    setState,
    play,
    destroy,
    // For tests and diagnostics.
    info(key) {
      const entry = live.get(key);
      if (!entry) return null;
      return { key, state: entry.state, live: Boolean(entry.scene), failed: entry.failed, visible: entry.visible, running: Boolean(entry.frame), scene: entry.scene?.info() || null };
    },
    sprite: SPRITE
  };
}(window));
