import * as THREE from 'three';
import { mulberry32 } from './config.js';

const TEX_DIR = 'assets/textures/';

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + url));
    img.src = url;
  });
}

function finish(tex, { srgb = false, repeat = true, aniso = 8 } = {}) {
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

function heightToNormalCanvas(src, strength = 3) {
  const w = src.width, h = src.height;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const H = (x, y) => data[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Terrain texture arrays: layer order matches the shader (grass, rock, cliff, snow, ash).
export const TERRAIN_LAYERS = ['grass', 'rock', 'cliff', 'snow', 'ash'];

export async function buildTerrainArrays(renderer) {
  const size = 1024;
  const n = TERRAIN_LAYERS.length;
  const diffData = new Uint8Array(size * size * 4 * n);
  const normData = new Uint8Array(size * size * 4 * n);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d', { willReadFrequently: true });

  const read = async (file) => {
    const img = await loadImage(TEX_DIR + file);
    ctx.drawImage(img, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data;
  };

  for (let i = 0; i < n; i++) {
    const name = TERRAIN_LAYERS[i];
    const [diff, nor, rough] = [
      await read(`${name}_diff.jpg`),
      await read(`${name}_nor.jpg`),
      await read(`${name}_rough.jpg`),
    ];
    for (let y = 0; y < size; y++) {
      const srcRow = size - 1 - y; // array textures are not flipped on upload
      for (let x = 0; x < size; x++) {
        const s = (srcRow * size + x) * 4;
        const d = ((i * size + y) * size + x) * 4;
        diffData[d] = diff[s];
        diffData[d + 1] = diff[s + 1];
        diffData[d + 2] = diff[s + 2];
        diffData[d + 3] = rough[s];
        normData[d] = nor[s];
        normData[d + 1] = nor[s + 1];
        normData[d + 2] = nor[s + 2];
        normData[d + 3] = 255;
      }
    }
  }

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const make = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, size, size, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return finish(t, { srgb, aniso });
  };
  return { diffuse: make(diffData, true), normal: make(normData, false) };
}

export async function loadPBR(name, { repeat = [1, 1], aniso = 8 } = {}) {
  const loader = new THREE.TextureLoader();
  const load = (suffix, srgb) =>
    new Promise((resolve, reject) =>
      loader.load(`${TEX_DIR}${name}_${suffix}.jpg`, (t) => {
        t.repeat.set(repeat[0], repeat[1]);
        resolve(finish(t, { srgb, aniso }));
      }, undefined, reject));
  const [map, normalMap, roughnessMap] = await Promise.all([load('diff', true), load('nor', false), load('rough', false)]);
  return { map, normalMap, roughnessMap };
}

// Overlapping reptile scales: albedo (grayscale), normal and roughness maps.
export function makeScaleTextures() {
  const S = 512, cols = 16, rows = 22;
  const rnd = mulberry32(77);
  const hc = makeCanvas(S), ac = makeCanvas(S);
  const hx = hc.getContext('2d', { willReadFrequently: true }), ax = ac.getContext('2d');
  hx.fillStyle = '#303030'; hx.fillRect(0, 0, S, S);
  ax.fillStyle = '#707070'; ax.fillRect(0, 0, S, S);
  const cw = S / cols, ch = S / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const shade = 150 + rnd() * 90;
      const cx = c * cw + (r % 2 ? cw / 2 : 0) + cw / 2;
      const cy = r * ch + ch / 2;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const x = cx + ox * S, y = cy + oy * S;
          if (x < -cw || x > S + cw || y < -ch || y > S + ch) continue;
          const rg = hx.createRadialGradient(x, y - ch * 0.15, 1, x, y, cw * 0.72);
          rg.addColorStop(0, '#f2f2f2'); rg.addColorStop(0.7, '#a0a0a0'); rg.addColorStop(1, '#202020');
          hx.fillStyle = rg;
          hx.beginPath(); hx.ellipse(x, y, cw * 0.62, ch * 0.95, 0, 0, Math.PI * 2); hx.fill();
          const ag = ax.createRadialGradient(x, y - ch * 0.2, 1, x, y, cw * 0.7);
          ag.addColorStop(0, `rgb(${shade + 20},${shade + 20},${shade + 20})`);
          ag.addColorStop(0.75, `rgb(${shade - 30},${shade - 30},${shade - 30})`);
          ag.addColorStop(1, `rgb(${shade - 80},${shade - 80},${shade - 80})`);
          ax.fillStyle = ag;
          ax.beginPath(); ax.ellipse(x, y, cw * 0.62, ch * 0.95, 0, 0, Math.PI * 2); ax.fill();
        }
      }
    }
  }
  const nc = heightToNormalCanvas(hc, 2.4);
  // Glow collects in the grooves between scales.
  const ec = makeCanvas(S);
  {
    const src = hx.getImageData(0, 0, S, S);
    const ectx = ec.getContext('2d');
    const out = ectx.createImageData(S, S);
    for (let i = 0; i < src.data.length; i += 4) {
      const v = Math.pow(1 - src.data[i] / 255, 2.2) * 255;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
    ectx.putImageData(out, 0, 0);
  }
  const rc = makeCanvas(S);
  const rx = rc.getContext('2d');
  rx.drawImage(hc, 0, 0);
  rx.globalCompositeOperation = 'difference';
  rx.fillStyle = '#ffffff';
  rx.globalAlpha = 0.45;
  rx.fillRect(0, 0, S, S);
  return {
    map: finish(new THREE.CanvasTexture(ac), { srgb: true }),
    normalMap: finish(new THREE.CanvasTexture(nc)),
    roughnessMap: finish(new THREE.CanvasTexture(rc)),
    emissiveMap: finish(new THREE.CanvasTexture(ec), { srgb: true }),
  };
}

