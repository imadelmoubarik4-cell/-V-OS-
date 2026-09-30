// Alcedo mascot: the 3D common-kingfisher scene (source).
//
// A drop-in replacement for scripts/mascot/atlas-mascot-scene.src.mjs: it
// exports the SAME createMascotScene(canvas, opts) interface, the same base
// state and moment names, and the same returned controls, so the existing
// loader (apps/web/assets/js/atlas-bot.js) can consume it unchanged.
//
// Like the robot, the bird is built procedurally from Three.js primitives
// (spheres / capsules / cones / lathe), rigged as a hierarchy of pivots
// (root, body, head, wings, tail, lower-beak, eyelids) and animated by a small
// pose state machine:
//   base states  idle · awake · sleeping · listening · thinking · answering ·
//                attention · error   (speaking is an alias of answering)
//   moments      greet · success · error · react · wake
// Every state is a set of pose targets blended at a fixed rate, so a change
// never rebuilds the scene or jumps. Motion is restrained and natural: a bird
// at rest that breathes, blinks, turns its head and, on success, lifts its
// wings — never continuous flight.
//
// Colour/proportion/silhouette follow an approved common-kingfisher reference
// and the Alcedo brand palette (teal-cyan crown/wings/back over the deep-teal
// shadow, an orange breast, white throat/cheek flashes, a long charcoal beak
// and orange feet).
import {
  ACESFilmicToneMapping, CanvasTexture, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, Group, HemisphereLight, MathUtils, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PMREMGenerator, RepeatWrapping, Scene,
  SphereGeometry, SRGBColorSpace, Vector3, WebGLRenderer
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Brand + reference palette (from the approved 12-pose sheet).
export const PALETTE = Object.freeze({
  crown: '#127E93',      // crown / nape: darker teal, finely cyan-speckled
  electric: '#1AAED2',   // back / wings / tail: vivid electric blue (brighter)
  teal: '#1E9FB8',       // Alcedo mid teal (general brand tone)
  deepTeal: '#08495C',   // Alcedo deep teal: shadowed feathers, wing edges
  speck: '#7FE4F2',      // the bright-cyan speckles on the crown and wings
  wingUnder: '#8C8172',  // muted grey-brown wing undersides (seen on lift)
  orange: '#E8732A',     // breast and belly (warm burnt orange)
  orangeDeep: '#C85A18', // shadowed belly / cheek edge
  foot: '#F0892E',       // bright orange feet
  white: '#F8F5ED',      // cheek / throat / ear-spot patches
  beak: '#26292E',       // charcoal near-black beak
  eye: '#0E0B09',        // large dark near-black eye
  ground: '#08495C'      // colour of the contact shadow
});

export const BASE_STATES = Object.freeze(['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error']);
export const MOMENTS = Object.freeze(['greet', 'success', 'error', 'react', 'wake']);
const BASE_ALIASES = Object.freeze({ speaking: 'answering' });

const damp = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const window01 = (t, a, b) => ease((t - a) / (b - a));

// The head is an ellipsoid centred inside the head pivot. Features (eyes,
// cheeks, throat, beak) sit on its surface, placed by azimuth/elevation.
const HEAD = { cx: 0, cy: 0.30, cz: 0.02, rx: 0.60, ry: 0.56, rz: 0.60 };

// A point on the head ellipsoid at (azimuth, elevation) with azimuth 0 = front
// (+Z), positive = the bird's left (+X); elevation 0 = the eye line, + = up.
// Returned in head-group local space, lifted along the surface normal.
function headSurface(azim, elev, lift = 0) {
  const dir = new Vector3(Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev));
  const position = new Vector3(HEAD.cx + dir.x * HEAD.rx, HEAD.cy + dir.y * HEAD.ry, HEAD.cz + dir.z * HEAD.rz);
  const normal = new Vector3(dir.x / HEAD.rx, dir.y / HEAD.ry, dir.z / HEAD.rz).normalize();
  return { position: position.addScaledVector(normal, lift), normal };
}

