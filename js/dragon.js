import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ELEMENTS, BODIES, dragonScale, clamp, lerp, mulberry32 } from './config.js';
import { makeScaleTextures } from './textures.js';

const TILE = 0.7;
const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

let sharedAssets = null;
export function getDragonAssets() {
  if (!sharedAssets) sharedAssets = { scales: makeScaleTextures() };
  return sharedAssets;
}

function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

// Collects primitives (pre-transformed, vertex-coloured) so each joint is a single draw call.
class Batch {
  constructor() { this.geos = []; }

  _push(g, matrix, color) {
    g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geos.push(g);
  }

  ball(c, r, color, seg = 12) {
    const rad = Array.isArray(r) ? r : [r, r, r];
    const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 4));
    const avg = (rad[0] + rad[1] + rad[2]) / 3;
    scaleUV(g, (2 * Math.PI * avg) / TILE, (Math.PI * avg) / TILE);
    _m.compose(_v.set(c[0], c[1], c[2]), _q.identity(), new THREE.Vector3(rad[0], rad[1], rad[2]));
    this._push(g, _m, color);
  }

  // Tapered tube from point a (radius rA) to point b (radius rB).
  bone(a, b, rA, rB, color, { seg = 8, squash = 1 } = {}) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const dir = B.clone().sub(A);
    const len = dir.length();
    if (len < 1e-5) return;
    const g = new THREE.CylinderGeometry(rB, rA, len, seg, 1, false);
    g.translate(0, len / 2, 0);
    scaleUV(g, (2 * Math.PI * Math.max(rA, rB)) / TILE, len / TILE);
    _q.setFromUnitVectors(UP, dir.normalize());
    _m.compose(A, _q, _one);
    if (squash !== 1) _m.premultiply(new THREE.Matrix4().makeScale(1, squash, 1));
    this._push(g, _m, color);
  }

  cone(base, dir, radius, length, color, { seg = 6, flat = 1 } = {}) {
    const g = new THREE.ConeGeometry(radius, length, seg, 1);
    g.translate(0, length / 2, 0);
    scaleUV(g, 1.2, 1.2);
    const d = new THREE.Vector3(...dir).normalize();
    _q.setFromUnitVectors(UP, d);
    _m.compose(_v.set(base[0], base[1], base[2]), _q, new THREE.Vector3(flat, 1, 1));
    this._push(g, _m, color);
  }

  box(c, size, euler, color) {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    scaleUV(g, size[0] / TILE, size[1] / TILE);
    _q.setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2]));
    _m.compose(_v.set(c[0], c[1], c[2]), _q, _one);
    this._push(g, _m, color);
  }

  merged() {
    if (!this.geos.length) return null;
    const g = mergeGeometries(this.geos, false);
    for (const d of this.geos) d.dispose();
    this.geos = [];
    return g;
  }
}

function palette(element, form, rnd) {
  const e = ELEMENTS[element];
  const jitter = (c) => c.offsetHSL((rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.07);
  const p = {
    skin: jitter(new THREE.Color(e.color)),
    belly: new THREE.Color(e.belly),
    horn: new THREE.Color(e.horn),
    glow: new THREE.Color(e.glow),
    eye: new THREE.Color(e.accent),
    membrane: jitter(new THREE.Color(e.color)).multiplyScalar(0.8),
    roughness: 0.62, metalness: 0.05, clearcoat: 0.0, emissive: 0.0,
    form,
  };
  if (element === 'fire') { p.emissive = 0.9; p.roughness = 0.6; }
  if (element === 'water') { p.clearcoat = 0.6; p.roughness = 0.42; p.emissive = 0.25; }
  if (element === 'earth') { p.roughness = 0.85; p.skin.offsetHSL(0, -0.05, 0.02); }
  if (form === 'ice') {
    p.skin = new THREE.Color(0x9fd6ee); p.belly = new THREE.Color(0xf2fbff); p.horn = new THREE.Color(0xe6fbff);
    p.glow = new THREE.Color(0x7fe9ff); p.eye = new THREE.Color(0xbdf7ff); p.membrane = new THREE.Color(0x7fc2e0);
    p.roughness = 0.22; p.clearcoat = 1; p.emissive = 0.8;
  } else if (form === 'metal') {
    p.skin = new THREE.Color(0xb9bfc7); p.belly = new THREE.Color(0xc9a06a); p.horn = new THREE.Color(0x30343b);
    p.glow = new THREE.Color(0xd9a35a); p.eye = new THREE.Color(0xffe2a0); p.membrane = new THREE.Color(0x8a8f98);
    p.roughness = 0.34; p.metalness = 0.95; p.emissive = 0.12;
  } else if (form === 'lightning') {
    p.skin = new THREE.Color(0x2b2535); p.belly = new THREE.Color(0x5a4a2c); p.horn = new THREE.Color(0xfff0a0);
    p.glow = new THREE.Color(0xffe15a); p.eye = new THREE.Color(0xfff6b0); p.membrane = new THREE.Color(0x3a3150);
    p.roughness = 0.45; p.emissive = 2.4;
  }
  return p;
}

function makeMaterials(pal, assets) {
  const s = assets.scales;
  const skin = new THREE.MeshPhysicalMaterial({
    vertexColors: true, color: new THREE.Color(1.35, 1.35, 1.35), map: s.map, normalMap: s.normalMap,
    normalScale: new THREE.Vector2(1.1, 1.1), roughnessMap: s.roughnessMap, roughness: pal.roughness,
    metalness: pal.metalness, emissive: pal.glow.clone(), emissiveMap: s.emissiveMap,
    emissiveIntensity: pal.emissive, clearcoat: pal.clearcoat, clearcoatRoughness: 0.3,
  });
  const membrane = new THREE.MeshStandardMaterial({
    color: pal.membrane, side: THREE.DoubleSide, roughness: 0.7, metalness: pal.metalness * 0.6,
    emissive: pal.glow.clone(), emissiveIntensity: pal.form === 'lightning' ? 0.1 : 0.04,
  });
  const eye = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: pal.eye.clone(), emissiveIntensity: 2.2, roughness: 0.2 });
  let decor = null;
  if (pal.form === 'ice') {
    decor = new THREE.MeshPhysicalMaterial({
      color: 0xcff3ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.82,
      emissive: 0x4fd0ff, emissiveIntensity: 0.9, clearcoat: 1, flatShading: true,
    });
  } else if (pal.form === 'metal') {
    decor = new THREE.MeshStandardMaterial({ color: 0xd3d8df, metalness: 1, roughness: 0.2, flatShading: true });
  } else if (pal.form === 'lightning') {
    decor = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff0a0, emissiveIntensity: 3, flatShading: true });
  }
  return { skin, membrane, eye, decor };
}

