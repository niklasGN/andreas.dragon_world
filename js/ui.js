import * as THREE from 'three';
import { ELEMENTS, BODIES, xpToNext, clamp, riskChance } from './config.js';

const svg = (inner, extra = '') => `<svg viewBox="0 0 24 24" ${extra}>${inner}</svg>`;
export const ICONS = {
  fire: svg('<path fill="currentColor" d="M12 2s5.5 4.6 5.5 10A5.5 5.5 0 0 1 12 17.5 5.5 5.5 0 0 1 6.5 12c0-2.2 1-3.7 2.2-4.8.1 2 1.1 3.2 2.3 3.4C10.4 7.8 11 4.6 12 2zm0 20a4.2 4.2 0 0 1-4.2-4.2c1 .9 2.4 1.5 4.2 1.5s3.2-.6 4.2-1.5A4.2 4.2 0 0 1 12 22z"/>'),
  water: svg('<path fill="currentColor" d="M12 2.5C9 7 5.5 10.5 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10.5 15 7 12 2.5z"/>'),
  earth: svg('<path fill="currentColor" d="M1.5 20 9 7l4 6.5 3-4L22.5 20z"/>'),
  ice: svg('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/>'),
  metal: svg('<path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.2 8 11 4.6-1.8 8-6 8-11V5z"/>'),
  lightning: svg('<path fill="currentColor" d="M13.5 2 5 13.5h6L10 22l9-12h-6z"/>'),
  broccoli: svg('<circle cx="7.5" cy="9.5" r="4.4" fill="#2f8f3a"/><circle cx="16.5" cy="9.5" r="4.4" fill="#37a044"/><circle cx="12" cy="6.2" r="4.8" fill="#2a7d33"/><path d="M9.6 12h4.8l1.2 9H8.4z" fill="#9ccf5a"/>'),
  candy: svg('<path d="M1.5 7.5 7 12l-5.5 4.5zM22.5 7.5 17 12l5.5 4.5z" fill="#ff7ad9"/><ellipse cx="12" cy="12" rx="6.5" ry="5.5" fill="#ff4f9a"/><path d="M7.5 11c3.2 1.4 5.2-1.4 9 .8" stroke="#fff" stroke-width="1.7" fill="none"/>'),
};

const ELEMENT_COLOR = { fire: '#ff7a2a', water: '#4cc3ff', earth: '#9bc46a' };
const FORM_COLOR = { ice: '#9fe8ff', metal: '#d0d6de', lightning: '#ffe15a' };

