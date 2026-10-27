import * as THREE from 'three';
import { WORLD, clamp, lerp, smoothstep, mulberry32 } from './config.js';
import { makeNoise } from './noise.js';

export const SEG = 384;
const SIZE = WORLD.size;
const HALF = SIZE / 2;
const STEP = SIZE / SEG;

// Biome anchors (x, z). Meadow is whatever is left in the middle.
export const BIOMES = {
  fire: { x: 0, z: 310, name: 'Cinder Wastes' },
  water: { x: -310, z: 0, name: 'Misty Lakes' },
  earth: { x: 310, z: 0, name: 'Stone Highlands' },
  forest: { x: 0, z: -310, name: 'Whisperwood' },
};
const BIOME_R = 210;

export class Terrain {
  constructor(seed = 2024) {
    this.n = makeNoise(seed);
    this.heights = new Float32Array((SEG + 1) * (SEG + 1));
    this.lavaPools = [];
    this._makeLavaPools();
    this._bake();
  }

  biomeWeights(x, z) {
    const out = {};
    let strongest = 0;
    for (const k of Object.keys(BIOMES)) {
      const b = BIOMES[k];
      const d = Math.hypot(x - b.x, z - b.z) / BIOME_R;
      out[k] = smoothstep(0.1, 0.62, Math.exp(-d * d));
      strongest = Math.max(strongest, out[k]);
    }
    out.meadow = 1 - strongest;
    return out;
  }

  dominantBiome(x, z) {
    const w = this.biomeWeights(x, z);
    let best = 'meadow', v = w.meadow;
    for (const k of Object.keys(BIOMES)) if (w[k] > v) { v = w[k]; best = k; }
    return best;
  }

  _makeLavaPools() {
    const rnd = mulberry32(404);
    let guard = 0;
    while (this.lavaPools.length < 7 && guard++ < 200) {
      const x = (rnd() - 0.5) * 360;
      const z = 230 + rnd() * 200;
      if (Math.hypot(x, z - 400) < 90) continue; // keep the volcano crater clear
      if (this.lavaPools.some((p) => Math.hypot(p.x - x, p.z - z) < 80)) continue;
      this.lavaPools.push({ x, z, r: 14 + rnd() * 14 });
    }
    for (const p of this.lavaPools) {
      let low = this._natural(p.x, p.z);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        low = Math.min(low, this._natural(p.x + Math.cos(ang) * p.r * 1.5, p.z + Math.sin(ang) * p.r * 1.5));
      }
      p.y = low - 0.9;
      p.depth = Math.max(5, this._natural(p.x, p.z) - p.y + 3);
    }
  }

  _natural(x, z) {
    const n = this.n;
    const b = this.biomeWeights(x, z);
    let h = n.fbm(x * 0.0035 + 10, z * 0.0035 + 10, 5) * 14;
    h += n.fbm(x * 0.02, z * 0.02, 3) * 1.4;
    h += b.earth * (n.ridged(x * 0.0045 + 50, z * 0.0045 - 30, 5) * 64 - 6);
    h += b.fire * (n.fbm(x * 0.01, z * 0.01, 4) * 9 + 3);
    h = lerp(h, Math.max(h, 0.8), b.fire);
    h += b.water * (n.fbm(x * 0.006 + 200, z * 0.006 + 200, 3) * 11 - 3.5);
    h += b.forest * (n.fbm(x * 0.008 - 90, z * 0.008 + 40, 3) * 6 + 2);
    const dv = Math.hypot(x, z - 410);
    h += 74 * Math.exp(-((dv / 78) ** 2)) - 30 * Math.exp(-((dv / 20) ** 2));
    const e = Math.max(Math.abs(x), Math.abs(z));
    h += smoothstep(380, 492, e) * (60 + 40 * Math.abs(n.noise(x * 0.012, z * 0.012)));
    const d0 = Math.hypot(x, z);
    h = lerp(2.6 + n.fbm(x * 0.05, z * 0.05, 2) * 0.35, h, smoothstep(16, 75, d0));
    return h;
  }

  _height(x, z) {
    let h = this._natural(x, z);
    for (const p of this.lavaPools) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r * 1.7) h -= p.depth * (1 - smoothstep(p.r * 0.55, p.r * 1.7, d));
    }
    return h;
  }

  _bake() {
    const H = this.heights;
    for (let j = 0; j <= SEG; j++) {
      for (let i = 0; i <= SEG; i++) {
        H[j * (SEG + 1) + i] = this._height(-HALF + i * STEP, -HALF + j * STEP);
      }
    }
  }

  // Exact height of the rendered triangle surface.
  heightAt(x, z) {
    const gx = clamp((x + HALF) / STEP, 0, SEG - 0.0001);
    const gz = clamp((z + HALF) / STEP, 0, SEG - 0.0001);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const W = SEG + 1;
    const h00 = this.heights[j * W + i], h10 = this.heights[j * W + i + 1];
    const h01 = this.heights[(j + 1) * W + i], h11 = this.heights[(j + 1) * W + i + 1];
    if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  }

  slopeAt(x, z) {
    const e = 1.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.2;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  inLava(x, z, pad = 0) {
    for (const p of this.lavaPools) {
      if (Math.hypot(x - p.x, z - p.z) < p.r * 1.05 + pad && this.heightAt(x, z) < p.y + 0.6) return true;
    }
    return false;
  }

  isWater(x, z, depth = 0.9) {
    return this.heightAt(x, z) < WORLD.waterLevel - depth;
  }

  isBlocked(x, z) {
    return this.isWater(x, z) || this.inLava(x, z, 1.5);
  }

  splatAt(x, z, h, out = [0, 0, 0, 0]) {
    const b = this.biomeWeights(x, z);
    const snowLine = smoothstep(34, 52, h);
    const coldWater = smoothstep(4, 16, h) * b.water * 0.55;
    out[0] = b.meadow + b.forest + b.water * 0.8 + b.earth * 0.1;
    out[1] = b.earth * 0.9 + b.water * 0.1;
    out[2] = Math.max(snowLine, coldWater);
    out[3] = b.fire;
    const s = out[0] + out[1] + out[3] + 1e-4;
    const keep = 1 - out[2];
    out[0] = (out[0] / s) * keep;
    out[1] = (out[1] / s) * keep;
    out[3] = (out[3] / s) * keep;
    return out;
  }

  buildMesh(arrays) {
    const W = SEG + 1;
    const pos = new Float32Array(W * W * 3);
    const uv = new Float32Array(W * W * 2);
    const splat = new Float32Array(W * W * 4);
    const tmp = [0, 0, 0, 0];
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const x = -HALF + i * STEP, z = -HALF + j * STEP, h = this.heights[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        uv[k * 2] = x; uv[k * 2 + 1] = z;
        this.splatAt(x, z, h, tmp);
        splat.set(tmp, k * 4);
      }
    }
    const idx = new Uint32Array(SEG * SEG * 6);
    let t = 0;
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const dummy = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    dummy.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, normalMap: dummy });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tDiff = { value: arrays.diffuse };
      shader.uniforms.tNorm = { value: arrays.normal };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vTPos;\nvarying vec3 vWNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat; vTPos = position; vWNormal = normal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform highp sampler2DArray tDiff;