// A chain of joints; each joint owns one merged mesh and the next joint hangs off its end (+Y).
function makeChain(o, ctx) {
  const { pal, mats, rnd } = ctx;
  const root = new THREE.Group();
  const joints = [];
  let parent = root;
  for (let i = 0; i < o.n; i++) {
    const t0 = i / o.n, t1 = (i + 1) / o.n;
    const rN = lerp(o.r0, o.r1, Math.pow(t0, o.taper ?? 1));
    const rF = lerp(o.r0, o.r1, Math.pow(t1, o.taper ?? 1));
    const j = new THREE.Group();
    if (i > 0) j.position.y = o.len;
    parent.add(j);
    joints.push(j);
    const skin = new Batch(), decor = new Batch();
    const c = pal.skin.clone().offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
    skin.bone([0, 0, 0], [0, o.len, 0], rN, rF, c, { seg: 9 });
    skin.ball([0, 0, 0], rN * 1.01, c, 10);
    if (i === o.n - 1) skin.ball([0, o.len, 0], rF * 1.01, c, 10);
    if (o.belly && t0 < o.belly) {
      skin.bone([0, 0, -o.up * rN * 0.62], [0, o.len, -o.up * rF * 0.62], rN * 0.55, rF * 0.55, pal.belly, { seg: 6 });
    }
    if (o.spike) {
      const f = 1 - t0 * 0.55;
      const size = o.spike * f;
      const sb = mats.decor ? decor : skin;
      const col = mats.decor ? new THREE.Color(1, 1, 1) : pal.horn;
      const mid = o.len * 0.5;
      const dir = [0, o.lean * 0.55, o.up];
      if (pal.form === 'base' && ctx.element === 'water') {
        sb.cone([0, mid, o.up * rN * 0.8], dir, rN * 0.9, size * 1.7, pal.belly.clone().lerp(pal.skin, 0.2), { seg: 3, flat: 0.12 });
      } else if (pal.form === 'base' && ctx.element === 'earth') {
        sb.cone([0, mid, o.up * rN * 0.8], dir, rN * 0.7, size * 0.9, pal.horn.clone().lerp(pal.skin, 0.45), { seg: 5 });
        if (rnd() < 0.5) sb.ball([0.04, mid, o.up * rN * 0.95], [rN * 0.7, rN * 0.28, o.len * 0.4], new THREE.Color(0x4f7a2d));
      } else {
        sb.cone([0, mid, o.up * rN * 0.8], dir, rN * 0.45, size * 1.35, col, { seg: 5 });
      }
    }
    const mesh = new THREE.Mesh(skin.merged(), mats.skin);
    mesh.castShadow = true; mesh.receiveShadow = true;
    j.add(mesh);
    const dg = decor.merged();
    if (dg && mats.decor) { const dm = new THREE.Mesh(dg, mats.decor); dm.castShadow = true; j.add(dm); }
    parent = j;
  }
  const end = new THREE.Group();
  end.position.y = o.len;
  parent.add(end);
  return { root, joints, end };
}

function legReach(spec, paw = 1) {
  let cum = 0, drop = 0;
  for (const s of spec.segs) { cum += s.rest; drop += s.len * Math.cos(cum); }
  return drop + spec.segs[spec.segs.length - 1].r1 * 0.8 * paw;
}

function makeLeg(spec, ctx, { paw = 1, claws = 3 } = {}) {
  const { pal, mats, rnd } = ctx;
  const hip = new THREE.Group();
  const joints = [];
  let parent = hip;
  let cum = 0, drop = 0;
  spec.segs.forEach((s, i) => {
    const j = new THREE.Group();
    if (i > 0) j.position.y = -spec.segs[i - 1].len;
    j.rotation.x = s.rest;
    parent.add(j);
    joints.push(j);
    cum += s.rest;
    drop += s.len * Math.cos(cum);
    const b = new Batch();
    const c = pal.skin.clone().offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
    b.bone([0, 0, 0], [0, -s.len, 0], s.r0, s.r1, c, { seg: 9 });
    b.ball([0, 0, 0], s.r0 * 1.02, c, 10);
    if (i === 0 && spec.thigh) b.ball([0, -0.08, 0], spec.thigh, c, 12);
    if (i === spec.segs.length - 1) {
      const pr = s.r1;
      b.ball([0, -s.len, pr * 1.5 * paw], [pr * 1.5 * paw, pr * 0.8 * paw, pr * 3.2 * paw], c, 10);
      for (let k = 0; k < claws; k++) {
        const x = (k - (claws - 1) / 2) * pr * 1.0 * paw;
        b.cone([x, -s.len - pr * 0.1, pr * 4.2 * paw], [x * 0.12, -0.28, 1], pr * 0.5 * paw, pr * 2.6 * paw, pal.horn, { seg: 5 });
      }
    }
    const mesh = new THREE.Mesh(b.merged(), mats.skin);
    mesh.castShadow = true; mesh.receiveShadow = true;
    j.add(mesh);
    parent = j;
  });
  const last = spec.segs[spec.segs.length - 1];
  return { hip, joints, reach: drop + last.r1 * 0.8 * paw };
}

