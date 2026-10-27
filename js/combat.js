import { ELEMENTS, COMBAT, computeStats, typeMultiplier, rand, clamp } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS_TEXT = {
  burn: ['Burning', 'bad'], slow: ['Chilled', 'bad'], fortify: ['Hardened', 'good'], frozen: ['Frozen', 'bad'], stunned: ['Stunned', 'bad'],
};

export class Combat {
  constructor(game, wild) {
    this.g = game;
    this.wild = wild;
    const ad = game.data;
    const as = computeStats(ad);
    this.ally = { key: 'ally', data: ad, actor: game.dragon, name: ad.name, element: ad.element, stats: as, hp: Math.min(ad.hp, as.maxHp), max: as.maxHp, energy: 40, st: {}, guard: false };
    const ed = wild.data;
    const es = computeStats(ed);
    this.enemy = { key: 'enemy', data: ed, actor: wild.actor, name: ed.name, element: ed.element, stats: es, hp: es.maxHp, max: es.maxHp, energy: 40, st: {}, guard: false };
    this.over = false;
    this.busy = true;
    this.turn = 'ally';
    this.rounds = 0;
  }

  foe(side) { return side === this.ally ? this.enemy : this.ally; }

  eff(side) {
    const s = { ...side.stats };
    if (side.st.fortify > 0) s.def *= 1.4;
    if (side.st.slow > 0) s.spd *= 0.65;
    return s;
  }

  dodgeChance(att, def) {
    const a = this.eff(att).spd, d = this.eff(def).spd;
    return clamp(0.08 + 0.5 * (d - a) / (d + a), 0.03, 0.5);
  }

  say(t) { this.g.ui.combatLog(t); }

