import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  ELEMENTS, BODIES, WORLD, FOOD, xpToNext, candyXp, computeStats, riskChance, clamp, lerp, rand, pick, mulberry32,
} from './config.js';
import { BIOMES } from './terrain.js';
import { World } from './world.js';
import { Player } from './player.js';
import { DragonActor } from './dragon.js';
import { UI } from './ui.js';
import { AudioEngine } from './audio.js';
import { Effects } from './effects.js';
import { Combat } from './combat.js';
import { Save, Scores } from './save.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) => t * t * (3 - 2 * t);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const REGION_NAMES = { meadow: 'Dragon Meadow', ...Object.fromEntries(Object.entries(BIOMES).map(([k, v]) => [k, v.name])) };
const ACTIONS = ['strike', 'breath', 'guard', 'ultimate', 'flee'];

export class Game {
  constructor() {
    this.ui = new UI();
    this.audio = new AudioEngine();
    this.state = 'loading';
    this.time = 0;
    this.clock = new THREE.Clock();
    this.tweens = [];
    this.wilds = [];
    this.data = null;
    this.dragon = null;
    this.preview = null;
    this.sel = { element: null, body: null };
    this.orbit = 0;
    this.suppressPause = false;
    this.dragonSpeed = 0;
    this.dragonYaw = 0;
    this.hudTimer = 0;
    this.saveTimer = 0;
    this.regionTimer = 0;
    this.mapTimer = 0;
    this.feeding = false;
    this.curWild = null;
    this.combat = null;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  // ------------------------------------------------------------------ boot
  async init() {
    const canvasHost = document.getElementById('app');
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.62;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'game';
    canvasHost.prepend(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.15, 3200);
    this.scene.add(this.camera);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 2 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.4, 0.5, 1.5);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.quality = { tier: 1, scale: 1, since: 0, frames: 0, acc: 0, lockUntil: 6 };
    this._applyQuality();

    this.world = new World(renderer, this.scene);
    await new Promise((r) => requestAnimationFrame(r));
    await this.world.init((t, p) => this.ui.loading(t, p));
    this._applyQuality();
    this.player = new Player(this.camera, this.world);
    this.player.onStep = (pos) => this.audio.step_(this._surface(pos));
    this.fx = new Effects(this.scene, this.world);
    this.player.teleport(-4, 5);
    this._spawnWilds();

    this._bindInput();
    this._bindUI();
    window.addEventListener('resize', () => this._resize());
    this.toTitle();
    this.ui.loadDone();
    this.clock.start();
    renderer.setAnimationLoop(() => this._frame());
  }

