import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Terrain, SEG } from './terrain.js';
import * as TX from './textures.js';
import { WORLD, clamp, lerp, smoothstep, mulberry32 } from './config.js';
import { hash2, makeNoise } from './noise.js';

const CELL = 100;
const TREE_VIEW = 330;
const GRASS_R = 46;
const GRASS_MAX = 26000;

function boxUV(geo, scale) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, p.getX(i) * scale, p.getZ(i) * scale);
    else if (ax >= az) uv.setXY(i, p.getZ(i) * scale, p.getY(i) * scale);
    else uv.setXY(i, p.getX(i) * scale, p.getY(i) * scale);
  }
}

function displaceBlob(geo, noise, amp, seed) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = noise.fbm(v.x * 0.9 + seed, v.y * 0.9 + v.z * 0.7, 3) * amp;
    v.multiplyScalar(1 + d);
    p.setXYZ(i, v.x, v.y, v.z);
  }
}

function radialNormals(geo, center) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).sub(center).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
}

export class World {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.terrain = new Terrain();
    this.noise = makeNoise(31);
    this.colHash = new Map();
    this.treeCells = [];
    this.pickups = [];
    this.lightSources = [];
    this.time = 0;
    this._grassCenter = new THREE.Vector2(1e9, 1e9);
    this.spawn = new THREE.Vector3(0, 0, 0);
    this.camp = new THREE.Vector3(7, 0, -5);
  }

  async init(progress = () => {}) {
    const r = this.renderer;
    progress('Reading the land', 0.05);
    const arrays = await TX.buildTerrainArrays(r);
    this.bark = await TX.loadPBR('bark');
    this.rockTex = await TX.loadPBR('rock');
    this.leafBroad = TX.makeLeafTexture('broad');
    this.leafBroad.repeat.set(4, 3);
    this.leafPine = TX.makeLeafTexture('pine');
    this.leafPine.repeat.set(3, 2);
    this.glow = TX.makeGlowSprite();

    progress('Raising mountains', 0.2);
    this.terrainMesh = this.terrain.buildMesh(arrays);
    this.scene.add(this.terrainMesh);

    this._buildSky();
    progress('Filling the lakes', 0.3);
    this._buildWater();
    this._buildLava();
    progress('Planting forests', 0.4);
    this._buildTrees();
    progress('Scattering stone', 0.6);
    this._buildRocks();
    this._buildCamp();
    progress('Hiding snacks', 0.75);
    this._buildPickups();
    this._buildGrass();
    this._buildParticles();
    this._buildLightPool();
    this.minimap = this._renderMinimap(360);
    progress('Ready', 1);
  }

  // ---------- Sky & light ----------
  _buildSky() {
    const sky = new Sky();
    sky.scale.setScalar(4000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.4;
    u.rayleigh.value = 2.1;
    u.mieCoefficient.value = 0.003;
    u.mieDirectionalG.value = 0.74;
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 30), THREE.MathUtils.degToRad(35));
    u.sunPosition.value.copy(this.sunDir);
    this.scene.add(sky);
    this.sky = sky;

    const envScene = new THREE.Scene();
    const skyEnv = new Sky();
    skyEnv.material = sky.material;
    skyEnv.scale.setScalar(100);
    envScene.add(skyEnv);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(envScene);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();

    this.scene.fog = new THREE.FogExp2(0xb7cadb, 0.0042);
    this.hemi = new THREE.HemisphereLight(0xa9c7ea, 0x4b4331, 0.55);
    this.scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(0xfff0dc, 4.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -75; sc.right = sc.top = 75; sc.near = 10; sc.far = 600;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.sun = sun;
    this.scene.add(sun, sun.target);
  }

  // ---------- Water ----------
  _buildWater() {
    const T = this.terrain, W = SEG + 1, STEP = WORLD.size / SEG, half = WORLD.half;
    const level = WORLD.waterLevel;
    const map = new Int32Array(W * W).fill(-1);
    const pos = [], col = [], uv = [], idx = [];
    const vert = (i, j) => {
      const k = j * W + i;
      if (map[k] >= 0) return map[k];
      const x = -half + i * STEP, z = -half + j * STEP, h = T.heights[k];
      const depth = level - h;
      const a = clamp(depth / 2.6, 0, 1);
      const d = clamp(depth / 14, 0, 1);
      pos.push(x, level, z);
      uv.push(x, z);
      col.push(lerp(0.12, 0.02, d), lerp(0.36, 0.1, d), lerp(0.42, 0.2, d), 0.15 + a * 0.8);
      map[k] = pos.length / 3 - 1;
      return map[k];
    };
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const k = j * W + i;
        if (Math.min(T.heights[k], T.heights[k + 1], T.heights[k + W], T.heights[k + W + 1]) > level + 0.2) continue;
        const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.waterNormal = TX.makeWaterNormal();
    this.waterNormal.repeat.set(0.16, 0.16);
    const m = new THREE.MeshPhysicalMaterial({
      vertexColors: true, transparent: true, roughness: 0.06, metalness: 0.0, normalMap: this.waterNormal,
      normalScale: new THREE.Vector2(0.55, 0.55), envMapIntensity: 1.4, depthWrite: false, specularIntensity: 1.0,
    });
    this.water = new THREE.Mesh(g, m);
    this.water.renderOrder = 2;
    this.scene.add(this.water);
  }

  // ---------- Lava ----------
  _buildLava() {
    this.lavaTex = TX.makeLavaTexture();
    this.lavaMeshes = [];
    for (const p of this.terrain.lavaPools) {
      const g = new THREE.CircleGeometry(p.r * 1.75, 48);
      g.rotateX(-Math.PI / 2);
      const uv = g.attributes.uv;
      const pos = g.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 9, pos.getZ(i) / 9);
      const tex = this.lavaTex.clone();
      tex.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.7, roughness: 0.55,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(p.x, p.y, p.z);
      this.scene.add(mesh);
      this.lavaMeshes.push(mesh);
      this.lightSources.push({ pos: new THREE.Vector3(p.x, p.y + 3, p.z), color: 0xff6a1a, intensity: 220, range: 55, flicker: 0.15 });
    }
    // Volcano crater glow
    const cy = this.terrain.heightAt(0, 410) + 4;
    this.lightSources.push({ pos: new THREE.Vector3(0, cy, 410), color: 0xff5a14, intensity: 600, range: 120, flicker: 0.2 });
  }

  // ---------- Colliders ----------
  _addCollider(x, z, r) {
    const key = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    let list = this.colHash.get(key);
    if (!list) { list = []; this.colHash.set(key, list); }
    list.push(x, z, r);
  }

  pushOut(pos, radius) {
    const cx = Math.floor(pos.x / 8), cz = Math.floor(pos.z / 8);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.colHash.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const ox = pos.x - list[i], oz = pos.z - list[i + 1];
          const min = radius + list[i + 2];
          const d2 = ox * ox + oz * oz;
          if (d2 < min * min && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            pos.x += (ox / d) * (min - d);
            pos.z += (oz / d) * (min - d);
          }
        }
      }
    }
  }

  // ---------- Trees ----------
  _buildTrees() {
    const rnd = mulberry32(8080);
    const T = this.terrain;
    const nz = makeNoise(4);

    const barkMat = new THREE.MeshStandardMaterial({
      map: this.bark.map, normalMap: this.bark.normalMap, roughnessMap: this.bark.roughnessMap, color: 0xffffff,
    });
    const deadMat = barkMat.clone();
    deadMat.color.setScalar(0.28);

    const broadFoliage = new THREE.MeshStandardMaterial({
      map: this.leafBroad, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, color: 0xffffff,
    });
    const pineFoliage = new THREE.MeshStandardMaterial({
      map: this.leafPine, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, color: 0xffffff,
    });

    const trunkGeo = (h, r0, r1) => {
      const g = new THREE.CylinderGeometry(r1, r0, h, 8, 3);
      g.translate(0, h / 2, 0);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * (h / 1.5));
      return g;
    };
    const branch = (len, r, ax, az, y) => {
      const g = new THREE.CylinderGeometry(r * 0.4, r, len, 5, 1);
      g.translate(0, len / 2, 0);
      g.rotateZ(az); g.rotateX(ax);
      g.translate(0, y, 0);
      return g;
    };

    // Broadleaf
    const broadTrunk = mergeGeometries([
      trunkGeo(4.8, 0.32, 0.16),
      branch(2.4, 0.13, 0.6, -0.9, 3.4),
      branch(2.2, 0.12, -0.5, 0.9, 3.9),
      branch(2.0, 0.1, 0.9, 0.5, 3.0),
    ]);
    const blobs = [];
    const blobDefs = [[0, 6.3, 0, 2.4], [1.6, 5.4, 0.5, 1.9], [-1.5, 5.6, -0.7, 2.0], [0.4, 5.3, 1.7, 1.8], [-0.3, 7.6, -0.2, 1.7]];
    blobDefs.forEach((d, k) => {
      const g = new THREE.IcosahedronGeometry(d[3], 1);
      displaceBlob(g, nz, 0.22, k * 5.3);
      g.translate(d[0], d[1], d[2]);
      radialNormals(g, new THREE.Vector3(d[0], d[1] - 0.8, d[2]));
      blobs.push(g);
    });
    const broadLeaves = mergeGeometries(blobs);

    // Conifer
    const pineTrunk = trunkGeo(11, 0.32, 0.08);
    const cones = [];
    [[1.6, 3.2, 3.6], [1.35, 6.4, 3.2], [1.0, 9.5, 2.8], [0.65, 12.0, 2.4], [0.35, 14.0, 2.0]].forEach(([y0, yy, h], k) => {
      const base = [3.4, 2.8, 2.2, 1.6, 0.9][k];
      const g = new THREE.ConeGeometry(base, h * 1.15, 9, 1, true);
      g.translate(0, yy + h * 0.45, 0);
      g.rotateY(k);
      const n = g.attributes.normal;
      for (let i = 0; i < n.count; i++) n.setY(i, n.getY(i) * 0.5 + 0.35);
      cones.push(g.toNonIndexed());
    });
    const pineLeaves = mergeGeometries(cones);

    // Dead tree
    const deadGeo = mergeGeometries([
      trunkGeo(5.2, 0.3, 0.08),
      branch(2.3, 0.1, 0.8, -1.0, 3.2), branch(2.0, 0.09, -0.7, 1.1, 3.8),
      branch(1.6, 0.08, 1.0, 0.2, 4.4), branch(1.8, 0.08, -0.4, -1.0, 2.6),
    ]);

    const species = {
      broad: { trunk: broadTrunk, leaves: broadLeaves, trunkMat: barkMat, leafMat: broadFoliage, r: 0.4, items: new Map() },
      pine: { trunk: pineTrunk, leaves: pineLeaves, trunkMat: barkMat, leafMat: pineFoliage, r: 0.4, items: new Map() },
      dead: { trunk: deadGeo, leaves: null, trunkMat: deadMat, leafMat: null, r: 0.35, items: new Map() },
    };

    const STEP = 6.5;
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (let gx = -WORLD.half + 10; gx < WORLD.half - 10; gx += STEP) {
      for (let gz = -WORLD.half + 10; gz < WORLD.half - 10; gz += STEP) {
        const x = gx + (rnd() - 0.5) * STEP * 0.9;
        const z = gz + (rnd() - 0.5) * STEP * 0.9;
        const d0 = Math.hypot(x, z);
        if (d0 < 26) continue;
        const h = T.heightAt(x, z);
        if (h < WORLD.waterLevel + 0.9 || h > 44) continue;
        if (T.slopeAt(x, z) > 0.62 || T.inLava(x, z, 8)) continue;
        const b = T.biomeWeights(x, z);
        const density = b.meadow * 0.07 + b.forest * 0.95 + b.water * 0.2 + b.earth * 0.1 + b.fire * 0.1;
        if (rnd() > density) continue;
        let kind;
        if (b.fire > 0.5) kind = 'dead';
        else {
          const pineP = clamp(0.1 + b.earth * 0.8 + b.forest * 0.45 + smoothstep(14, 30, h), 0, 1);
          kind = rnd() < pineP ? 'pine' : 'broad';
        }
        const s = (kind === 'pine' ? 0.8 + rnd() * 0.9 : 0.75 + rnd() * 0.75);
        dummy.position.set(x, h - 0.2, z);
        dummy.rotation.set((rnd() - 0.5) * 0.06, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.06);
        dummy.scale.set(s * (0.9 + rnd() * 0.25), s, s * (0.9 + rnd() * 0.25));
        dummy.updateMatrix();
        const sp = species[kind];
        const key = `${Math.floor((x + WORLD.half) / CELL)},${Math.floor((z + WORLD.half) / CELL)}`;
        let arr = sp.items.get(key);
        if (!arr) { arr = []; sp.items.set(key, arr); }
        const tint = kind === 'pine' ? col.setHSL(0.36 + rnd() * 0.05, 0.4, 0.55 + rnd() * 0.25)
          : col.setHSL(0.2 + rnd() * 0.12 - b.water * 0.04, 0.5, 0.5 + rnd() * 0.3);
        arr.push({ m: dummy.matrix.clone(), c: tint.clone() });
        this._addCollider(x, z, sp.r * s);
      }
    }

    this.trees = new THREE.Group();
    this.scene.add(this.trees);
    const cells = new Map();
    for (const [name, sp] of Object.entries(species)) {
      for (const [key, arr] of sp.items) {
        const [cx, cz] = key.split(',').map(Number);
        const center = new THREE.Vector3(-WORLD.half + (cx + 0.5) * CELL, 0, -WORLD.half + (cz + 0.5) * CELL);
        let cell = cells.get(key);
        if (!cell) { cell = { center, group: new THREE.Group() }; cells.set(key, cell); this.trees.add(cell.group); }
        const mk = (geo, mat, colored) => {
          const im = new THREE.InstancedMesh(geo, mat, arr.length);
          arr.forEach((it, i) => { im.setMatrixAt(i, it.m); if (colored) im.setColorAt(i, it.c); });
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.castShadow = true;
          im.receiveShadow = true;
          im.computeBoundingSphere();
          cell.group.add(im);
        };
        mk(sp.trunk, sp.trunkMat, false);
        if (sp.leaves) mk(sp.leaves, sp.leafMat, true);
      }
    }
    this.treeCells = [...cells.values()];
  }

  // ---------- Rocks ----------
  _buildRocks() {
    const rnd = mulberry32(555);
    const T = this.terrain;
    const nz = makeNoise(9);
    const mat = new THREE.MeshStandardMaterial({
      map: this.rockTex.map, normalMap: this.rockTex.normalMap, roughnessMap: this.rockTex.roughnessMap, color: 0xffffff,
    });
    this.rockTex.map.repeat.set(1, 1);
    const variants = [];
    for (let v = 0; v < 3; v++) {
      const g = new THREE.IcosahedronGeometry(1, 2);
      const p = g.attributes.position;
      const vec = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        vec.fromBufferAttribute(p, i);
        const n = nz.fbm(vec.x * 1.3 + v * 7, vec.y * 1.3 + vec.z * 1.1, 4) * 0.45 + nz.noise(vec.x * 4 + v, vec.z * 4) * 0.08;
        vec.multiplyScalar(1 + n);
        vec.y *= 0.75;
        p.setXYZ(i, vec.x, vec.y, vec.z);
      }
      g.computeVertexNormals();
      boxUV(g, 0.5);
      variants.push(g);
    }
    const buckets = variants.map(() => []);
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const add = (x, z, s) => {
      const h = T.heightAt(x, z);
      if (h < WORLD.waterLevel + 0.3 || T.inLava(x, z, 4)) return;
      const v = Math.floor(rnd() * variants.length);
      dummy.position.set(x, h + s * 0.1, z);
      dummy.rotation.set((rnd() - 0.5) * 0.4, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.4);
      dummy.scale.set(s * (0.8 + rnd() * 0.5), s * (0.7 + rnd() * 0.6), s * (0.8 + rnd() * 0.5));
      dummy.updateMatrix();
      const b = T.biomeWeights(x, z);
      col.setHSL(0.08 - b.fire * 0.04, 0.12 + b.earth * 0.1, 0.45 + rnd() * 0.25 - b.fire * 0.2);
      buckets[v].push({ m: dummy.matrix.clone(), c: col.clone() });
      if (s > 0.9) this._addCollider(x, z, s * 0.85);
    };
    for (let i = 0; i < 520; i++) {
      const x = (rnd() - 0.5) * 940, z = (rnd() - 0.5) * 940;
      if (Math.hypot(x, z) < 22) continue;
      const b = T.biomeWeights(x, z);
      const p = 0.12 + b.earth * 0.9 + b.fire * 0.4;
      if (rnd() < p) add(x, z, 0.5 + Math.pow(rnd(), 2.2) * 3.2);
    }
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2, d = 120 + rnd() * 340;
      const x = 310 + Math.cos(a) * d * 0.55, z = Math.sin(a) * d * 0.7;
      if (Math.abs(x) > 460 || Math.abs(z) > 460) continue;
      add(x, z, 5 + rnd() * 7);
    }
    this.rocks = new THREE.Group();
    this.scene.add(this.rocks);
    buckets.forEach((arr, v) => {
      if (!arr.length) return;
      const im = new THREE.InstancedMesh(variants[v], mat, arr.length);
      arr.forEach((it, i) => { im.setMatrixAt(i, it.m); im.setColorAt(i, it.c); });
      im.castShadow = true; im.receiveShadow = true;
      im.computeBoundingSphere();
      this.rocks.add(im);
    });
  }

  // ---------- Campfire ----------
  _buildCamp() {
    const T = this.terrain;
    const c = this.camp;
    c.y = T.heightAt(c.x, c.z);
    const group = new THREE.Group();
    group.position.copy(c);
    const rockGeo = new THREE.IcosahedronGeometry(0.5, 1);
    const mat = new THREE.MeshStandardMaterial({ map: this.rockTex.map, normalMap: this.rockTex.normalMap, color: 0x9a9a98, roughness: 0.95 });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const m = new THREE.Mesh(rockGeo, mat);
      const x = c.x + Math.cos(a) * 1.5, z = c.z + Math.sin(a) * 1.5;
      m.position.set(Math.cos(a) * 1.5, T.heightAt(x, z) - c.y + 0.2, Math.sin(a) * 1.5);
      m.scale.set(1, 0.7, 1.1);
      m.rotation.y = i;
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
    const logMat = new THREE.MeshStandardMaterial({ map: this.bark.map, normalMap: this.bark.normalMap, color: 0x6d5a4a });
    for (let i = 0; i < 4; i++) {
      const g = new THREE.CylinderGeometry(0.12, 0.14, 1.3, 7);
      const m = new THREE.Mesh(g, logMat);
      m.rotation.set(Math.PI / 2 - 0.35, (i / 4) * Math.PI * 2 + 0.4, 0);
      m.position.set(Math.cos(i * 1.6) * 0.15, 0.22, Math.sin(i * 1.6) * 0.15);
      m.castShadow = true;
      group.add(m);
    }
    this.flames = [];
    const flameTex = TX.makeFlameTexture();
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 1.5),
        new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(1.8, 1.2, 0.8) }),
      );
      m.position.y = 0.75;
      m.rotation.y = (i / 4) * Math.PI;
      group.add(m);
      this.flames.push(m);
    }
    this.scene.add(group);
    this.lightSources.push({ pos: new THREE.Vector3(c.x, c.y + 1.3, c.z), color: 0xff9a40, intensity: 26, range: 28, flicker: 0.25, camp: true });
    this._addCollider(c.x, c.z, 1.7);
  }

  // ---------- Pickups ----------
  _buildPickups() {
    const rnd = mulberry32(9090);
    const T = this.terrain;

    const brocGeo = (() => {
      const stem = new THREE.CylinderGeometry(0.05, 0.075, 0.28, 7);
      stem.translate(0, 0.14, 0);
      const parts = [stem];
      const cols = [[0.55, 0.72, 0.3]];
      const flo = [[0, 0.42, 0, 0.17], [0.13, 0.35, 0.05, 0.12], [-0.12, 0.36, 0.06, 0.12], [0.02, 0.33, -0.13, 0.12], [0.02, 0.36, 0.14, 0.11]];
      flo.forEach((f, k) => {
        const g = new THREE.IcosahedronGeometry(f[3], 1);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const s = 1 + Math.sin(p.getX(i) * 40 + k) * Math.cos(p.getZ(i) * 37) * 0.18;
          p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
        }
        g.translate(f[0], f[1], f[2]);
        parts.push(g);
        cols.push([0.1, 0.36 + (k % 2) * 0.06, 0.1]);
      });
      parts[0] = parts[0].toNonIndexed();
      parts.forEach((g, i) => {
        const n = g.attributes.position.count;
        const c = new Float32Array(n * 3);
        for (let v = 0; v < n; v++) { c[v * 3] = cols[i][0]; c[v * 3 + 1] = cols[i][1]; c[v * 3 + 2] = cols[i][2]; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        g.deleteAttribute('uv');
      });
      return mergeGeometries(parts);
    })();
    const brocMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });

    const candyPairs = [['#ff4f9a', '#ffffff'], ['#3ec3ff', '#ffffff'], ['#ffd23f', '#ff5a3c'], ['#9b5cff', '#ffffff']];
    const candyMats = candyPairs.map(([a, b]) => new THREE.MeshStandardMaterial({ map: TX.makeCandySwirl(a, b), roughness: 0.18, metalness: 0 }));
    const candyBall = new THREE.SphereGeometry(0.2, 16, 12);
    candyBall.scale(1, 1, 0.35);
    const stickGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6);
    const stickMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
    const wrapGeo = new THREE.CapsuleGeometry(0.07, 0.18, 4, 8);
    wrapGeo.rotateZ(Math.PI / 2);

    const glowMats = {
      broccoli: new THREE.SpriteMaterial({ map: this.glow, color: 0x6dff7a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.22 }),
      candy: new THREE.SpriteMaterial({ map: this.glow, color: 0xff7ad9, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.26 }),
    };

    this.pickupGroup = new THREE.Group();
    this.scene.add(this.pickupGroup);

    const place = (type, x, z) => {
      const y = T.heightAt(x, z);
      const g = new THREE.Group();
      g.position.set(x, y, z);
      let spin = null;
      if (type === 'broccoli') {
        const m = new THREE.Mesh(brocGeo, brocMat);
        m.scale.setScalar(1.4);
        m.castShadow = true;
        g.add(m);
        spin = m;
      } else {
        const mi = Math.floor(rnd() * candyMats.length);
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + rnd();
          const stick = new THREE.Mesh(stickGeo, stickMat);
          const lean = 0.25 + rnd() * 0.2;
          stick.position.set(Math.cos(a) * 0.1, 0.28, Math.sin(a) * 0.1);
          stick.rotation.set(Math.sin(a) * lean, 0, -Math.cos(a) * lean);
          g.add(stick);
          const ball = new THREE.Mesh(candyBall, candyMats[(mi + k) % candyMats.length]);
          ball.position.set(Math.cos(a) * (0.1 + Math.sin(lean) * 0.28), 0.28 + Math.cos(lean) * 0.28, Math.sin(a) * (0.1 + Math.sin(lean) * 0.28));
          ball.lookAt(ball.position.clone().add(new THREE.Vector3(Math.sin(a) * lean * 0.5, 1, -Math.cos(a) * lean * 0.5)));
          ball.castShadow = true;
          g.add(ball);
        }
        const wrap = new THREE.Mesh(wrapGeo, candyMats[(mi + 1) % candyMats.length]);
        wrap.position.set(0.18, 0.09, 0.1);
        g.add(wrap);
        g.scale.setScalar(1.8);
      }
      const sprite = new THREE.Sprite(glowMats[type]);
      sprite.scale.setScalar(type === 'broccoli' ? 1.3 : 1.6);
      sprite.position.y = 0.55;
      g.add(sprite);
      this.pickupGroup.add(g);
      this.pickups.push({ type, obj: g, spin, pos: new THREE.Vector3(x, y, z), active: true, respawnAt: 0, phase: rnd() * 6 });
    };

    const tryPlace = (type, count, minR, maxR, filter) => {
      let placed = 0, guard = 0;
      while (placed < count && guard++ < count * 60) {
        const a = rnd() * Math.PI * 2, d = minR + Math.sqrt(rnd()) * (maxR - minR);
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        if (Math.abs(x) > 455 || Math.abs(z) > 455) continue;
        const h = T.heightAt(x, z);
        if (h < WORLD.waterLevel + 0.6 || T.slopeAt(x, z) > 0.5 || T.inLava(x, z, 4)) continue;
        if (filter && !filter(T.biomeWeights(x, z), h)) continue;
        place(type, x, z);
        placed++;
      }
    };
    // Starter stash near the spawn camp, then spread across the world.
    tryPlace('broccoli', 10, 10, 55);
    tryPlace('candy', 8, 12, 60);
    tryPlace('broccoli', 90, 55, 460, (b) => b.fire < 0.5);
    tryPlace('candy', 70, 55, 460);
  }

  nearestPickup(pos, range) {
    let best = null, bd = range * range;
    for (const p of this.pickups) {
      if (!p.active) continue;
      const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  collect(p, now) {
    p.active = false;
    p.obj.visible = false;
    p.respawnAt = now + 90 + Math.random() * 60;
  }

  // ---------- Grass ----------
  _buildGrass() {
    const tex = TX.makeGrassTuft();
    const planes = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(1, 1);
      g.translate(0, 0.5, 0);
      g.rotateY((i / 3) * Math.PI);
      const n = g.attributes.normal;
      for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
      planes.push(g);
    }
    const geo = mergeGeometries(planes);
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff });
    this.grassUniforms = { uTime: { value: 0 } };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float gw = uv.y * uv.y;