  refresh() {
    const chips = (side) => Object.entries(side.st)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ text: `${STATUS_TEXT[k][0]} ${v}`, kind: STATUS_TEXT[k][1] }))
      .concat(side.guard ? [{ text: 'Guarding', kind: 'good' }] : []);
    this.g.ui.combatUpdate({
      allyHp: this.ally.hp, allyMax: this.ally.max, enemyHp: this.enemy.hp, enemyMax: this.enemy.max,
      energy: this.ally.energy, allyStatus: chips(this.ally), enemyStatus: chips(this.enemy),
    });
  }

  enableActions(on) {
    const a = this.ally;
    this.g.ui.setActions({
      strike: on, breath: on && a.energy >= COMBAT.breathCost, guard: on,
      ultimate: on && a.data.awakened && a.energy >= COMBAT.ultimateCost, flee: on,
    });
  }

  async begin() {
    const g = this.g;
    g.ui.combatShow(this.ally.data, { ...this.enemy.data });
    this.refresh();
    this.enableActions(false);
    g.ui.setTurn('Face off');
    g.audio.setMusic('battle');
    this.say(`A wild ${this.enemy.name} (Lv ${this.enemy.data.level}) challenges you!`);
    await this.enemy.actor.play('roar');
    g.audio.roar(this.enemy.actor.scaleValue, this.enemy.element);
    g.ui.banner('BATTLE', `${this.ally.name} vs ${this.enemy.name}`, '#ff8a5a', 1800);
    await sleep(900);
    const sa = this.eff(this.ally).spd, se = this.eff(this.enemy).spd;
    this.turn = sa >= se ? 'ally' : 'enemy';
    this.say(this.turn === 'ally' ? `${this.ally.name} is faster and strikes first.` : `${this.enemy.name} is faster and moves first.`);
    await this.nextTurn();
  }

  async startOfTurn(side) {
    side.energy = Math.min(COMBAT.maxEnergy, side.energy + COMBAT.energyPerTurn);
    side.guard = false;
    if (side.st.burn > 0) {
      const dmg = Math.max(1, Math.ceil(side.max * 0.06));
      side.hp = Math.max(0, side.hp - dmg);
      this.say(`${side.name} burns for ${dmg}.`);
      this.g.floatAt(side.actor, `-${dmg}`, 'dmg');
      side.actor.play('hurt');
      this.g.audio.hit(false);
    }
    for (const k of ['burn', 'slow', 'fortify']) if (side.st[k] > 0) side.st[k]--;
    this.refresh();
    if (side.hp <= 0) return 'dead';
    for (const k of ['frozen', 'stunned']) {
      if (side.st[k] > 0) {
        side.st[k]--;
        this.say(`${side.name} is ${k === 'frozen' ? 'frozen solid' : 'stunned'} and loses the turn!`);
        this.refresh();
        return 'skip';
      }
    }
    return 'ok';
  }

  async nextTurn() {
    if (this.over) return;
    const side = this.turn === 'ally' ? this.ally : this.enemy;
    this.rounds++;
    const r = await this.startOfTurn(side);
    if (r === 'dead') return this.finish(side === this.ally ? 'defeat' : 'victory');
    if (r === 'skip') { await sleep(900); this.turn = this.turn === 'ally' ? 'enemy' : 'ally'; return this.nextTurn(); }
    if (side === this.ally) {
      this.g.ui.setTurn('Your turn');
      this.busy = false;
      this.enableActions(true);
    } else {
      this.g.ui.setTurn(`${this.enemy.name}'s turn`);
      this.enableActions(false);
      await sleep(900);
      const act = this.chooseEnemyAction();
      await this.perform(this.enemy, act);
      if (this.over) return undefined;
      this.turn = 'ally';
      return this.nextTurn();
    }
    return undefined;
  }

  chooseEnemyAction() {
    const e = this.enemy;
    const mult = typeMultiplier(e.element, this.ally.element);
    if (e.data.awakened && e.energy >= COMBAT.ultimateCost && Math.random() < 0.5) return 'ultimate';
    if (e.hp / e.max < 0.3 && Math.random() < 0.3) return 'guard';
    if (e.energy >= COMBAT.breathCost && Math.random() < (mult > 1 ? 0.8 : mult < 1 ? 0.35 : 0.55)) return 'breath';
    return 'strike';
  }

  async act(action) {
    if (this.over || this.busy || this.turn !== 'ally') return;
    const a = this.ally;
    if (action === 'breath' && a.energy < COMBAT.breathCost) return;
    if (action === 'ultimate' && (!a.data.awakened || a.energy < COMBAT.ultimateCost)) return;
    this.busy = true;
    this.enableActions(false);
    this.g.ui.setTurn('...');
    const fled = await this.perform(a, action);
    if (this.over) return;
    if (fled === 'fled') return;
    this.turn = 'enemy';
    await this.nextTurn();
  }

  damage(att, def, power, { pierce = 0 } = {}) {
    const A = this.eff(att), D = this.eff(def);
    const defv = D.def * (1 - pierce);
    let dmg = power * A.atk * rand(0.9, 1.1) * (30 / (30 + defv));
    const crit = Math.random() < 0.08;
    if (crit) dmg *= 1.5;
    if (def.guard) dmg *= 0.5;
    return { dmg: Math.max(1, Math.round(dmg)), crit };
  }

  async charge(att, def) {
    const g = this.g;
    const A = att.actor.root.position, D = def.actor.root.position;
    att.home = A.clone();
    const dir = D.clone().sub(A).setY(0);
    const dist = dir.length();
    dir.normalize();
    const stop = att.actor.radius * 1.1 + def.actor.radius * 1.1 + 1.2;
    const target = D.clone().addScaledVector(dir, -stop);
    await g.tweenTo(att.actor, target, clamp(dist / 24, 0.35, 0.9));
  }

  async retreat(att) {
    await this.g.tweenTo(att.actor, att.home, 0.55);
  }

  applyHit(att, def, power, opts = {}) {
    const { dmg, crit } = this.damage(att, def, power, opts);
    const mult = opts.mult ?? 1;
    const total = Math.max(1, Math.round(dmg * mult));
    def.hp = Math.max(0, def.hp - total);
    def.actor.play('hurt');
    this.g.audio.hit(total > def.max * 0.2 || crit);
    this.g.floatAt(def.actor, `${total}`, crit ? 'crit' : 'dmg');
    this.g.ui.screenFlash(def === this.ally ? '#ff2a1a' : '#ffffff', 220, def === this.ally ? 0.35 : 0.15);
    if (def === this.ally) this.g.player.shake = Math.max(this.g.player.shake, 0.03 + total / def.max * 0.1);
    let note = `${att.name} hits ${def.name} for ${total}${crit ? ' (critical!)' : ''}`;
    if (mult > 1) note += ' - super effective!';
    else if (mult < 1) note += ' - resisted.';
    this.say(`${note}`);
    this.refresh();
    return total;
  }

  miss(att, def) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    def.actor.play('dodge', { dir });
    this.g.audio.miss();
    this.g.floatAt(def.actor, 'Dodged!', 'miss');
    this.say(`${def.name} dodges ${att.name}'s attack!`);
  }

  async perform(att, action) {
    const g = this.g;
    const def = this.foe(att);
    const E = ELEMENTS[att.element];
    const form = att.data.awakened ? E.bonus : 'base';
    const A = att.actor, D = def.actor;
    const dodge = this.dodgeChance(att, def);

    if (action === 'strike') {
      this.say(`${att.name} charges in!`);
      await this.charge(att, def);
      A.play('bite');
      await sleep(330);
      if (Math.random() > dodge) {
        this.applyHit(att, def, 1.0);
        g.fx.strikeImpact(D.chestWorld(), att.element, form);
      } else this.miss(att, def);
      att.energy = Math.min(COMBAT.maxEnergy, att.energy + 8);
      await sleep(450);
      await this.retreat(att);
    } else if (action === 'breath') {
      att.energy -= COMBAT.breathCost;
      this.say(`${att.name} unleashes ${E.breath}!`);
      A.play('breath');
      g.audio.roar(A.scaleValue * 0.6, att.element);
      g.audio.breath(att.element);
      await sleep(350);
      const mult = typeMultiplier(att.element, def.element);
      const hit = Math.random() > dodge * 0.4;
      await g.fx.breath(A.mouthWorld(), D.chestWorld(), att.element, 'base');
      if (hit) {
        this.applyHit(att, def, 1.8, { mult });
        if (att.element === 'fire') { def.st.burn = 3; this.say(`${def.name} is set ablaze!`); }
        if (att.element === 'water') { def.st.slow = 3; this.say(`${def.name} is chilled and slowed!`); }
      } else this.miss(att, def);
      if (att.element === 'earth') { att.st.fortify = 3; this.say(`${att.name}'s hide hardens like stone.`); g.fx.heal(A.chestWorld()); }
      await sleep(600);
    } else if (action === 'ultimate') {
      att.energy -= COMBAT.ultimateCost;
      this.say(`${att.name} unleashes ${E.ultimate}!`);
      g.ui.banner(E.ultimate, E.bonusName, E.bonus === 'ice' ? '#9fe8ff' : E.bonus === 'metal' ? '#d0d6de' : '#ffe15a', 1800);
      A.play('ult');
      g.audio.roar(A.scaleValue, att.element);
      g.audio.breath(E.bonus);
      await sleep(700);
      await g.fx.ultimate(A.mouthWorld(), D.chestWorld(), att.element, E.bonus);
      const mult = typeMultiplier(att.element, def.element);
      if (E.bonus === 'ice') {
        this.applyHit(att, def, 3.0, { mult });
        def.st.frozen = 1; def.st.slow = 3;
        this.say(`${def.name} is frozen solid!`);
      } else if (E.bonus === 'metal') {
        this.applyHit(att, def, 3.4, { mult, pierce: 0.5 });
        att.st.fortify = 3;
        this.say('The iron shards pierce its defenses!');
      } else {
        this.applyHit(att, def, 3.0, { mult });
        if (def.hp > 0) { await sleep(300); this.applyHit(att, def, 0.8); }
        def.st.stunned = 1;
        this.say(`${def.name} is stunned by the lightning!`);
      }
      await sleep(700);
    } else if (action === 'guard') {
      att.guard = true;
      att.energy = Math.min(COMBAT.maxEnergy, att.energy + 20);
      this.say(`${att.name} braces for impact.`);
      g.fx.heal(A.chestWorld());
      g.floatAt(A, 'Guard', 'note');
      await sleep(700);
    } else if (action === 'flee') {
      const sa = this.eff(att).spd, sd = this.eff(def).spd;
      const chance = 0.35 + 0.45 * (sa / (sa + sd));
      this.say(`${att.name} tries to escape...`);
      await sleep(600);
      if (Math.random() < chance) {
        this.say('Got away safely!');
        await this.finish('fled');
        return 'fled';
      }
      this.say('The path is blocked!');
      await sleep(400);
    }

    this.refresh();
    if (def.hp <= 0) { await this.finish(def === this.enemy ? 'victory' : 'defeat'); return 'over'; }
    if (att.hp <= 0) { await this.finish(att === this.ally ? 'defeat' : 'victory'); return 'over'; }
    return 'ok';
  }

  async finish(result) {
    if (this.over) return;
    this.over = true;
    this.enableActions(false);
    const g = this.g;
    this.ally.data.hp = Math.max(1, this.ally.hp);
    if (result === 'victory') {
      this.say(`${this.enemy.name} is defeated!`);
      await this.enemy.actor.play('faint');
      g.audio.victory();
      await sleep(500);
    } else if (result === 'defeat') {
      this.say(`${this.ally.name} collapses...`);
      await this.ally.actor.play('faint');
      g.audio.defeat();
      await sleep(500);
    }
    g.endCombat(result, this);
  }
}
