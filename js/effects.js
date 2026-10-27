import * as THREE from 'three';
import { ELEMENTS, rand } from './config.js';

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

class DebrisPool {
  constructor(scene, geo, mat, n) {
    this.n = n;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.items = Array.from({ length: n }, () => ({
      p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), rv: new THREE.Vector3(), life: 0, s: 1,
    }));
    this.next = 0;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this.zero);
    scene.add(this.mesh);
  }

  spawn(pos, vel, scale, life = 1.6) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.n;
    it.p.copy(pos); it.v.copy(vel); it.s = scale; it.life = life;
    it.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    it.rv.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
  }

  update(dt, groundAt) {
    for (let i = 0; i < this.n; i++) {
      const it = this.items[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { this.mesh.setMatrixAt(i, this.zero); continue; }
      it.v.y -= 22 * dt;
      it.p.addScaledVector(it.v, dt);
      const g = groundAt(it.p.x, it.p.z);
      if (it.p.y < g + it.s * 0.3) { it.p.y = g + it.s * 0.3; it.v.multiplyScalar(0.35); it.v.y = Math.abs(it.v.y) * 0.3; it.rv.multiplyScalar(0.4); }
      it.r.x += it.rv.x * dt; it.r.y += it.rv.y * dt; it.r.z += it.rv.z * dt;
      this.q.setFromEuler(it.r);
      const s = it.s * Math.min(1, it.life * 2);
      this.m.compose(it.p, this.q, tmp2.set(s, s, s));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    const N = 1600;
    this.N = N;
    this.next = 0;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.c0 = new Float32Array(N * 3);
    this.c1 = new Float32Array(N * 3);
    this.col = new Float32Array(N * 3);
    this.size = new Float32Array(N);
    this.alpha = new Float32Array(N);
    this.life = new Float32Array(N);
    this.maxLife = new Float32Array(N).fill(1);
    this.s0 = new Float32Array(N);
    this.s1 = new Float32Array(N);
    this.grav = new Float32Array(N);
    this.drag = new Float32Array(N);
    this.a0 = new Float32Array(N);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uScale: { value: 800 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uScale; attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vC; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.3), 0.0, 220.0);
          vC = aColor; vA = aAlpha;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vA;
          if (a < 0.005) discard;
          gl_FragColor = vec4(vC, a);
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a7066, roughness: 0.9, flatShading: true });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0xcfd5dc, roughness: 0.2, metalness: 1, flatShading: true });
    const iceMat = new THREE.MeshPhysicalMaterial({ color: 0xcff3ff, roughness: 0.05, emissive: 0x3fb8ff, emissiveIntensity: 0.9, transparent: true, opacity: 0.85, flatShading: true });
    this.rocks = new DebrisPool(scene, new THREE.DodecahedronGeometry(0.4, 0), rockMat, 60);
    this.metals = new DebrisPool(scene, new THREE.TetrahedronGeometry(0.5, 0), metalMat, 60);
    this.shards = new DebrisPool(scene, (() => { const c = new THREE.ConeGeometry(0.22, 1.3, 5); c.translate(0, 0.65, 0); return c; })(), iceMat, 80);

    this.bolts = [];
    for (let i = 0; i < 8; i++) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(14 * 3), 3));
      const l = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: new THREE.Color(3, 2.8, 1.2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      l.frustumCulled = false;
      l.visible = false;
      scene.add(l);
      this.bolts.push({ line: l, life: 0 });
    }

    this.meteor = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.4, 1),
      new THREE.MeshStandardMaterial({ color: 0xd6dbe2, metalness: 1, roughness: 0.25, emissive: 0xff7a2a, emissiveIntensity: 1.4, flatShading: true }),
    );
    this.meteor.visible = false;
    scene.add(this.meteor);

    this.emitters = [];
  }

  groundAt = (x, z) => this.world.terrain.heightAt(x, z);

  emit(px, py, pz, vx, vy, vz, o) {
    const i = this.next;
    this.next = (this.next + 1) % this.N;
    const k = i * 3;
    this.pos[k] = px; this.pos[k + 1] = py; this.pos[k + 2] = pz;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    const a = o.c0, b = o.c1 ?? o.c0;
    this.c0[k] = a.r; this.c0[k + 1] = a.g; this.c0[k + 2] = a.b;
    this.c1[k] = b.r; this.c1[k + 1] = b.g; this.c1[k + 2] = b.b;
    this.life[i] = this.maxLife[i] = o.life ?? 0.8;
    this.s0[i] = o.s0 ?? 0.4; this.s1[i] = o.s1 ?? 0.1;
    this.grav[i] = o.grav ?? 0; this.drag[i] = o.drag ?? 0.5; this.a0[i] = o.a ?? 0.9;
  }

  burst(pos, color, n = 30, speed = 6, o = {}) {
    const c0 = new THREE.Color(color);
    const c1 = o.c1 ? new THREE.Color(o.c1) : c0.clone().multiplyScalar(0.3);
    for (let i = 0; i < n; i++) {
      tmp.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      this.emit(pos.x, pos.y, pos.z, tmp.x, tmp.y, tmp.z, {
        c0: c0.clone().multiplyScalar(1.6), c1, life: rand(0.4, 1.0), s0: o.s0 ?? 0.7, s1: 0.1, grav: o.grav ?? -2, drag: 1.5, a: 0.9,
      });
    }
  }

  _elementStyle(element, form) {
    const key = form && form !== 'base' ? form : element;
    switch (key) {
      case 'fire': return { c0: new THREE.Color(3, 1.9, 0.5), c1: new THREE.Color(1.2, 0.18, 0.03), grav: -3, drag: 0.8, s0: 0.5, s1: 2.0 };
      case 'water': return { c0: new THREE.Color(0.7, 1.6, 2.4), c1: new THREE.Color(0.1, 0.4, 0.8), grav: 6, drag: 0.4, s0: 0.35, s1: 0.9 };
      case 'earth': return { c0: new THREE.Color(1.1, 0.9, 0.6), c1: new THREE.Color(0.35, 0.28, 0.18), grav: 1, drag: 1.2, s0: 0.7, s1: 1.6 };
      case 'ice': return { c0: new THREE.Color(1.8, 2.4, 3), c1: new THREE.Color(0.4, 0.8, 1.4), grav: 0, drag: 1.2, s0: 0.5, s1: 1.4 };
      case 'metal': return { c0: new THREE.Color(3, 2.2, 1.0), c1: new THREE.Color(1, 0.4, 0.1), grav: 4, drag: 1, s0: 0.3, s1: 0.1 };
      case 'lightning': return { c0: new THREE.Color(3, 2.8, 1.2), c1: new THREE.Color(1.2, 0.8, 0.2), grav: 0, drag: 2, s0: 0.5, s1: 0.2 };
      default: return { c0: new THREE.Color(2, 2, 2), c1: new THREE.Color(0.5, 0.5, 0.5), grav: 0, drag: 1, s0: 0.4, s1: 0.2 };
    }
  }

  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  _stream(from, to, style, dur, rate, spread, speed) {
    const dir = tmp2.copy(to).sub(from);
    const dist = dir.length();
    dir.normalize();
    const e = { t: 0 };
    e.fn = (dt) => {
      e.t += dt;
      const n = Math.max(1, Math.round(rate * dt));
      for (let i = 0; i < n; i++) {
        const v = tmp.copy(dir).multiplyScalar(speed * rand(0.85, 1.1));
        v.x += rand(-spread, spread); v.y += rand(-spread, spread) + (style.arc ?? 0); v.z += rand(-spread, spread);
        this.emit(from.x, from.y, from.z, v.x, v.y, v.z, { ...style, life: dist / speed * 1.05 + rand(0, 0.15) });
      }
      return e.t < dur;
    };
    this.emitters.push(e);
    return dist / speed;
  }

  async breath(from, to, element, form = 'base') {
    const style = this._elementStyle(element, form);
    const fromP = from.clone(), toP = to.clone();
    if (element === 'earth') {
      const n = 9;
      for (let i = 0; i < n; i++) {
        const dir = toP.clone().sub(fromP);
        const t = 0.8 + i * 0.03;
        const vel = dir.clone().divideScalar(t);
        vel.y += 0.5 * 22 * t + rand(-1, 1);
        vel.x += rand(-3, 3); vel.z += rand(-3, 3);
        setTimeout(() => this.rocks.spawn(fromP, vel, rand(0.9, 1.8), 2.2), i * 50);
      }
      this._stream(fromP, toP, { ...style, arc: 3 }, 0.5, 60, 1.2, 22);
      await this.wait(950);
      this.burst(toP, 0xb89a6a, 50, 9, { s0: 1.4, grav: -1 });
      this.world.flash(toP, 0xffd9a0, 150);
      return;
    }
    const travel = this._stream(fromP, toP, { ...style, arc: element === 'water' ? 2.2 : 0 }, 0.9, 170, element === 'water' ? 1.1 : 1.6, element === 'water' ? 26 : 30);
    this.world.flash(fromP, element === 'water' ? 0x66ccff : 0xff8a30, 220);
    await this.wait(Math.max(250, travel * 1000 * 0.85));
    this.burst(toP, element === 'water' ? 0x77ddff : 0xff7a22, 46, 8, { s0: 1.0, c1: element === 'water' ? 0x2266aa : 0x661100 });
    this.world.flash(toP, element === 'water' ? 0x66ccff : 0xff7a22, 260);
  }

  _bolt(a, b, life = 0.25) {
    const slot = this.bolts.find((x) => x.life <= 0) ?? this.bolts[0];
    const pts = slot.line.geometry.attributes.position;
    const d = tmp.copy(b).sub(a);
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const j = (i === 0 || i === 13) ? 0 : 1;
      pts.setXYZ(i, a.x + d.x * t + rand(-1.4, 1.4) * j, a.y + d.y * t + rand(-1.4, 1.4) * j, a.z + d.z * t + rand(-1.4, 1.4) * j);
    }
    pts.needsUpdate = true;
    slot.line.visible = true;
    slot.life = life;
  }

  async ultimate(from, to, element, form) {
    const toP = to.clone();
    if (form === 'ice') {
      this.world.flash(toP.clone().add(new THREE.Vector3(0, 6, 0)), 0x88ddff, 400);
      const e = { t: 0 };
      e.fn = (dt) => {
        e.t += dt;
        for (let i = 0; i < 3; i++) {
          const p = tmp.set(toP.x + rand(-5, 5), toP.y + 22 + rand(0, 6), toP.z + rand(-5, 5));
          this.shards.spawn(p, tmp2.set(rand(-2, 2), rand(-26, -16), rand(-2, 2)), rand(1.2, 2.4), 1.6);
        }
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2, r = rand(1, 9);
          this.emit(toP.x + Math.cos(a) * r, toP.y + rand(0, 8), toP.z + Math.sin(a) * r, -Math.sin(a) * 7, rand(-1, 3), Math.cos(a) * 7, { c0: new THREE.Color(1.8, 2.4, 3), c1: new THREE.Color(0.5, 0.9, 1.4), life: 1.2, s0: 0.5, s1: 1.2, drag: 0.8 });
        }
        return e.t < 1.7;
      };
      this.emitters.push(e);
      await this.wait(900);
      this.burst(toP.clone().add(new THREE.Vector3(0, 1.5, 0)), 0xaee8ff, 90, 12, { s0: 1.6, grav: -1 });
      this.world.flash(toP, 0x88ddff, 500);
      return;
    }
    if (form === 'metal') {
      const start = toP.clone().add(new THREE.Vector3(14, 70, -10));
      this.meteor.visible = true;
      this.meteor.position.copy(start);
      const t0 = performance.now();
      await new Promise((res) => {
        const e = { t: 0 };
        e.fn = (dt) => {
          e.t += dt;
          const k = Math.min(1, e.t / 0.75);
          this.meteor.position.lerpVectors(start, toP, k * k);
          this.meteor.rotation.x += dt * 5;
          this.emit(this.meteor.position.x, this.meteor.position.y, this.meteor.position.z, rand(-1, 1), rand(-1, 1), rand(-1, 1), { c0: new THREE.Color(3, 1.6, 0.5), c1: new THREE.Color(0.8, 0.2, 0.05), life: 0.6, s0: 2.0, s1: 0.4 });
          if (k >= 1) { res(); return false; }
          return true;
        };
        this.emitters.push(e);
      });
      this.meteor.visible = false;
      this.world.flash(toP, 0xffb060, 700);
      this.burst(toP.clone().add(new THREE.Vector3(0, 1, 0)), 0xffc070, 110, 16, { s0: 1.8, grav: -2 });
      for (let i = 0; i < 40; i++) this.metals.spawn(toP, tmp2.set(rand(-14, 14), rand(8, 22), rand(-14, 14)), rand(0.6, 1.5), 2.2);
      return;
    }
    // Lightning
    const sky = toP.clone().add(new THREE.Vector3(0, 40, 0));
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        const t = toP.clone().add(new THREE.Vector3(rand(-3, 3), 0, rand(-3, 3)));
        this._bolt(sky.clone().add(new THREE.Vector3(rand(-6, 6), 0, rand(-6, 6))), t, 0.3);
        this.world.flash(t.clone().add(new THREE.Vector3(0, 3, 0)), 0xfff2b0, 800);
        this.burst(t.clone().add(new THREE.Vector3(0, 1, 0)), 0xffee88, 40, 11, { s0: 1.2, grav: -1 });
      }, i * 180);
    }
    await this.wait(300);
  }

  strikeImpact(pos, element, form = 'base') {
    const s = this._elementStyle(element, form);
    this.burst(pos, s.c0, 26, 7, { s0: 0.8, c1: s.c1 });
    this.world.flash(pos, s.c0, 120);
    if (element === 'earth' || form === 'metal') for (let i = 0; i < 5; i++) this.rocks.spawn(pos, tmp2.set(rand(-6, 6), rand(4, 10), rand(-6, 6)), rand(0.4, 0.9), 1.4);
  }

  heal(pos) {
    for (let i = 0; i < 26; i++) {
      this.emit(pos.x + rand(-1.5, 1.5), pos.y + rand(0, 1), pos.z + rand(-1.5, 1.5), 0, rand(1.5, 3.5), 0, { c0: new THREE.Color(0.5, 2.2, 0.6), c1: new THREE.Color(0.1, 0.8, 0.2), life: 1.2, s0: 0.45, s1: 0.1, drag: 0.3 });
    }
  }

  levelUp(pos, color = 0xffd36a) {
    const c = new THREE.Color(color).multiplyScalar(2);
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(0.5, 3);
      this.emit(pos.x + Math.cos(a) * r, pos.y + rand(0, 1), pos.z + Math.sin(a) * r, Math.cos(a) * 1.2, rand(3, 8), Math.sin(a) * 1.2, { c0: c, c1: new THREE.Color(0.8, 0.3, 0.05), life: rand(1, 1.8), s0: 0.6, s1: 0.1, drag: 0.5 });
    }
    this.world.flash(pos.clone().add(new THREE.Vector3(0, 3, 0)), color, 350);
  }

  crash(pos) {
    for (let i = 0; i < 60; i++) {
      this.emit(pos.x + rand(-2, 2), pos.y + rand(0, 3), pos.z + rand(-2, 2), rand(-2, 2), rand(-1, 2), rand(-2, 2), { c0: new THREE.Color(2.2, 0.6, 1.8), c1: new THREE.Color(0.3, 0.1, 0.5), life: rand(0.8, 1.6), s0: 0.8, s1: 0.2, drag: 0.7 });
    }
  }

  update(dt, camera, height) {
    this.uniforms.uScale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (let i = this.emitters.length - 1; i >= 0; i--) if (!this.emitters[i].fn(dt)) this.emitters.splice(i, 1);
    for (let i = 0; i < this.N; i++) {
      const L = this.life[i];
      if (L <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.size[i] = 0; } continue; }
      this.life[i] = L - dt;
      const k = i * 3;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt; this.vel[k + 2] *= dr;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.col[k] = this.c0[k] + (this.c1[k] - this.c0[k]) * t;
      this.col[k + 1] = this.c0[k + 1] + (this.c1[k + 1] - this.c0[k + 1]) * t;
      this.col[k + 2] = this.c0[k + 2] + (this.c1[k + 2] - this.c0[k + 2]) * t;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.a0[i] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
    }
    const g = this.points.geometry.attributes;
    g.position.needsUpdate = g.aColor.needsUpdate = g.aSize.needsUpdate = g.aAlpha.needsUpdate = true;

    this.rocks.update(dt, this.groundAt);
    this.metals.update(dt, this.groundAt);
    this.shards.update(dt, this.groundAt);
    for (const b of this.bolts) {
      if (b.life > 0) {
        b.life -= dt;
        b.line.material.opacity = Math.max(0, b.life / 0.3);
        if (b.life <= 0) b.line.visible = false;
      }
    }
  }
}
