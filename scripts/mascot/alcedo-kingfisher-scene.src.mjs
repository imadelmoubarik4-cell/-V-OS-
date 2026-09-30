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
  ACESFilmicToneMapping, BufferAttribute, CanvasTexture, CapsuleGeometry, Color, ConeGeometry,
  DirectionalLight, Group, HemisphereLight, LatheGeometry, MathUtils, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PMREMGenerator,
  Quaternion, RepeatWrapping, Scene, SphereGeometry, SRGBColorSpace, Vector2, Vector3, WebGLRenderer
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Palette sampled directly from the approved master photo (8.webp).
export const PALETTE = Object.freeze({
  crown: '#134F61',      // crown / nape base: rich deep teal
  crownSpangle: '#54C4D8', // bright cyan crown spangles
  electric: '#0A7CA4',   // back / wing coverts: electric teal-blue
  electricDeep: '#063E54', // shadowed back / wing base
  covertSpot: '#7ED6E8', // cyan spots on the wing coverts
  primary: '#24303A',    // dark grey-blue primary tips
  teal: '#0B6DA9',       // tail blue
  deepTeal: '#083D50',   // deepest shadow feathers
  orange: '#D97826',     // breast: deep warm orange
  orangeUp: '#E58230',   // upper breast, a touch brighter
  orangeDeep: '#B4601A', // shadowed breast
  cream: '#E9D8B4',      // low belly, fading to cream
  foot: '#EF7C1E',       // bright orange feet
  claw: '#17130E',       // dark claws
  white: '#F4F0EB',      // white throat and cheek/neck patch
  beak: '#1E1F22',       // long black beak
  beakBase: '#6E513F',   // faint warm base of the beak
  eye: '#0A0A0C',        // dark eye
  ground: '#0B4A5E'      // colour of the contact shadow
});

export const BASE_STATES = Object.freeze(['idle', 'awake', 'sleeping', 'listening', 'thinking', 'answering', 'attention', 'error']);
export const MOMENTS = Object.freeze(['greet', 'success', 'error', 'react', 'wake']);
const BASE_ALIASES = Object.freeze({ speaking: 'answering' });

const damp = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const window01 = (t, a, b) => ease((t - a) / (b - a));

// The head is a flattened ellipsoid (wider/longer front-to-back than tall, a
// real bird crown rather than a ball) centred inside the head pivot. Features
// sit on its surface, placed by azimuth/elevation.
const HEAD = { cx: 0, cy: 0.2, cz: 0.0, rx: 0.4, ry: 0.37, rz: 0.47 };
const UP = new Vector3(0, 1, 0);

// The outward direction at (azimuth, elevation): azimuth 0 = front (+Z),
// positive = the bird's left (+X); elevation 0 = the eye line, + = up.
function headDir(azim, elev) {
  return new Vector3(Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev));
}
// A point on the head ellipsoid and its surface normal (head-local space).
function headSurface(azim, elev, lift = 0) {
  const dir = headDir(azim, elev);
  const position = new Vector3(HEAD.cx + dir.x * HEAD.rx, HEAD.cy + dir.y * HEAD.ry, HEAD.cz + dir.z * HEAD.rz);
  const normal = new Vector3(dir.x / HEAD.rx, dir.y / HEAD.ry, dir.z / HEAD.rz).normalize();
  return { position: position.addScaledVector(normal, lift), normal };
}

const finish = (canvas, { srgb = true, repeat = false } = {}) => {
  const texture = new CanvasTexture(canvas);
  if (srgb) texture.colorSpace = SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
};
const spangle = (ctx, x0, y0, x1, y1, color, count, rMin, rMax, aMin = 0.3, aMax = 0.75) => {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i += 1) {
    const x = x0 + Math.random() * (x1 - x0);
    const y = y0 + Math.random() * (y1 - y0);
    const r = rMin + Math.random() * (rMax - rMin);
    ctx.globalAlpha = aMin + Math.random() * (aMax - aMin);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};