vec2 ip = instanceMatrix[3].xz;
float gph = uTime * 1.7 + ip.x * 0.33 + ip.y * 0.27;
transformed.x += (sin(gph) + 0.5 * sin(gph * 2.3 + 1.0)) * 0.1 * gw;
transformed.z += cos(gph * 0.83) * 0.07 * gw;`);
    };
    this.grass = new THREE.InstancedMesh(geo, mat, GRASS_MAX);
    this.grass.frustumCulled = false;
    this.grass.receiveShadow = true;
    this.grass.count = 0;
    this.scene.add(this.grass);
    this._scatterGrass(0, 0);
  }

  _scatterGrass(cx, cz) {
    const T = this.terrain;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();
    const CELLG = 0.58;
    let n = 0;
    const x0 = Math.floor((cx - GRASS_R) / CELLG), x1 = Math.ceil((cx + GRASS_R) / CELLG);
    const z0 = Math.floor((cz - GRASS_R) / CELLG), z1 = Math.ceil((cz + GRASS_R) / CELLG);
    for (let gx = x0; gx <= x1 && n < GRASS_MAX; gx++) {
      for (let gz = z0; gz <= z1 && n < GRASS_MAX; gz++) {
        const x = (gx + hash2(gx, gz, 1)) * CELLG;
        const z = (gz + hash2(gx, gz, 2)) * CELLG;
        const d = Math.hypot(x - cx, z - cz);
        if (d > GRASS_R) continue;
        const b = T.biomeWeights(x, z);
        const dens = (b.meadow + b.forest * 0.6 + b.water * 0.5 + b.earth * 0.15) * (1 - smoothstep(24, 34, T.heightAt(x, z)));
        if (hash2(gx, gz, 3) > dens * 0.9) continue;
        const h = T.heightAt(x, z);
        if (h < WORLD.waterLevel + 0.4 || h > 40 || T.slopeAt(x, z) > 0.7) continue;
        const fade = 1 - smoothstep(GRASS_R * 0.62, GRASS_R, d);
        const s = (0.5 + hash2(gx, gz, 4) * 0.55) * (0.35 + 0.65 * fade);
        pos.set(x, h - 0.03, z);
        e.set(0, hash2(gx, gz, 5) * 6.28, 0);
        q.setFromEuler(e);
        sc.set(s * 1.1, (0.3 + hash2(gx, gz, 6) * 0.3) * (0.35 + 0.65 * fade), s * 1.1);
        m.compose(pos, q, sc);
        this.grass.setMatrixAt(n, m);
        const dry = b.earth * 0.4 + (1 - dens) * 0.2;
        col.setHSL(0.24 - dry * 0.1, 0.55 - dry * 0.2, 0.42 + hash2(gx, gz, 7) * 0.2);
        this.grass.setColorAt(n, col);
        n++;
      }
    }
    this.grass.count = n;
    this.grass.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
    this._grassCenter.set(cx, cz);
  }

  // ---------- Ambient particles (pollen / embers / snow) ----------
  _buildParticles() {
    const N = 900;
    const seeds = new Float32Array(N * 4);
    const rnd = mulberry32(3);
    for (let i = 0; i < N * 4; i++) seeds[i] = rnd();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.particleUniforms = {
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBiome: { value: new THREE.Vector4() }, uScale: { value: 600 },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.particleUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uTime; uniform vec3 uCam; uniform vec4 uBiome; uniform float uScale;
        attribute vec4 aSeed; varying float vA; varying vec3 vC;
        void main() {
          vec3 box = vec3(60.0, 22.0, 60.0);
          vec3 vel = vec3(0.3, 0.05, 0.2) * uBiome.z + vec3(0.7, 2.4, 0.4) * uBiome.x + vec3(0.5, -1.1, 0.2) * uBiome.y;
          vec3 p = aSeed.xyz * box + vel * uTime;
          p.x += sin(uTime * 0.7 + aSeed.w * 20.0) * 0.8; p.z += cos(uTime * 0.6 + aSeed.w * 17.0) * 0.8;
          p = mod(p - uCam + box * 0.5, box) - box * 0.5;
          p += vec3(0.0, 6.0, 0.0);
          vec4 mv = viewMatrix * vec4(p + uCam, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = mix(0.05, 0.17, aSeed.w) * uScale / max(-mv.z, 0.5);
          vC = uBiome.x * vec3(1.0, 0.42, 0.1) + uBiome.y * vec3(0.9, 0.95, 1.0) + uBiome.z * vec3(1.0, 0.95, 0.55);
          vA = clamp(uBiome.x + uBiome.y + uBiome.z, 0.0, 1.0) * (0.35 + aSeed.w * 0.65) * smoothstep(60.0, 8.0, -mv.z);
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC * 1.6, a);
        }`,
    });
    this.particles = new THREE.Points(g, m);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  // ---------- Dynamic light pool (constant light count to avoid shader recompiles) ----------
  _buildLightPool() {
    this.lightPool = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 60, 2);
      this.scene.add(l);
      this.lightPool.push(l);
    }
    this.flashLight = new THREE.PointLight(0xffffff, 0, 80, 2);
    this.scene.add(this.flashLight);
  }

  // ---------- Minimap ----------
  _renderMinimap(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const T = this.terrain;
    const sp = [0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const wx = (x / size - 0.5) * WORLD.size, wz = (y / size - 0.5) * WORLD.size;
        const h = T.heightAt(wx, wz);
        T.splatAt(wx, wz, h, sp);
        const g = sp[0];
        let r = g * 62 + sp[1] * 128 + sp[2] * 236 + sp[3] * 68;
        let gg = g * 112 + sp[1] * 108 + sp[2] * 240 + sp[3] * 56;
        let b = g * 52 + sp[1] * 84 + sp[2] * 246 + sp[3] * 52;
        const shade = clamp(1 + (h - T.heightAt(wx + 8, wz + 8)) * 0.05, 0.6, 1.4);
        r *= shade; gg *= shade; b *= shade;
        if (h < WORLD.waterLevel) { r = 40; gg = 92; b = 150; }
        if (T.inLava(wx, wz)) { r = 255; gg = 110; b = 30; }
        const i = (y * size + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- Per-frame ----------
  update(dt, camera, focus) {
    this.time += dt;
    const t = this.time;
    const cp = camera.position;

    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.sun.position.copy(this.sunDir).multiplyScalar(300).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();

    if (this.waterNormal) {
      this.waterNormal.offset.x += dt * 0.012;
      this.waterNormal.offset.y += dt * 0.007;
    }
    for (const m of this.lavaMeshes) {
      m.material.map.offset.x += dt * 0.004;
      m.material.map.offset.y += dt * 0.002;
      m.material.emissiveIntensity = 1.6 + Math.sin(t * 1.3 + m.position.x) * 0.25;
    }
    for (const [i, f] of this.flames.entries()) {
      const k = 1 + Math.sin(t * 11 + i * 2) * 0.12 + Math.sin(t * 17 + i) * 0.08;
      f.scale.set(k, 0.9 + (k - 1) * 2.2, k);
    }

    // Pick the 3 nearest light sources to the camera.
    const srcs = this.lightSources
      .map((s) => ({ s, d: s.pos.distanceToSquared(cp) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lightPool.length);
    this.lightPool.forEach((l, i) => {
      const e = srcs[i];
      if (!e || e.d > (e.s.range * 3) ** 2) { l.intensity = 0; return; }
      const fl = 1 + (Math.sin(t * 13 + i * 3) * 0.5 + Math.sin(t * 7.3 + i) * 0.5) * e.s.flicker;
      l.position.copy(e.s.pos);
      l.color.setHex(e.s.color);
      l.distance = e.s.range;
      l.intensity = e.s.intensity * fl;
    });

    // Tree cell visibility
    for (const c of this.treeCells) {
      const dx = c.center.x - cp.x, dz = c.center.z - cp.z;
      c.group.visible = dx * dx + dz * dz < (TREE_VIEW + 70) ** 2;
    }

    // Grass follows the player
    this.grassUniforms.uTime.value = t;
    if (Math.hypot(focus.x - this._grassCenter.x, focus.z - this._grassCenter.y) > 10) this._scatterGrass(focus.x, focus.z);

    // Pickups
    for (const p of this.pickups) {
      if (!p.active) {
        if (t > p.respawnAt) { p.active = true; p.obj.visible = true; }
        continue;
      }
      const near = p.pos.distanceToSquared(cp) < 140 * 140;
      p.obj.visible = near;
      if (!near) continue;
      p.obj.position.y = p.pos.y + 0.12 + Math.sin(t * 1.8 + p.phase) * 0.05;
      if (p.spin) p.spin.rotation.y = t * 0.8 + p.phase;
    }

    // Ambient particles
    const b = this.terrain.biomeWeights(focus.x, focus.z);
    const snow = Math.max(smoothstep(26, 40, focus.y) * 0.9, b.water * smoothstep(6, 14, focus.y) * 0.4);
    this.particleUniforms.uTime.value = t;
    this.particleUniforms.uCam.value.copy(cp);
    this.particleUniforms.uBiome.value.set(b.fire * 1.0, snow, (b.meadow + b.forest * 0.6) * 0.5, 0);
    this.particleUniforms.uScale.value = this.renderer.domElement.height * 0.35;

    this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 400);
  }

  flash(pos, color, intensity = 300) {
    this.flashLight.position.copy(pos);
    this.flashLight.color.set(color);
    this.flashLight.intensity = intensity;
  }
}