function makeWing(size, ctx) {
  const { pal, mats } = ctx;
  const holder = new THREE.Group();
  const shoulder = new THREE.Group();
  holder.add(shoulder);
  const A = new THREE.Vector3(1.0, 0.5, -0.25).multiplyScalar(size);
  const F = new THREE.Vector3(1.05, 0.12, -0.4).multiplyScalar(size);
  const elbow = new THREE.Group();
  elbow.position.copy(A);
  shoulder.add(elbow);
  const arm = new Batch();
  const boneC = pal.skin.clone().multiplyScalar(0.9);
  arm.bone([0, 0, 0], A.toArray(), 0.1 * size, 0.07 * size, boneC);
  arm.ball([0, 0, 0], 0.12 * size, boneC);
  const am = new THREE.Mesh(arm.merged(), mats.skin);
  am.castShadow = true;
  shoulder.add(am);

  const fore = new Batch();
  fore.bone([0, 0, 0], F.toArray(), 0.07 * size, 0.045 * size, boneC);
  fore.ball([0, 0, 0], 0.08 * size, boneC);
  const tips = [
    new THREE.Vector3(1.0, -0.12, -0.85), new THREE.Vector3(0.7, -0.3, -1.7), new THREE.Vector3(0.2, -0.4, -2.35),
  ].map((v) => v.multiplyScalar(size).add(F));
  for (const t of tips) {
    fore.bone(F.toArray(), t.toArray(), 0.035 * size, 0.012 * size, boneC, { seg: 5 });
    fore.cone(t.toArray(), [0.3, -0.1, -0.5], 0.014 * size, 0.1 * size, pal.horn, { seg: 4 });
  }
  fore.cone(F.toArray(), [0.6, 0.2, 0.3], 0.03 * size, 0.18 * size, pal.horn, { seg: 4 });
  const fm = new THREE.Mesh(fore.merged(), mats.skin);
  fm.castShadow = true;
  elbow.add(fm);

  // Membrane outline in elbow space, fanned from the wrist.
  const R = new THREE.Vector3(0.18, -0.2, -2.5).multiplyScalar(size).sub(A);
  const poly = [new THREE.Vector3(0, 0, 0), F.clone()];
  const sag = (a, b) => a.clone().add(b).multiplyScalar(0.5).lerp(F, 0.2);
  poly.push(tips[0], sag(tips[0], tips[1]), tips[1], sag(tips[1], tips[2]), tips[2], sag(tips[2], R), R);
  const pos = [], uv = [];
  const addV = (v) => { pos.push(v.x, v.y, v.z); uv.push(v.x / 1.6, v.z / 1.6); };
  for (let k = 2; k < poly.length - 1; k++) { addV(F); addV(poly[k]); addV(poly[k + 1]); }
  addV(F); addV(R); addV(poly[0]);
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  mg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  mg.computeVertexNormals();
  const mem = new THREE.Mesh(mg, mats.membrane);
  mem.castShadow = true;
  elbow.add(mem);

  // Short inner membrane between the arm and the flank.
  const inner = new THREE.Group();
  shoulder.add(inner);
  const ig = new THREE.BufferGeometry();
  const body = new THREE.Vector3(0.15, -0.15, -1.2).multiplyScalar(size);
  ig.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, ...A.toArray(), ...body.toArray(), ...A.toArray(), ...A.clone().add(R).toArray(), ...body.toArray()], 3));
  ig.computeVertexNormals();
  const im = new THREE.Mesh(ig, mats.membrane);
  im.castShadow = true;
  inner.add(im);
  return { holder, shoulder, elbow, inner };
}

