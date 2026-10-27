// Fully procedural audio: ambience, generative music and sound effects (no asset files).

const D_DORIAN = [146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0];
const PROGRESSION = [
  [73.42, 146.83, 220.0, 349.23],
  [58.27, 116.54, 174.61, 293.66],
  [65.41, 130.81, 196.0, 329.63],
  [55.0, 110.0, 164.81, 261.63],
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.mode = 'menu';
    this.step = 0;
    this.nextTime = 0;
    this.lastStep = 0;
  }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.musicGain = ctx.createGain(); this.musicGain.gain.value = 0.32; this.musicGain.connect(this.master);
    this.sfxGain = ctx.createGain(); this.sfxGain.gain.value = 0.9; this.sfxGain.connect(this.master);
    this.ambGain = ctx.createGain(); this.ambGain.gain.value = 0.5; this.ambGain.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Wind bed
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.12;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain).connect(this.windGain.gain);
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.07;
    const lfo2Gain = ctx.createGain(); lfo2Gain.gain.value = 180;
    lfo2.connect(lfo2Gain).connect(this.windFilter.frequency);
    src.connect(this.windFilter).connect(this.windGain).connect(this.ambGain);
    src.start(); lfo.start(); lfo2.start();

    this.nextTime = ctx.currentTime + 0.2;
    this.timer = setInterval(() => this._schedule(), 120);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  setMusic(mode) { this.mode = mode; }

  setBiome(b) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = { meadow: 520, forest: 700, water: 420, earth: 340, fire: 220 }[b] ?? 500;
    const g = { meadow: 0.12, forest: 0.15, water: 0.1, earth: 0.2, fire: 0.17 }[b] ?? 0.12;
    this.windFilter.frequency.setTargetAtTime(f, t, 1.5);
    this.windGain.gain.setTargetAtTime(g, t, 1.5);
  }

  // ---------- primitives ----------
  _tone(freq, t, dur, { type = 'sine', gain = 0.2, dest = this.sfxGain, attack = 0.01, filter = 0, glide = 0, detune = 0 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter;
      o.connect(f); node = f;
    }
    node.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _noise(t, dur, { type = 'bandpass', freq = 1000, freqEnd = 0, q = 1, gain = 0.3, attack = 0.005, dest = this.sfxGain } = {}) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loopStart = Math.random(); s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  _now() { return this.ctx.currentTime; }

  // ---------- music ----------
  _schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextTime < ctx.currentTime + 0.5) {
      this._musicStep(this.nextTime);
      const bpm = this.mode === 'battle' ? 128 : this.mode === 'menu' ? 54 : 64;
      this.nextTime += 60 / bpm / 2; // eighth notes
      this.step++;
    }
  }

  _musicStep(t) {
    const s = this.step;
    const beat = 60 / (this.mode === 'battle' ? 128 : this.mode === 'menu' ? 54 : 64);
    const bar = Math.floor(s / 8) % 4;
    const chord = PROGRESSION[bar];
    const mg = this.musicGain;
    if (this.mode === 'battle') {
      if (s % 2 === 0) { // kick
        this._tone(120, t, 0.18, { type: 'sine', gain: 0.9, dest: mg, glide: 0.3, attack: 0.002 });
      }
      if (s % 4 === 2) this._noise(t, 0.16, { type: 'highpass', freq: 1800, gain: 0.35, dest: mg });
      if (s % 2 === 1) this._noise(t, 0.05, { type: 'highpass', freq: 6000, gain: 0.12, dest: mg });
      const root = chord[0];
      this._tone(root, t, beat * 0.45, { type: 'sawtooth', gain: 0.22, dest: mg, filter: 380 });
      if (s % 8 === 0) for (const f of chord) this._tone(f, t, beat * 3.5, { type: 'sawtooth', gain: 0.05, dest: mg, filter: 900, attack: 0.05 });
      if (s % 4 === 3 || Math.random() < 0.25) {
        const n = D_DORIAN[(Math.random() * 8 | 0) + 3];
        this._tone(n, t, beat * 0.5, { type: 'square', gain: 0.045, dest: mg, filter: 2200 });
      }
      return;
    }
    const slow = this.mode === 'menu';
    if (s % 8 === 0) {
      for (const f of chord) {
        this._tone(f, t, beat * 8.2, { type: 'sawtooth', gain: slow ? 0.05 : 0.06, dest: mg, filter: 520, attack: 1.2, detune: -6 });
        this._tone(f, t, beat * 8.2, { type: 'sawtooth', gain: slow ? 0.05 : 0.06, dest: mg, filter: 520, attack: 1.2, detune: 7 });
      }
      this._tone(chord[0] / 2, t, beat * 8, { type: 'sine', gain: 0.22, dest: mg, attack: 0.8 });
    }
    if (s % 2 === 0 && Math.random() < (slow ? 0.35 : 0.55)) {
      const n = D_DORIAN[Math.floor(Math.random() * D_DORIAN.length)];
      this._tone(n * 2, t, beat * 2.2, { type: 'triangle', gain: 0.07, dest: mg, attack: 0.01 });
      this._tone(n * 4, t, beat * 1.2, { type: 'sine', gain: 0.025, dest: mg });
    }
    if (!slow && s % 4 === 0) this._noise(t, 0.4, { type: 'lowpass', freq: 160, gain: 0.08, dest: mg });
  }

  // ---------- SFX ----------
  step_(surface = 'grass') {
    if (!this.ctx) return;
    const t = this._now();
    const f = { grass: 700, rock: 1800, snow: 500, ash: 900, water: 1200 }[surface] ?? 800;
    this._noise(t, 0.09, { type: 'bandpass', freq: f * (0.8 + Math.random() * 0.4), q: 0.9, gain: 0.14 });
    this._tone(70, t, 0.08, { type: 'sine', gain: 0.1 });
  }

  pickup(type) {
    if (!this.ctx) return;
    const t = this._now();
    if (type === 'candy') [880, 1175, 1568].forEach((f, i) => this._tone(f, t + i * 0.06, 0.25, { type: 'triangle', gain: 0.18 }));
    else { this._tone(330, t, 0.16, { type: 'triangle', gain: 0.2 }); this._tone(494, t + 0.07, 0.2, { type: 'triangle', gain: 0.2 }); this._noise(t, 0.12, { freq: 3000, gain: 0.08 }); }
  }

  chomp() {
    if (!this.ctx) return;
    const t = this._now();
    for (let i = 0; i < 3; i++) {
      this._noise(t + i * 0.13, 0.08, { type: 'lowpass', freq: 900, gain: 0.35 });
      this._tone(110, t + i * 0.13, 0.1, { type: 'square', gain: 0.1, filter: 400 });
    }
  }

  roar(size = 1, element = 'fire') {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this._now();
    const base = 150 / Math.sqrt(size);
    const dur = 1.0 + size * 0.3;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(base * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(base * 0.55, t + dur);
    const vib = ctx.createOscillator(); vib.frequency.value = 22;
    const vg = ctx.createGain(); vg.gain.value = base * 0.12;
    vib.connect(vg).connect(o.frequency);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i / 255) * 2 - 1; curve[i] = Math.tanh(x * 3); }
    shaper.curve = curve;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(shaper).connect(f).connect(g).connect(this.sfxGain);
    o.start(t); vib.start(t); o.stop(t + dur + 0.1); vib.stop(t + dur + 0.1);
    this._noise(t, dur, { type: 'bandpass', freq: 900, freqEnd: 250, q: 0.8, gain: 0.35 });
  }

  breath(kind) {
    if (!this.ctx) return;
    const t = this._now();
    if (kind === 'fire') { this._noise(t, 1.1, { type: 'lowpass', freq: 2200, freqEnd: 400, gain: 0.6, attack: 0.1 }); this._noise(t, 1.1, { type: 'bandpass', freq: 600, q: 0.5, gain: 0.4 }); }
    else if (kind === 'water') { this._noise(t, 1.0, { type: 'highpass', freq: 1500, freqEnd: 4000, gain: 0.4, attack: 0.1 }); this._noise(t, 1.0, { type: 'bandpass', freq: 900, q: 1, gain: 0.3 }); }
    else if (kind === 'earth') { this._noise(t, 0.7, { type: 'lowpass', freq: 300, gain: 0.8 }); for (let i = 0; i < 6; i++) this._tone(70 + Math.random() * 40, t + 0.5 + i * 0.05, 0.2, { type: 'square', gain: 0.12, filter: 300 }); }
    else if (kind === 'ice') { for (let i = 0; i < 12; i++) this._tone(1800 + Math.random() * 2500, t + i * 0.07, 0.4, { type: 'sine', gain: 0.07 }); this._noise(t, 1.6, { type: 'highpass', freq: 3000, gain: 0.25, attack: 0.3 }); }
    else if (kind === 'metal') { [180, 412, 770, 1130].forEach((f, i) => this._tone(f, t + 0.6, 1.4, { type: 'sine', gain: 0.18 / (i + 1) })); this._noise(t, 0.7, { type: 'lowpass', freq: 400, gain: 0.7, attack: 0.5 }); }
    else if (kind === 'lightning') { for (let i = 0; i < 5; i++) { this._noise(t + i * 0.18, 0.2, { type: 'highpass', freq: 2500, gain: 0.7, attack: 0.002 }); this._tone(55, t + i * 0.18, 0.4, { type: 'sine', gain: 0.5 }); } }
  }

  hit(heavy = false) {
    if (!this.ctx) return;
    const t = this._now();
    this._noise(t, heavy ? 0.4 : 0.2, { type: 'lowpass', freq: heavy ? 700 : 1200, gain: 0.7 });
    this._tone(heavy ? 60 : 90, t, heavy ? 0.4 : 0.2, { type: 'sine', gain: 0.8, glide: 0.4 });
  }

  miss() { if (this.ctx) this._noise(this._now(), 0.25, { type: 'bandpass', freq: 1500, freqEnd: 400, gain: 0.25 }); }

  levelUp() {
    if (!this.ctx) return;
    const t = this._now();
    [392, 494, 587, 784, 988].forEach((f, i) => { this._tone(f, t + i * 0.09, 0.6, { type: 'triangle', gain: 0.2 }); this._tone(f * 2, t + i * 0.09, 0.4, { type: 'sine', gain: 0.06 }); });
  }

  levelDown() {
    if (!this.ctx) return;
    const t = this._now();
    [440, 349, 262, 196].forEach((f, i) => this._tone(f, t + i * 0.14, 0.5, { type: 'sawtooth', gain: 0.12, filter: 900 }));
    this._tone(80, t, 0.9, { type: 'sine', gain: 0.4, glide: 0.5 });
  }

  warning() {
    if (!this.ctx) return;
    const t = this._now();
    this._tone(90, t, 0.5, { type: 'sawtooth', gain: 0.16, filter: 300, glide: 0.85 });
    this._tone(94, t, 0.5, { type: 'sawtooth', gain: 0.16, filter: 300, glide: 0.85 });
  }

  eaten() {
    if (!this.ctx) return;
    this.roar(3, 'fire');
    const t = this._now() + 0.9;
    this._noise(t, 0.5, { type: 'lowpass', freq: 500, gain: 0.9 });
    this._tone(50, t, 1.2, { type: 'sine', gain: 0.8, glide: 0.4 });
  }

  victory() {
    if (!this.ctx) return;
    const t = this._now();
    [294, 370, 440, 587].forEach((f, i) => this._tone(f, t + i * 0.12, 0.9, { type: 'sawtooth', gain: 0.09, filter: 1600 }));
  }

  defeat() {
    if (!this.ctx) return;
    const t = this._now();
    [220, 208, 196, 147].forEach((f, i) => this._tone(f, t + i * 0.25, 0.8, { type: 'sawtooth', gain: 0.1, filter: 700 }));
  }

  awaken() {
    if (!this.ctx) return;
    const t = this._now();
    this.roar(3, 'fire');
    [196, 294, 392, 587, 784, 1175].forEach((f, i) => this._tone(f, t + 0.3 + i * 0.16, 1.6, { type: 'triangle', gain: 0.17 }));
    this._noise(t + 0.6, 2, { type: 'highpass', freq: 2000, gain: 0.3, attack: 1 });
  }

  click() { if (this.ctx) this._tone(660, this._now(), 0.08, { type: 'triangle', gain: 0.12 }); }
}
