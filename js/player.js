import * as THREE from 'three';
import { WORLD, clamp, lerp } from './config.js';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.eye = 1.72;
    this.onGround = true;
    this.keys = new Set();
    this.enabled = false;
    this.cameraControlled = true;
    this.bobPhase = 0;
    this.stepDist = 0;
    this.speed = 0;
    this.shake = 0;
    this.onStep = null;
    this.onJump = null;
    camera.rotation.order = 'YXZ';
    this._fwd = new THREE.Vector3();
  }

  teleport(x, z, yaw = this.yaw) {
    this.pos.set(x, this.world.terrain.heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
  }

  look(dx, dy) {
    if (!this.enabled) return;
    this.yaw -= dx * 0.0022;
    this.pitch = clamp(this.pitch - dy * 0.0022, -1.45, 1.45);
  }

  forward(out = this._fwd) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.eye, this.pos.z);
  }

  facePoint(point, dt, rate = 4) {
    const e = this.eyePos();
    const dx = point.x - e.x, dz = point.z - e.z, dy = point.y - e.y;
    const ty = Math.atan2(-dx, -dz);
    const tp = Math.atan2(dy, Math.hypot(dx, dz));
    const k = 1 - Math.exp(-rate * dt);
    this.yaw += wrapAngle(ty - this.yaw) * k;
    this.pitch += (tp - this.pitch) * k;
  }

  _canStand(x, z, fromX, fromZ) {
    const T = this.world.terrain;
    if (Math.abs(x) > WORLD.playable || Math.abs(z) > WORLD.playable) return false;
    if (T.isBlocked(x, z)) return false;
    if (this.onGround) {
      const d = Math.hypot(x - fromX, z - fromZ);
      if (d > 1e-4 && (T.heightAt(x, z) - T.heightAt(fromX, fromZ)) / d > 1.05) return false;
    }
    return true;
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    const T = this.world.terrain;
    const k = this.keys;
    if (this.enabled) {
      const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      const s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let wx = -sin * f + cos * s;
      let wz = -cos * f - sin * s;
      const len = Math.hypot(wx, wz);
      if (len > 0) { wx /= len; wz /= len; }
      const wading = T.heightAt(this.pos.x, this.pos.z) < WORLD.waterLevel - 0.1;
      const top = (sprint && f > 0 ? 9.6 : 5.2) * (wading ? 0.6 : 1);
      const accel = this.onGround ? 12 : 2.5;
      const a = 1 - Math.exp(-accel * dt);
      this.vel.x = lerp(this.vel.x, wx * top, a);
      this.vel.z = lerp(this.vel.z, wz * top, a);
      if (this.onGround && k.has('Space')) {
        this.vel.y = 7.2;
        this.onGround = false;
        this.onJump?.();
      }
    } else {
      this.vel.x = lerp(this.vel.x, 0, 1 - Math.exp(-8 * dt));
      this.vel.z = lerp(this.vel.z, 0, 1 - Math.exp(-8 * dt));
    }
    this.vel.y -= 20 * dt;

    const ox = this.pos.x, oz = this.pos.z;
    const nx = ox + this.vel.x * dt;
    if (this._canStand(nx, oz, ox, oz)) this.pos.x = nx; else this.vel.x = 0;
    const nz = this.pos.z + this.vel.z * dt;
    if (this._canStand(this.pos.x, nz, this.pos.x, this.pos.z)) this.pos.z = nz; else this.vel.z = 0;
    this.world.pushOut(this.pos, 0.45);
    this.pos.y += this.vel.y * dt;

    const g = T.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= g) {
      if (!this.onGround && this.vel.y < -6) this.shake = Math.max(this.shake, 0.02);
      this.pos.y = g;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.pos.y > g + 0.15) this.onGround = false;

    const moved = Math.hypot(this.pos.x - ox, this.pos.z - oz);
    this.speed = moved / Math.max(dt, 1e-4);
    if (this.onGround && moved > 0) {
      this.stepDist += moved;
      this.bobPhase += moved * 1.35;
      const stride = this.speed > 7 ? 3.0 : 2.1;
      if (this.stepDist > stride) { this.stepDist = 0; this.onStep?.(this.pos); }
    }

    if (this.cameraControlled) this._applyCamera(dt);
  }

  _applyCamera(dt) {
    const bob = this.onGround ? Math.sin(this.bobPhase * 2) * 0.035 * clamp(this.speed / 5, 0, 1.4) : 0;
    const sway = Math.cos(this.bobPhase) * 0.004 * clamp(this.speed / 5, 0, 1.4);
    this.shake = Math.max(0, this.shake - dt * 0.06);
    const sx = (Math.random() - 0.5) * this.shake * 2;
    const sy = (Math.random() - 0.5) * this.shake * 2;
    this.camera.position.set(this.pos.x + sx, this.pos.y + this.eye + bob + sy, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, sway);
  }
}