// The speckled feather texture: a base tint with scattered lighter cyan
// flecks, the field mark of a common kingfisher's crown and wing coverts.
function speckleTexture(base, speck) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = speck;
  for (let i = 0; i < 230; i += 1) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 1.1 + Math.random() * 2.2;
    ctx.globalAlpha = 0.35 + Math.random() * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// The soft contact shadow under the bird (a blurred deep-teal ellipse: cheaper
// than a shadow map and reads the same), matching the robot's approach.
function shadowTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const c = new Color(color);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, `rgba(${rgb},0.5)`);
  gradient.addColorStop(0.45, `rgba(${rgb},0.2)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function orientTo(object, normal) {
  object.lookAt(object.position.clone().add(normal));
}

// look 'small' brightens and enlarges the eyes for badges shown at 24 px or
// less, where fine feather detail is lost (mirrors the robot's EYE_SCALE).
export const EYE_SCALE = Object.freeze({ normal: 1, small: 1.35 });

export function buildKingfisher({ look = 'normal' } = {}) {
  const small = look === 'small';
  const disposables = [];
  const keep = (thing) => { disposables.push(thing); return thing; };
  const geo = (g) => keep(g);
  const mesh = (g, m) => new Mesh(g, m);

  // Feather materials. Standard (matte-ish) rather than the robot's glossy
  // physical shells: feathers are soft. The env map gives a gentle sheen.
  // Crown/nape are a darker teal; back/wings/tail a brighter electric blue.
  const crownMap = keep(speckleTexture(PALETTE.crown, PALETTE.speck));
  const backMap = keep(speckleTexture(PALETTE.electric, PALETTE.speck));
  const crownMat = keep(new MeshStandardMaterial({ color: 0xffffff, map: crownMap, roughness: 0.74, metalness: 0.06, envMapIntensity: 0.55 }));
  const backMat = keep(new MeshStandardMaterial({ color: 0xffffff, map: backMap, roughness: 0.68, metalness: 0.08, envMapIntensity: 0.7 }));
  const deepTealMat = keep(new MeshStandardMaterial({ color: PALETTE.deepTeal, roughness: 0.78, metalness: 0.05, envMapIntensity: 0.5 }));
  const wingUnderMat = keep(new MeshStandardMaterial({ color: PALETTE.wingUnder, roughness: 0.88, metalness: 0.02, envMapIntensity: 0.4 }));
  const orangeMat = keep(new MeshStandardMaterial({ color: PALETTE.orange, roughness: 0.82, metalness: 0.02, envMapIntensity: 0.45 }));
  const orangeDeepMat = keep(new MeshStandardMaterial({ color: PALETTE.orangeDeep, roughness: 0.85, metalness: 0.02, envMapIntensity: 0.4 }));
  const whiteMat = keep(new MeshStandardMaterial({ color: PALETTE.white, roughness: 0.7, metalness: 0.02, envMapIntensity: 0.5 }));
  const footMat = keep(new MeshStandardMaterial({ color: PALETTE.foot, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.5 }));
  const beakMat = keep(new MeshPhysicalMaterial({ color: PALETTE.beak, roughness: 0.38, metalness: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.35, envMapIntensity: 0.7 }));
  const eyeMat = keep(new MeshPhysicalMaterial({ color: PALETTE.eye, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.1 }));
  const shineMat = keep(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));

  const root = new Group();
  root.name = 'alcedo-mascot';
  // Front-facing and symmetric: the FRONT idle pose. A zero base yaw makes a
  // left head-turn and a right head-turn true mirror images across the camera.
  root.rotation.y = 0;

  const body = new Group();
  body.name = 'body';
  root.add(body);

  // Torso: a plump egg, electric-blue over the back, tilted a touch upright.
  const torso = mesh(geo(new SphereGeometry(1, 48, 36)), backMat);
  torso.scale.set(0.64, 0.74, 0.66);
  torso.position.set(0, 0.86, 0);
  torso.rotation.x = -0.12;
  body.add(torso);

  // Orange breast/belly: a second egg pushed to the front and down, so orange
  // shows on the belly and chest while teal stays on the back and shoulders.
  const belly = mesh(geo(new SphereGeometry(1, 44, 32)), orangeMat);
  belly.scale.set(0.55, 0.64, 0.5);
  belly.position.set(0, 0.8, 0.22);
  body.add(belly);
  const bellyLow = mesh(geo(new SphereGeometry(1, 36, 26)), orangeDeepMat);
  bellyLow.scale.set(0.42, 0.32, 0.4);
  bellyLow.position.set(0, 0.42, 0.2);
  body.add(bellyLow);

  // A short dark-teal nape to bridge body and head.
  const neck = mesh(geo(new SphereGeometry(1, 32, 24)), crownMat);
  neck.scale.set(0.34, 0.3, 0.34);
  neck.position.set(0, 1.24, 0.06);
  body.add(neck);

  // --- Head (pivot at the neck, so a nod turns about the neck) ------------
  const head = new Group();
  head.name = 'head';
  head.position.set(0, 1.28, 0.02);
  body.add(head);
  const skull = mesh(geo(new SphereGeometry(1, 56, 44)), crownMat);
  skull.scale.set(HEAD.rx, HEAD.ry, HEAD.rz);
  skull.position.set(HEAD.cx, HEAD.cy, HEAD.cz);
  head.add(skull);

  // A flat-topped crown reads as a kingfisher: a slightly flattened dark-teal
  // cap, finely cyan-speckled.
  const crown = mesh(geo(new SphereGeometry(1, 40, 28, 0, Math.PI * 2, 0, Math.PI * 0.55)), crownMat);
  crown.scale.set(HEAD.rx * 1.01, HEAD.ry * 0.92, HEAD.rz * 1.01);
  crown.position.set(HEAD.cx, HEAD.cy + 0.02, HEAD.cz);
  head.add(crown);

  // A surface patch (orange cheeks, white throat/neck flashes): a flattened
  // disc laid on the head, oriented to the surface normal.
  const patchAt = (azim, elev, w, h, material, lift = 0.02) => {
    const { position, normal } = headSurface(azim, elev, lift);
    const patch = mesh(geo(new SphereGeometry(1, 24, 18)), material);
    patch.position.copy(position);
    orientTo(patch, normal);
    patch.scale.set(w, h, 0.02);
    head.add(patch);
    return patch;
  };
  // Orange ear-coverts below and behind each eye (symmetric), reaching down
  // toward the breast as in the reference.
  patchAt(0.82, -0.24, 0.2, 0.22, orangeMat);
  patchAt(-0.82, -0.24, 0.2, 0.22, orangeMat);
  // White throat at the chin and a small white flash low on each side.
  patchAt(0, -0.66, 0.2, 0.17, whiteMat, 0.015);
  patchAt(1.28, -0.5, 0.12, 0.16, whiteMat);
  patchAt(-1.28, -0.5, 0.12, 0.16, whiteMat);
  // The white throat continues up behind each eye as a small ear-spot.
  patchAt(1.18, -0.02, 0.09, 0.12, whiteMat);
  patchAt(-1.18, -0.02, 0.09, 0.12, whiteMat);

  // --- Beak: a long straight charcoal dagger, upper fixed + lower on a pivot
  // for a small open/close while speaking. -----------------------------------
  const beakBase = headSurface(0, -0.04, -0.02);
  const beakGroup = new Group();
  beakGroup.position.copy(beakBase.position);
  // Angle the beak forward and gently down so its full length reads even
  // head-on (a straight beak pointed at the camera foreshortens to a dot),
  // without drooping in profile.
  beakGroup.rotation.x = Math.PI / 2 + 0.48;
  head.add(beakGroup);
  // Upper mandible: the solid blade that carries the silhouette. Roughly as
  // long as the head is deep. Flattened top-to-bottom.
  const BEAK_LEN = 1.0;
  const upperBeak = mesh(geo(new ConeGeometry(0.1, BEAK_LEN, 20, 1, false)), beakMat);
  upperBeak.position.set(0, BEAK_LEN * 0.5 + 0.02, 0);
  upperBeak.scale.set(1, 1, 0.72);
  beakGroup.add(upperBeak);
  // Lower mandible: nested directly beneath and slightly inside the upper, so
  // a closed beak reads as one blade; it drops on a pivot to "speak".
  const lowerBeakPivot = new Group();
  lowerBeakPivot.position.set(0, 0.04, 0);
  beakGroup.add(lowerBeakPivot);
  const lowerBeak = mesh(geo(new ConeGeometry(0.082, BEAK_LEN * 0.94, 18, 1, false)), beakMat);
  lowerBeak.position.set(0, BEAK_LEN * 0.47, -0.008);
  lowerBeak.scale.set(0.9, 1, 0.5);
  lowerBeakPivot.add(lowerBeak);

  // --- Eyes with an upper eyelid each (dark, glossy, a small white catch-light)
  const eyes = [];
  const eyeScale = small ? EYE_SCALE.small : EYE_SCALE.normal;
  [1, -1].forEach((side) => {
    const eye = new Group();
    const { position, normal } = headSurface(side * 0.56, 0.12, 0.0);
    eye.position.copy(position);
    orientTo(eye, normal);
    eye.scale.setScalar(eyeScale);
    const rEye = 0.1;
    const ball = mesh(geo(new SphereGeometry(rEye, 24, 18)), eyeMat);
    ball.position.z = -0.035; // sink into the head so the eye is not a bulging dome
    ball.scale.set(1, 1, 0.72); // flatten toward the surface
    eye.add(ball);
    const shine = mesh(geo(new SphereGeometry(rEye * 0.17, 10, 8)), shineMat);
    shine.position.set(-side * 0.028, 0.03, rEye * 0.6);
    eye.add(shine);
    // Upper eyelid: a teal cap pivoted at the top of the eye. Open = tucked
    // back over the brow; closed = swung forward-down over the eye.
    const lidPivot = new Group();
    lidPivot.position.set(0, rEye * 0.92, 0);
    const lid = mesh(geo(new SphereGeometry(rEye * 1.16, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62)), crownMat);
    lid.position.set(0, -rEye * 0.92, 0);
    lidPivot.add(lid);
    eye.add(lidPivot);
    head.add(eye);
    eyes.push({ group: eye, ball, shine, lidPivot, side });
  });

  // --- Wings: a folded, speckled teal wing on each side, pivoted at the
  // shoulder so it can lift briefly on success. ------------------------------
  const wings = [];
  [1, -1].forEach((side) => {
    const pivot = new Group();
    pivot.name = side > 0 ? 'wingL' : 'wingR';
    // Pivot high on the shoulder; the wing hangs down along the flank at rest
    // (reading as a folded wing) and swings up-and-out when raised.
    pivot.position.set(side * 0.3, 1.06, -0.06);
    const wing = mesh(geo(new SphereGeometry(1, 32, 24)), backMat);
    wing.scale.set(0.17, 0.66, 0.4);
    wing.position.set(side * 0.12, -0.5, -0.02);
    wing.rotation.z = side * 0.06;
    pivot.add(wing);
    // The muted grey-brown underside, on the inner face (shown when raised).
    const under = mesh(geo(new SphereGeometry(1, 28, 20)), wingUnderMat);
    under.scale.set(0.14, 0.63, 0.37);
    under.position.set(side * (0.12 - 0.05), -0.5, -0.02);
    under.rotation.z = side * 0.06;
    pivot.add(under);
    // A darker deep-teal wingtip toward the tail.
    const tip = mesh(geo(new ConeGeometry(0.13, 0.5, 16)), deepTealMat);
    tip.position.set(side * 0.1, -1.0, -0.06);
    tip.rotation.set(0.35, 0, side * 0.06);
    pivot.add(tip);
    body.add(pivot);
    const rest = side * 0.05;
    pivot.rotation.z = rest;
    wings.push({ pivot, side, rest });
  });

  // --- Tail: short, teal, angled back and down. -----------------------------
  const tailPivot = new Group();
  tailPivot.position.set(0, 0.64, -0.34);
  body.add(tailPivot);
  const tail = mesh(geo(new ConeGeometry(0.17, 0.72, 18)), backMat);
  tail.scale.set(1, 1, 0.4);
  tail.position.set(0, -0.28, -0.14);
  tail.rotation.x = -2.3; // point back and slightly down
  tailPivot.add(tail);

  // --- Feet: two small orange perched feet with toes. -----------------------
  [1, -1].forEach((side) => {
    const leg = mesh(geo(new CapsuleGeometry(0.045, 0.12, 6, 12)), footMat);
    leg.position.set(side * 0.17, 0.2, 0.16);
    body.add(leg);
    const ankle = mesh(geo(new SphereGeometry(0.06, 16, 12)), footMat);
    ankle.position.set(side * 0.17, 0.12, 0.18);
    body.add(ankle);
    [-0.07, 0, 0.07].forEach((dx) => {
      const toe = mesh(geo(new CapsuleGeometry(0.022, 0.09, 4, 8)), footMat);
      toe.position.set(side * 0.17 + dx, 0.09, 0.26);
      toe.rotation.x = 1.35;
      body.add(toe);
    });
    const back = mesh(geo(new CapsuleGeometry(0.022, 0.06, 4, 8)), footMat);
    back.position.set(side * 0.17, 0.09, 0.11);
    back.rotation.x = -1.35;
    body.add(back);
  });

  // The contact shadow lies on the floor outside the root, so it stays put
  // while the bird breathes (shown for the full framing only).
  const shadow = mesh(geo(new PlaneGeometry(1.4, 0.72)), keep(new MeshBasicMaterial({ map: keep(shadowTexture(PALETTE.ground)), transparent: true, depthWrite: false, toneMapped: false, opacity: 0.6 })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.004, 0.12);
  shadow.renderOrder = -1;

  return { root, body, head, eyes, wings, tailPivot, lowerBeakPivot, shadow, disposables };
}

// ---------------------------------------------------------------------------
// Scene, renderer and the animation state machine.
// ---------------------------------------------------------------------------
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
  scene.add(new HemisphereLight(0xffffff, 0xbfe4ec, 0.6));
  const key = new DirectionalLight(0xfff4e6, 1.55);
  key.position.set(2.6, 4, 5);
  scene.add(key);
  const rim = new DirectionalLight(0x9fd6e6, 0.85);
  rim.position.set(-3, 2.4, -3);
  scene.add(rim);

  const bird = buildKingfisher({ look });
  scene.add(bird.root);
  scene.add(bird.shadow);
  const camera = new PerspectiveCamera(26, 1, 0.1, 40);
  // full: the whole bird; bust: head and shoulders; badge / badge-small: the
  // head filling a small square.
  const frames = { full: { y: 1.2, z: 6.6, look: 1.05 }, bust: { y: 1.5, z: 4.4, look: 1.42 }, badge: { y: 1.5, z: 4.3, look: 1.46 }, 'badge-small': { y: 1.5, z: 4.05, look: 1.48 } };
  let frame = frames[framing] || frames.full;
  const placeCamera = () => { camera.position.set(0, frame.y, frame.z); camera.lookAt(0, frame.look, 0); bird.shadow.visible = frame === frames.full; };
  placeCamera();

  // Pose values (current) and their targets.
  //   bob        root lift            squash    breathing scale
  //   bodyYaw/Roll subtle body sway   headYaw/Pitch/Roll  head aim
  //   beak       lower-beak open      wing      wing lift (0 rest .. 1 raised)
  //   blinkAmt   eyelid cover 0..1    sleepy    settled/eyes-closed 0..1
  //   alert      eye catch-light      eyeX/eyeUp  small gaze shift
  const REST = { bob: 0, bodyYaw: 0, bodyRoll: 0, headYaw: 0, headPitch: 0, headRoll: 0, squash: 1, beak: 0, wing: 0, blinkAmt: 0, sleepy: 0, alert: 1, eyeX: 0, eyeUp: 0, tail: 0 };
  const pose = { ...REST };
  const wallClock = () => globalThis.performance?.now?.() ?? Date.now();
  const MOMENT_LENGTH = { greet: [2.6, 1.2], success: [1.4, 1.5], react: [0.72, 0.9], wake: [0.9, 0.9], error: [2.2, 2.2] };
  const momentTime = (t) => (reducedMotion ? (wallClock() - status.momentWall) / 1000 : t - status.momentAt);
  function endMomentIfOver(t) {
    if (status.moment && momentTime(t) > (MOMENT_LENGTH[status.moment]?.[reducedMotion ? 1 : 0] ?? 0)) status.moment = null;
  }
  const status = { base: 'idle', baseSince: 0, moment: null, momentAt: 0, momentWall: 0, greetings: 0, frames: 0, time: 0, pointer: { x: 0, y: 0, active: false }, blinkAt: 2.5, blinkUntil: 0, lookAt: 6, lookUntil: 0, lookSide: 1 };

  // Where each base state puts the bird. t: seconds; calm: motion allowed.
  function baseTargets(out, t, calm) {
    const breathe = (speed, amount) => { out.bob = amount * Math.sin(t * speed); out.squash = 1 + amount * 0.5 * Math.sin(t * speed); };
    switch (status.base) {
      case 'awake':
        Object.assign(out, { headPitch: -0.06, alert: 1.2 });
        if (calm) { breathe(1.15, 0.012); out.headRoll = 0.02 * Math.sin(t * 0.6); }
        break;
      case 'sleeping':
        // Eyes closed, head dipped and turned into the shoulder, settled.
        Object.assign(out, { sleepy: 1, blinkAmt: 1, headPitch: 0.22, headRoll: 0.14, headYaw: 0.28, alert: 0.6, wing: 0 });
        if (calm) { breathe(0.62, 0.016); out.headPitch += 0.02 * Math.sin(t * 0.62 + 0.6); }
        break;
      case 'listening':
        // Alert: upright, head lifted and cocked, a slow slight turn.
        Object.assign(out, { headPitch: -0.08, headRoll: -0.1, headYaw: 0.06, alert: 1.25 });
        if (calm) { breathe(1.2, 0.01); out.headYaw = 0.06 + 0.07 * Math.sin(t * 0.7); out.headRoll += 0.03 * Math.sin(t * 1.1); }
        break;
      case 'thinking':
        // A curious cocked head, gaze up, small side-to-side musing.
        Object.assign(out, { headRoll: 0.16, headPitch: -0.05, headYaw: -0.12, eyeUp: 0.5, alert: 1.1 });
        if (calm) { out.headYaw = -0.12 + 0.08 * Math.sin(t * 0.8); out.headRoll = 0.16 + 0.04 * Math.sin(t * 1.2); out.eyeX = 0.4 * Math.sin(t * 0.9); breathe(1.1, 0.008); }
        break;
      case 'answering':
        // Settled toward the viewer, small natural beak movements while it
        // "speaks", a gentle head bob.
        Object.assign(out, { headPitch: 0.04, headYaw: 0.02, eyeUp: -0.1, alert: 1.12 });
        if (calm) {
          const talk = 0.5 + 0.5 * Math.sin(t * 7.5);
          out.beak = 0.18 + 0.22 * Math.max(0, Math.sin(t * 6.2));
          out.headPitch = 0.04 + 0.03 * Math.sin(t * 3.1) - 0.02 * talk;
          out.headYaw = 0.02 + 0.04 * Math.sin(t * 1.3);
          breathe(1.3, 0.008);
        }
        break;
      case 'attention':
        // Chin lifted, beak angled up: the HEAD-UP pose.
        Object.assign(out, { headPitch: -0.16, headRoll: 0.06, alert: 1.35, bob: 0.01 });
        if (calm) { breathe(1.2, 0.008); }
        break;
      case 'error':
        // Concerned: a gentle head tilt and dip, settled. No red anywhere.
        Object.assign(out, { headRoll: 0.2, headPitch: 0.12, headYaw: -0.06, alert: 0.85, wing: 0 });
        break;
      default:
        // Idle: barely-there breathing, a slow head drift and an occasional
        // look aside.
        if (calm) {
          breathe(1.15, 0.014);
          out.headYaw = 0.05 * Math.sin(t * 0.34);
          out.headRoll = 0.025 * Math.sin(t * 0.5);
          if (t >= status.lookAt) { status.lookUntil = t + 1.4; status.lookAt = t + 7 + Math.random() * 6; status.lookSide = -status.lookSide; }
          if (t < status.lookUntil) { out.headYaw += 0.2 * status.lookSide; out.headPitch = -0.04; out.eyeX = 0.5 * status.lookSide; }
        }
    }
  }

  function targets(t) {
    const out = { ...REST };
    const calm = !reducedMotion;
    baseTargets(out, t, calm);
    const tracks = ['idle', 'awake', 'listening', 'attention'].includes(status.base);
    if (finePointer && calm && tracks && status.pointer.active && !status.moment) {
      out.headYaw = MathUtils.clamp(status.pointer.x * 0.5, -0.5, 0.5);
      out.headPitch = MathUtils.clamp(status.pointer.y * 0.28, -0.24, 0.24);
    }
    endMomentIfOver(t);
    const m = status.moment;
    const since = momentTime(t);
    if (m === 'greet') {
      if (reducedMotion) {
        Object.assign(out, { headPitch: -0.08, headYaw: 0.04, wing: 0.5, sleepy: 0, blinkAmt: 0, alert: 1.3 });
      } else {
        const up = window01(since, 0.2, 0.55) * (1 - window01(since, 2.0, 2.55));
        out.headPitch = MathUtils.lerp(out.headPitch, -0.12, up);
        out.bob += 0.05 * up;
        out.squash = 1 + 0.05 * up;
        // A quick friendly double wing-flick.
        const flick = since > 0.3 && since < 1.8 ? Math.max(0, Math.sin((since - 0.3) * Math.PI * 2.2)) : 0;
        out.wing = Math.max(out.wing, 0.55 * up * (0.4 + 0.6 * flick));
        out.alert = 1.35;
        out.sleepy = 0;
        out.blinkAmt = 0;
      }
    } else if (m === 'success') {
      // A brief wing lift and a nod, then settle: the signature happy beat.
      const d = 1.4;
      const k = Math.sin(Math.min(1, since / d) * Math.PI);
      out.alert = Math.max(out.alert, 1.25);
      if (!reducedMotion) {
        out.wing = Math.max(out.wing, window01(since, 0.05, 0.35) * (1 - window01(since, 0.9, 1.4)));
        const nod = since < 0.6 ? Math.sin((since / 0.6) * Math.PI) : 0;
        out.headPitch = 0.14 * nod - 0.05 * window01(since, 0.5, 0.9) * k;
        out.bob += 0.04 * k;
      } else {
        out.wing = 0.7;
        out.headPitch = -0.05;
      }
    } else if (m === 'react') {
      // A small jump: a crouch (JUMP PREP / anticipation), then a spring up
      // with the wings out and the feet leaving the perch, then a landing.
      const crouch = window01(since, 0, 0.13) * (1 - window01(since, 0.13, 0.28));
      const air = window01(since, 0.15, 0.32) * (1 - window01(since, 0.4, 0.62));
      if (!reducedMotion) {
        out.bob += 0.3 * air - 0.045 * crouch;
        out.squash = 1 - 0.08 * crouch + 0.04 * air;
        out.wing = Math.max(out.wing, 0.6 * air);
        out.headPitch += 0.05 * crouch - 0.06 * air; // lean into it, then lift
      }
      out.alert = Math.max(out.alert, 1.3);
    } else if (m === 'wake') {
      // Waking with a small anticipatory hop and a head lift.
      const d = 0.9;
      const k = Math.sin(Math.min(1, since / d) * Math.PI);
      out.sleepy = Math.min(out.sleepy, 1 - k);
      out.blinkAmt = Math.min(out.blinkAmt, 1 - k);
      if (!reducedMotion) { out.headPitch -= 0.08 * k; out.bob += 0.08 * window01(since, 0.1, 0.35) * (1 - window01(since, 0.4, 0.7)); }
      out.alert = Math.max(out.alert, 1 + 0.3 * k);
    } else if (m === 'error') {
      Object.assign(out, { headRoll: 0.24, headPitch: 0.14, alert: 0.85 });
    }
    return out;
  }

  // Going to sleep is slow (the eyelids close over about two seconds);
  // everything else, waking included, settles in a fraction of one.
  const rateFor = () => (status.base === 'sleeping' && status.moment !== 'greet' && status.moment !== 'wake' ? 1.6 : 9);

  function apply(dt, t, instant, overrides = null) {
    const goal = { ...targets(t), ...(overrides || {}) };
    const rate = instant ? Infinity : rateFor();
    for (const [name, value] of Object.entries(goal)) if (name in pose) pose[name] = instant ? value : damp(pose[name], value, rate, dt);
    const { root, body, head, eyes, wings, tailPivot, lowerBeakPivot, shadow } = bird;
    root.position.y = pose.bob;
    body.rotation.y = pose.bodyYaw;
    body.rotation.z = pose.bodyRoll;
    body.scale.set(1 + (1 - pose.squash) * 0.5, pose.squash, 1 + (1 - pose.squash) * 0.5);
    head.rotation.set(pose.headPitch, pose.headYaw, pose.headRoll);
    lowerBeakPivot.rotation.x = 0.3 * MathUtils.clamp(pose.beak, 0, 1);
    tailPivot.rotation.x = -0.12 * pose.tail;

    // Blink: an automatic quick blink while awake, on top of any pose cover.
    let blink = pose.blinkAmt;
    if (!reducedMotion && !overrides && pose.sleepy < 0.3) {
      if (t >= status.blinkAt) { status.blinkUntil = t + 0.13; status.blinkAt = t + 2.6 + Math.random() * 3.6; }
      if (t < status.blinkUntil) blink = 1;
    }
    const cover = MathUtils.clamp(Math.max(blink, pose.sleepy), 0, 1);
    eyes.forEach((eye) => {
      // Eyelid: open = tucked back (-1.35), closed = drawn down over the eye.
      eye.lidPivot.rotation.x = MathUtils.lerp(-1.35, 0.35, cover);
      eye.shine.visible = cover < 0.5;
      eye.shine.scale.setScalar(MathUtils.clamp(pose.alert, 0.6, 1.5));
      eye.group.position.x += 0; // placeholder to keep base intact
    });
    // Small gaze shift: nudge each eye's catch-light for life.
    eyes.forEach((eye) => { eye.shine.position.x = -eye.side * 0.03 + pose.eyeX * 0.03; eye.shine.position.y = 0.035 + pose.eyeUp * 0.03; });

    wings.forEach((w) => {
      const lift = MathUtils.clamp(pose.wing, 0, 1);
      // Swing up and out (sign chosen so each wing opens outward, symmetric),
      // with a slight forward tilt so the raised wings read as spread.
      w.pivot.rotation.z = w.rest + w.side * 1.55 * lift;
      w.pivot.rotation.x = -0.3 * lift;
    });

    // The shadow tightens a little as the bird rises.
    const rise = MathUtils.clamp(pose.bob * 4, -0.2, 0.3);
    shadow.scale.setScalar(1 - 0.5 * rise);
    shadow.material.opacity = 0.6 * (1 - rise);
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

  return {
    step,
    frameInterval,
    resize,
    renderStatic(overrides = null) { step((last ?? 0) * 1000 + 16, { instant: true, overrides }); },
    setBase(name) {
      const value = BASE_ALIASES[name] || (BASE_STATES.includes(name) ? name : 'idle');
      if (value === status.base) return;
      status.base = value;
      status.baseSince = status.time;
      if (reducedMotion && status.moment) status.moment = null;
    },
    play(moment) {
      if (!MOMENTS.includes(moment)) return;
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
        pose: { squash: pose.squash, beak: pose.beak, wing: pose.wing, sleepy: pose.sleepy, blinkAmt: pose.blinkAmt, alert: pose.alert, bob: pose.bob },
        shadow: bird.shadow.visible,
        triangles: render.triangles, calls: render.calls, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures
      };
    },
    dispose({ loseContext = true } = {}) {
      bird.disposables.forEach((thing) => thing.dispose?.());
      envTarget.dispose();
      renderer.dispose();
      if (loseContext) renderer.forceContextLoss?.();
    }
  };
}