// A soft radial blob (feathered edge, no hard disc) used for face markings.
const softBlob = (ctx, cx, cy, rx, ry, color) => {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
  const c = new Color(color); const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(0.6, `rgba(${rgb},0.95)`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.save(); ctx.translate(cx, cy); ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2); ctx.fill(); ctx.restore();
};

// The head colour + markings, painted flush into one texture mapped onto the
// head sphere. Sphere UV: u=0.25 is the face (+Z), v=1 is the crown (+Y),
// v=0 the chin. Markings follow the master: spangled teal crown, orange lores
// around the eyes, a white throat and a white cheek/neck patch behind each eye.
function headTexture() {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Base teal, a touch deeper low (nape/collar) and richer on the crown.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, PALETTE.crown); grad.addColorStop(0.45, PALETTE.electricDeep); grad.addColorStop(1, PALETTE.crown);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  const U = (u) => u * W, V = (v) => (1 - v) * H; // v=1 top -> canvas y=0
  // Crown spangles (upper band, all around): fine and restrained so the deep
  // teal dominates, as in the master.
  spangle(ctx, 0, 0, W, V(0.58), PALETTE.crownSpangle, 520, 1.0, 2.4, 0.25, 0.62);
  // Face markings, symmetric around the face at u=0.25, mirrored near u=0.75
  // is the back (no face there). The eyes sit near u=0.17 and u=0.33.
  const eyeU = [0.17, 0.33];
  eyeU.forEach((u) => {
    softBlob(ctx, U(u), V(0.5), 78, 92, PALETTE.orange);          // orange lore around the eye
    softBlob(ctx, U(u + (u < 0.25 ? -0.05 : 0.05)), V(0.42), 42, 48, PALETTE.orangeDeep);
  });
  // White throat (front chin) and white cheek/neck patch behind each eye.
  softBlob(ctx, U(0.25), V(0.2), 70, 70, PALETTE.white);
  softBlob(ctx, U(0.06), V(0.4), 56, 74, PALETTE.white);
  softBlob(ctx, U(0.44), V(0.4), 56, 74, PALETTE.white);
  // A hint of spangle over the orange lore edge for feather flow.
  eyeU.forEach((u) => spangle(ctx, U(u) - 40, V(0.58), U(u) + 40, V(0.5), PALETTE.crownSpangle, 40, 1, 2, 0.2, 0.5));
  return finish(canvas);
}

// A feather-panel texture: base colour with cyan spangle spots (wing coverts).
function spotTexture(base, spot, count = 120) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, base); g.addColorStop(1, PALETTE.electricDeep);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
  spangle(ctx, 0, 0, 256, 220, spot, count, 1.6, 4.2, 0.35, 0.85);
  return finish(canvas, { repeat: true });
}

