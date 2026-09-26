// Atlas AI robot: the assistant's face (not the Atlas logo, which stays the
// brand mark everywhere). Two forms of one model (scripts/mascot/):
//
//   AtlasBot.html({ size, state, follow })   a small badge: the pre-rendered
//     robot (assets/atlas-bot/atlas-bot.png, frames open · blink · sleep ·
//     happy; at 24 px or less atlas-bot-small.png, a tighter face with a matte
//     visor) animated in CSS (.atlas-bot, atlas-components.css): it blinks,
//     smiles on hover, sleeps with a small z · zz · zzz, bobs and glows while
//     thinking, pulses while listening. Use it wherever the assistant is the
//     symbol (nav, Ask Atlas, message labels).
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
// context (WebGL support is probed once, and the probe's context released).
// Drawing stops while it is off screen, the tab is hidden, or after 15 s of
// calm idle; a pointer move, a state change, a moment or the tab showing
// again resumes it. Pointer moves only schedule a frame: at most one draw per
// animation frame. Reduced motion is followed live (the system setting and
// Atlas's own preference): the scene is told, pointer tracking stops and the
// robot draws still frames only when something changes. A lost WebGL context
// shows the poster again; a restored one rebuilds the scene. Where WebGL runs
// only in software (no GPU), the poster stays: building and drawing the scene
// there would hold the page's main thread for seconds.
//
// One state controller (AtlasBot.robot, below) decides what the assistant is
// doing for every surface that follows it (data-atlas-bot-follow: the sidebar
// and tab bar badges, the Atlas AI welcome robot, the label of the answer
// being written). States and how each ends are one table (STATE_TABLE); a
// transient state (awake, success) returns to idle by itself; calm states
// fall asleep after a quiet spell; wake triggers (hover, tap, opening Atlas
// AI, a new conversation, the composer, voice, an AI task) wake it at once.
// All of it runs on one timer. Surfaces with a state of their own (the live
// voice robot) use setState(key, state) through the same table.
(function atlasBot(root) {
  'use strict';

  const SPRITE = 'assets/atlas-bot/atlas-bot.png?v=20261004-bot5';
  const SPRITE_SMALL = 'assets/atlas-bot/atlas-bot-small.png?v=20261004-bot5';
  const SCENE = 'assets/atlas-bot/atlas-mascot-scene.js?v=20261004-bot5';
  // Badges this size or smaller use the small sprite (.atlas-bot--small).
  const SMALL_MAX = 24;
  // The assistant's states: what each shows in the 3D scene, and how it ends.
  //   calm   it may fall asleep after a quiet spell (idle, awake)
  //   then   a transient state: after `after` ms it returns to `then`
  //   moment a one-off movement played as the state starts
  // Anything else lasts until the next state is set (listening, thinking,
  // answering, attention, error never fall asleep).
  const STATE_TABLE = Object.freeze({
    idle: { scene: 'idle', calm: true },
    awake: { scene: 'awake', calm: true, then: 'idle', after: 8000 },
    sleeping: { scene: 'sleeping', asleep: true },
    listening: { scene: 'listening' },
    thinking: { scene: 'thinking' },
    answering: { scene: 'answering' },
    success: { scene: 'idle', moment: 'success', then: 'idle', after: 1600 },
    attention: { scene: 'attention' },
    error: { scene: 'error' }
  });
  // Older names still accepted: speaking is answering; hover is awake.
  const ALIASES = Object.freeze({ speaking: 'answering', hover: 'awake' });
  // Badges also show 'happy' (the smile frame), which is not a state.
  const STATES = [...Object.keys(STATE_TABLE), 'happy'];
  // Quiet spell before the robot falls asleep: 90 s while Atlas AI is open
  // (the welcome robot is in front of the person, and a long read or a pause to
  // think should not be interrupted sooner); 5 min while Atlas AI is not
  // open, where only the small sidebar or tab bar robot shows it.
  const SLEEP_AFTER = Object.freeze({ active: 90000, inactive: 300000 });
  const live = new Map();
  let scenePromise = null;
  let webgl = null;
  let idleAfter = 15000;
  // WebGL drawn in software (no usable GPU: the browser reports a major
  // performance caveat). Building and drawing the scene there blocks the
  // page's main thread for seconds, so the badge poster stays instead.
  let software = false;
  let animateInSoftware = false;
  const now = () => root.performance?.now?.() ?? Date.now();

  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const stateOf = (value) => { const name = ALIASES[value] || value; return STATES.includes(name) ? name : 'idle'; };
  const media = (query) => Boolean(root.matchMedia?.(query).matches);
  // The system setting or Atlas's own Reduce motion preference.
  const reducedMotion = () => media('(prefers-reduced-motion: reduce)') || Boolean(document.documentElement.classList?.contains('atlas-reduce-motion'));
  let motionReduced = reducedMotion();

  // Badges blink at slightly different moments so a list of them never blinks
  // in step.
  let blinkSeed = 0;
  // follow: the badge shows the assistant's state (AtlasBot.robot) and keeps
  // showing it as it changes; `state` is then ignored.
  function html({ size = 20, state = 'idle', className = '', label = '', follow = false } = {}) {
    blinkSeed = (blinkSeed + 1) % 7;
    const px = Math.max(12, Math.min(128, Math.round(Number(size) || 20)));
    const a11y = label ? ` role="img" aria-label="${escape(label)}"` : ' aria-hidden="true"';
    return `<span class="atlas-bot${px <= SMALL_MAX ? ' atlas-bot--small' : ''}${className ? ` ${escape(className)}` : ''}" data-atlas-bot${follow ? ' data-atlas-bot-follow' : ''} data-state="${follow ? robot.state : stateOf(state)}" style="--atlas-bot-size:${px}px;--atlas-bot-delay:${phase(blinkSeed)};--atlas-bot-clock:${phase(0)}"${a11y}></span>`;
  }

  // A negative delay of the time since the page opened: every badge animation
  // runs on the page's clock, so a badge drawn again (a streamed answer
  // re-rendering its label) continues its animation instead of restarting it.
  // The blink adds a per-badge offset (seed) so a list never blinks in step.
  function phase(seed) {
    return `-${((now() / 1000) + seed * 0.9).toFixed(2)}s`;
  }

  // The sleeping z · zz · zzz: one element per robot, animated in CSS only
  // (shown while the robot sleeps, gone the moment it wakes).
  const Z = '<span class="atlas-bot-z" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>';

  function liveHtml({ key = 'default', framing = 'full', state = 'idle', size = 160, label = 'Atlas, your assistant', follow = false } = {}) {
    const px = Math.max(48, Math.min(320, Math.round(Number(size) || 160)));
    const value = follow ? robot.state : stateOf(state);
    return `<div class="atlas-bot-live" data-atlas-bot-live="${escape(key)}" data-framing="${framing === 'bust' ? 'bust' : 'full'}" data-state="${value}"${follow ? ' data-atlas-bot-follow' : ''} style="--atlas-bot-live-size:${px}px" role="img" aria-label="${escape(label)}">${html({ size: Math.round(px * 0.72), state: value, className: 'atlas-bot-live__poster' })}${Z}</div>`;
  }

  // Probed once per page: every probe opens a WebGL context, and browsers
  // keep only a handful (Chrome drops the oldest past ~16). Probe contexts are
  // released straight away. A GPU context first; failing that, any context
  // means WebGL in software.
  const release = (context) => context?.getExtension?.('WEBGL_lose_context')?.loseContext();
  function probe(options) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options);
    release(context);
    return Boolean(context);
  }
  function webglAvailable() {
    if (webgl !== null) return webgl;
    try {
      webgl = probe({ failIfMajorPerformanceCaveat: true });
      if (!webgl) { webgl = probe(undefined); software = webgl; }
    } catch {
      webgl = false;
    }
    return webgl;
  }

  function canGoLive() {
    if (root.navigator?.connection?.saveData) return false;
    return webglAvailable() && (!software || animateInSoftware);
  }

  function loadScene() {
    if (!scenePromise) {
      const url = new URL(SCENE, document.baseURI).href;
      scenePromise = import(url).catch((error) => { scenePromise = null; throw error; });
    }
    return scenePromise;
  }

  // Moments the scene knows.
  const MOMENTS = ['greet', 'success', 'error', 'react', 'wake'];

  function createLive(key, framing) {
    const entry = {
      key, framing, state: 'idle', host: null, scene: null, canvas: null, failed: false, lost: false,
      visible: false, frame: 0, lastDraw: 0, activeAt: now(), greeted: false, observer: null, sizer: null, size: '', pending: []
    };
    const canvas = document.createElement('canvas');
    canvas.className = 'atlas-bot-live__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    entry.canvas = canvas;

    const fine = media('(hover: hover) and (pointer: fine)');
    // Records where the pointer is and asks for a frame; never draws here.
    const onPointer = (event) => {
      if (!entry.scene || !entry.host || motionReduced) return;
      const box = entry.host.getBoundingClientRect();
      const x = ((event.clientX - (box.left + box.width / 2)) / Math.max(240, root.innerWidth / 2));
      const y = ((event.clientY - (box.top + box.height * 0.35)) / Math.max(240, root.innerHeight / 2));
      entry.scene.pointer(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)), true);
      wake(entry);
    };
    const onLeave = () => { if (motionReduced) return; entry.scene?.pointer(0, 0, false); wake(entry); };
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
    canvas.addEventListener('pointerdown', () => { play(key, 'react'); });
    // The browser can take the context back (too many contexts, GPU reset):
    // the poster shows again until it is restored.
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      // destroy() releases the context on purpose: nothing to show then.
      if (live.get(key) !== entry) return;
      entry.lost = true;
      stop(entry);
      entry.host?.classList.remove('is-live');
      entry.host?.classList.add('is-static');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      if (live.get(key) !== entry || !entry.lost) return;
      entry.scene?.dispose({ loseContext: false });
      entry.scene = null;
      entry.size = '';
      entry.lost = false;
      start(entry);
    });
    return entry;
  }

  // Resizing clears the canvas, so it happens only when the size changed;
  // the next frame redraws it.
  function resize(entry) {
    if (!entry.scene || !entry.host || entry.lost) return;
    const box = entry.host.getBoundingClientRect();
    // Software WebGL (only drawn when a test turns it on) renders at 1x: every
    // pixel is computed on the CPU and would starve the page.
    const ratio = software ? 1 : Math.min(root.devicePixelRatio || 1, media('(pointer: coarse)') ? 1.5 : 2);
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    const size = `${width}x${height}@${ratio}`;
    if (!width || !height || size === entry.size) return;
    entry.size = size;
    entry.scene.resize(width, height, ratio);
    wake(entry, false);
  }

  const drawable = (entry) => Boolean(entry.scene && !entry.lost && entry.visible && !document.hidden && entry.host?.isConnected);

  // One animation frame at a time. Reduced motion: a single still frame per
  // change. Calm idle for idleAfter ms: the loop pauses until woken.
  function loop(entry) {
    entry.frame = 0;
    if (!drawable(entry)) return;
    if (motionReduced) {
      entry.frame = root.requestAnimationFrame(() => {
        entry.frame = 0;
        if (drawable(entry)) entry.scene.renderStatic();
      });
      return;
    }
    entry.frame = root.requestAnimationFrame((time) => {
      entry.frame = 0;
      if (!drawable(entry)) return;
      // Software WebGL: at most 20 frames a second, for the same reason.
      const interval = software ? Math.max(50, entry.scene.frameInterval()) : entry.scene.frameInterval();
      if (time - entry.lastDraw >= interval - 2) {
        entry.lastDraw = time;
        entry.scene.step(time);
      }
      const calm = (STATE_TABLE[entry.state]?.calm || STATE_TABLE[entry.state]?.asleep) && !entry.scene.busy();
      if (calm && now() - entry.activeAt > idleAfter) { entry.paused = true; return; }
      loop(entry);
    });
  }

  // active: something happened (pointer, state, moment, showing again), which
  // restarts the idle clock.
  function wake(entry, active = true) {
    if (active) entry.activeAt = now();
    entry.paused = false;
    if (!entry.frame) loop(entry);
  }

  function stop(entry) {
    if (entry.frame) root.cancelAnimationFrame(entry.frame);
    entry.frame = 0;
  }

  function observe(entry) {
    entry.observer?.disconnect();
    entry.sizer?.disconnect();
    if ('ResizeObserver' in root) {
      entry.sizer = new root.ResizeObserver(() => resize(entry));
      entry.sizer.observe(entry.host);
    }
    if (!('IntersectionObserver' in root)) { entry.visible = true; return; }
    entry.observer = new root.IntersectionObserver(([record]) => {
      const was = entry.visible;
      entry.visible = Boolean(record?.isIntersecting);
      if (entry.visible) {
        if (!entry.greeted && entry.scene) { entry.greeted = true; entry.scene.play('greet'); }
        // Coming into view is activity; a re-render that keeps it in view is not.
        wake(entry, !was);
      } else stop(entry);
    });
    entry.observer.observe(entry.host);
  }

  async function start(entry) {
    try {
      const { createMascotScene } = await loadScene();
      // Build the scene in a task of its own (not inside the click or render
      // that asked for it), when the page is idle.
      await new Promise((resolve) => (root.requestIdleCallback ? root.requestIdleCallback(resolve, { timeout: 400 }) : root.setTimeout(resolve, 0)));
      // Destroyed or replaced meanwhile: open no context.
      if (live.get(entry.key) !== entry || entry.scene || entry.failed || entry.lost) return;
      entry.scene = createMascotScene(entry.canvas, {
        reducedMotion: motionReduced,
        finePointer: media('(hover: hover) and (pointer: fine)'),
        framing: entry.framing
      });
      entry.host?.classList.remove('is-static');
      entry.host?.classList.add('is-live');
      applyState(entry);
      resize(entry);
      entry.scene.renderStatic();
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

  // A changed state counts as activity; re-applying the same one only
  // schedules a frame (the scene keeps the state's timing: no restart). A
  // state's moment plays as it starts; leaving sleep plays the wake moment.
  function applyState(entry) {
    if (!entry.scene) return;
    const was = entry.applied;
    const changed = was !== entry.state;
    entry.applied = entry.state;
    const row = STATE_TABLE[entry.state] || STATE_TABLE.idle;
    entry.scene.setBase(row.scene);
    if (changed && was !== undefined) {
      if (row.moment) entry.scene.play(row.moment);
      else if (was === 'sleeping') entry.scene.play('wake');
    }
    wake(entry, changed);
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
      entry.follow = host.hasAttribute('data-atlas-bot-follow');
      if (entry.follow) paintHost(host, robot.state);
      entry.state = entry.follow ? robot.state : stateOf(host.dataset.state);
      host.appendChild(entry.canvas);
      // Moved into a new placeholder: redraw on the next frame, not now (a
      // caller may re-render many times a second, e.g. live voice).
      if (entry.scene && !entry.lost) { host.classList.add('is-live'); resize(entry); applyState(entry); }
      else if (entry.failed || entry.lost) host.classList.add('is-static');
      observe(entry);
      if (!entry.scene && !entry.failed) start(entry);
    });
  }

  function paintHost(host, value) {
    if (host.dataset.state !== value) host.dataset.state = value;
    const poster = host.querySelector('.atlas-bot-live__poster');
    if (poster && poster.dataset.state !== value) poster.dataset.state = value;
  }

  // One surface's own state (the live voice robot), through the same table:
  // a transient state plays its moment and settles on the state it returns to.
  function setState(key, state) {
    const entry = live.get(key);
    let value = stateOf(state);
    if (value === 'happy') value = 'success';
    const row = STATE_TABLE[value] || STATE_TABLE.idle;
    const shown = row.then || value;
    document.querySelectorAll(`[data-atlas-bot-live="${CSS.escape(key)}"]`).forEach((host) => paintHost(host, shown));
    if (!entry) return;
    entry.state = shown;
    applyState(entry);
    // The moment after the state it settles on (a new state ends a still
    // moment under reduced motion).
    if (row.then && entry.scene && row.moment) entry.scene.play(row.moment);
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
    entry.sizer?.disconnect();
    entry.unlisten?.();
    entry.scene?.dispose();
    entry.canvas.remove();
    live.delete(key);
  }

  // ---------------------------------------------------------------------------
  // The state controller: one assistant state for every following surface.
  // ---------------------------------------------------------------------------
  const robot = {
    state: 'idle', since: now(), activity: now(), until: 0, active: false,
    timer: 0, timers: 0, wakes: 0, lastWake: 0, history: [],
    delays: { ...SLEEP_AFTER }, transient: {}
  };
  const sleepAfter = () => (robot.active ? robot.delays.active : robot.delays.inactive);
  const lasts = (name) => robot.transient[name] ?? STATE_TABLE[name].after;

  // The single timer: whichever comes first of the transient state ending and
  // the robot falling asleep. Activity only records a time; the timer checks
  // it when it fires and waits again if something happened meanwhile. No
  // timer while the tab is hidden (it is set again when the tab shows).
  function schedule() {
    if (robot.timer) { root.clearTimeout(robot.timer); robot.timer = 0; robot.timers -= 1; }
    if (document.hidden || !root.setTimeout) return;
    const row = STATE_TABLE[robot.state];
    const due = robot.until || (row.calm ? robot.activity + sleepAfter() : 0);
    if (!due) return;
    robot.timers += 1;
    robot.timer = root.setTimeout(tick, Math.max(0, due - now()));
  }

  function tick() {
    robot.timer = 0;
    robot.timers -= 1;
    const time = now() + 4;
    const row = STATE_TABLE[robot.state];
    if (robot.until) {
      if (time >= robot.until) { setRobot(row.then, { auto: true }); return; }
    } else if (row.calm && time >= robot.activity + sleepAfter()) {
      setRobot('sleeping', { auto: true });
      return;
    }
    schedule();
  }

  // Every following surface shows the new state: badges by their data-state
  // (CSS), live robots by their scene.
  function paint() {
    document.querySelectorAll('[data-atlas-bot-follow]').forEach((node) => {
      if (node.hasAttribute('data-atlas-bot-live')) paintHost(node, robot.state);
      else if (node.dataset.state !== robot.state) node.dataset.state = robot.state;
    });
    live.forEach((entry) => {
      if (!entry.follow || entry.state === robot.state) return;
      entry.state = robot.state;
      applyState(entry);
    });
  }

  // auto: the controller itself moved on (a transient state ended, the robot
  // fell asleep), which is not activity.
  function setRobot(value, { auto = false } = {}) {
    const next = ALIASES[value] || (value === 'happy' ? 'success' : value);
    const row = STATE_TABLE[next];
    if (!row) return robot.state;
    const time = now();
    if (!auto) robot.activity = time;
    robot.until = row.then ? time + lasts(next) : 0;
    // The same state again (a stream of updates) is one continuous state.
    if (next !== robot.state) {
      robot.history.push({ from: robot.state, to: next, at: Math.round(time) });
      if (robot.history.length > 40) robot.history.shift();
      robot.state = next;
      robot.since = time;
      paint();
    }
    schedule();
    return robot.state;
  }

  // Something the person did that concerns the assistant. A sleeping or idle
  // robot wakes (awake, for a while); an awake one stays awake longer without
  // moving again (typing wakes once, not on every key). clear: a new start
  // (a new conversation) also clears an error or a pending attention.
  function wakeRobot(reason = 'activity', { clear = false } = {}) {
    const time = now();
    robot.activity = time;
    robot.lastWake = time;
    robot.wakes += 1;
    const current = robot.state;
    if (current === 'sleeping' || current === 'idle' || (clear && (current === 'error' || current === 'attention'))) {
      setRobot('awake');
      return reason;
    }
    if (current === 'awake') robot.until = time + lasts('awake');
    if (!robot.timer) schedule();
    return reason;
  }

  // Atlas AI opened (a wake trigger) or closed; the quiet spell before sleep
  // depends on it.
  function setActive(value) {
    const next = Boolean(value);
    if (next === robot.active) return;
    robot.active = next;
    if (next) wakeRobot('open');
    else schedule();
  }

  // Hovering or tapping anything that carries a following robot (the Atlas AI
  // sidebar item, the tab, the welcome robot) wakes it. One listener each for
  // the page, installed once.
  const followerAt = (target) => {
    const node = target?.closest?.('[data-atlas-bot-follow], a, button');
    if (!node) return null;
    return node.hasAttribute('data-atlas-bot-follow') ? node : node.querySelector(':scope > [data-atlas-bot-follow]');
  };
  let hovered = null;
  document.addEventListener('pointerover', (event) => {
    const node = followerAt(event.target);
    if (node === hovered) return;
    hovered = node;
    if (node) wakeRobot('hover');
  }, { passive: true });
  document.addEventListener('pointerdown', (event) => { if (followerAt(event.target)) wakeRobot('tap'); }, { passive: true });
  // While Atlas AI is open, moving the pointer or pressing keys keeps the
  // robot from falling asleep (it does not wake a sleeping one).
  const note = () => { if (robot.active && robot.state !== 'sleeping') robot.activity = now(); };
  root.addEventListener('pointermove', note, { passive: true });
  root.addEventListener('keydown', note, { passive: true });

  document.addEventListener('visibilitychange', () => {
    live.forEach((entry) => { if (document.hidden) stop(entry); else wake(entry); });
    schedule();
  });
  // The quiet spell starts when the page opens.
  schedule();
  root.addEventListener('resize', () => live.forEach((entry) => resize(entry)), { passive: true });

  // Reduced motion can be switched on or off while a robot is on screen.
  function motionChanged() {
    const value = reducedMotion();
    if (value === motionReduced) return;
    motionReduced = value;
    live.forEach((entry) => {
      if (!entry.scene) return;
      entry.scene.setReducedMotion(motionReduced);
      stop(entry);
      wake(entry);
    });
  }
  const motionQuery = root.matchMedia?.('(prefers-reduced-motion: reduce)');
  motionQuery?.addEventListener?.('change', motionChanged);
  if ('MutationObserver' in root && document.documentElement) {
    new root.MutationObserver(motionChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  const robotInfo = () => ({
    state: robot.state, since: Math.round(robot.since), active: robot.active, timers: robot.timers, pendingTimer: Boolean(robot.timer),
    wakes: robot.wakes, sleepAfter: sleepAfter(), transientUntil: robot.until ? Math.round(robot.until) : 0,
    history: robot.history.map((step) => ({ ...step })), liveRobots: live.size
  });

  root.AtlasBot = {
    html,
    liveHtml,
    upgrade,
    setState,
    play,
    destroy,
    // The assistant's state for every following surface (see STATE_TABLE):
    //   robot.set(state)   idle · awake · sleeping · listening · thinking ·
    //                      answering · success · attention · error
    //   robot.wake(reason) a wake trigger (hover, tap, composer, voice…)
    //   robot.active(bool) Atlas AI opened or closed
    //   robot.setDelays({ active, inactive, awake, success })  tests only:
    //                      shorter sleep and transient delays (ms)
    robot: {
      set: (state) => setRobot(state),
      wake: (reason, options) => wakeRobot(reason, options),
      active: (value) => setActive(value),
      get state() { return robot.state; },
      info: robotInfo,
      setDelays({ active, inactive, awake, success } = {}) {
        if (active !== undefined) robot.delays.active = Math.max(0, Number(active) || 0);
        if (inactive !== undefined) robot.delays.inactive = Math.max(0, Number(inactive) || 0);
        if (awake !== undefined) robot.transient.awake = Math.max(0, Number(awake) || 0);
        if (success !== undefined) robot.transient.success = Math.max(0, Number(success) || 0);
        schedule();
      },
      table: STATE_TABLE
    },
    // setRobotState(state) sets the assistant's state; with { key } one
    // surface's own state.
    setRobotState(state, { key } = {}) { return key ? setState(key, state) : setRobot(state); },
    // For tests and diagnostics.
    info(key) {
      const entry = live.get(key);
      if (!entry) return null;
      return { key, state: entry.state, follow: Boolean(entry.follow), live: Boolean(entry.scene), failed: entry.failed, lost: entry.lost, visible: entry.visible, running: Boolean(entry.frame), paused: Boolean(entry.paused), reducedMotion: entry.scene?.reducedMotion() ?? motionReduced, scene: entry.scene?.info() || null, robot: robotInfo() };
    },
    // Tests shorten the calm-idle pause.
    setIdleTimeout(ms) { idleAfter = Math.max(0, Number(ms) || 0); },
    // Browser tests draw WebGL in software (SwiftShader) and turn the live
    // robot on there to exercise it: posters left for software mount now.
    animateInSoftware(value = true) {
      animateInSoftware = Boolean(value);
      if (!animateInSoftware) return;
      document.querySelectorAll('[data-atlas-bot-live].is-static').forEach((host) => {
        if (live.has(host.dataset.atlasBotLive || 'default')) return;
        delete host.dataset.atlasBotMounted;
        host.classList.remove('is-static');
      });
      upgrade(document);
    },
    software: () => (webglAvailable(), software),
    sprite: SPRITE,
    spriteSmall: SPRITE_SMALL
  };
}(window));