function makeHead(ctx, size) {
  const { pal, mats, rnd } = ctx;
  const head = new THREE.Group();
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.075, 0.1);
  head.add(jaw);
  const skin = new Batch(), jawB = new Batch(), eyes = new Batch();
  const c = pal.skin.clone();
  const hornC = pal.horn;
  skin.ball([0, 0.02, 0.2], [0.2, 0.17, 0.3], c);
  skin.bone([0, 0.0, 0.36], [0, -0.01, 0.9], 0.13, 0.075, c, { seg: 10, squash: 0.74 });
  skin.ball([0, -0.01, 0.9], [0.078, 0.058, 0.07], c, 8);
  for (const s of [-1, 1]) {
    skin.ball([s * 0.14, 0.115, 0.3], [0.07, 0.035, 0.12], c.clone().multiplyScalar(0.8), 8);
    eyes.ball([s * 0.155, 0.075, 0.3], 0.042, new THREE.Color(1, 1, 1), 10);
    skin.ball([s * 0.035, 0.03, 0.9], 0.016, new THREE.Color(0.05, 0.03, 0.03), 6);
    const hornDir = [s * 0.45, 0.5, -0.85];
    const hb = mats.decor ? new THREE.Color(1, 1, 1) : hornC;
    const target = mats.decor ? new Batch() : skin;
    target.cone([s * 0.1, 0.13, 0.03], hornDir, 0.052, 0.62 * size, hb, { seg: 7 });
    target.cone([s * 0.17, 0.0, 0.1], [s * 0.9, -0.05, -0.6], 0.03, 0.26, hb, { seg: 5 });
    if (mats.decor) {
      const dg = target.merged();
      const dm = new THREE.Mesh(dg, mats.decor);
      dm.castShadow = true;
      head.add(dm);
    }
    for (let k = 0; k < 5; k++) {
      const z = 0.5 + k * 0.07;
      skin.cone([s * (0.092 - k * 0.006), -0.052, z], [s * 0.1, -1, 0.1], 0.012, 0.055, new THREE.Color(0.95, 0.93, 0.85), { seg: 4 });
      jawB.cone([s * (0.078 - k * 0.005), 0.02, 0.44 + k * 0.06], [-s * 0.05, 1, 0.1], 0.011, 0.048, new THREE.Color(0.95, 0.93, 0.85), { seg: 4 });
    }
    if (ctx.element === 'water') skin.cone([s * 0.17, 0.0, 0.06], [s * 1, 0.1, -0.5], 0.06, 0.3, pal.belly, { seg: 3, flat: 0.1 });
    if (ctx.element === 'earth') skin.ball([s * 0.1, 0.17, 0.12], [0.07, 0.04, 0.09], new THREE.Color(0x4f7a2d), 6);
  }
  if (ctx.element === 'fire') skin.cone([0, 0.18, 0.1], [0, 0.4, -0.6], 0.04, 0.3, hornC, { seg: 5 });
  jawB.bone([0, 0, 0], [0, 0, 0.74], 0.092, 0.05, c, { seg: 9, squash: 0.62 });
  jawB.ball([0, 0, 0.02], [0.09, 0.06, 0.1], c, 8);
  jawB.ball([0, 0, 0.74], [0.052, 0.03, 0.05], c, 8);
  head.add(Object.assign(new THREE.Mesh(skin.merged(), mats.skin), { castShadow: true }));
  jaw.add(Object.assign(new THREE.Mesh(jawB.merged(), mats.skin), { castShadow: true }));
  head.add(new THREE.Mesh(eyes.merged(), mats.eye));
  const mouth = new THREE.Object3D();
  mouth.position.set(0, -0.02, 0.92);
  head.add(mouth);
  head.scale.setScalar(size);
  return { head, jaw, mouth };
}