// A soft feather-structure bump map (fine directional streaks + noise), so the
// matte materials read as feathers rather than plastic.
function bumpTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i += 1) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const g = 128 + (Math.random() * 2 - 1) * 60;
    ctx.strokeStyle = `rgb(${g},${g},${g})`; ctx.lineWidth = 0.6 + Math.random();
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() * 6 - 3), y + 4 + Math.random() * 6); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return finish(canvas, { srgb: false, repeat: true });
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

  // Matte-to-satin feather materials (low specular), each with a fine feather
  // bump so they read as plumage, not plastic.
  const bump = keep(bumpTexture());
  const feather = (opts) => keep(new MeshStandardMaterial({ roughness: 0.85, metalness: 0.02, envMapIntensity: 0.24, bumpMap: bump, bumpScale: 0.015, ...opts }));
  const headMat = feather({ map: keep(headTexture()) });
  const bodyMat = feather({ vertexColors: true, bumpScale: 0.02 });
  const covertMat = keep(new MeshStandardMaterial({ map: keep(spotTexture(PALETTE.electric, PALETTE.covertSpot, 120)), roughness: 0.8, metalness: 0.03, envMapIntensity: 0.3, bumpMap: bump, bumpScale: 0.02 }));
  const scapularMat = keep(new MeshStandardMaterial({ map: keep(spotTexture(PALETTE.electric, PALETTE.covertSpot, 70)), roughness: 0.82, metalness: 0.03, envMapIntensity: 0.28, bumpMap: bump, bumpScale: 0.02 }));
  const primaryMat = feather({ color: PALETTE.primary, roughness: 0.8, bumpScale: 0.025 });
  const tailMat = keep(new MeshStandardMaterial({ map: keep(spotTexture(PALETTE.teal, PALETTE.covertSpot, 40)), roughness: 0.82, metalness: 0.03, envMapIntensity: 0.3, bumpMap: bump, bumpScale: 0.02 }));
  const footMat = keep(new MeshStandardMaterial({ color: PALETTE.foot, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.4 }));
  const clawMat = keep(new MeshStandardMaterial({ color: PALETTE.claw, roughness: 0.4, metalness: 0.05 }));
  // The beak: satin black with a faint warm base. Low specular.
  const beakMat = keep(new MeshStandardMaterial({ color: PALETTE.beak, roughness: 0.34, metalness: 0.12, envMapIntensity: 0.5 }));
  const beakBaseMat = feather({ color: PALETTE.beakBase, roughness: 0.6 });
  // Matte-dark eye: no clearcoat, so no bright rim at any yaw; one catch-light.
  const eyeMat = keep(new MeshStandardMaterial({ color: PALETTE.eye, roughness: 0.35, metalness: 0, envMapIntensity: 0.4 }));
  const shineMat = keep(new MeshBasicMaterial({ color: 0xb9c4c6, toneMapped: false }));

  const root = new Group();
  root.name = 'alcedo-mascot';
  root.rotation.y = 0; // FRONT; view angle for renders is set separately (setViewYaw)

  const body = new Group();
  body.name = 'body';
  // A slight forward-leaning perched posture, like the master.
  body.rotation.x = 0.1;
  root.add(body);

  // Body: a compact teardrop (lathe of revolution) — broad shoulders under the
  // head, widest chest, tapering to a short rear. Two-tone plumage is painted
  // per-vertex: electric-blue back/flanks, deep-orange breast, cream low belly.
  // Broad rounded shoulders at the top (so the head merges in, no snowman
  // waist), widest at the chest, tapering to a short rear.
  const torsoProfile = [
    [0.001, 0.1], [0.13, 0.16], [0.24, 0.27], [0.33, 0.43], [0.39, 0.6],
    [0.42, 0.78], [0.43, 0.97], [0.42, 1.14], [0.38, 1.28], [0.31, 1.4], [0.2, 1.5], [0.08, 1.56]
  ].map(([r, y]) => new Vector2(r, y));
  const torsoGeo = geo(new LatheGeometry(torsoProfile, 64));
  // Per-vertex colour (stored linear). Front (+Z) = orange over cream; back
  // (-Z) = electric blue; a soft blend at the flanks.
  const pos = torsoGeo.attributes.position;
  const colAttr = new Float32Array(pos.count * 3);
  const cBackHi = new Color(PALETTE.electric).convertSRGBToLinear();
  const cBackLo = new Color(PALETTE.electricDeep).convertSRGBToLinear();
  const cOrange = new Color(PALETTE.orange).convertSRGBToLinear();
  const cOrangeUp = new Color(PALETTE.orangeUp).convertSRGBToLinear();
  const cCream = new Color(PALETTE.cream).convertSRGBToLinear();
  const tmpA = new Color(); const tmpB = new Color();
  const smooth = (e0, e1, x) => { const t = MathUtils.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const rh = Math.hypot(x, z) || 1e-5;
    const front = smooth(-0.55, 0.5, z / rh); // 0 back .. 1 front, soft wrap (no hard seam)
    const t = MathUtils.clamp((y - 0.1) / (1.5 - 0.1), 0, 1);
    tmpA.copy(cBackLo).lerp(cBackHi, smooth(0.15, 0.85, t));            // back gradient
    tmpB.copy(cCream).lerp(cOrange, smooth(0.12, 0.32, t));              // low belly cream -> orange
    tmpB.lerp(cOrangeUp, smooth(0.5, 0.9, t));                          // upper breast brighter
    tmpA.lerp(tmpB, front);
    colAttr[i * 3] = tmpA.r; colAttr[i * 3 + 1] = tmpA.g; colAttr[i * 3 + 2] = tmpA.b;
  }
  torsoGeo.setAttribute('color', new BufferAttribute(colAttr, 3));
  const torso = mesh(torsoGeo, bodyMat);
  torso.scale.set(0.97, 1, 1.04);
  body.add(torso);

  // --- Head: a real bird head, flatter crown, seated LOW so its lower back
  // merges into the broad shoulders (no snowman neck). All markings are painted
  // flush into the head texture (crown spangles, orange lores, white throat,
  // white cheek/neck) — no raised discs.
  // A nape filler bridges the back of the head to the upper back, filling the
  // concave junction so the back reads as one continuous crown->nape->back line
  // (no snowman waist). Deep teal, part of the body.
  const napeMat = feather({ color: PALETTE.crown });
  const nape = mesh(geo(new SphereGeometry(1, 32, 24)), napeMat);
  nape.scale.set(0.3, 0.33, 0.26);
  nape.position.set(0, 1.0, -0.18);
  body.add(nape);

  const head = new Group();
  head.name = 'head';
  head.position.set(0, 1.16, -0.02);
  body.add(head);
  const skull = mesh(geo(new SphereGeometry(1, 64, 48)), headMat);
  skull.scale.set(HEAD.rx, HEAD.ry, HEAD.rz);
  skull.position.set(HEAD.cx, HEAD.cy, HEAD.cz);
  head.add(skull);

  // --- Beak: a long straight forward dagger (~head length), nearly horizontal
  // (~10 deg down), separate upper and lower mandibles meeting along a mouth
  // line. The lower mandible is the pivot for the speaking animation.
  const beakBase = headSurface(0, -0.05, -0.02);
  const beakGroup = new Group();
  beakGroup.position.copy(beakBase.position);
  beakGroup.rotation.x = Math.PI / 2 + 0.17; // ~10 deg below horizontal
  head.add(beakGroup);
  const BEAK_LEN = 1.05;
  const upperBeak = mesh(geo(new ConeGeometry(0.115, BEAK_LEN, 24, 1, false)), beakMat);
  upperBeak.position.set(0, BEAK_LEN * 0.5, 0.012);
  upperBeak.scale.set(1, 1, 0.6); // flat-bottomed blade
  beakGroup.add(upperBeak);
  const beakWarm = mesh(geo(new SphereGeometry(0.07, 16, 12)), beakBaseMat);
  beakWarm.scale.set(0.9, 0.3, 0.8);
  beakWarm.position.set(0, -0.08, -0.01); // tucked into the face, no knob
  beakGroup.add(beakWarm);
  const lowerBeakPivot = new Group();
  lowerBeakPivot.position.set(0, 0.0, -0.028); // hinge at the gape
  beakGroup.add(lowerBeakPivot);
  const lowerBeak = mesh(geo(new ConeGeometry(0.1, BEAK_LEN * 0.96, 22, 1, false)), beakMat);
  lowerBeak.position.set(0, BEAK_LEN * 0.48, 0.028);
  lowerBeak.scale.set(0.92, 1, 0.5); // flat-topped blade -> the two meet at a mouth line
  lowerBeakPivot.add(lowerBeak);

  // --- Eyes: small, dark, seated in the face on the sides of the head, with
  // one restrained catch-light. Sunk so only a rounded lens shows. The eyelid
  // is a small local dome hinged at the top (blink), flush at any yaw.
  const eyes = [];
  const eyeScale = small ? EYE_SCALE.small : EYE_SCALE.normal;
  [1, -1].forEach((side) => {
    const eyeGrp = new Group();
    const { position, normal } = headSurface(side * 0.55, 0.08, 0);
    eyeGrp.position.copy(position);
    orientTo(eyeGrp, normal);
    eyeGrp.scale.setScalar(eyeScale);
    const rEye = 0.066;
    const ball = mesh(geo(new SphereGeometry(rEye, 20, 16)), eyeMat);
    ball.position.z = -rEye * 0.5; // recessed, only a small dark lens shows
    ball.scale.set(1, 1, 0.78);
    eyeGrp.add(ball);
    const shine = mesh(geo(new SphereGeometry(rEye * 0.13, 8, 6)), shineMat);
    shine.position.set(-side * 0.014, 0.016, rEye * 0.5);
    eyeGrp.add(shine);
    const lidHinge = new Group();
    lidHinge.position.set(0, rEye * 0.92, 0);
    const lid = mesh(geo(new SphereGeometry(rEye * 1.3, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62)), headMat);
    lid.position.set(0, -rEye * 0.92, rEye * 0.05);
    lidHinge.add(lid);
    eyeGrp.add(lidHinge);
    head.add(eyeGrp);
    eyes.push({ group: eyeGrp, ball, shine, lidHinge, side });
  });

  // --- Wings: FOLDED wings lying flat against each flank, from shoulder to
  // just past the hip and ABOVE the feet. Built from stacked feather panels:
  // scapulars + cyan-spotted coverts + a darker tapered primary tip. The whole
  // group pivots at the shoulder so the later animation lifts it up-and-out.
  const wings = [];
  [1, -1].forEach((side) => {
    const pivot = new Group();
    pivot.name = side > 0 ? 'wingL' : 'wingR';
    // High on the flank toward the back, so the folded wing sits on the
    // back/side (not splaying to the front). Panels are FLAT against the body.
    pivot.position.set(side * 0.33, 1.02, -0.08);
    // Scapulars over the shoulder/back.
    const scap = mesh(geo(new SphereGeometry(1, 28, 20)), scapularMat);
    scap.scale.set(0.1, 0.28, 0.26);
    scap.position.set(-side * 0.02, -0.18, -0.06);
    scap.rotation.set(0.05, side * 0.1, side * 0.06);
    pivot.add(scap);
    // Coverts: the main cyan-spotted panel down the flank (flat, layered).
    const cov = mesh(geo(new SphereGeometry(1, 28, 22)), covertMat);
    cov.scale.set(0.09, 0.4, 0.3);
    cov.position.set(-side * 0.01, -0.44, -0.08);
    cov.rotation.set(0.02, side * 0.08, side * 0.04);
    pivot.add(cov);
    // Primaries: a darker tapered blade to a clear pointed tip, angled DOWN and
    // BACK to a wingtip past the hip, above the feet.
    const prim = mesh(geo(new ConeGeometry(0.12, 0.64, 18)), primaryMat);
    prim.scale.set(0.7, 1, 0.42);
    prim.position.set(-side * 0.02, -0.66, -0.2);
    prim.rotation.set(-0.5, side * 0.06, side * 0.02);
    pivot.add(prim);
    body.add(pivot);
    const rest = side * 0.02;
    const restX = 0.05;
    pivot.rotation.set(restX, 0, rest);
    wings.push({ pivot, side, rest, restX });
  });

  // --- Tail: a short, broad blue tail behind, clearly visible, not dominant.
  const tailPivot = new Group();
  tailPivot.position.set(0, 0.34, -0.34);
  body.add(tailPivot);
  const tail = mesh(geo(new ConeGeometry(0.17, 0.52, 16)), tailMat);
  tail.scale.set(1, 1, 0.3); // a broad flat feather blade
  tail.position.set(0, -0.2, -0.1);
  tail.rotation.x = -2.4; // back and a little down
  tailPivot.add(tail);

  // --- Feet: bright orange, three forward toes + one back, dark claws, clearly
  // readable below the body on the perch (the body leans forward, so the feet
  // sit forward under the chest).
  const claw = (x, y, z, ax, ay) => { const c = mesh(geo(new ConeGeometry(0.016, 0.06, 8)), clawMat); c.position.set(x, y, z); c.rotation.set(ax, ay, 0); body.add(c); };
  [1, -1].forEach((side) => {
    const leg = mesh(geo(new CapsuleGeometry(0.042, 0.14, 6, 12)), footMat);
    leg.position.set(side * 0.12, 0.17, 0.14);
    body.add(leg);
    const ankle = mesh(geo(new SphereGeometry(0.055, 16, 12)), footMat);
    ankle.position.set(side * 0.12, 0.08, 0.17);
    body.add(ankle);
    // Three forward toes, splayed on the perch.
    [[-0.07, 0.3], [0.0, 0.33], [0.07, 0.29]].forEach(([dx, tz]) => {
      const toe = mesh(geo(new CapsuleGeometry(0.021, 0.12, 4, 8)), footMat);
      toe.position.set(side * 0.12 + dx, 0.05, 0.2);
      toe.rotation.set(1.4, side * 0.14, 0);
      body.add(toe);
      claw(side * 0.12 + dx * 1.3, 0.035, tz, 2.0, side * 0.14);
    });
    // One back toe.
    const back = mesh(geo(new CapsuleGeometry(0.02, 0.07, 4, 8)), footMat);
    back.position.set(side * 0.12, 0.05, 0.06);
    back.rotation.x = -1.4;
    body.add(back);
    claw(side * 0.12, 0.035, 0.0, -2.0, 0);
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
  renderer.toneMappingExposure = 0.98;
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
  room.traverse?.((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
  pmrem.dispose();
  scene.add(new HemisphereLight(0xffffff, 0xb8ddE6, 0.34));
  const key = new DirectionalLight(0xfff4e6, 1.5);
  key.position.set(2.6, 4, 5);
  scene.add(key);
  const rim = new DirectionalLight(0x9fd6e6, 0.7);
  rim.position.set(-3, 2.4, -3);
  scene.add(rim);

  const bird = buildKingfisher({ look });
  scene.add(bird.root);
  scene.add(bird.shadow);
  const camera = new PerspectiveCamera(26, 1, 0.1, 40);
  // full: the whole bird; bust: head and shoulders; badge / badge-small: the
  // head filling a small square.
  const frames = { full: { y: 1.05, z: 7.0, look: 1.02 }, bust: { y: 1.58, z: 4.6, look: 1.5 }, badge: { y: 1.58, z: 4.45, look: 1.52 }, 'badge-small': { y: 1.58, z: 4.2, look: 1.54 } };
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
      // Eyelid hinge: open = tucked up behind the brow (-1.5), closed = swept
      // down over the eye (+0.25). Real geometry, flush at every head turn.
      eye.lidHinge.rotation.x = MathUtils.lerp(-1.5, 0.25, cover);
      eye.shine.visible = cover < 0.45;
      eye.shine.scale.setScalar(MathUtils.clamp(pose.alert, 0.6, 1.4));
    });

    wings.forEach((w) => {
      const lift = MathUtils.clamp(pose.wing, 0, 1);
      // Swing up and out (sign chosen so each wing opens outward, symmetric),
      // with a slight forward tilt so the raised wings read as spread.
      w.pivot.rotation.z = w.rest + w.side * 1.55 * lift;
      w.pivot.rotation.x = w.restX - 0.38 * lift;
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
    // Rotate the whole bird to a viewing angle (radians). For static preview
    // renders only (front/back/profiles/three-quarter); does not affect states.
    setViewYaw(rad) { bird.root.rotation.y = rad; },
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