export function makeWaterNormal() {
  const S = 256;
  const hc = makeCanvas(S);
  const ctx = hc.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(S, S);
  const rnd = mulberry32(5);
  const waves = [];
  for (let i = 0; i < 14; i++) {
    waves.push({
      kx: Math.floor(rnd() * 7) - 3, ky: Math.floor(rnd() * 7) - 3,
      ph: rnd() * Math.PI * 2, a: 0.4 + rnd() * 0.6,
    });
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let h = 0;
      for (const w of waves) h += Math.sin(((w.kx * x + w.ky * y) / S) * Math.PI * 2 + w.ph) * w.a;
      const v = Math.max(0, Math.min(255, 128 + h * 14));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(heightToNormalCanvas(hc, 5)));
}

export function makeLeafTexture(kind = 'broad') {
  const S = 512;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(kind === 'broad' ? 11 : 12);
  ctx.clearRect(0, 0, S, S);
  if (kind === 'broad') {
    for (let i = 0; i < 520; i++) {
      const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI, l = 26 + rnd() * 24;
      const g = 70 + rnd() * 90;
      ctx.fillStyle = `rgb(${g * 0.45 | 0},${g},${g * 0.25 | 0})`;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, 0, l, l * 0.42, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(20,40,10,0.5)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-l, 0); ctx.lineTo(l, 0); ctx.stroke();
      ctx.restore();
    }
  } else {
    for (let i = 0; i < 900; i++) {
      const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2, l = 30 + rnd() * 26;
      const g = 55 + rnd() * 50;
      ctx.strokeStyle = `rgb(${g * 0.35 | 0},${g},${g * 0.5 | 0})`;
      ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
  }
  return finish(new THREE.CanvasTexture(c), { srgb: true });
}

export function makeGrassTuft() {
  const W = 256, H = 256;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(21);
  for (let i = 0; i < 46; i++) {
    const bx = W / 2 + (rnd() - 0.5) * 150;
    const lean = (rnd() - 0.5) * 120;
    const tipx = bx + lean, tipy = 8 + rnd() * 120;
    const w = 3 + rnd() * 4;
    const g = ctx.createLinearGradient(0, H, 0, tipy);
    const t = 0.55 + rnd() * 0.45;
    g.addColorStop(0, `rgb(${50 * t | 0},${88 * t | 0},${28 * t | 0})`);
    g.addColorStop(1, `rgb(${170 * t | 0},${200 * t | 0},${90 * t | 0})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(bx - w, H);
    ctx.quadraticCurveTo(bx - w + lean * 0.1, (H + tipy) / 2, tipx, tipy);
    ctx.quadraticCurveTo(bx + w + lean * 0.1, (H + tipy) / 2, bx + w, H);
    ctx.closePath();
    ctx.fill();
  }
  return finish(new THREE.CanvasTexture(c), { srgb: true, repeat: false });
}

export function makeGlowSprite() {
  const S = 128;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finish(new THREE.CanvasTexture(c), { srgb: true, repeat: false });
}

export function makeLavaTexture() {
  const S = 512, G = 8;
  const rnd = mulberry32(99);
  const pts = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) pts.push([gx + rnd(), gy + rnd()]);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = (x / S) * G, py = (y / S) * G;
      let f1 = 9, f2 = 9;
      const cx = Math.floor(px), cy = Math.floor(py);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = (cx + ox + G) % G, gy = (cy + oy + G) % G;
          const p = pts[gy * G + gx];
          const dx = p[0] + (cx + ox - gx) - px, dy = p[1] + (cy + oy - gy) - py;
          const d = Math.hypot(dx, dy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
      }
      const crack = Math.max(0, 1 - (f2 - f1) * 5.5);
      const heat = Math.pow(crack, 1.6);
      const i = (y * S + x) * 4;
      img.data[i] = 30 + heat * 225;
      img.data[i + 1] = 14 + heat * 130;
      img.data[i + 2] = 8 + heat * 20;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(c), { srgb: true });
}

export function makeCandySwirl(colorA = '#ff4f9a', colorB = '#ffffff') {
  const S = 128;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colorA;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = colorB;
  ctx.lineWidth = 9;
  ctx.beginPath();
  for (let t = 0; t < 40; t += 0.15) {
    const x = S / 2 + Math.cos(t) * t * 1.6;
    const y = S / 2 + Math.sin(t) * t * 1.6;
    if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  return finish(new THREE.CanvasTexture(c), { srgb: true, repeat: false });
}

export function makeFlameTexture() {
  const W = 64, H = 128;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(W / 2, H * 0.72, 2, W / 2, H * 0.62, H * 0.5);
  g.addColorStop(0, 'rgba(255,245,200,1)');
  g.addColorStop(0.35, 'rgba(255,160,40,0.9)');
  g.addColorStop(1, 'rgba(200,40,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(W * 0.15, H);
  ctx.quadraticCurveTo(W * 0.1, H * 0.45, W / 2, 0);
  ctx.quadraticCurveTo(W * 0.9, H * 0.45, W * 0.85, H);
  ctx.closePath();
  ctx.fill();
  return finish(new THREE.CanvasTexture(c), { srgb: true, repeat: false });
}
