// Alcedo mascot: the supplied Blender GLB, rigged and animated by node
// transforms (source).
//
// A drop-in for the existing loader (apps/web/assets/js/atlas-bot.js): it
// exports the SAME createMascotScene(canvas, opts) interface, the same base
// state and moment names, and the same returned controls. Instead of building
// primitives, it loads the owner's stylized kingfisher GLB
// (ALCEDO_Simple_v05) with GLTFLoader and animates it through the model's
// NAMED PREPARATION PIVOTS (no skeleton): the head pivot turns/nods/tilts, the
// eye meshes squash to blink, the beak opens a little to "speak", the wing
// pivots lift on success and the whole model hops for a react/wake.
//
// GLB loading is asynchronous; createMascotScene returns synchronously (as the
// loader requires) and its methods are safe before the model arrives. The
// returned object also exposes `ready` (a promise) for the preview harness.
import {
  ACESFilmicToneMapping, CanvasTexture, Color, DirectionalLight, Group, HemisphereLight,
  MathUtils, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PerspectiveCamera, PlaneGeometry,
  PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const PALETTE = Object.freeze({ teal: '#1E9FB8', deepTeal: '#0A3E50', orange: '#E8732A', ivory: '#F4EFE6', ground: '#123845' });
export const BASE_STATES = Object.freeze(['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error']);
export const MOMENTS = Object.freeze(['greet', 'success', 'error', 'react', 'wake']);
const BASE_ALIASES = Object.freeze({ speaking: 'answering' });
export const EYE_SCALE = Object.freeze({ normal: 1, small: 1.35 });

const damp = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const window01 = (t, a, b) => ease((t - a) / (b - a));

// Node names in the GLB (glTF v2, Y-up, standing; pivots at their intended
// rotation points with children carrying compensating transforms).
// GLTFLoader sanitizes names (spaces -> underscores).
const NODE = {
  root: 'ALCEDO_ROOT', body: 'Compact_smooth_body', headPivot: 'Head_preparation_pivot',
  eyeL: 'Left_oval_eye', eyeR: 'Right_oval_eye', beak: 'Small_central_orange_beak',
  wingL: 'Left_wing_preparation_pivot', wingR: 'Right_wing_preparation_pivot'
};
// Default asset location: the GLB ships next to the built scene bundle
// (apps/web/assets/atlas-bot/alcedo-mascot.glb), fetched by a runtime-relative
// URL so no absolute path is baked in. The cache token matches the bundle's.
const GLB_VERSION = '20260930-glb2';
const DEFAULT_ASSET = `${new URL('./alcedo-mascot.glb', import.meta.url).href}?v=${GLB_VERSION}`;

// The soft contact shadow under the bird (a blurred ellipse — cheaper than a
// shadow map and reads the same), matching the existing mascot's approach.
function shadowTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const c = new Color(color); const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(${rgb},0.5)`); g.addColorStop(0.45, `rgba(${rgb},0.2)`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; return texture;
}

export function createMascotScene(canvas, { reducedMotion: reduced = false, finePointer = false, framing = 'full', look = 'normal', onFrame = null, assetUrl = DEFAULT_ASSET } = {}) {
  let reducedMotion = Boolean(reduced);
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  room.traverse?.((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
  pmrem.dispose();
  scene.add(new HemisphereLight(0xffffff, 0xcdd9dc, 0.5));
  const key = new DirectionalLight(0xfff6ec, 1.35);
  key.position.set(2.4, 4, 5);
  scene.add(key);
  const rim = new DirectionalLight(0xbfe1ea, 0.6);
  rim.position.set(-3, 2.4, -3.5);
  scene.add(rim);

  // A wrapper the whole model hangs under, so bob/jump/breathing move and
  // squash the bird as one without disturbing the model's own root.
  const model = new Group();
  model.name = 'alcedo-model';
  scene.add(model);

  const disposables = [];
  const shadow = new Mesh(new PlaneGeometry(1.5, 0.8), new MeshBasicMaterial({ map: shadowTexture(PALETTE.ground), transparent: true, depthWrite: false, toneMapped: false, opacity: 0.55 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.01, 0.08);
  shadow.renderOrder = -1;
  scene.add(shadow);
  disposables.push(shadow.geometry, shadow.material, shadow.material.map);

  const camera = new PerspectiveCamera(26, 1, 0.1, 60);
  // The model stands ~2 units tall (feet ~0, head top ~2). full: whole bird;
  // bust: head + shoulders; badge/badge-small: the head filling a square.
  // head: a tight crop on the head + upper body (the Alcedo AI panel uses it so
  // the assistant reads as a face, not a full body).
  const frames = { full: { y: 1.0, z: 6.9, look: 0.98 }, head: { y: 1.62, z: 3.5, look: 1.56 }, bust: { y: 1.5, z: 4.6, look: 1.46 }, badge: { y: 1.5, z: 4.4, look: 1.5 }, 'badge-small': { y: 1.5, z: 4.15, look: 1.52 } };
  let frame = frames[framing] || frames.full;
  const placeCamera = () => { camera.position.set(0, frame.y, frame.z); camera.lookAt(0, frame.look, 0); shadow.visible = frame === frames.full; };
  placeCamera();

  // Rig references + their base transforms (filled once the GLB loads).
  let rig = null;
  const REST = { bob: 0, headYaw: 0, headPitch: 0, headRoll: 0, squash: 1, beak: 0, wing: 0, blink: 0, sleepy: 0, alert: 1 };
  const pose = { ...REST };
  const wallClock = () => globalThis.performance?.now?.() ?? Date.now();
  const MOMENT_LENGTH = { greet: [2.6, 1.2], success: [1.4, 1.5], react: [0.72, 0.9], wake: [0.9, 0.9], error: [2.2, 2.2] };
  const momentTime = (t) => (reducedMotion ? (wallClock() - status.momentWall) / 1000 : t - status.momentAt);
  function endMomentIfOver(t) { if (status.moment && momentTime(t) > (MOMENT_LENGTH[status.moment]?.[reducedMotion ? 1 : 0] ?? 0)) status.moment = null; }
  const status = { base: 'idle', baseSince: 0, moment: null, momentAt: 0, momentWall: 0, greetings: 0, frames: 0, time: 0, pointer: { x: 0, y: 0, active: false }, blinkAt: 2.4, blinkUntil: 0, doubleAt: 0, lookAt: 6, lookUntil: 0, lookSide: 1 };

  // Head yaw is capped: head and body are separate volumes with a concealed
  // neck overlap, and a large yaw exposes the seam. ~20 deg is the clean max
  // found in testing; turns also add a tiny nod so the overlap stays hidden.
  const YAW_MAX = 0.36;

  function baseTargets(out, t, calm) {
    const breathe = (speed, amount) => { out.bob = amount * Math.sin(t * speed); out.squash = 1 + amount * 0.6 * Math.sin(t * speed); };
    switch (status.base) {
      case 'awake':
        Object.assign(out, { headPitch: -0.05, alert: 1.25 });
        if (calm) { breathe(1.2, 0.01); out.headRoll = 0.02 * Math.sin(t * 0.6); }
        break;
      case 'sleeping':
        Object.assign(out, { sleepy: 1, blink: 1, headPitch: 0.2, headRoll: 0.12, headYaw: 0.16, alert: 0.6 });
        if (calm) { breathe(0.6, 0.014); out.headPitch += 0.02 * Math.sin(t * 0.6 + 0.6); }
        break;
      case 'listening':
        Object.assign(out, { headPitch: -0.05, headRoll: -0.09, headYaw: 0.12, alert: 1.3 });
        if (calm) { breathe(1.2, 0.008); out.headYaw = 0.12 + 0.08 * Math.sin(t * 0.7); out.headRoll += 0.02 * Math.sin(t * 1.1); }
        break;
      case 'thinking':
        Object.assign(out, { headRoll: 0.14, headPitch: -0.04, headYaw: -0.14, alert: 1.12 });
        if (calm) { out.headYaw = -0.14 + 0.08 * Math.sin(t * 0.8); out.headRoll = 0.14 + 0.04 * Math.sin(t * 1.2); breathe(1.1, 0.007); }
        break;
      case 'answering':
        Object.assign(out, { headPitch: 0.03, headYaw: 0.02, alert: 1.12 });
        if (calm) {
          out.beak = 0.2 + 0.32 * Math.max(0, Math.sin(t * 6.4));
          out.headPitch = 0.03 + 0.03 * Math.sin(t * 3.1);
          out.headYaw = 0.02 + 0.04 * Math.sin(t * 1.3);
          breathe(1.3, 0.007);
        }
        break;
      case 'attention':
        Object.assign(out, { headPitch: -0.12, headRoll: 0.05, alert: 1.35, bob: 0.01 });
        if (calm) breathe(1.2, 0.007);
        break;
      case 'error':
        Object.assign(out, { headRoll: 0.2, headPitch: 0.12, headYaw: -0.05, alert: 0.72 });
        break;
      default:
        if (calm) {
          breathe(1.15, 0.012);
          out.headYaw = 0.05 * Math.sin(t * 0.34);
          out.headRoll = 0.02 * Math.sin(t * 0.5);
          if (t >= status.lookAt) { status.lookUntil = t + 1.4; status.lookAt = t + 7 + Math.random() * 6; status.lookSide = -status.lookSide; }
          if (t < status.lookUntil) { out.headYaw += 0.22 * status.lookSide; out.headPitch = -0.03; }
        }
    }
  }

  function targets(t) {
    const out = { ...REST };
    const calm = !reducedMotion;
    baseTargets(out, t, calm);
    const tracks = ['idle', 'awake', 'listening', 'attention'].includes(status.base);
    if (finePointer && calm && tracks && status.pointer.active && !status.moment) {
      out.headYaw = MathUtils.clamp(status.pointer.x * 0.4, -YAW_MAX, YAW_MAX);
      out.headPitch = MathUtils.clamp(status.pointer.y * 0.24, -0.24, 0.24);
    }
    endMomentIfOver(t);
    const m = status.moment; const since = momentTime(t);
    if (m === 'greet') {
      if (reducedMotion) { Object.assign(out, { headPitch: -0.08, headYaw: 0.05, wing: 0.5, sleepy: 0, blink: 0, alert: 1.3 }); }
      else {
        const up = window01(since, 0.2, 0.55) * (1 - window01(since, 2.0, 2.55));
        out.headPitch = MathUtils.lerp(out.headPitch, -0.1, up);
        out.bob += 0.05 * up; out.squash = 1 + 0.05 * up;
        const flick = since > 0.3 && since < 1.8 ? Math.max(0, Math.sin((since - 0.3) * Math.PI * 2.2)) : 0;
        out.wing = Math.max(out.wing, 0.6 * up * (0.4 + 0.6 * flick));
        out.alert = 1.35; out.sleepy = 0; out.blink = 0;
      }
    } else if (m === 'success') {
      const d = 1.4; const k = Math.sin(Math.min(1, since / d) * Math.PI);
      out.alert = Math.max(out.alert, 1.25);
      if (!reducedMotion) {
        out.wing = Math.max(out.wing, window01(since, 0.05, 0.35) * (1 - window01(since, 0.95, 1.4)));
        const nod = since < 0.6 ? Math.sin((since / 0.6) * Math.PI) : 0;
        out.headPitch = 0.13 * nod - 0.05 * window01(since, 0.5, 0.9) * k;
        out.bob += 0.05 * k;
      } else { out.wing = 0.75; out.headPitch = -0.05; }
    } else if (m === 'react') {
      // A small jump: crouch, spring up (feet leave the ground), land.
      const crouch = window01(since, 0, 0.13) * (1 - window01(since, 0.13, 0.28));
      const air = window01(since, 0.15, 0.32) * (1 - window01(since, 0.4, 0.62));
      if (!reducedMotion) { out.bob += 0.34 * air - 0.05 * crouch; out.squash = 1 - 0.1 * crouch + 0.05 * air; out.wing = Math.max(out.wing, 0.45 * air); out.headPitch += 0.05 * crouch - 0.05 * air; }
      out.alert = Math.max(out.alert, 1.3);
    } else if (m === 'wake') {
      const d = 0.9; const k = Math.sin(Math.min(1, since / d) * Math.PI);
      out.sleepy = Math.min(out.sleepy, 1 - k); out.blink = Math.min(out.blink, 1 - k);
      if (!reducedMotion) { out.headPitch -= 0.08 * k; out.bob += 0.09 * window01(since, 0.1, 0.35) * (1 - window01(since, 0.4, 0.7)); }
      out.alert = Math.max(out.alert, 1 + 0.3 * k);
    } else if (m === 'error') {
      Object.assign(out, { headRoll: 0.24, headPitch: 0.14, alert: 0.85 });
    }
    return out;
  }

  const rateFor = () => (status.base === 'sleeping' && status.moment !== 'greet' && status.moment !== 'wake' ? 1.6 : 9);

  function apply(dt, t, instant, overrides = null) {
    const goal = { ...targets(t), ...(overrides || {}) };
    const rate = instant ? Infinity : rateFor();
    for (const [name, value] of Object.entries(goal)) if (name in pose) pose[name] = instant ? value : damp(pose[name], value, rate, dt);
    if (!rig) return;
    // Whole-bird bob + breathing squash (scale about the feet).
    model.position.y = pose.bob;
    const sy = pose.squash, sxz = 1 + (1 - pose.squash) * 0.6;
    model.scale.set(sxz, sy, sxz);
    // Head: yaw capped, with a small nod coupling so the neck seam stays hidden.
    const yaw = MathUtils.clamp(pose.headYaw, -YAW_MAX, YAW_MAX);
    rig.headPivot.rotation.set(pose.headPitch + 0.12 * Math.abs(yaw), yaw, pose.headRoll);
    // Blink / sleep: squash the eye meshes vertically (no eyelids in the model).
    let blink = pose.blink;
    if (!reducedMotion && !overrides && pose.sleepy < 0.3) {
      if (t >= status.blinkAt) { status.blinkUntil = t + 0.12; status.doubleAt = t + 0.26; status.blinkAt = t + 3.0 + Math.random() * 3.4; }
      if ((t < status.blinkUntil) || (t > status.doubleAt - 0.12 && t < status.doubleAt)) blink = 1; // natural double-blink
    }
    const cover = MathUtils.clamp(Math.max(blink, pose.sleepy), 0, 1);
    const open = (1 - 0.92 * cover) * (0.97 + 0.05 * (MathUtils.clamp(pose.alert, 0.6, 1.4) - 1));
    rig.eyeL.scale.y = rig.base.eyeLy * open;
    rig.eyeR.scale.y = rig.base.eyeRy * open;
    // Beak: a small open (down) to "speak".
    const bk = MathUtils.clamp(pose.beak, 0, 1);
    rig.beak.scale.y = rig.base.beakSy * (1 - 0.4 * bk);
    rig.beak.position.y = rig.base.beakPy - 0.035 * bk;
    // Wings: lift up-and-out, symmetric (sign per side).
    const lift = MathUtils.clamp(pose.wing, 0, 1);
    rig.wingL.rotation.z = rig.base.wingLz + 1.15 * lift;
    rig.wingR.rotation.z = rig.base.wingRz - 1.15 * lift;
    rig.wingL.rotation.x = rig.base.wingLx - 0.3 * lift;
    rig.wingR.rotation.x = rig.base.wingRx - 0.3 * lift;
    // The shadow tightens as the bird rises.
    const rise = MathUtils.clamp(pose.bob * 3.5, -0.2, 0.35);
    shadow.scale.setScalar(1 - 0.5 * rise);
    shadow.material.opacity = 0.55 * (1 - rise);
  }

  let size = { w: 1, h: 1 };
  function resize(width, height, pixelRatio) {
    size = { w: Math.max(1, width), h: Math.max(1, height) };
    renderer.setPixelRatio(pixelRatio); renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h; camera.updateProjectionMatrix();
  }

  let last = null;
  function step(now, { instant = false, overrides = null } = {}) {
    const seconds = now / 1000;
    const dt = last === null ? 0 : Math.min(0.25, seconds - last);
    last = seconds;
    status.time += dt;
    apply(dt, status.time, instant, overrides);
    renderer.render(scene, camera);
    status.frames += 1;
    onFrame?.(status);
  }

  function frameInterval() {
    if (status.moment) return 1000 / 60;
    if (status.base === 'sleeping') return 1000 / 10;
    if (status.base === 'idle' || status.base === 'awake') return 1000 / 30;
    return 1000 / 45;
  }

  // --- Load the GLB and wire the rig. ----------------------------------------
  let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
  const loader = new GLTFLoader();
  loader.load(assetUrl, (gltf) => {
    const g = gltf.scene;
    model.add(g);
    const names = []; g.traverse((o) => names.push(o.name)); if (globalThis.__ALCEDO_DEBUG) console.log('GLB names:', JSON.stringify(names));
    const find = (n) => { const o = g.getObjectByName(n); if (!o) console.warn('alcedo: node not found:', n); return o; };
    const headPivot = find(NODE.headPivot), eyeL = find(NODE.eyeL), eyeR = find(NODE.eyeR), beak = find(NODE.beak), wingL = find(NODE.wingL), wingR = find(NODE.wingR), body = find(NODE.body);
    if (!headPivot || !eyeL || !eyeR || !beak || !wingL || !wingR) { console.error('alcedo: missing rig nodes; names =', JSON.stringify(names)); readyResolve(false); return; }
    // A subtle glossy glass/ceramic finish: convert each material to a physical
    // one with a light clearcoat and environment reflections (the RoomEnvironment
    // PMREM map already on the scene). The approved vertex colours (teal head,
    // orange breast, white throat, dark eyes, orange beak/feet) are preserved —
    // colour, map and vertexColors are carried over; only the surface gains a
    // soft highlight, never a recolour or a wash-out.
    const glassCache = new Map();
    const toGlass = (m) => {
      if (glassCache.has(m)) return glassCache.get(m);
      const p = new MeshPhysicalMaterial({
        color: m.color ? m.color.clone() : undefined,
        map: m.map || null,
        vertexColors: Boolean(m.vertexColors),
        transparent: Boolean(m.transparent),
        opacity: m.opacity ?? 1,
        side: m.side,
        roughness: 0.3,
        metalness: 0,
        clearcoat: 0.5,
        clearcoatRoughness: 0.2,
        envMapIntensity: 0.85
      });
      glassCache.set(m, p);
      disposables.push(p);
      return p;
    };
    g.traverse((o) => { if (o.isMesh && o.material) { o.material = Array.isArray(o.material) ? o.material.map(toGlass) : toGlass(o.material); } });
    rig = {
      headPivot, eyeL, eyeR, beak, wingL, wingR, body,
      base: {
        eyeLy: eyeL.scale.y, eyeRy: eyeR.scale.y, beakSy: beak.scale.y, beakPy: beak.position.y,
        wingLz: wingL.rotation.z, wingRz: wingR.rotation.z, wingLx: wingL.rotation.x, wingRx: wingR.rotation.x
      }
    };
    apply(0, status.time, true, null);
    renderer.render(scene, camera);
    readyResolve(true);
  }, undefined, (err) => { console.error('alcedo GLB load failed', err); readyResolve(false); });

  return {
    ready,
    step,
    frameInterval,
    resize,
    renderStatic(overrides = null) { step((last ?? 0) * 1000 + 16, { instant: true, overrides }); },
    setBase(name) {
      const value = BASE_ALIASES[name] || (BASE_STATES.includes(name) ? name : 'idle');
      if (value === status.base) return;
      status.base = value; status.baseSince = status.time;
      if (reducedMotion && status.moment) status.moment = null;
    },
    play(moment) {
      if (!MOMENTS.includes(moment)) return;
      endMomentIfOver(status.time);
      if (status.moment === 'greet' && moment !== 'greet') return;
      if (moment === 'greet') status.greetings += 1;
      status.moment = moment; status.momentAt = status.time; status.momentWall = wallClock();
    },
    pointer(x, y, active) { status.pointer = { x, y, active }; },
    setReducedMotion(value) { reducedMotion = Boolean(value); if (reducedMotion) status.pointer = { x: 0, y: 0, active: false }; },
    reducedMotion() { return reducedMotion; },
    setFraming(name) { frame = frames[name] || frames.full; placeCamera(); },
    setViewYaw(rad) { model.rotation.y = rad; },
    busy() { return Boolean(status.moment); },
    info() {
      const render = renderer.info.render;
      return {
        base: status.base, baseSince: status.baseSince, moment: status.moment, greetings: status.greetings, frames: status.frames, frameInterval: frameInterval(), ready: Boolean(rig),
        headPitch: pose.headPitch, headYaw: pose.headYaw, headRoll: pose.headRoll,
        // A diagnostic: the eyes read closed when blinking or asleep (the model
        // has no eyelids — the eye meshes are squashed flat), else open.
        eyes: Math.max(pose.blink, pose.sleepy) > 0.6 ? 'closed' : 'open',
        pose: { squash: pose.squash, beak: pose.beak, wing: pose.wing, sleepy: pose.sleepy, blink: pose.blink, alert: pose.alert, bob: pose.bob },
        shadow: shadow.visible, triangles: render.triangles, calls: render.calls, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures
      };
    },
    dispose({ loseContext = true } = {}) {
      disposables.forEach((d) => d.dispose?.());
      model.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); const mm = Array.isArray(o.material) ? o.material : [o.material]; mm.forEach((m) => m?.dispose?.()); } });
      envTarget.dispose(); renderer.dispose();
      if (loseContext) renderer.forceContextLoss?.();
    }
  };
}
