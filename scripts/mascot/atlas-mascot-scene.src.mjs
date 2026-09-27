// Atlas AI mascot: the 3D robot scene (source).
//
// Built into apps/web/assets/atlas-bot/atlas-mascot-scene.js by
// scripts/build_atlas_mascot.mjs (esbuild, Three.js bundled in, no runtime
// download). Loaded on first use by assets/js/atlas-bot.js.
//
// The robot is built procedurally from Three.js primitives (no GLB: the
// source of truth is this file, so the model is reproducible and reviewable).
// It is rigged as a hierarchy of pivots (root, body, head, shoulders,
// elbows) and animated by a small state machine:
//   base states  idle · awake · sleeping · listening · thinking · answering ·
//                attention · error (speaking is the old name of answering)
//   moments      greet · success · error · react (a tap) · wake
// A moment plays over the base state and hands back to it. Which state shows
// when (timers, wake triggers, transient states) is decided in one place,
// the controller in assets/js/atlas-bot.js; the scene only poses the robot.
// Every state is a set of pose targets blended at a fixed rate, so a change
// never rebuilds the scene or jumps.
//
// The official Atlas A mark is drawn from its SVG path (unchanged geometry)
// onto a canvas texture and projected onto the forehead and chest as decals.
import {
  ACESFilmicToneMapping, AdditiveBlending, CanvasTexture, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight, Euler,
  BufferAttribute, BufferGeometry, Group, HemisphereLight, MathUtils, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SphereGeometry, SRGBColorSpace,
  TorusGeometry, Vector3, WebGLRenderer
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

// Brand palette (docs/brand): Midnight, Slate, Mist, Snow, Atlas Blue.
export const PALETTE = Object.freeze({ midnight: '#0B1220', slate: '#334155', mist: '#CBD5E1', snow: '#FBFAFC', blue: '#3B82F6', glow: '#6FB0FF' });
// apps/web/assets/brand/Atlas_Mark_Midnight.svg (viewBox 0 0 266 236), verbatim.
export const MARK_PATH = 'M133 8 L22 195 C34 184 46 174 57 165 C68 158 82 153 97 149 L132 92 L174 159 C156 156 137 154 119 155 C101 157 86 162 74 167 C59 173 48 181 39 189 L7 226 L46 226 C51 217 56 210 60 204 C65 198 71 192 78 187 C87 180 97 175 107 171 C117 168 127 166 138 164 C151 164 164 165 176 167 C186 170 194 173 202 177 C211 182 219 188 224 192 L254 226 L258 226 Z';
export const BASE_STATES = Object.freeze(['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error']);
export const MOMENTS = Object.freeze(['greet', 'success', 'error', 'react', 'wake']);
const BASE_ALIASES = Object.freeze({ speaking: 'answering' });

const HEAD = { y: 1.62, scale: new Vector3(0.98, 0.84, 0.88) };
const damp = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const window01 = (t, a, b) => ease((t - a) / (b - a));

function markTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const scale = 232 / 266;
  ctx.translate((256 - 266 * scale) / 2, (256 - 236 * scale) / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(MARK_PATH));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(111,176,255,0.9)');
  gradient.addColorStop(0.4, 'rgba(59,130,246,0.35)');
  gradient.addColorStop(1, 'rgba(59,130,246,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

// The soft contact shadow under the full robot (no light casts it: a blurred
// Midnight ellipse is cheaper than a shadow map and reads the same).
function shadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(11,18,32,0.55)');
  gradient.addColorStop(0.45, 'rgba(11,18,32,0.22)');
  gradient.addColorStop(1, 'rgba(11,18,32,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

// A point on the head ellipsoid at (u, v) in [-1, 1] across the face
// (u: left-right, v: up-down), lifted along the surface normal.
function headSurface(u, v, lift = 0, { halfW = 0.9, halfH = 0.52, centreV = -0.06 } = {}) {
  const phi = Math.PI / 2 + u * halfW;
  const theta = Math.PI / 2 - (v * halfH + centreV);
  const unit = new Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
  const position = unit.clone().multiply(HEAD.scale);
  const normal = new Vector3(unit.x / HEAD.scale.x, unit.y / HEAD.scale.y, unit.z / HEAD.scale.z).normalize();
  return { position: position.addScaledVector(normal, lift), normal };
}

// The visor: a rounded-rectangle (superellipse) patch that follows the head.
function visorGeometry() {
  const cols = 40;
  const rows = 26;
  const positions = [];
  const normals = [];
  const index = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const s = (i / cols) * 2 - 1;
      const t = (j / rows) * 2 - 1;
      const rInf = Math.max(Math.abs(s), Math.abs(t));
      const n = 4.2;
      const norm = rInf === 0 ? 1 : (Math.abs(s) ** n + Math.abs(t) ** n) ** (1 / n);
      const k = rInf === 0 ? 0 : rInf / norm;
      const { position, normal } = headSurface(s * k, t * k, 0.012, { halfW: 0.86, halfH: 0.5, centreV: -0.1 });
      positions.push(position.x, position.y, position.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // Counter-clockwise seen from the front, so the visor faces the camera.
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(index);
  return geometry;
}

function orientTo(mesh, normal) {
  mesh.lookAt(mesh.position.clone().add(normal));
}

// look 'small': the finish for badges shown at 24 px or less, where a glossy
// visor reads as a dark blob: a matte visor with no highlight, a matte shell
// and larger, brighter eyes (see EYE_SCALE).
export const EYE_SCALE = Object.freeze({ normal: 1, small: 1.5 });

export function buildRobot({ look = 'normal' } = {}) {
  const small = look === 'small';
  const disposables = [];
  const keep = (thing) => { disposables.push(thing); return thing; };
  const white = keep(new MeshPhysicalMaterial({ color: PALETTE.snow, roughness: small ? 0.5 : 0.32, metalness: 0, clearcoat: small ? 0.1 : 0.7, clearcoatRoughness: 0.18 }));
  const midnight = keep(new MeshPhysicalMaterial({ color: PALETTE.midnight, roughness: 0.28, metalness: 0.15, clearcoat: 0.6, clearcoatRoughness: 0.2 }));
  const slate = keep(new MeshStandardMaterial({ color: PALETTE.slate, roughness: 0.45, metalness: 0.2 }));
  // A soft studio reflection on the visor, not a mirror of the light box
  // (none at all on the small look).
  const visorMat = keep(small
    ? new MeshPhysicalMaterial({ color: '#0B1220', roughness: 0.9, metalness: 0, clearcoat: 0, envMapIntensity: 0.04 })
    : new MeshPhysicalMaterial({ color: '#070B14', roughness: 0.22, metalness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.28, envMapIntensity: 0.45 }));
  const eyeColor = new Color(small ? '#9FD0FF' : PALETTE.glow);
  const eyeMat = keep(new MeshBasicMaterial({ color: eyeColor.clone(), toneMapped: false }));
  const accent = keep(new MeshBasicMaterial({ color: new Color(PALETTE.blue).multiplyScalar(1.25), toneMapped: false }));
  const chestColor = new Color(PALETTE.blue).multiplyScalar(1.25);
  const chestMat = keep(new MeshBasicMaterial({ color: chestColor.clone(), toneMapped: false }));
  const glowMap = keep(glowTexture());
  const glowMat = keep(new MeshBasicMaterial({ map: glowMap, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, opacity: 0.55 }));
  const chestGlowMat = keep(new MeshBasicMaterial({ map: glowMap, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, opacity: 0.42 }));
  // Unlit, so the A reads as the Midnight brand mark under any light.
  const markMat = keep(new MeshBasicMaterial({ map: keep(markTexture(PALETTE.midnight)), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  const geo = (g) => keep(g);
  const mesh = (g, m) => new Mesh(g, m);

  const root = new Group();
  root.name = 'atlas-mascot';
  const body = new Group();
  body.name = 'body';
  root.add(body);

  // Torso (egg), neck, chest light.
  const torso = mesh(geo(new SphereGeometry(1, 48, 32)), white);
  torso.scale.set(0.56, 0.6, 0.5);
  torso.position.y = 0.72;
  body.add(torso);
  const belt = mesh(geo(new TorusGeometry(0.47, 0.035, 12, 48)), slate);
  belt.rotation.x = Math.PI / 2;
  belt.position.y = 0.5;
  belt.scale.set(1, 0.9, 1);
  body.add(belt);
  const neck = mesh(geo(new CylinderGeometry(0.2, 0.26, 0.2, 32)), midnight);
  neck.position.y = 1.28;
  body.add(neck);
  const chestLight = mesh(geo(new CapsuleGeometry(0.028, 0.2, 6, 12)), chestMat);
  chestLight.rotation.z = Math.PI / 2;
  chestLight.position.set(0, 0.58, 0.49);
  body.add(chestLight);
  const chestGlow = mesh(geo(new PlaneGeometry(0.5, 0.18)), chestGlowMat);
  chestGlow.position.set(0, 0.58, 0.505);
  body.add(chestGlow);

  // Head.
  const head = new Group();
  head.name = 'head';
  head.position.y = HEAD.y;
  body.add(head);
  const skull = mesh(geo(new SphereGeometry(1, 64, 48)), white);
  skull.scale.copy(HEAD.scale);
  head.add(skull);
  const visor = mesh(geo(visorGeometry()), visorMat);
  head.add(visor);

  // Eyes: happy arcs and open ovals, one pair each; expressions toggle them.
  const eyes = [];
  [-1, 1].forEach((side) => {
    const eye = new Group();
    const { position, normal } = headSurface(side * 0.36, -0.02, 0.03, { halfW: 0.86, halfH: 0.5, centreV: -0.1 });
    eye.position.copy(position);
    orientTo(eye, normal);
    const arc = mesh(geo(new TorusGeometry(0.105, 0.028, 10, 28, Math.PI)), eyeMat);
    arc.position.y = -0.035;
    const oval = mesh(geo(new SphereGeometry(1, 20, 14)), eyeMat);
    oval.scale.set(0.068, 0.1, 0.02);
    const glow = mesh(geo(new PlaneGeometry(0.46, 0.46)), glowMat);
    glow.position.z = -0.012;
    eye.add(arc, oval, glow);
    eye.scale.setScalar(small ? EYE_SCALE.small : EYE_SCALE.normal);
    head.add(eye);
    eyes.push({ group: eye, arc, oval, glow, side, base: eye.position.clone() });
  });

  // Ears: white discs with a glowing Atlas Blue ring and a slate centre.
  const earRings = [];
  [-1, 1].forEach((side) => {
    const ear = new Group();
    ear.position.set(side * HEAD.scale.x * 0.97, -0.02, 0);
    ear.rotation.z = Math.PI / 2;
    const disc = mesh(geo(new CylinderGeometry(0.22, 0.22, 0.14, 40)), white);
    const centre = mesh(geo(new CylinderGeometry(0.13, 0.13, 0.16, 32)), slate);
    const ring = mesh(geo(new TorusGeometry(0.17, 0.022, 10, 40)), accent);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = side * -0.075;
    ear.add(disc, centre, ring);
    head.add(ear);
    earRings.push(ring);
  });

  // Limbs. Shoulders and elbows are pivots so the arm can wave.
  const arms = {};
  [-1, 1].forEach((side) => {
    const shoulder = new Group();
    shoulder.position.set(side * 0.5, 1.02, 0);
    const joint = mesh(geo(new SphereGeometry(0.12, 24, 16)), midnight);
    shoulder.add(joint);
    const upper = mesh(geo(new CapsuleGeometry(0.105, 0.16, 8, 20)), white);
    upper.position.y = -0.2;
    shoulder.add(upper);
    const elbow = new Group();
    elbow.position.y = -0.36;
    shoulder.add(elbow);
    const cuff = mesh(geo(new CylinderGeometry(0.1, 0.1, 0.06, 24)), midnight);
    elbow.add(cuff);
    const fore = mesh(geo(new CapsuleGeometry(0.1, 0.1, 8, 20)), white);
    fore.position.y = -0.14;
    elbow.add(fore);
    const hand = new Group();
    hand.position.y = -0.31;
    elbow.add(hand);
    const palm = mesh(geo(new SphereGeometry(0.11, 20, 14)), midnight);
    palm.scale.set(1, 0.9, 0.8);
    hand.add(palm);
    [-0.055, 0, 0.055].forEach((x) => {
      const finger = mesh(geo(new CapsuleGeometry(0.03, 0.06, 4, 10)), midnight);
      finger.position.set(x, -0.1, 0.02);
      hand.add(finger);
    });
    const thumb = mesh(geo(new CapsuleGeometry(0.03, 0.05, 4, 10)), midnight);
    thumb.position.set(-side * 0.095, -0.03, 0.03);
    thumb.rotation.z = -side * 0.9;
    hand.add(thumb);
    body.add(shoulder);
    arms[side < 0 ? 'right' : 'left'] = { shoulder, elbow, hand, side };
  });
  [-1, 1].forEach((side) => {
    const leg = mesh(geo(new CapsuleGeometry(0.13, 0.1, 8, 20)), white);
    leg.position.set(side * 0.2, 0.22, 0);
    body.add(leg);
    const knee = mesh(geo(new TorusGeometry(0.125, 0.025, 8, 28)), slate);
    knee.rotation.x = Math.PI / 2;
    knee.position.set(side * 0.2, 0.3, 0);
    body.add(knee);
    const foot = mesh(geo(new SphereGeometry(1, 28, 18)), midnight);
    foot.scale.set(0.17, 0.09, 0.23);
    foot.position.set(side * 0.21, 0.07, 0.05);
    root.add(foot);
  });

  // Official A mark decals: forehead and chest. The forehead mark sits wholly
  // on the white shell above the visor; the chest mark sits low enough that
  // the head never covers it.
  root.updateMatrixWorld(true);
  const forehead = headSurface(0, 1.56, 0, { halfW: 0.86, halfH: 0.5, centreV: -0.1 });
  const decalAt = (target, point, normal, size) => {
    const probe = new Mesh();
    probe.position.copy(point);
    probe.lookAt(point.clone().add(normal));
    const decal = mesh(geo(new DecalGeometry(target, point, new Euler().copy(probe.rotation), new Vector3(size, size * 0.887, 0.4))), markMat);
    return decal;
  };
  const headDecal = decalAt(skull, head.localToWorld(forehead.position.clone()), forehead.normal, 0.4);
  head.attach(headDecal);
  const chestPoint = new Vector3(0, 0.76, 0.5);
  const chestDecal = decalAt(torso, chestPoint, new Vector3(0, 0.07, 1).normalize(), 0.26);
  body.attach(chestDecal);

  // The contact shadow lies on the floor, outside the robot's root, so it stays
  // put while the robot breathes (shown for the full framing only).
  const shadow = mesh(geo(new PlaneGeometry(1.5, 0.62)), keep(new MeshBasicMaterial({ map: keep(shadowTexture()), transparent: true, depthWrite: false, toneMapped: false, opacity: 0.62 })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.002, 0.04);
  shadow.renderOrder = -1;

  return { root, body, head, eyes, earRings, arms, glowMat, accent, eyeMat, eyeColor, chestMat, chestColor, chestGlowMat, shadow, disposables };
}

// ---------------------------------------------------------------------------
// Scene, renderer and the animation state machine.
// ---------------------------------------------------------------------------
// reducedMotion can change later (setReducedMotion): the system setting or
// Atlas's own preference may be switched while the robot is on screen.
export function createMascotScene(canvas, { reducedMotion: reduced = false, finePointer = false, framing = 'full', look = 'normal', onFrame = null } = {}) {
  let reducedMotion = Boolean(reduced);
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  room.traverse?.((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
  pmrem.dispose();
  scene.add(new HemisphereLight(0xffffff, 0xcbd5e1, 0.55));
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(2.5, 4, 5);
  scene.add(key);
  const rim = new DirectionalLight(0x9cc3ff, 0.9);
  rim.position.set(-3, 2.5, -3);
  scene.add(rim);

  const robot = buildRobot({ look });
  scene.add(robot.root);
  scene.add(robot.shadow);
  const camera = new PerspectiveCamera(26, 1, 0.1, 40);
  // full: the whole robot; bust: head and shoulders; badge: the head, filling
  // a small square; badge-small: a tighter crop on the face for 24 px or less.
  const frames = { full: { y: 1.14, z: 6.4, look: 1.1 }, bust: { y: 1.62, z: 4.2, look: 1.56 }, badge: { y: 1.6, z: 4.25, look: 1.58 }, 'badge-small': { y: 1.6, z: 4.0, look: 1.6 } };
  let frame = frames[framing] || frames.full;
  const placeCamera = () => { camera.position.set(0, frame.y, frame.z); camera.lookAt(0, frame.look, 0); robot.shadow.visible = frame === frames.full; };
  placeCamera();

  // Pose values (current) and their targets. eyeLight: eye brightness; chest:
  // the chest light; sleepy: eyelids (1 = closed); scan: which eye is lit
  // brighter while thinking (-1 · 1); eyeX / eyeUp: where the eyes look.
  const REST = { bob: 0, bodyYaw: 0, bodyRoll: 0, headYaw: 0, headPitch: 0, headRoll: 0, rShoulder: -0.2, rElbow: -0.05, lShoulder: 0.2, lElbow: 0.05, rShoulderX: 0, lShoulderX: 0, squash: 1, glow: 1, happy: 0.35, eyeUp: 0, eyeX: 0, eyeOpen: 1, eyeLight: 1, chest: 1, sleepy: 0, scan: 0, confused: 0 };
  const pose = { ...REST, rShoulder: -0.2, rElbow: 0, lElbow: 0 };
  const wallClock = () => globalThis.performance?.now?.() ?? Date.now();
  // How long each moment lasts, in seconds: [animated, reduced motion].
  const MOMENT_LENGTH = { greet: [2.9, 1.2], success: [1.2, 1.5], react: [0.6, 0.9], wake: [0.8, 0.8], error: [2.2, 2.2] };
  const momentTime = (t) => (reducedMotion ? (wallClock() - status.momentWall) / 1000 : t - status.momentAt);
  function endMomentIfOver(t) {
    if (status.moment && momentTime(t) > (MOMENT_LENGTH[status.moment]?.[reducedMotion ? 1 : 0] ?? 0)) status.moment = null;
  }
  const status = { base: 'idle', baseSince: 0, moment: null, momentAt: 0, momentWall: 0, greetings: 0, frames: 0, time: 0, pointer: { x: 0, y: 0, active: false }, blinkAt: 2.5, blinkUntil: 0, lookAt: 7, lookUntil: 0, lookSide: 1 };

  // Where each base state puts the robot. t: seconds; calm: motion allowed.
  function baseTargets(out, t, calm) {
    const breathe = (speed, amount) => { out.bob = amount * Math.sin(t * speed); out.squash = 1 + amount * 0.4 * Math.sin(t * speed * 1.4); };
    switch (status.base) {
      case 'awake':
        // Attentive: eyes a touch wider and brighter, facing the viewer.
        Object.assign(out, { eyeOpen: 1.06, eyeLight: 1.16, glow: 1.3, headPitch: -0.03 });
        if (calm) { breathe(1.25, 0.012); out.headRoll = 0.015 * Math.sin(t * 0.53); }
        break;
      case 'sleeping':
        // Eyes closed, head dipped, glow down, slow breathing.
        Object.assign(out, { sleepy: 1, eyeLight: 0.62, glow: 0.42, chest: 0.55, headPitch: 0.17, headRoll: 0.05, happy: 0, rShoulder: -0.14, lShoulder: 0.14 });
        if (calm) { breathe(0.7, 0.014); out.headPitch += 0.015 * Math.sin(t * 0.7 + 0.6); }
        break;
      case 'listening':
        // A soft, slow blue pulse in the eyes and the chest; an attentive tilt.
        Object.assign(out, { headRoll: -0.09, headPitch: 0.05, happy: 0, eyeOpen: 1.08, eyeLight: 1.12, glow: 1.2, chest: 1.3 });
        if (calm) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 1.9);
          out.glow = 1.08 + 0.32 * pulse;
          out.eyeLight = 1.04 + 0.14 * pulse;
          out.chest = 1.05 + 0.6 * pulse;
          out.headRoll += 0.02 * Math.sin(t * 0.8);
        }
        break;
      case 'thinking':
        // Eyes up and scanning side to side, lit in turn; head tilted, hand
        // to the chin. No spinner, nothing fast.
        Object.assign(out, { headRoll: 0.12, headPitch: -0.07, headYaw: -0.1, eyeUp: 0.7, eyeX: 0.03, happy: 0, glow: 1.05, rShoulder: -0.55, rElbow: -1.9, rShoulderX: -0.5 });
        if (calm) {
          out.eyeX = 0.03 + 0.045 * Math.sin(t * 1.3);
          out.scan = Math.sin(t * 2.2);
          out.headYaw += 0.04 * Math.sin(t * 0.9);
          out.bodyRoll = 0.02 * Math.sin(t * 1.1);
        }
        break;
      case 'answering':
        // Settled, looking a little down and to the left, toward the answer.
        Object.assign(out, { headPitch: 0.1, headYaw: -0.1, eyeX: -0.03, eyeUp: -0.35, happy: 0.4, eyeLight: 1.08, glow: 1.12, bodyYaw: -0.03 });
        if (calm) { out.headRoll = 0.025 * Math.sin(t * 1.1); out.glow = 1.12 + 0.06 * Math.sin(t * 1.6); out.bodyYaw = -0.03 + 0.015 * Math.sin(t * 0.9); breathe(1.25, 0.008); }
        break;
      case 'attention':
        // Something needs the person: brighter, a slight tilt, idle stops.
        Object.assign(out, { glow: 1.55, eyeLight: 1.22, eyeOpen: 1.14, chest: 1.6, headRoll: 0.12, headPitch: -0.05, happy: 0 });
        break;
      case 'error':
        // Unavailable: still, eyes dimmer, head a little down. Blue, never red.
        Object.assign(out, { glow: 0.5, eyeLight: 0.62, eyeOpen: 0.86, chest: 0.6, headPitch: 0.14, headRoll: 0.05, confused: 0.3, happy: 0, rShoulder: -0.12, lShoulder: 0.12 });
        break;
      default:
        // Idle: barely visible breathing, a slow drift and now and then a
        // short look aside.
        if (calm) {
          breathe(1.25, 0.018);
          out.headYaw = 0.04 * Math.sin(t * 0.37);
          out.headRoll = 0.02 * Math.sin(t * 0.53);
          if (t >= status.lookAt) { status.lookUntil = t + 1.5; status.lookAt = t + 8 + Math.random() * 7; status.lookSide = -status.lookSide; }
          if (t < status.lookUntil) { out.headYaw += 0.16 * status.lookSide; out.eyeX = 0.025 * status.lookSide; out.headPitch = -0.03; }
        }
    }
  }

  function targets(t) {
    const out = { ...REST };
    const calm = !reducedMotion;
    baseTargets(out, t, calm);
    // Looking toward the pointer (desktop, not while a moment plays, not while
    // the robot thinks, answers, sleeps or is unavailable).
    const tracks = ['idle', 'awake', 'listening', 'attention'].includes(status.base);
    if (finePointer && calm && tracks && status.pointer.active && !status.moment) {
      out.headYaw = MathUtils.clamp(status.pointer.x * 0.5, -0.5, 0.5);
      // pointer.y grows downwards and a positive head pitch tips the face down,
      // so the robot looks down at a pointer below it and up at one above.
      out.headPitch = MathUtils.clamp(status.pointer.y * 0.25, -0.22, 0.22);
    }
    // Moments.
    // Reduced motion draws a still frame only when something changes, so a
    // moment's clock is the real one there (it ends on time, not after many
    // frames).
    // A moment that is over by now ends before this frame is drawn, not
    // after it: under reduced motion the frame drawn at the next change may
    // be the last one for a long while, and must show that state (an error
    // stays dimmed), never the pose of a moment that has already ended.
    endMomentIfOver(t);
    const m = status.moment;
    const since = momentTime(t);
    if (m === 'greet') {
      if (reducedMotion) {
        Object.assign(out, { rShoulder: -2.45, rElbow: -0.35, happy: out.sleepy > 0.5 ? 0 : 1, headYaw: 0, headPitch: 0.04 });
      } else {
        const up = window01(since, 0.25, 0.7) * (1 - window01(since, 2.25, 2.8));
        out.headYaw = MathUtils.lerp(out.headYaw, 0.1, window01(since, 0, 0.4));
        out.headPitch = MathUtils.lerp(out.headPitch, 0.06, window01(since, 0, 0.4));
        out.bodyYaw = 0.12 * up;
        out.rShoulder = MathUtils.lerp(-0.2, -2.5, up);
        out.rShoulderX = 0.25 * up;
        const waving = since > 0.7 && since < 2.25 ? Math.sin((since - 0.7) * Math.PI * 2 * 1.9) : 0;
        out.rElbow = MathUtils.lerp(-0.05, -0.35 + 0.42 * waving, up);
        out.happy = 1;
        out.sleepy = 0;
        out.bob += 0.02 * up;
      }
    } else if (m === 'success') {
      // Restrained: a brief brightening, a small nod, then an upward posture.
      const d = 1.2;
      const k = Math.sin(Math.min(1, since / d) * Math.PI);
      out.happy = 1;
      out.glow = Math.max(out.glow, 1 + 0.5 * k);
      out.eyeLight = Math.max(out.eyeLight, 1 + 0.2 * k);
      if (!reducedMotion) {
        const nod = since < 0.6 ? Math.sin((since / 0.6) * Math.PI) : 0;
        out.headPitch = 0.14 * nod - 0.06 * window01(since, 0.5, 0.8) * k;
        out.bob += 0.025 * k;
        out.lShoulder = 0.2 + 0.12 * k;
        out.rShoulder = -0.2 - 0.12 * k;
      }
    } else if (m === 'react') {
      const d = 0.6;
      const k = Math.sin(Math.min(1, since / d) * Math.PI);
      if (!reducedMotion) { out.bob += 0.06 * k; out.squash = 1 + 0.025 * k; }
      out.happy = 1;
    } else if (m === 'wake') {
      // Waking: eyes open and a small lift of the head.
      const d = 0.8;
      const k = Math.sin(Math.min(1, since / d) * Math.PI);
      if (!reducedMotion) { out.headPitch -= 0.06 * k; out.bob += 0.012 * k; }
      out.glow = Math.max(out.glow, 1 + 0.25 * k);
    } else if (m === 'error') {
      Object.assign(out, { headRoll: 0.16, happy: 0, confused: 1, glow: 0.75 });
    }
    return out;
  }

  // Blend rates: going to sleep is slow (the eyes close over about two
  // seconds); everything else, waking included, settles in a fraction of one.
  const rateFor = () => (status.base === 'sleeping' && status.moment !== 'greet' ? 1.6 : 9);

  function apply(dt, t, instant, overrides = null) {
    const goal = { ...targets(t), ...(overrides || {}) };
    const rate = instant ? Infinity : rateFor();
    for (const [name, value] of Object.entries(goal)) if (name in pose) pose[name] = instant ? value : damp(pose[name], value, rate, dt);
    const { root, body, head, eyes, earRings, arms, glowMat, eyeMat, eyeColor, chestMat, chestColor, chestGlowMat, shadow } = robot;
    root.position.y = pose.bob;
    body.rotation.y = pose.bodyYaw;
    body.rotation.z = pose.bodyRoll;
    body.scale.set(1, pose.squash, 1);
    head.rotation.set(pose.headPitch, pose.headYaw, pose.headRoll);
    arms.right.shoulder.rotation.set(pose.rShoulderX, 0, pose.rShoulder);
    arms.right.elbow.rotation.z = pose.rElbow;
    arms.left.shoulder.rotation.set(pose.lShoulderX, 0, pose.lShoulder);
    arms.left.elbow.rotation.z = pose.lElbow;
    // Eyes: blink, happy arcs vs open ovals, closed (sleeping) arcs, a
    // confused (uneven) look.
    let blink = overrides?.blink ?? 1;
    if (!reducedMotion && !overrides && pose.sleepy < 0.2) {
      if (t >= status.blinkAt) { status.blinkUntil = t + 0.14; status.blinkAt = t + 2.6 + Math.random() * 3.4; }
      if (t < status.blinkUntil) blink = 0.12;
    }
    const closed = pose.sleepy > 0.8;
    const happy = !closed && pose.happy > 0.5;
    const lid = Math.max(0.1, 1 - 1.1 * pose.sleepy);
    eyes.forEach((eye) => {
      eye.arc.visible = happy || closed;
      eye.oval.visible = !happy && !closed;
      const uneven = eye.side > 0 ? 1 - 0.35 * pose.confused : 1;
      eye.oval.scale.set(0.068 * pose.eyeOpen, 0.1 * pose.eyeOpen * blink * uneven * lid, 0.02);
      // Closed eyes: the arc turned over, a soft downward curve.
      eye.arc.rotation.z = closed ? Math.PI : 0;
      eye.arc.position.y = closed ? 0.012 : -0.035;
      eye.arc.scale.set(closed ? 0.82 : 1, closed ? 0.5 : blink < 1 ? 0.4 : 1, 1);
      eye.glow.scale.setScalar(1 + 0.22 * pose.scan * eye.side);
      eye.group.position.copy(eye.base);
      eye.group.position.y += 0.05 * pose.eyeUp + (eye.side > 0 ? 0.02 * pose.confused : 0) - 0.03 * pose.sleepy;
      eye.group.position.x += 0.04 * Math.max(0, pose.eyeUp) + pose.eyeX;
    });
    eyeMat.color.copy(eyeColor).multiplyScalar(MathUtils.clamp(pose.eyeLight, 0.3, 1.5));
    chestMat.color.copy(chestColor).multiplyScalar(MathUtils.clamp(0.55 + 0.45 * pose.chest, 0.3, 1.6));
    chestGlowMat.opacity = MathUtils.clamp(0.4 * pose.chest, 0.08, 0.8);
    earRings.forEach((ring) => ring.scale.setScalar(1 + 0.06 * (pose.glow - 1)));
    glowMat.opacity = MathUtils.clamp(0.42 * pose.glow, 0.12, 0.85);
    // The shadow tightens a little as the robot rises.
    const lift = MathUtils.clamp(pose.bob * 4, -0.2, 0.3);
    shadow.scale.setScalar(1 - 0.5 * lift);
    shadow.material.opacity = 0.62 * (1 - lift);
  }

  let size = { w: 1, h: 1 };
  function resize(width, height, pixelRatio) {
    size = { w: Math.max(1, width), h: Math.max(1, height) };
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
  }

  let last = null;
  function step(now, { instant = false, overrides = null } = {}) {
    const seconds = now / 1000;
    // Up to a quarter second per frame: slow frames (software WebGL, a busy
    // phone) keep animations close to real time; longer gaps (a paused loop)
    // do not jump.
    const dt = last === null ? 0 : Math.min(0.25, seconds - last);
    last = seconds;
    status.time += dt;
    apply(dt, status.time, instant, overrides);
    renderer.render(scene, camera);
    status.frames += 1;
    onFrame?.(status);
  }

  // How often to draw: calm idle needs few frames, sleeping fewer still;
  // moments get smooth ones.
  function frameInterval() {
    if (status.moment) return 1000 / 60;
    if (status.base === 'sleeping') return 1000 / 10;
    if (status.base === 'idle' || status.base === 'awake') return 1000 / 30;
    return 1000 / 45;
  }

  return {
    step,
    frameInterval,
    resize,
    // A still frame; overrides pin pose values (the badge renders use this:
    // { happy: 1 } for the smile, { blink: 0.12 } for closed eyes).
    renderStatic(overrides = null) { step((last ?? 0) * 1000 + 16, { instant: true, overrides }); },
    // Changing the base never restarts it: setting the same state again
    // keeps its timing (baseSince), so a stream of updates is one state.
    setBase(name) {
      const value = BASE_ALIASES[name] || (BASE_STATES.includes(name) ? name : 'idle');
      if (value === status.base) return;
      status.base = value;
      status.baseSince = status.time;
      // Under reduced motion a new state ends any (still) moment pose: the
      // next still frame shows the new state, which may stay on screen
      // until the state after it (a success smile never masks an error).
      if (reducedMotion && status.moment) status.moment = null;
    },
    play(moment) {
      if (!MOMENTS.includes(moment)) return;
      // A greeting that is already over (no frame drawn since, e.g. under
      // reduced motion) no longer holds other moments back.
      endMomentIfOver(status.time);
      if (status.moment === 'greet' && moment !== 'greet') return;
      if (moment === 'greet') status.greetings += 1;
      status.moment = moment;
      status.momentAt = status.time;
      status.momentWall = wallClock();
    },
    pointer(x, y, active) { status.pointer = { x, y, active }; },
    setReducedMotion(value) {
      reducedMotion = Boolean(value);
      if (reducedMotion) status.pointer = { x: 0, y: 0, active: false };
    },
    reducedMotion() { return reducedMotion; },
    setFraming(name) { frame = frames[name] || frames.full; placeCamera(); },
    busy() { return Boolean(status.moment); },
    info() {
      const render = renderer.info.render;
      return {
        base: status.base, baseSince: status.baseSince, moment: status.moment, greetings: status.greetings, frames: status.frames, frameInterval: frameInterval(),
        headPitch: pose.headPitch, headYaw: pose.headYaw, headRoll: pose.headRoll,
        pose: { eyeOpen: pose.eyeOpen, eyeLight: pose.eyeLight, glow: pose.glow, chest: pose.chest, sleepy: pose.sleepy, eyeX: pose.eyeX, eyeUp: pose.eyeUp, scan: pose.scan, bob: pose.bob },
        eyes: robot.eyes[0].arc.visible ? (pose.sleepy > 0.8 ? 'closed' : 'happy') : 'open',
        eyeColor: `#${robot.eyeMat.color.getHexString()}`,
        shadow: robot.shadow.visible,
        triangles: render.triangles, calls: render.calls, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures
      };
    },
    // loseContext: false keeps the canvas's WebGL context (used after the
    // browser restored a lost context, to build a fresh scene on it).
    dispose({ loseContext = true } = {}) {
      robot.disposables.forEach((thing) => thing.dispose?.());
      envTarget.dispose();
      renderer.dispose();
      if (loseContext) renderer.forceContextLoss?.();
    }
  };
}