function buildBody(kind, ctx) {
  const { pal, mats } = ctx;
  const rig = new THREE.Group();
  const body = {};
  const quad = kind === 'quad';
  const skinC = pal.skin;

  const hindSpec = quad
    ? { segs: [{ len: 0.5, r0: 0.2, r1: 0.13, rest: -0.55 }, { len: 0.5, r0: 0.13, r1: 0.085, rest: 1.35 }, { len: 0.34, r0: 0.085, r1: 0.065, rest: -0.95 }], thigh: 0.22 }
    : { segs: [{ len: 0.7, r0: 0.32, r1: 0.2, rest: -0.75 }, { len: 0.7, r0: 0.2, r1: 0.12, rest: 1.55 }, { len: 0.42, r0: 0.12, r1: 0.09, rest: -0.8 }], thigh: 0.34 };
  const reach = legReach(hindSpec, quad ? 1 : 1.25);
  const torsoPitch = quad ? 0 : -0.42;
  // Pelvis position after pitching; hips must sit at leg-reach height so feet touch the ground.
  const pel = new THREE.Vector3(0, -0.05, -0.95).applyEuler(new THREE.Euler(torsoPitch, 0, 0));
  const T = reach - pel.y; // torso pivot height

  const torso = new THREE.Group();
  torso.position.set(0, T, 0);
  rig.add(torso);
  torso.rotation.x = torsoPitch;
  const tb = new Batch();
  const tr = quad ? 1 : 1.3;
  tb.ball([0, 0, 0.55], [0.46 * tr, 0.5 * tr, 0.66 * tr], skinC);
  tb.ball([0, -0.02, -0.35], [0.44 * tr, 0.46 * tr, 0.72 * tr], skinC);
  tb.ball([0, 0.02, -1.0], [0.38 * tr, 0.4 * tr, 0.46 * tr], skinC);
  tb.ball([0, -0.24 * tr, 0.0], [0.34 * tr, 0.3 * tr, 1.2 * tr], pal.belly);
  const ridgeN = quad ? 7 : 8;
  for (let i = 0; i < ridgeN; i++) {
    const z = 0.9 - i * (1.7 / ridgeN) * 1.05;
    const h = (0.46 + 0.04 * Math.sin(i * 0.9)) * tr;
    const col = mats.decor ? new THREE.Color(1, 1, 1) : pal.horn;
    const size = (quad ? 0.2 : 0.26) * (1 - i * 0.04);
    const target = mats.decor ? (body.decorB ||= new Batch()) : tb;
    if (ctx.element === 'water' && pal.form === 'base') target.cone([0, h, z], [0, 1, 0.45], 0.08, size * 1.9, pal.belly, { seg: 3, flat: 0.12 });
    else if (ctx.element === 'earth' && pal.form === 'base') {
      target.box([0, h + 0.03, z], [0.26, 0.12, 0.3], [0.15, (i % 3) * 0.3, 0.12], pal.horn.clone().lerp(skinC, 0.5));
      if (i % 2 === 0) tb.ball([0.08, h, z - 0.1], [0.2, 0.06, 0.22], new THREE.Color(0x4f7a2d), 6);
    } else target.cone([0, h, z], [0, 1, 0.45], 0.07 * tr, size * 1.4, col, { seg: 5 });
  }
  if (mats.decor && pal.form === 'metal') {
    for (const s of [-1, 1]) tb.box([s * 0.48 * tr, 0.28, 0.5], [0.34, 0.26, 0.5], [0, 0, s * 0.4], new THREE.Color(0xd3d8df));
  }
  const torsoMesh = new THREE.Mesh(tb.merged(), mats.skin);
  torsoMesh.castShadow = true; torsoMesh.receiveShadow = true;
  torso.add(torsoMesh);
  if (body.decorB) {
    const dm = new THREE.Mesh(body.decorB.merged(), mats.decor);
    dm.castShadow = true;
    torso.add(dm);
  }
  body.torso = torso;
  body.torsoPitch = torsoPitch;

  // Neck + head
  const neckDir = quad ? new THREE.Vector3(0, 0.62, 0.78) : new THREE.Vector3(0, 0.2, 1);
  const neck = makeChain({
    n: quad ? 7 : 6, len: quad ? 0.25 : 0.26, r0: quad ? 0.27 : 0.36, r1: quad ? 0.15 : 0.2, taper: 0.9,
    up: -1, lean: -1, spike: quad ? 0.17 : 0.22, belly: 0.9,
  }, ctx);
  neck.root.position.set(0, quad ? 0.18 : 0.15, quad ? 1.0 : 1.15);
  neck.root.quaternion.setFromUnitVectors(UP, neckDir.normalize());
  torso.add(neck.root);
  const headBits = makeHead(ctx, quad ? 1 : 1.3);
  headBits.head.rotation.x = -Math.PI / 2;
  neck.end.add(headBits.head);
  body.neck = neck;
  body.neckRest = quad ? [-0.1, -0.1, -0.05, 0.12, 0.22, 0.28, 0.28] : [0.0, 0.05, 0.15, 0.3, 0.4, 0.4];
  neck.joints.forEach((j, i) => { j.rotation.x = body.neckRest[i]; });
  body.head = headBits.head;
  body.jaw = headBits.jaw;
  body.mouth = headBits.mouth;

  // Tail
  const tail = makeChain({
    n: quad ? 11 : 10, len: quad ? 0.32 : 0.36, r0: quad ? 0.3 : 0.42, r1: 0.035, taper: 0.85,
    up: 1, lean: 1, spike: quad ? 0.15 : 0.2, belly: 0.5,
  }, ctx);
  tail.root.position.set(0, 0.02, -1.35);
  tail.root.rotation.x = -Math.PI / 2 - torsoPitch + 0.08;
  torso.add(tail.root);
  body.tail = tail;
  tail.joints.forEach((j, i) => { j.rotation.x = i < 3 ? -0.04 : 0.05; });
  if (ctx.element === 'fire' || ctx.element === 'earth' || pal.form !== 'base') {
    const tb2 = new Batch();
    const col = mats.decor ? new THREE.Color(1, 1, 1) : pal.horn;
    tb2.cone([0, 0, 0], [0.0, 1, 0.0], 0.1, 0.3, col, { seg: 5 });
    tail.end.add(new THREE.Mesh(tb2.merged(), mats.decor || mats.skin));
  }

  // Legs
  body.legs = [];
  const mk = (spec, x, y, z, kind2, phase, bendSign) => {
    const side = Math.sign(x) || 1;
    const leg = makeLeg(spec, ctx, { paw: kind2 === 'arm' ? 0.7 : quad ? 1 : 1.25 });
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.add(leg.hip);
    (kind2 === 'hind' ? rig : torso).add(holder);
    body.legs.push({ ...leg, holder, kind: kind2, side, phase, bendSign, rest: spec.segs.map((s) => s.rest), amp: kind2 === 'arm' ? 0.2 : 0.55 });
  };
  if (quad) {
    mk(hindSpec, -0.42, reach, pel.z, 'hind', Math.PI, 1);
    mk(hindSpec, 0.42, reach, pel.z, 'hind', 0, 1);
    const fs = { segs: [{ len: 0.5, r0: 0.17, r1: 0.11, rest: 0.45 }, { len: 0.5, r0: 0.11, r1: 0.075, rest: -0.95 }, { len: 0.3, r0: 0.075, r1: 0.06, rest: 0.5 }], thigh: 0.17 };
    const k = (T - 0.02) / legReach(fs, 1);
    fs.segs.forEach((s) => { s.len *= k; });
    mk(fs, -0.4, -0.02, 0.55, 'front', 0, -1);
    mk(fs, 0.4, -0.02, 0.55, 'front', Math.PI, -1);
  } else {
    mk(hindSpec, -0.58, reach, pel.z, 'hind', Math.PI, 1);
    mk(hindSpec, 0.58, reach, pel.z, 'hind', 0, 1);
    const arm = { segs: [{ len: 0.3, r0: 0.1, r1: 0.07, rest: 0.9 }, { len: 0.3, r0: 0.07, r1: 0.05, rest: -1.0 }, { len: 0.16, r0: 0.05, r1: 0.04, rest: 0.4 }] };
    mk(arm, -0.5, 0.0, 0.85, 'arm', 0, -1);
    mk(arm, 0.5, 0.0, 0.85, 'arm', Math.PI, -1);
  }

  // Wings
  body.wings = [];
  const wingSize = quad ? 1.12 : 1.0;
  for (const s of [-1, 1]) {
    const w = makeWing(wingSize, ctx);
    w.holder.position.set(s * 0.3 * tr, quad ? 0.38 : 0.45, quad ? 0.42 : 0.35);
    w.holder.scale.x = s;
    torso.add(w.holder);
    body.wings.push({ ...w, side: s });
  }

  body.height = T + 1.2;
  body.T = T;
  body.isQuad = quad;
  return { rig, body };
}