export class UI {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.hud = this.$('hud');
    this.mm = this.$('minimap').getContext('2d');
    this.labels = new Map();
    this.floaters = [];
    this._v = new THREE.Vector3();
    this.$('icon-broc').innerHTML = ICONS.broccoli;
    this.$('icon-candy').innerHTML = ICONS.candy;
    this._buildElementCards();
    this._buildBodyCards();
  }

  on(id, fn) {
    this.$(id).addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
  }

  // ---------- loading ----------
  loading(text, p) {
    this.$('load-text').textContent = text;
    this.$('load-bar-fill').style.width = `${Math.round(p * 100)}%`;
  }

  loadError(err) {
    const el = this.$('load-error');
    el.classList.remove('hidden');
    el.textContent = `Could not start the game.\n${err?.stack || err}`;
  }

  loadDone() {
    const l = this.$('loading');
    l.classList.add('done');
    setTimeout(() => l.classList.add('hidden'), 900);
  }

  // ---------- screens ----------
  screen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('show'));
    if (id) this.$(`screen-${id}`).classList.add('show');
    this.current = id;
  }

  showHud(v) { this.hud.classList.toggle('hidden', !v); }

  _buildElementCards() {
    const host = this.$('element-cards');
    host.innerHTML = '';
    for (const e of Object.values(ELEMENTS)) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.element = e.id;
      card.style.setProperty('--c', ELEMENT_COLOR[e.id]);
      card.innerHTML = `
        <div class="icon">${ICONS[e.id]}</div>
        <h3>${e.name}</h3>
        <div class="bonus">Level 100 awakening: <b>${e.bonusName}</b></div>
        <p>${e.blurb}</p>
        <div class="stat">${e.breath} &middot; ${e.ultimate}</div>
        <div class="stat">Strong against ${ELEMENTS[e.beats].name}</div>`;
      host.appendChild(card);
    }
  }

  _buildBodyCards() {
    const host = this.$('body-cards');
    host.innerHTML = '';
    for (const b of Object.values(BODIES)) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.body = b.id;
      card.style.setProperty('--c', b.id === 'quad' ? '#7fe3ff' : '#ffb35a');
      const pct = (v) => `${Math.round(v * 100)}%`;
      card.innerHTML = `
        <h3>${b.name}</h3>
        <p>${b.blurb}</p>
        <div class="stat">Health ${pct(b.hp)} &middot; Attack ${pct(b.atk)}</div>
        <div class="stat">Defense ${pct(b.def)} &middot; Speed ${pct(b.spd)}</div>`;
      host.appendChild(card);
    }
  }

  // ---------- HUD ----------
  updateHud(d) {
    const el = ELEMENTS[d.element];
    const col = d.awakened ? FORM_COLOR[el.bonus] : ELEMENT_COLOR[d.element];
    this.hud.style.setProperty('--accent', col);
    const badge = this.$('hud-icon');
    const icon = d.awakened ? el.bonus : d.element;
    if (badge.dataset.icon !== icon) { badge.innerHTML = ICONS[icon]; badge.dataset.icon = icon; }
    badge.style.color = col;
    this.$('hud-name').textContent = d.name;
    this.$('hud-level').textContent = `Lv ${d.level}`;
    this.$('hud-form').textContent = d.awakened
      ? `${el.bonusName} ${BODIES[d.body].id === 'quad' ? 'Quadruped' : 'Biped'}`
      : `${el.name} ${BODIES[d.body].id === 'quad' ? 'Quadruped' : 'Biped'}`;
    const need = xpToNext(d.level);
    this.$('hud-xp-fill').style.width = `${clamp(d.xp / need, 0, 1) * 100}%`;
    this.$('hud-xp-text').textContent = `XP ${Math.floor(d.xp)} / ${need}`;
    this.$('hud-hp-fill').style.width = `${clamp(d.hp / d.stats.maxHp, 0, 1) * 100}%`;
    this.$('hud-hp-text').textContent = `HP ${Math.ceil(d.hp)} / ${d.stats.maxHp}`;
    this.$('hud-stats').textContent = `ATK ${Math.round(d.stats.atk)}  DEF ${Math.round(d.stats.def)}  SPD ${Math.round(d.stats.spd)}  \u00b7  Vigor ${d.vigor}  Agility ${d.agility}`;
    this.$('inv-broc-count').textContent = d.broccoli;
    this.$('inv-candy-count').textContent = d.candy;
    this._meter('stomach-broc', 'stomach-broc-label', d.stomachB, 'eaten');
    this._meter('stomach-candy', 'stomach-candy-label', d.stomachC, 'crash');
  }

  _meter(fillId, labelId, load, penalty) {
    const f = this.$(fillId);
    f.style.width = `${clamp(load / 5, 0, 1) * 100}%`;
    const risk = riskChance(load + 1);
    const hue = clamp(120 - risk * 140, 0, 120);
    f.style.background = `hsl(${hue} 75% 52%)`;
    const label = this.$(labelId);
    label.textContent = risk <= 0 ? 'Safe to feed' : `Next bite: ${Math.round(risk * 100)}% ${penalty === 'eaten' ? 'you get eaten' : 'sugar crash'}`;
    label.style.color = risk > 0 ? `hsl(${hue} 85% 65%)` : '';
  }

  flashSlot(id) {
    const s = this.$(id);
    s.classList.remove('flash');
    void s.offsetWidth;
    s.classList.add('flash');
  }

  setRegion(name) {
    if (this.$('hud-region').textContent !== name) this.$('hud-region').textContent = name;
  }

  prompt(text) {
    const p = this.$('prompt');
    if (text) { p.innerHTML = text; p.classList.add('on'); } else p.classList.remove('on');
  }

  toast(text, kind = '') {
    const host = this.$('toasts');
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    host.prepend(t);
    while (host.children.length > 5) host.lastChild.remove();
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4700);
  }

  banner(title, sub = '', color = '#ffd36a', ms = 3200) {
    const b = this.$('banner');
    b.classList.remove('hidden');
    b.querySelector('h1').textContent = title;
    b.querySelector('h1').style.color = color;
    b.querySelector('p').textContent = sub;
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
    clearTimeout(this._bt);
    this._bt = setTimeout(() => b.classList.add('hidden'), ms);
  }

  screenFlash(color = '#fff', ms = 400, opacity = 0.6) {
    const f = this.$('flash');
    f.style.background = color;
    f.style.transition = 'none';
    f.style.opacity = opacity;
    void f.offsetWidth;
    f.style.transition = `opacity ${ms}ms`;
    f.style.opacity = 0;
  }

  fade(on) { this.$('fade').classList.toggle('on', on); }

  // ---------- world-anchored overlays ----------
  float(text, cls, worldPos) {
    const el = document.createElement('div');
    el.className = `float ${cls}`;
    el.textContent = text;
    this.$('floaters').appendChild(el);
    this.floaters.push({ el, pos: worldPos.clone(), t: 0 });
  }

  setLabels(list) {
    const seen = new Set();
    for (const l of list) {
      seen.add(l.key);
      let e = this.labels.get(l.key);
      if (!e) {
        e = document.createElement('div');
        this.$('labels').appendChild(e);
        this.labels.set(l.key, e);
      }
      if (e._text !== l.text || e._cls !== l.cls) { e.textContent = l.text; e.className = `label ${l.cls}`; e._text = l.text; e._cls = l.cls; }
      e._pos = l.pos;
    }
    for (const [k, e] of this.labels) if (!seen.has(k)) { e.remove(); this.labels.delete(k); }
  }

  updateOverlays(camera, dt, enabled = true) {
    const w = window.innerWidth, h = window.innerHeight;
    const proj = (pos) => {
      this._v.copy(pos).project(camera);
      return this._v.z < 1 && this._v.z > -1 ? [(this._v.x * 0.5 + 0.5) * w, (-this._v.y * 0.5 + 0.5) * h] : null;
    };
    for (const e of this.labels.values()) {
      const p = enabled ? proj(e._pos) : null;
      if (!p) { e.style.display = 'none'; continue; }
      e.style.display = '';
      e.style.left = `${p[0]}px`;
      e.style.top = `${p[1]}px`;
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      const p = proj(f.pos);
      if (f.t > 1.5 || !p) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      f.el.style.left = `${p[0]}px`;
      f.el.style.top = `${p[1] - f.t * 46}px`;
      f.el.style.opacity = String(clamp(1.6 - f.t, 0, 1));
    }
  }

  // ---------- minimap ----------
  drawMinimap(base, worldSize, px, pz, yaw, markers) {
    const ctx = this.mm, S = 200, win = 400;
    const k = base.width / worldSize;
    const srcSize = win * k;
    const sx = (px + worldSize / 2) * k - srcSize / 2;
    const sy = (pz + worldSize / 2) * k - srcSize / 2;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#0c1a2a'; ctx.fillRect(0, 0, S, S);
    ctx.translate(S / 2, S / 2);
    ctx.rotate(yaw);
    ctx.drawImage(base, sx, sy, srcSize, srcSize, -S / 2, -S / 2, S, S);
    const sc = S / win;
    for (const m of markers) {
      const dx = (m.x - px) * sc, dz = (m.z - pz) * sc;
      const d = Math.hypot(dx, dz);
      if (d > S / 2 - 6) continue;
      ctx.fillStyle = m.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(dx, dz, m.r ?? 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(S / 2, S / 2 - 8); ctx.lineTo(S / 2 + 6, S / 2 + 6); ctx.lineTo(S / 2, S / 2 + 2); ctx.lineTo(S / 2 - 6, S / 2 + 6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  // ---------- combat ----------
  combatShow(ally, enemy) {
    this.$('combat').classList.remove('hidden');
    this.$('c-ally-name').textContent = ally.name;
    this.$('c-ally-level').textContent = `Lv ${ally.level}`;
    this.$('c-enemy-name').textContent = enemy.name;
    this.$('c-enemy-level').textContent = `Lv ${enemy.level}`;
    const ee = ELEMENTS[enemy.element];
    this.$('c-enemy-info').textContent = `${enemy.awakened ? ee.bonusName : ee.name} ${enemy.body === 'quad' ? 'Quadruped' : 'Biped'}`;
    const ae = ELEMENTS[ally.element];
    this.$('c-breath-name').textContent = ae.breath;
    this.$('c-ult-name').textContent = ally.awakened ? ae.ultimate : 'Ultimate';
    this.$('c-ult-desc').textContent = ally.awakened ? 'Costs 60 focus' : 'Awaken at level 100';
    this.$('c-log').innerHTML = '';
  }

  combatHide() { this.$('combat').classList.add('hidden'); }

  combatUpdate(c) {
    const set = (id, hp, max) => {
      this.$(`${id}-hp`).style.width = `${clamp(hp / max, 0, 1) * 100}%`;
      this.$(`${id}-hp-text`).textContent = `${Math.max(0, Math.ceil(hp))} / ${max}`;
    };
    set('c-ally', c.allyHp, c.allyMax);
    set('c-enemy', c.enemyHp, c.enemyMax);
    this.$('c-ally-en').style.width = `${clamp(c.energy / 100, 0, 1) * 100}%`;
    const chips = (id, list) => {
      this.$(id).innerHTML = list.map((s) => `<span class="chip ${s.kind}">${s.text}</span>`).join('');
    };
    chips('c-ally-status', c.allyStatus);
    chips('c-enemy-status', c.enemyStatus);
  }

  combatLog(text) {
    const log = this.$('c-log');
    const d = document.createElement('div');
    d.textContent = text;
    log.prepend(d);
    while (log.children.length > 7) log.lastChild.remove();
  }

  setTurn(text) { this.$('c-turn').textContent = text; }

  setActions(enabled) {
    document.querySelectorAll('#c-actions button').forEach((b) => { b.disabled = !enabled[b.dataset.action]; });
  }

  // ---------- results / score screens ----------
  results(title, html, button = 'Continue') {
    this.$('res-title').textContent = title;
    this.$('res-body').innerHTML = html;
    this.$('btn-res-continue').textContent = button;
    this.screen('results');
  }

  gameOver(title, html) {
    this.$('over-title').textContent = title;
    this.$('over-body').innerHTML = html;
    this.screen('gameover');
  }

  renderScores(list) {
    const host = this.$('score-list');
    if (!list.length) { host.innerHTML = '<p class="muted">No legends yet. Raise a dragon and retire it, or get eaten trying.</p>'; return; }
    host.innerHTML = '<div class="score head"><span>#</span><span>Dragon</span><span>Level</span><span>Wins</span></div>' + list
      .map((s, i) => {
        const e = ELEMENTS[s.element];
        const form = s.awakened ? e.bonusName : e.name;
        return `<div class="score"><span>${i + 1}</span><span>${s.name} <span class="muted">${form} ${s.body === 'quad' ? 'Quad' : 'Biped'} &middot; ${s.cause}</span></span><b>Lv ${s.level}</b><span>${s.kills}</span></div>`;
      }).join('');
  }
}