uniform highp sampler2DArray tNorm;
varying vec4 vSplat;
varying vec3 vTPos;
varying vec3 vWNormal;
void layerSample(float layer, vec2 uv, vec2 dx, vec2 dy, out vec4 d, out vec3 n) {
  d = textureGrad(tDiff, vec3(uv, layer), dx, dy);
  n = textureGrad(tNorm, vec3(uv, layer), dx, dy).xyz * 2.0 - 1.0;
}`)
        .replace('#include <map_fragment>', `
vec2 tuv = vTPos.xz / 2.2;
vec2 gdx = dFdx(tuv), gdy = dFdy(tuv);
float tSlope = 1.0 - clamp(normalize(vWNormal).y, 0.0, 1.0);
float cliffW = smoothstep(0.16, 0.36, tSlope);
float lw[5];
lw[0] = vSplat.x * (1.0 - cliffW);
lw[1] = vSplat.y * (1.0 - cliffW);
lw[2] = cliffW;
lw[3] = vSplat.z * (1.0 - cliffW * 0.7);
lw[4] = vSplat.w * (1.0 - cliffW);
vec4 ld[5]; vec3 ln[5]; float lh[5];
float maxH = 0.0;
for (int i = 0; i < 5; i++) {
  ld[i] = vec4(0.0); ln[i] = vec3(0.0, 0.0, 1.0); lh[i] = 0.0;
  if (lw[i] > 0.02) {
    layerSample(float(i), tuv, gdx, gdy, ld[i], ln[i]);
    lh[i] = dot(ld[i].rgb, vec3(0.3, 0.59, 0.11)) + lw[i];
    maxH = max(maxH, lh[i]);
  }
}
float wsum = 0.0; float bw[5];
for (int i = 0; i < 5; i++) {
  bw[i] = lw[i] > 0.02 ? max(lh[i] - (maxH - 0.28), 0.0) : 0.0;
  wsum += bw[i];
}
vec3 tCol = vec3(0.0); vec3 tN = vec3(0.0); float tR = 0.0;
for (int i = 0; i < 5; i++) {
  float b = bw[i] / max(wsum, 1e-4);
  vec3 c = ld[i].rgb;
  if (i == 0) c *= vec3(0.78, 1.12, 0.55);
  if (i == 4) c *= vec3(0.62, 0.55, 0.5);
  tCol += c * b; tN += ln[i] * b; tR += ld[i].a * b;
}
float macro = textureGrad(tDiff, vec3(vTPos.xz / 31.0, 0.0), gdx / 14.0, gdy / 14.0).g;
tCol *= mix(0.72, 1.28, clamp(macro * 1.7, 0.0, 1.0));
diffuseColor.rgb *= tCol;
tN = normalize(tN);
float terrRough = clamp(tR, 0.3, 1.0);
`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = terrRough;')
        .replace('#include <normal_fragment_maps>', `
vec3 mapN = tN;
mapN.xy *= normalScale;
normal = normalize( tbn * mapN );
`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }
}