const ease = (t) => t * t * (3 - 2 * t);
const pulse = (t, a = 0.25, b = 0.7) => (t < a ? ease(t / a) : t > b ? 1 - ease((t - b) / (1 - b)) : 1);

export class DragonActor {
  constructor({ element, body, awakened = false, seed = 1, level = 1 }) {
    this.element = element;
    this.bodyType = body;
    this.awakened = awakened;
    this.seed = seed;
    this.level = level;
    this.root = new THREE.Group();
    this.time = Math.random() * 10;
    this.gait = 0;
    this.moveBlend = 0;
    this.fx = {};
    this.anims = [];
    this.look = null;
    this.lookYaw = 0;
    this.bulge = 0;
    this.hyper = 0;
    this.hunger = 0;
    this.crash = 0;
    this._arcTimer = 0;
    this._build();
    this.setLevel(level);
  }

  get form() {
    if (!this.awakened) return 'base';
    return ELEMENTS[this.element].bonus;
  }

  _build() {
    if (this.rigRoot) {
      this.rigRoot.removeFromParent();
      this._disposeRig();
    }
    const rnd = mulberry32(this.seed * 7919 + 13);
    const assets = getDragonAssets();
    const pal = palette(this.element, this.form, rnd);
    const mats = makeMaterials(pal, assets);
    const ctx = { pal, mats, rnd, element: this.element };
    const { rig, body } = buildBody(this.bodyType, ctx);
    this.rigRoot = rig;
    this.parts = body;
    this.mats = mats;
    this.pal = pal;
    this.root.add(rig);
    this.root.userData.actor = this;
    this.bulgeBase = new THREE.Vector3(1, 1, 1);
    const box = new THREE.Box3().setFromObject(this.root);
    this.baseHeight = Math.max(2, box.max.y);
    this.baseLength = Math.max(2, box.max.z - box.min.z);
    if (this.form === 'lightning') this._makeArcs();
  }