  _resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this._applyQuality();
  }

  // Tiers: 0 low, 1 medium, 2 high. `scale` is an extra resolution multiplier used when even low is too slow.
  _applyQuality() {
    const q = this.quality;
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const base = [Math.min(dpr, 0.85), Math.min(dpr, 1.0), Math.min(dpr, 1.5)][q.tier];
    const pr = clamp(base * q.scale, 0.4, 2);
    const samples = [0, 2, 4][q.tier];
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples !== samples) { t.samples = samples; t.dispose(); }
    }
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.enabled = q.tier > 0;
    this.bloom.setSize(Math.round(w * pr / 2), Math.round(h * pr / 2));
    const sm = q.tier === 2 ? 2048 : 1024;
    const sun = this.world?.sun;
    if (sun && sun.shadow.mapSize.x !== sm) {
      sun.shadow.mapSize.set(sm, sm);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }

  _adaptQuality(dt) {
    const q = this.quality;
    if (this.state === 'loading') return;
    q.frames++;
    q.acc += dt;
    if (q.acc < 2.5) return;
    const avg = q.acc / q.frames;
    q.frames = 0;
    q.acc = 0;
    q.lockUntil -= 2.5;
    if (avg > 0.03 && q.lockUntil <= 0) {
      if (q.tier > 0) q.tier--;
      else if (q.scale > 0.55) q.scale = Math.max(0.55, q.scale * 0.85);
      else return;
      q.lockUntil = 10;
      this._applyQuality();
    } else if (avg < 0.011 && q.lockUntil <= -10 && q.scale >= 1 && q.tier < 2) {
      q.tier++;
      q.lockUntil = 10;
      this._applyQuality();
    } else if (avg < 0.011 && q.lockUntil <= -10 && q.scale < 1) {
      q.scale = Math.min(1, q.scale / 0.85);
      q.lockUntil = 10;
      this._applyQuality();
    }
  }

  _surface(pos) {
    const b = this.world.terrain.dominantBiome(pos.x, pos.z);
    if (this.world.terrain.heightAt(pos.x, pos.z) < WORLD.waterLevel) return 'water';
    return { fire: 'ash', earth: 'rock' }[b] ?? (pos.y > 34 ? 'snow' : 'grass');
  }

  // ------------------------------------------------------------------ input / UI wiring
  _bindInput() {
    const canvas = this.renderer.domElement;
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      this.audio.init();
      if (e.code === 'KeyM') { const m = this.audio.toggleMute(); this.ui.toast(m ? 'Sound off' : 'Sound on'); this._syncMute(); return; }
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (this.state === 'playing') {
        this.player.keys.add(e.code);
        if (e.repeat) return;
        if (e.code === 'Digit1') this.feed('broccoli');
        else if (e.code === 'Digit2') this.feed('candy');
        else if (e.code === 'KeyE') this._interact();
        else if (e.code === 'KeyF') this._challenge();
      } else if (this.state === 'combat') {
        const i = parseInt(e.key, 10);
        if (i >= 1 && i <= 5) this.combat?.act(ACTIONS[i - 1]);
      } else if (this.state === 'results' && (e.code === 'Enter' || e.code === 'Space')) {
        this._closeResults();
      }
    });
    document.addEventListener('keyup', (e) => this.player.keys.delete(e.code));
    window.addEventListener('blur', () => this.player.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) this.player.look(e.movementX, e.movementY);
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (!locked && this.state === 'playing' && !this.suppressPause) this.pause();
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.state === 'playing') this.ui.toast('Click the game window to capture the mouse.', 'warn');
    });
    canvas.addEventListener('mousedown', () => {
      this.audio.init();
      if (this.state === 'playing' && document.pointerLockElement !== canvas) this._lock();
    });
  }

  _lock() {
    const c = this.renderer.domElement;
    try {
      const p = c.requestPointerLock();
      if (p?.catch) p.catch(() => {});
    } catch { /* unavailable */ }
  }

  _bindUI() {
    const ui = this.ui;
    ui.on('btn-continue', () => { this.audio.init(); this.audio.click(); this.continueGame(); });
    ui.on('btn-new', () => { this.audio.init(); this.audio.click(); this.showElement(); });
    ui.on('btn-scores', () => { this.audio.click(); ui.renderScores(Scores.all()); ui.screen('scores'); this._back = 'title'; });
    ui.on('btn-scores-back', () => { this.audio.click(); ui.screen(this._back === 'title' ? 'title' : 'gameover'); });
    ui.on('btn-controls', () => { this.audio.click(); this._back = 'title'; ui.screen('controls'); });
    ui.on('btn-controls2', () => { this.audio.click(); this._back = 'pause'; ui.screen('controls'); });
    ui.on('btn-controls-back', () => { this.audio.click(); ui.screen(this._back === 'pause' ? 'pause' : 'title'); });
    ui.on('btn-element-back', () => { this.audio.click(); this.toTitle(); });
    ui.on('btn-body-back', () => { this.audio.click(); this.showElement(); });
    ui.on('btn-begin', () => this.startNew());
    ui.on('btn-resume', () => this.resume());
    ui.on('btn-save', () => { this.autosave(); ui.toast('Game saved.', 'good'); });
    ui.on('btn-mute', () => { this.audio.toggleMute(); this._syncMute(); });
    ui.on('btn-retire', () => this.gameOver('retired'));
    ui.on('btn-quit', () => { this.autosave(); this.suppressPause = true; this._leaveWorld(); this.toTitle(); });
    ui.on('btn-res-continue', () => this._closeResults());
    ui.on('btn-over-again', () => { this._leaveWorld(); this.showElement(); });
    ui.on('btn-over-title', () => { this._leaveWorld(); this.toTitle(); });

    document.querySelectorAll('#element-cards .card').forEach((c) => {
      c.addEventListener('click', () => { this.audio.click(); this.sel.element = c.dataset.element; this.showBody(); });
      c.addEventListener('mouseenter', () => this.setPreview({ element: c.dataset.element, body: 'quad' }));
    });
    document.querySelectorAll('#body-cards .card').forEach((c) => {
      c.addEventListener('click', () => {
        this.audio.click();
        this.sel.body = c.dataset.body;
        document.querySelectorAll('#body-cards .card').forEach((x) => x.classList.toggle('sel', x === c));
        document.getElementById('btn-begin').disabled = false;
        this.setPreview({ element: this.sel.element, body: this.sel.body });
      });
      c.addEventListener('mouseenter', () => this.setPreview({ element: this.sel.element, body: c.dataset.body }));
    });
    document.querySelectorAll('#c-actions button').forEach((b) => {
      b.addEventListener('click', () => this.combat?.act(b.dataset.action));
    });
  }

  _syncMute() {
    document.getElementById('btn-mute').textContent = `Sound: ${this.audio.muted ? 'Off' : 'On'}`;
  }

  // ------------------------------------------------------------------ menus
  setPreview({ element, body, awakened = false, level = 30 }) {
    const key = `${element}|${body}|${awakened}`;
    if (this.preview && this.previewKey === key) return;
    if (this.preview) this.preview.dispose();
    this.previewKey = key;
    const a = new DragonActor({ element, body, awakened, seed: 11, level });
    a.root.position.set(0, this.world.terrain.heightAt(0, 0), 0);
    a.root.rotation.y = 0.6;
    this.scene.add(a.root);
    this.preview = a;
  }

  toTitle() {
    this.state = 'title';
    this._leaveWorldVisuals();
    this.ui.showHud(false);
    this.ui.combatHide();
    this.ui.setLabels([]);
    this.ui.screen('title');
    this.ui.fade(false);
    const has = Save.has();
    document.getElementById('btn-continue').style.display = has ? '' : 'none';
    const best = Scores.best();
    document.getElementById('title-best').textContent = best ? `Best dragon so far: level ${best}` : '';
    const el = pick(Object.keys(ELEMENTS));
    this.setPreview({ element: el, body: pick(['quad', 'biped']), awakened: true, level: 100 });
    this.audio.setMusic('menu');
    this.menuOffset = 1;
  }

  showElement() {
    this.state = 'select';
    this.sel = { element: null, body: null };
    this.ui.showHud(false);
    this.ui.screen('element');
    this.menuOffset = 1;
    this.setPreview({ element: 'fire', body: 'quad', level: 40 });
  }

  showBody() {
    const e = ELEMENTS[this.sel.element];
    document.getElementById('body-lead').textContent = `${e.name} dragon. At level 100 it awakens as ${e.bonusName}.`;
    document.getElementById('dragon-name').value = pick(e.names);
    document.getElementById('btn-begin').disabled = true;
    document.querySelectorAll('#body-cards .card').forEach((x) => x.classList.remove('sel'));
    this.sel.body = null;
    this.ui.screen('body');
    this.setPreview({ element: this.sel.element, body: 'quad' });
  }

  _menuCamera(dt) {
    this.orbit += dt * 0.2;
    const p = this.preview;
    const s = p ? p.scaleValue : 1;
    const r = 9 + s * 6.5;
    const c = this.world.terrain.heightAt(0, 0);
    const look = new THREE.Vector3(0, c + (p ? p.height * 0.42 : 2), 0);
    this.camera.position.set(Math.sin(this.orbit) * r, c + (p ? p.height * 0.55 : 3) + 1, Math.cos(this.orbit) * r);
    this.camera.lookAt(look);
    if (this.menuOffset) {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      look.addScaledVector(right, -r * 0.28);
      this.camera.lookAt(look);
    }
  }

  // ------------------------------------------------------------------ starting / loading a game
  _newData(element, body, name) {
    const d = {
      name: name || pick(ELEMENTS[element].names), element, body, level: 1, xp: 0, vigor: 0, agility: 0, awakened: false,
      broccoli: 5, candy: 3, stomachB: 0, stomachC: 0, kills: 0, bestLevel: 1, hp: 1,
    };
    d.hp = computeStats(d).maxHp;
    return d;
  }

  startNew() {
    const name = document.getElementById('dragon-name').value.trim().slice(0, 16);
    this.audio.init();
    this.audio.click();
    this._leaveWorld();
    this._lock();
    this.data = this._newData(this.sel.element, this.sel.body, name);
    this.player.teleport(-4, 5, -0.83);
    Save.store(this.serialize());
    this._beginPlay(true);
  }

  continueGame() {
    const s = Save.load();
    if (!s) return;
    this._leaveWorld();
    this._lock();
    this.data = { ...this._newData(s.data.element, s.data.body, s.data.name), ...s.data };
    this.player.teleport(s.pos?.x ?? -4, s.pos?.z ?? 5, s.pos?.yaw ?? 0);
    if (this.world.terrain.isBlocked(this.player.pos.x, this.player.pos.z)) this.player.teleport(-4, 5);
    this._beginPlay(false);
  }

  async _beginPlay(isNew) {
    this.suppressPause = false;
    if (this.preview) { this.preview.dispose(); this.preview = null; this.previewKey = null; }
    const d = this.data;
    this.stats = computeStats(d);
    d.hp = clamp(d.hp, 1, this.stats.maxHp);
    this.dragon = new DragonActor({ element: d.element, body: d.body, awakened: d.awakened, seed: 3 + d.name.length, level: d.level });
    this.scene.add(this.dragon.root);
    const p = this.player.pos;
    const dp = this._v.set(p.x + 3, 0, p.z + 3);
    this.dragon.root.position.set(dp.x, this.world.terrain.heightAt(dp.x, dp.z), dp.z);
    this.dragonYaw = 0;
    this.player.cameraControlled = true;
    this.player.enabled = false;
    this.ui.screen(null);
    this.ui.showHud(true);
    this.ui.fade(true);
    this.world._grassCenter.set(1e9, 1e9);
    await sleep(500);
    this.state = 'playing';
    this.player.enabled = true;
    this.ui.fade(false);
    this.audio.setMusic('explore');
    this._refreshHud();
    this.saveTimer = 0;
    if (isNew) {
      this.ui.banner('DRAGON WORLD', `${d.name} has hatched`, '#ffd36a', 3600);
      setTimeout(() => this.ui.toast('Find broccoli and candy near the camp. Press E to pick them up.', 'good'), 1500);
      setTimeout(() => this.ui.toast('Press 1 to feed broccoli, 2 to feed candy. Don\'t overfeed!', 'warn'), 6500);
      setTimeout(() => this.ui.toast('Wild dragons roam the world. Beat them in battle to level up.'), 11500);
    } else this.ui.toast(`Welcome back. ${d.name} is level ${d.level}.`, 'good');
  }

  _leaveWorld() {
    if (this.dragon) { this.dragon.dispose(); this.dragon = null; }
    this._leaveWorldVisuals();
    this.combat = null;
    this.curWild = null;
    this.ui.combatHide();
    this.ui.prompt('');
    this.player.keys.clear();
    this.player.enabled = false;
    this.player.cameraControlled = true;
    this.feeding = false;
    if (document.pointerLockElement) {
      this.suppressPause = true;
      document.exitPointerLock();
    }
  }

  _leaveWorldVisuals() {
    for (const w of this.wilds) {
      this._deactivateWild(w);
      if (w.state !== 'dead') { w.state = 'idle'; w.cooldown = 0; }
    }
  }

  // ------------------------------------------------------------------ pause
  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.player.enabled = false;
    this.player.keys.clear();
    this._syncMute();
    this.ui.prompt('');
    this.ui.screen('pause');
    this.autosave();
  }

  async resume() {
    this.audio.click();
    this.ui.screen(null);
    this.suppressPause = false;
    this.state = 'playing';
    this.player.enabled = true;
    this._lock();
  }

  // ------------------------------------------------------------------ persistence
  serialize() {
    const p = this.player.pos;
    return { v: 1, data: { ...this.data }, pos: { x: p.x, z: p.z, yaw: this.player.yaw } };
  }

  autosave() {
    if (this.data) Save.store(this.serialize());
  }

  // ------------------------------------------------------------------ main loop
  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;
    this._adaptQuality(dt);
    this._update(dt);
    this.composer.render();
  }

  _update(dt) {
    this._updateTweens(dt);
    let focus = this._v2.set(0, this.world.terrain.heightAt(0, 0), 0);
    switch (this.state) {
      case 'title':
      case 'select':
        this._menuCamera(dt);
        this.preview?.update(dt, 0);
        this._updateWilds(dt, true);
        break;
      case 'playing':
        this._updatePlaying(dt);
        focus = this.player.pos;
        break;
      case 'paused':
        this.dragon?.update(dt, 0);
        this.player.update(dt);
        this._updateWilds(dt, true);
        focus = this.player.pos;
        break;
      case 'combat':
      case 'results':
        this._updateCombatView(dt);
        focus = this.player.pos;
        break;
      case 'eaten':
        this._updateEaten(dt);
        focus = this.player.pos;
        break;
      case 'gameover':
        this._updateEaten(dt);
        focus = this.player.pos;
        break;
      default: break;
    }
    this.world.update(dt, this.camera, focus);
    this.fx.update(dt, this.camera, this.renderer.domElement.height);
    this.ui.updateOverlays(this.camera, dt, this.state === 'playing');
  }

  _updateTweens(dt) {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const t = this.tweens[i];
      t.t += dt;
      const p = clamp(t.t / t.dur, 0, 1);
      t.fn(p, dt);
      if (p >= 1) { this.tweens.splice(i, 1); t.res(); }
    }
  }

  tween(dur, fn) {
    return new Promise((res) => this.tweens.push({ t: 0, dur, fn, res }));
  }

  tweenTo(actor, target, dur) {
    const from = actor.root.position.clone();
    const to = target.clone();
    actor.extSpeed = from.distanceTo(to) / dur;
    return this.tween(dur, (p) => {
      const k = easeInOut(p);
      const x = lerp(from.x, to.x, k), z = lerp(from.z, to.z, k);
      actor.root.position.set(x, this.world.terrain.heightAt(x, z), z);
      if (p >= 1) actor.extSpeed = 0;
    });
  }

  floatAt(actor, text, cls) {
    const p = actor.chestWorld(new THREE.Vector3());
    p.y += actor.height * 0.35;
    this.ui.float(text, cls, p);
  }

  // ------------------------------------------------------------------ playing
  _updatePlaying(dt) {
    const d = this.data;
    this.player.update(dt);
    this._updateDragon(dt);
    this._updateWilds(dt, false);
    if (this.state !== 'playing') return;

    d.stomachB = Math.max(0, d.stomachB - dt / FOOD.decaySeconds);
    d.stomachC = Math.max(0, d.stomachC - dt / FOOD.decaySeconds);
    this.dragon.setFullness(d.stomachB, d.stomachC);
    if (d.hp < this.stats.maxHp) d.hp = Math.min(this.stats.maxHp, d.hp + this.stats.maxHp * 0.03 * dt);

    // Interaction prompts
    const pick_ = this.world.nearestPickup(this.player.pos, 3.2);
    const chal = this._nearestWild(22);
    if (pick_) this.ui.prompt(`<b>E</b> Pick up ${pick_.type}`);
    else if (chal) this.ui.prompt(`<b>F</b> Challenge Lv ${chal.data.level} ${chal.data.name}`);
    else this.ui.prompt('');

    // HUD
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) { this.hudTimer = 0.1; this._refreshHud(); }
    this.regionTimer -= dt;
    if (this.regionTimer <= 0) {
      this.regionTimer = 0.6;
      const b = this.world.terrain.dominantBiome(this.player.pos.x, this.player.pos.z);
      this.ui.setRegion(REGION_NAMES[b]);
      this.audio.setBiome(b);
    }
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) { this.mapTimer = 0.1; this._drawMap(); }
    this._updateLabels();

    this.saveTimer += dt;
    if (this.saveTimer > 20) { this.saveTimer = 0; this.autosave(); }
  }

  _refreshHud() {
    if (!this.data) return;
    this.ui.updateHud({ ...this.data, stats: this.stats });
  }

  _drawMap() {
    const p = this.player.pos;
    const markers = [];
    for (const w of this.wilds) {
      if (w.state === 'dead') continue;
      const r = w.data.level / this.data.level;
      markers.push({ x: w.pos.x, z: w.pos.z, color: r < 0.8 ? '#6ee17f' : r <= 1.25 ? '#ffd36a' : '#ff5a4a', r: 4.5 });
    }
    for (const k of this.world.pickups) {
      if (!k.active || Math.hypot(k.pos.x - p.x, k.pos.z - p.z) > 150) continue;
      markers.push({ x: k.pos.x, z: k.pos.z, color: k.type === 'broccoli' ? '#3bd66a' : '#ff7ad9', r: 2 });
    }
    if (this.dragon) markers.push({ x: this.dragon.root.position.x, z: this.dragon.root.position.z, color: '#ffffff', r: 3 });
    this.ui.drawMinimap(this.world.minimap, WORLD.size, p.x, p.z, this.player.yaw, markers);
  }

  _updateLabels() {
    const list = [];
    for (const w of this.wilds) {
      if (!w.actor || w.state === 'dead') continue;
      const dist = w.pos.distanceTo(this.player.pos);
      if (dist > 90) continue;
      const r = w.data.level / this.data.level;
      list.push({
        key: w.id, text: `Lv ${w.data.level} ${w.data.name}`, cls: r < 0.8 ? 'weak' : r <= 1.25 ? 'even' : 'strong',
        pos: new THREE.Vector3(w.pos.x, w.pos.y + w.actor.height + 1.2, w.pos.z),
      });
    }
    this.ui.setLabels(list);
  }

  _interact() {
    const p = this.world.nearestPickup(this.player.pos, 3.2);
    if (!p) return;
    this.world.collect(p, this.world.time);
    const n = p.type === 'candy' ? randInt(1, 2) : randInt(1, 2);
    this.data[p.type] += n;
    this.audio.pickup(p.type);
    this.ui.toast(`Picked up ${n} ${p.type}.`, 'good');
    this.ui.flashSlot(p.type === 'broccoli' ? 'slot-broc' : 'slot-candy');
    this._refreshHud();
  }

  _nearestWild(range) {
    let best = null, bd = Infinity;
    for (const w of this.wilds) {
      if (!w.actor || w.state === 'dead' || w.cooldown > 0 || w.state === 'fight') continue;
      const d = w.pos.distanceTo(this.player.pos) - w.actor.radius;
      if (d < range && d < bd) { bd = d; best = w; }
    }
    return best;
  }

  _challenge() {
    const w = this._nearestWild(22);
    if (w) this._startCombat(w);
  }

  // ------------------------------------------------------------------ own dragon AI
  _updateDragon(dt) {
    const d = this.dragon, p = this.player;
    if (!d) return;
    const T = this.world.terrain;
    const pos = d.root.position;
    const body = BODIES[this.data.body];
    const fwd = p.forward(this._v);
    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    const back = 4.5 + d.radius * 1.3, side = 3 + d.radius * 0.6;
    const tx = p.pos.x - fwd.x * back + rx * side;
    const tz = p.pos.z - fwd.z * back + rz * side;
    let dx = tx - pos.x, dz = tz - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 70) {
      pos.set(tx, T.heightAt(tx, tz), tz);
      dx = dz = 0;
    }
    const want = dist > 1.3 ? clamp((dist - 1.0) * 1.9, 0, body.run) : 0;
    this.dragonSpeed = lerp(this.dragonSpeed, want, 1 - Math.exp(-6 * dt));
    let moved = 0;
    if (this.dragonSpeed > 0.05 && dist > 0.01) {
      const ox = pos.x, oz = pos.z;
      const nx = pos.x + (dx / dist) * this.dragonSpeed * dt;
      const nz = pos.z + (dz / dist) * this.dragonSpeed * dt;
      if (!T.isBlocked(nx, nz)) { pos.x = nx; pos.z = nz; } else if (!T.isBlocked(nx, pos.z)) pos.x = nx; else if (!T.isBlocked(pos.x, nz)) pos.z = nz;
      this.world.pushOut(pos, d.radius * 0.5);
      moved = Math.hypot(pos.x - ox, pos.z - oz) / Math.max(dt, 1e-4);
      const yaw = Math.atan2(dx, dz);
      this.dragonYaw += wrapAngle(yaw - this.dragonYaw) * (1 - Math.exp(-6 * dt));
    } else {
      const yaw = Math.atan2(fwd.x, fwd.z);
      this.dragonYaw += wrapAngle(yaw - this.dragonYaw) * (1 - Math.exp(-1.5 * dt));
    }
    pos.y = T.heightAt(pos.x, pos.z);
    d.root.rotation.y = this.dragonYaw;
    d.setLookTarget(p.eyePos(this._v2));
    d.update(dt, moved);
  }

  // ------------------------------------------------------------------ wild dragons
  _spawnWilds() {
    const rnd = mulberry32(777);
    const T = this.world.terrain;
    let id = 0;
    const add = (x, z, level) => {
      const b = T.dominantBiome(x, z);
      const biomeEl = { fire: 'fire', water: 'water', earth: 'earth' }[b];
      const element = biomeEl && rnd() < 0.78 ? biomeEl : ['fire', 'water', 'earth'][Math.floor(rnd() * 3)];
      const w = {
        id: `w${id++}`, home: new THREE.Vector3(x, T.heightAt(x, z), z), pos: new THREE.Vector3(x, T.heightAt(x, z), z),
        yaw: rnd() * Math.PI * 2, actor: null, state: 'idle', timer: rand(1, 4), target: new THREE.Vector3(), cooldown: 0,
        respawnAt: 0, seed: Math.floor(rnd() * 9999) + 1, element, body: rnd() < 0.5 ? 'quad' : 'biped', speed: 0,
      };
      w.data = this._rollWildData(w, level);
      this.wilds.push(w);
    };
    const starters = [1, 1, 2, 2, 3];
    starters.forEach((lv, i) => {
      for (let tries = 0; tries < 40; tries++) {
        const a = (i / starters.length) * Math.PI * 2 + rnd() * 0.6, r = 55 + rnd() * 45;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (T.isBlocked(x, z) || T.slopeAt(x, z) > 0.5) continue;
        add(x, z, lv);
        break;
      }
    });
    let tries = 0;
    while (this.wilds.length < 42 && tries++ < 600) {
      const x = (rnd() - 0.5) * 900, z = (rnd() - 0.5) * 900;
      const dist = Math.hypot(x, z);
      if (dist < 100 || T.isBlocked(x, z) || T.slopeAt(x, z) > 0.45 || T.heightAt(x, z) > 40) continue;
      const level = Math.min(200, Math.max(1, Math.round(1 + Math.pow(dist / 470, 1.35) * 150 * (0.55 + rnd() * 0.7))));
      add(x, z, level);
    }
  }

  _rollWildData(w, level) {
    const e = ELEMENTS[w.element];
    const d = {
      name: pick(e.names), element: w.element, body: w.body, level, awakened: level >= 100,
      vigor: Math.floor(level * 0.3 * Math.random()), agility: Math.floor(level * 0.2 * Math.random()), hp: 1,
    };
    d.hp = computeStats(d).maxHp;
    if (level <= 3) d.handicap = 0.7;
    return d;
  }

  _activateWild(w) {
    w.actor = new DragonActor({ element: w.data.element, body: w.data.body, awakened: w.data.awakened, seed: w.seed, level: w.data.level });
    w.actor.root.position.copy(w.pos);
    w.actor.root.rotation.y = w.yaw;
    this.scene.add(w.actor.root);
  }

  _deactivateWild(w) {
    if (!w.actor) return;
    w.actor.dispose();
    w.actor = null;
  }

  _updateWilds(dt, ambient) {
    const pp = this.player.pos;
    const now = this.time;
    for (const w of this.wilds) {
      const dist = Math.hypot(w.pos.x - pp.x, w.pos.z - pp.z);
      if (w.state === 'dead') {
        if (now > w.respawnAt && dist > 90 && this.state !== 'combat') this._respawnWild(w);
        continue;
      }
      if (!w.actor && dist < 240 && (this.state === 'playing' || this.state === 'paused')) this._activateWild(w);
      else if (w.actor && dist > 330 && (w.state === 'idle' || w.state === 'wander')) this._deactivateWild(w);
      if (w.actor && w.state !== 'fight') this._updateWild(w, dt, dist, ambient);
    }
  }

  _updateWild(w, dt, dist, ambient) {
    const a = w.actor, T = this.world.terrain;
    w.cooldown = Math.max(0, w.cooldown - dt);
    const bd = BODIES[w.data.body];
    const passive = w.data.level < this.data.level * 0.5 - 1;
    const canAggro = !ambient && !passive && w.cooldown <= 0 && this.state === 'playing';
    const aggroRange = 24 + a.radius;
    let speed = 0;
    const face = (tx, tz, rate = 5) => {
      w.yaw += wrapAngle(Math.atan2(tx - w.pos.x, tz - w.pos.z) - w.yaw) * (1 - Math.exp(-rate * dt));
    };
    const step = (tx, tz, v) => {
      const dx = tx - w.pos.x, dz = tz - w.pos.z;
      const l = Math.hypot(dx, dz);
      if (l < 0.5) return false;
      face(tx, tz);
      const nx = w.pos.x + (dx / l) * v * dt, nz = w.pos.z + (dz / l) * v * dt;
      if (T.isBlocked(nx, nz)) return false;
      w.pos.x = nx; w.pos.z = nz;
      this.world.pushOut(w.pos, a.radius * 0.5);
      speed = v;
      return true;
    };

    switch (w.state) {
      case 'idle':
        w.timer -= dt;
        if (w.timer <= 0) {
          if (Math.random() < 0.6) {
            w.target.set(w.home.x + rand(-22, 22), 0, w.home.z + rand(-22, 22));
            w.state = 'wander';
          } else w.timer = rand(2, 6);
        }
        break;
      case 'wander':
        if (!step(w.target.x, w.target.z, bd.walk * 0.5)) { w.state = 'idle'; w.timer = rand(2, 5); }
        break;
      case 'notice':
        face(this.player.pos.x, this.player.pos.z, 6);
        w.timer -= dt;
        if (w.timer <= 0) w.state = 'charge';
        break;
      case 'charge': {
        const p = this.player.pos;
        step(p.x, p.z, bd.run * 0.75);
        if (dist < 13 + a.radius * 1.1) this._startCombat(w);
        else if (dist > 70 || this.state !== 'playing') { w.state = 'idle'; w.timer = 3; }
        break;
      }
      default: break;
    }
    if ((w.state === 'idle' || w.state === 'wander') && canAggro && dist < aggroRange) {
      w.state = 'notice';
      w.timer = 1.2;
      a.play('roar');
      if (dist < 90) this.audio.roar(a.scaleValue, w.data.element);
    }
    w.pos.y = T.heightAt(w.pos.x, w.pos.z);
    a.root.position.copy(w.pos);
    a.root.rotation.y = w.yaw;
    if (dist < 45) a.setLookTarget(this.player.eyePos(this._v2)); else a.setLookTarget(null);
    a.update(dt, speed);
  }

  _respawnWild(w) {
    this._deactivateWild(w);
    const dist = Math.hypot(w.home.x, w.home.z);
    const level = Math.min(200, Math.max(1, Math.round(1 + Math.pow(dist / 470, 1.35) * 150 * (0.55 + Math.random() * 0.7))));
    w.body = Math.random() < 0.5 ? 'quad' : 'biped';
    w.data = this._rollWildData(w, level);
    w.pos.copy(w.home);
    w.state = 'idle';
    w.timer = 2;
    w.cooldown = 0;
  }

  // ------------------------------------------------------------------ feeding
  async feed(type) {
    if (this.state !== 'playing' || this.feeding) return;
    const d = this.data;
    if (d[type] <= 0) { this.ui.toast(`You have no ${type} left.`, 'warn'); return; }
    const mouth = this.dragon.mouthWorld(new THREE.Vector3());
    if (this.player.pos.distanceTo(this.dragon.root.position) > 22) { this.ui.toast('Your dragon is too far away to feed.', 'warn'); return; }
    this.feeding = true;
    d[type]--;
    this.ui.flashSlot(type === 'broccoli' ? 'slot-broc' : 'slot-candy');
    this._refreshHud();

    const col = type === 'broccoli' ? 0x39c455 : 0xff4fa8;
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.8 }));
    this.scene.add(m);
    const start = this.player.eyePos(new THREE.Vector3()).addScaledVector(this.player.forward(new THREE.Vector3()), 0.6);
    start.y -= 0.35;
    await this.tween(0.45, (p) => {
      const end = this.dragon.mouthWorld(this._v2);
      m.position.lerpVectors(start, end, p);
      m.position.y += Math.sin(p * Math.PI) * 1.6;
    });
    this.scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
    this.dragon.play('eat');
    this.audio.chomp();
    this.fx.burst(mouth.copy(this.dragon.mouthWorld(this._v2)), col, 14, 4, { s0: 0.3 });
    await sleep(380);
    this.feeding = false;
    if (this.state !== 'playing') return;

    const key = type === 'broccoli' ? 'stomachB' : 'stomachC';
    d[key] += 1;
    const risk = riskChance(d[key]);
    this.dragon.setFullness(d.stomachB, d.stomachC);
    if (Math.random() < risk) {
      if (type === 'broccoli') this._eaten();
      else this._sugarCrash();
      this._refreshHud();
      return;
    }
    const chest = this.dragon.chestWorld(new THREE.Vector3());
    chest.y += this.dragon.height * 0.3;
    if (type === 'broccoli') {
      d.vigor += 1;
      this.stats = computeStats(d);
      d.hp = Math.min(this.stats.maxHp, d.hp + this.stats.maxHp * FOOD.healFrac);
      this.ui.float('+1 Vigor', 'heal', chest);
      this.fx.heal(this.dragon.chestWorld(new THREE.Vector3()));
    } else {
      d.agility += 1;
      const xp = candyXp(d.level);
      this.ui.float(`+${xp} XP`, 'xp', chest);
      this.ui.float('+1 Agility', 'note', chest.clone().add(new THREE.Vector3(0, -0.8, 0)));
      this.gainXp(xp);
    }
    this.stats = computeStats(d);
    if (d[key] >= 2) {
      this.audio.warning();
      this.ui.toast(type === 'broccoli'
        ? `${d.name} is getting full and eyes you hungrily. The next broccoli is risky!`
        : `${d.name} is buzzing with sugar. The next candy could cause a crash!`, 'warn');
    }
    this._refreshHud();
  }

  // ------------------------------------------------------------------ progression
  gainXp(xp) {
    const d = this.data;
    d.xp += xp;
    let ups = 0;
    while (d.xp >= xpToNext(d.level)) {
      d.xp -= xpToNext(d.level);
      d.level++;
      ups++;
    }
    if (ups) this._onLevelUp(ups);
    this._refreshHud();
    return ups;
  }

  _onLevelUp(ups) {
    const d = this.data;
    this.stats = computeStats(d);
    d.hp = this.stats.maxHp;
    d.bestLevel = Math.max(d.bestLevel, d.level);
    this.dragon.setLevel(d.level);
    this.audio.levelUp();
    this.fx.levelUp(this.dragon.root.position.clone(), ELEMENTS[d.element].glow);
    const chest = this.dragon.chestWorld(new THREE.Vector3());
    chest.y += this.dragon.height * 0.6;
    this.ui.float(ups > 1 ? `LEVEL UP x${ups}` : 'LEVEL UP!', 'crit', chest);
    this.ui.toast(`${d.name} reached level ${d.level}!`, 'good');
    if (d.level >= 100 && !d.awakened) this._awaken();
    this.autosave();
  }

  async _awaken() {
    const d = this.data;
    const e = ELEMENTS[d.element];
    d.awakened = true;
    const color = { ice: '#9fe8ff', metal: '#e0e4ea', lightning: '#ffe15a' }[e.bonus];
    this.ui.banner('AWAKENING', `${d.name} becomes a ${e.bonusName} dragon`, color, 5200);
    this.ui.screenFlash(color, 1600, 0.9);
    this.audio.awaken();
    await sleep(900);
    if (!this.dragon) return;
    this.dragon.setAwakened(true);
    this.fx.levelUp(this.dragon.root.position.clone(), e.glow);
    this.ui.toast(`${e.ultimate} unlocked! Use it in battle.`, 'good');
    this._refreshHud();
  }

  _sugarCrash() {
    const d = this.data;
    const lost = Math.min(d.level - 1, 1 + Math.floor(d.level * 0.03) + (d.stomachC >= 4 ? 1 : 0) + (Math.random() < 0.5 ? 1 : 0));
    d.xp = 0;
    d.stomachC = Math.max(0, d.stomachC - 1.5);
    this.dragon.play('crash');
    this.audio.levelDown();
    this.fx.crash(this.dragon.root.position.clone());
    this.ui.screenFlash('#c050ff', 700, 0.45);
    if (lost <= 0) {
      this.ui.banner('SUGAR CRASH', `${d.name} feels sick but has no levels to lose`, '#c78bff', 3000);
      return;
    }
    d.level -= lost;
    this.stats = computeStats(d);
    d.hp = Math.min(d.hp, this.stats.maxHp);
    this.dragon.setLevel(d.level);
    this.ui.banner('SUGAR CRASH', `${d.name} lost ${lost} level${lost > 1 ? 's' : ''}`, '#c78bff', 3600);
    this.ui.toast(`Too much candy. ${d.name} dropped to level ${d.level}.`, 'bad');
    this.autosave();
  }

  // ------------------------------------------------------------------ death by broccoli
  async _eaten() {
    if (this.state !== 'playing') return;
    this.state = 'eaten';
    this.player.enabled = false;
    this.player.cameraControlled = false;
    this.suppressPause = true;
    this.ui.prompt('');
    this.ui.setLabels([]);
    const d = this.dragon;
    this.eatCam = { phase: 0, from: this.player.eyePos(new THREE.Vector3()) };
    this.ui.banner('TOO MUCH BROCCOLI', `${this.data.name} stares at you hungrily...`, '#ff5a4a', 4000);
    d.setFullness(6, 0);
    this.audio.warning();
    d.play('roar');
    this.audio.roar(d.scaleValue * 1.4, this.data.element);
    const fwd = this.player.forward(new THREE.Vector3());
    const stop = d.radius * 1.5 + 3.2;
    const target = new THREE.Vector3(this.player.pos.x + fwd.x * stop, 0, this.player.pos.z + fwd.z * stop);
    await Promise.all([this.tweenTo(d, target, 1.0), this.tween(1.0, () => { d.root.rotation.y += wrapAngle(Math.atan2(-fwd.x, -fwd.z) - d.root.rotation.y) * 0.15; })]);
    await sleep(500);
    d.play('bite', { dur: 1.0, reach: 0.4 });
    this.audio.eaten();
    this.ui.screenFlash('#a00000', 900, 0.8);
    await this.tween(0.9, (p) => { this.eatCam.phase = easeInOut(p); });
    this.ui.fade(true);
    await sleep(1100);
    this.gameOver('eaten');
  }

  _updateEaten(dt) {
    const d = this.dragon;
    if (d) {
      d.update(dt, d.extSpeed ?? 0);
      if (this.state === 'eaten' && this.eatCam) {
        const mouth = d.mouthWorld(this._v2);
        const ph = this.eatCam.phase;
        const target = mouth.clone().add(new THREE.Vector3(0, 0.3, 0));
        this.camera.position.lerpVectors(this.eatCam.from, target, ph * 0.9);
        const look = mouth.clone();
        look.y += d.height * 0.05;
        this.camera.lookAt(look);
      }
    }
  }

  // ------------------------------------------------------------------ combat
  async _startCombat(w) {
    if (this.state !== 'playing' || !w.actor) return;
    this.state = 'combat';
    this.curWild = w;
    w.state = 'fight';
    this.player.enabled = false;
    this.player.keys.clear();
    this.suppressPause = true;
    document.exitPointerLock?.();
    this.ui.prompt('');
    this.ui.setLabels([]);
    this.ui.showHud(false);
    this.dragonSpeed = 0;
    this.feeding = false;
    await this._setupArena(w);
    this.combat = new Combat(this, w);
    await this.combat.begin();
  }

  async _setupArena(w) {
    const T = this.world.terrain;
    const p = this.player.pos;
    const E = w.actor.root.position;
    const f = new THREE.Vector3(E.x - p.x, 0, E.z - p.z);
    if (f.lengthSq() < 1) f.copy(this.player.forward(new THREE.Vector3()));
    f.normalize();
    const rA = this.dragon.radius, rE = w.actor.radius;
    const dE = 9 + (rA + rE) * 2.2, dA = 5 + rA * 1.3;
    const a = -0.65;
    const left = new THREE.Vector3(f.x * Math.cos(a) - f.z * Math.sin(a), 0, f.x * Math.sin(a) + f.z * Math.cos(a));
    const place = (dir, dist) => {
      let r = dist;
      const v = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        v.set(p.x + dir.x * r, 0, p.z + dir.z * r);
        if (!T.isBlocked(v.x, v.z)) break;
        r *= 0.8;
      }
      v.y = T.heightAt(v.x, v.z);
      return v;
    };
    this.arena = { ally: place(left, dA), enemy: place(f, dE) };
    await Promise.all([this.tweenTo(this.dragon, this.arena.ally, 1.1), this.tweenTo(w.actor, this.arena.enemy, 1.1)]);
  }

  _updateCombatView(dt) {
    const d = this.dragon, w = this.curWild;
    if (!d || !w?.actor) return;
    const faceTo = (a, b) => {
      const dx = b.x - a.root.position.x, dz = b.z - a.root.position.z;
      a.root.rotation.y += wrapAngle(Math.atan2(dx, dz) - a.root.rotation.y) * (1 - Math.exp(-6 * dt));
    };
    faceTo(d, w.actor.root.position);
    faceTo(w.actor, d.root.position);
    d.setLookTarget(w.actor.root.position);
    w.actor.setLookTarget(d.root.position);
    d.update(dt, d.extSpeed ?? 0);
    w.actor.update(dt, w.actor.extSpeed ?? 0);
    w.pos.copy(w.actor.root.position);
    const mid = this._v.set(
      (d.root.position.x + w.actor.root.position.x) / 2,
      Math.max(d.root.position.y, w.actor.root.position.y) + Math.max(d.height, w.actor.height) * 0.35,
      (d.root.position.z + w.actor.root.position.z) / 2,
    );
    this.player.facePoint(mid, dt, 3);
    this.player.update(dt);
  }

  endCombat(result, combat) {
    const d = this.data, w = this.curWild;
    this.state = 'results';
    this.ui.combatHide();
    this.audio.setMusic('explore');
    this.resultInfo = { result, w };
    let html = '';
    let title = '';
    if (result === 'victory') {
      const ratio = clamp(w.data.level / d.level, 0.35, 2.5);
      const xp = Math.round((20 + 7 * w.data.level) * ratio);
      const broc = randInt(1, 3), candy = randInt(1, 3) + (w.data.level > 50 ? 1 : 0);
      d.broccoli += broc;
      d.candy += candy;
      d.kills++;
      const before = d.level;
      const ups = this.gainXp(xp);
      title = 'Victory!';
      html = `<span class="big">+${xp} XP</span>${ups ? `<b>Level ${before} &rarr; ${d.level}</b><br>` : ''}Loot: ${broc} broccoli, ${candy} candy`;
      w.state = 'dead';
      w.respawnAt = this.time + 100;
    } else if (result === 'defeat') {
      const lost = Math.min(d.level - 1, 1 + Math.ceil(d.level * 0.04));
      d.level -= lost;
      d.xp = 0;
      this.stats = computeStats(d);
      d.hp = this.stats.maxHp;
      this.dragon.setLevel(d.level);
      title = 'Defeated';
      html = `${d.name} was beaten and fled back to camp.<br>${lost > 0 ? `Lost <b>${lost}</b> level${lost > 1 ? 's' : ''}.` : 'It had no levels left to lose.'}`;
      w.cooldown = 40;
      w.state = 'idle';
    } else {
      title = 'Escaped';
      html = `You slipped away from ${w.data.name}.`;
      w.cooldown = 25;
      w.state = 'idle';
    }
    this.stats = computeStats(d);
    this._refreshHud();
    this.combat = null;
    this.ui.results(title, html);
    this.autosave();
  }

  _closeResults() {
    if (this.state !== 'results') return;
    this.audio.click();
    const { result, w } = this.resultInfo;
    this.dragon.clearAnims();
    this.dragon.revive();
    if (w.actor) { w.actor.clearAnims(); w.actor.revive(); }
    if (result === 'victory') {
      this._deactivateWild(w);
    } else if (result === 'defeat') {
      this.player.teleport(-4, 5);
      const T = this.world.terrain;
      this.dragon.root.position.set(-1, T.heightAt(-1, 8), 8);
      w.pos.copy(w.home);
      if (w.actor) w.actor.root.position.copy(w.home);
    }
    w.actor?.setLookTarget(null);
    this.curWild = null;
    this.ui.screen(null);
    this.suppressPause = false;
    this.player.enabled = true;
    this.player.pitch = 0;
    this.state = 'playing';
    this.ui.showHud(true);
    this._lock();
  }

  // ------------------------------------------------------------------ end of run
  gameOver(cause) {
    const d = this.data;
    if (!d) return;
    const e = ELEMENTS[d.element];
    const eaten = cause === 'eaten';
    Scores.add({ name: d.name, element: d.element, body: d.body, level: d.level, awakened: d.awakened, kills: d.kills, cause: eaten ? 'Eaten' : 'Retired' });
    Save.clear();
    this.state = 'gameover';
    this.player.enabled = false;
    this.suppressPause = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.showHud(false);
    this.ui.prompt('');
    const best = Scores.best();
    const form = d.awakened ? `${e.bonusName} dragon` : `${e.name} dragon`;
    this.ui.gameOver(
      eaten ? 'Devoured' : 'Retired',
      `${eaten ? `${d.name} could not resist one more floret of broccoli.<br>` : ''}
       <span class="big">Level ${d.level}</span>
       ${d.name}, ${form} &middot; ${d.kills} wild dragons defeated<br>
       ${d.level >= best ? '<b>New personal best!</b>' : `Best so far: level ${best}`}`,
    );
    this.ui.fade(false);
    this.audio.setMusic('menu');
  }
}