  _makeArcs() {
    this.arcs = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xfff2a0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      l.frustumCulled = false;
      this.arcs.add(l);
    }
    this.rigRoot.add(this.arcs);
  }

  _updateArcs(dt) {
    this._arcTimer -= dt;
    if (this._arcTimer > 0) return;
    this._arcTimer = 0.06 + Math.random() * 0.08;
    const T = this.parts.T;
    for (const l of this.arcs.children) {
      const a = l.geometry.attributes.position;
      const base = new THREE.Vector3((Math.random() - 0.5) * 0.9, T + (Math.random() - 0.3) * 0.6, (Math.random() - 0.5) * 2.2);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize();
      const len = 0.6 + Math.random() * 1.1;
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        a.setXYZ(i, base.x + dir.x * len * t + (Math.random() - 0.5) * 0.18 * Math.sin(t * Math.PI),
          base.y + dir.y * len * t + (Math.random() - 0.5) * 0.18 * Math.sin(t * Math.PI),
          base.z + dir.z * len * t + (Math.random() - 0.5) * 0.18 * Math.sin(t * Math.PI));
      }
      a.needsUpdate = true;
      l.visible = Math.random() < 0.7;
    }
  }

  _disposeRig() {
    this.rigRoot.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of Object.values(this.mats)) if (m) m.dispose();
  }

  dispose() {
    this.root.removeFromParent();
    this._disposeRig();
  }

  setAwakened(v) {
    if (this.awakened === v) return;
    this.awakened = v;
    this._build();
    this.setLevel(this.level);
  }

  setLevel(level, snap = false) {
    this.level = level;
    this.scaleTarget = dragonScale(level);
    if (snap || this.scaleValue === undefined) {
      this.scaleValue = this.scaleTarget;
      this.root.scale.setScalar(this.scaleValue);
    }
  }

  get height() { return this.baseHeight * this.scaleValue; }
  get length() { return this.baseLength * this.scaleValue; }
  get radius() { return (this.bodyType === 'quad' ? 0.9 : 1.1) * this.scaleValue; }

  setFullness(broccoli, candy) {
    this.bulge = clamp(broccoli / 5, 0, 1);
    this.hunger = clamp((broccoli - 2) / 3, 0, 1);
    this.hyper = clamp(candy / 5, 0, 1);
  }

  setLookTarget(worldPos) { this.look = worldPos; }

  mouthWorld(out = new THREE.Vector3()) {
    this.parts.mouth.getWorldPosition(out);
    return out;
  }

  chestWorld(out = new THREE.Vector3()) {
    out.set(0, this.parts.T + 0.2, 0.3);
    return this.rigRoot.localToWorld(out);
  }

  play(name, opts = {}) {
    const defs = {
      bite: 0.8, breath: 1.3, roar: 1.4, hurt: 0.55, dodge: 0.6, faint: 1.2, eat: 0.7, stomp: 0.9, ult: 2.0, crash: 1.6, lunge: 0.9,
    };
    return new Promise((resolve) => {
      this.anims.push({ name, t: 0, dur: opts.dur ?? defs[name] ?? 0.8, resolve, opts, hold: name === 'faint' });
    });
  }

  clearAnims() {
    for (const a of this.anims) a.resolve();
    this.anims.length = 0;
  }

  _applyAnims(dt) {
    const fx = this.fx = {
      lunge: 0, jaw: 0, headPitch: 0, neckLift: 0, wing: 0, crouch: 0, tilt: 0, roll: 0, hop: 0, side: 0,
      flash: 0, faint: 0, recoil: 0, shake: 0, yaw: 0,
    };
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const p = clamp(a.t / a.dur, 0, 1);
      switch (a.name) {
        case 'bite':
          fx.lunge += Math.sin(p * Math.PI) * 3.2 * (a.opts.reach ?? 1);
          fx.neckLift -= Math.sin(clamp(p * 1.6, 0, 1) * Math.PI) * 0.15;
          fx.headPitch += Math.sin(p * Math.PI) * 0.25;
          fx.jaw += p > 0.35 && p < 0.7 ? 1 - Math.abs((p - 0.52) / 0.17) : p < 0.35 ? p / 0.35 * 0.8 : 0;
          fx.crouch += Math.sin(p * Math.PI) * 0.1;
          break;
        case 'breath': {
          const wind = pulse(p, 0.3, 0.8);
          fx.neckLift += wind * 0.5 * (p < 0.3 ? 1 : 0.2);
          fx.headPitch -= (p < 0.3 ? Math.sin(p / 0.3 * Math.PI * 0.5) * 0.35 : 0.2 * wind);
          fx.jaw += wind * 0.95;
          fx.wing += wind * 0.8;
          fx.crouch += wind * 0.12;
          fx.tilt -= wind * 0.12;
          break;
        }
        case 'ult': {
          const wind = pulse(p, 0.25, 0.85);
          fx.neckLift += wind * 0.7; fx.headPitch -= wind * 0.45; fx.jaw += wind;
          fx.wing += wind; fx.tilt -= wind * 0.3; fx.hop += Math.sin(p * Math.PI * 1.5) * 0.5 * wind; fx.shake += wind * 0.03;
          break;
        }
        case 'roar': {
          const wind = pulse(p, 0.25, 0.8);
          fx.neckLift += wind * 0.6; fx.headPitch -= wind * 0.5; fx.jaw += wind; fx.wing += wind;
          fx.tilt -= wind * 0.2; fx.shake += wind * 0.02;
          break;
        }
        case 'hurt':
          fx.recoil += Math.sin(p * Math.PI) * 1.1 * (1 - p);
          fx.flash += 1 - p;
          fx.tilt -= Math.sin(p * Math.PI) * 0.18;
          fx.headPitch -= Math.sin(p * Math.PI) * 0.4;
          fx.jaw += Math.sin(p * Math.PI) * 0.4;
          break;
        case 'dodge':
          fx.side += Math.sin(p * Math.PI) * 2.4 * (a.opts.dir ?? 1);
          fx.hop += Math.sin(p * Math.PI) * 0.5;
          fx.roll += Math.sin(p * Math.PI) * 0.25 * (a.opts.dir ?? 1);
          break;
        case 'eat':
          fx.headPitch += Math.sin(p * Math.PI * 3) * 0.25;
          fx.jaw += Math.abs(Math.sin(p * Math.PI * 3)) * 0.6;
          fx.neckLift -= 0.1;
          break;
        case 'stomp':
          fx.hop += Math.max(0, Math.sin(p * Math.PI * 2)) * 0.25;
          break;
        case 'crash':
          fx.shake += (1 - p) * 0.05; fx.crouch += pulse(p, 0.2, 0.9) * 0.2; fx.flash += (1 - p) * 0.4;
          break;
        case 'lunge':
          fx.lunge += Math.sin(p * Math.PI) * 4.5 * (a.opts.reach ?? 1);
          fx.crouch += Math.sin(p * Math.PI) * 0.15;
          break;
        case 'faint':
          fx.faint += ease(p);
          break;
        default: break;
      }
      if (p >= 1) {
        a.resolve();
        if (a.name === 'faint') this.faintHold = true;
        this.anims.splice(i, 1);
      }
    }
    if (this.faintHold) fx.faint = 1;
    if (this.crash > 0) fx.shake += this.crash * 0.02;
  }

  revive() {
    this.faintHold = false;
  }

  update(dt, speed = 0, opts = {}) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    if (Math.abs(this.scaleValue - this.scaleTarget) > 0.0005) {
      this.scaleValue = lerp(this.scaleValue, this.scaleTarget, 1 - Math.exp(-2.5 * dt));
      this.root.scale.setScalar(this.scaleValue);
    }
    const t = this.time;
    const P = this.parts;
    this._applyAnims(dt);
    const fx = this.fx;
    const sc = this.scaleValue;

    const body = BODIES[this.bodyType];
    const stride = (this.bodyType === 'quad' ? 1.9 : 2.2) * sc;
    const targetMove = clamp(speed / 1.2, 0, 1);
    this.moveBlend = lerp(this.moveBlend, targetMove, 1 - Math.exp(-9 * dt));
    this.gait += (speed / stride) * dt * Math.PI * 2;
    const running = clamp((speed - body.walk) / (body.run - body.walk), 0, 1);
    const mb = this.moveBlend;
    const g = this.gait;
    const jitter = this.hyper * Math.sin(t * 23) * 0.03;

    // Torso / rig
    const bob = Math.abs(Math.sin(g)) * 0.07 * mb * (1 + running * 0.8);
    const breathe = Math.sin(t * 1.7) * 0.012;
    const crouch = fx.crouch + fx.faint * 0.45;
    this.rigRoot.position.set(fx.side, bob + fx.hop - crouch * 0.6 - fx.faint * 0.22, fx.lunge - fx.recoil * 0.5);
    this.rigRoot.rotation.set(fx.tilt + (running * 0.08) * mb, fx.yaw, fx.roll + Math.sin(g) * 0.025 * mb + fx.faint * 1.1);
    P.torso.rotation.x = P.torsoPitch + Math.sin(g * 2) * 0.02 * mb;
    const bl = 1 + breathe + this.bulge * 0.16;
    P.torso.scale.set(bl + this.bulge * 0.06, bl, 1);
    if (fx.shake) this.rigRoot.position.x += (Math.random() - 0.5) * fx.shake;

    // Look target
    let yawGoal = 0;
    if (this.look) {
      const local = this.root.worldToLocal(this.look.clone());
      yawGoal = clamp(Math.atan2(local.x, local.z), -0.9, 0.9);
    }
    this.lookYaw = lerp(this.lookYaw, yawGoal, 1 - Math.exp(-4 * dt));

    // Neck
    const n = P.neck.joints.length;
    P.neck.joints.forEach((j, i) => {
      const f = i / (n - 1);
      j.rotation.x = P.neckRest[i] + (Math.sin(t * 1.3 + i * 0.4) * 0.025 + Math.sin(g * 2 - i * 0.5) * 0.04 * mb) * (0.5 + f)
        - fx.neckLift * (0.3 + f * 0.7) * 0.5 + this.hunger * 0.08 * Math.sin(t * 9 + i);
      j.rotation.z = (this.lookYaw / n) * 1.1 + Math.sin(t * 0.8 + i * 0.5) * 0.03 + jitter;
    });
    P.head.rotation.x = -Math.PI / 2 + fx.headPitch + 0.12;
    P.jaw.rotation.x = clamp(fx.jaw, 0, 1) * 0.7 + 0.02 + Math.sin(t * 1.7) * 0.01 + this.hunger * 0.12;

    // Tail
    const tn = P.tail.joints.length;
    const wag = 0.55 + mb * 0.8 + this.hyper * 1.2;
    P.tail.joints.forEach((j, i) => {
      const f = i / tn;
      j.rotation.z = Math.sin(t * (1.6 + this.hyper * 5) - i * 0.55) * 0.1 * wag * (0.4 + f) + Math.sin(g - i * 0.4) * 0.04 * mb;
      j.rotation.x = (i < 3 ? -0.04 : 0.05) + Math.sin(t * 1.1 - i * 0.4) * 0.025 + fx.faint * (i < 5 ? 0.0 : 0.1);
    });

    // Legs
    for (const L of P.legs) {
      const ph = g + L.phase;
      const swing = Math.sin(ph);
      const lift = Math.max(0, -Math.cos(ph));
      const amp = L.amp * mb * (0.7 + running * 0.5);
      L.joints[0].rotation.x = L.rest[0] + swing * amp * 0.8;
      L.joints[1].rotation.x = L.rest[1] + L.bendSign * lift * 0.9 * mb * (1 + running * 0.5) * (L.kind === 'arm' ? 0.3 : 1);
      L.joints[2].rotation.x = L.rest[2] - L.bendSign * lift * 0.4 * mb;
      if (fx.faint) L.joints[0].rotation.x += fx.faint * L.side * 0.6;
    }

    // Wings: folded by default, spread when roaring/attacking
    const spread = clamp(fx.wing + (opts.spread ?? 0) + this.hyper * 0.15, 0, 1);
    const flap = Math.sin(t * (3 + spread * 3)) * (0.1 + spread * 0.55) * (spread > 0.15 ? 1 : 0.3);
    for (const W of P.wings) {
      W.shoulder.rotation.y = lerp(1.1, 0.05, spread);
      W.shoulder.rotation.z = lerp(0.3, 0.2, spread) + flap * (spread > 0.15 ? 1 : 0.1) + Math.sin(t * 1.2) * 0.02;
      W.elbow.rotation.y = lerp(-2.4, -0.05, spread);
      W.elbow.rotation.z = lerp(0.0, -0.1, spread) - flap * 0.4 * spread;
      W.shoulder.scale.setScalar(lerp(0.7, 1, spread));
      const chord = lerp(0.16, 1, spread);
      W.elbow.scale.set(lerp(0.7, 1, spread), 1, chord);
      W.inner.scale.set(1, 1, chord);
    }

    // Flash on hit
    const f = fx.flash;
    this.mats.skin.color.setRGB(1.35 + f * 1.4, 1.35 - f * 0.6, 1.35 - f * 0.7);
    this.mats.eye.emissiveIntensity = 2.2 + this.hunger * 2.5 + (this.hunger > 0.5 ? Math.sin(t * 8) * 0.8 : 0);
    this.mats.eye.emissive.copy(this.pal.eye).lerp(new THREE.Color(1, 0.1, 0.05), this.hunger);

    if (this.arcs) this._updateArcs(dt);
  }
}
