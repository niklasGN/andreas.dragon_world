// Shared constants and balance formulas for Dragon World.

export const WORLD = {
  size: 1000,
  half: 500,
  playable: 470,
  waterLevel: -2.2,
};

export const ELEMENTS = {
  water: {
    id: 'water', name: 'Water', bonus: 'ice', bonusName: 'Ice',
    color: 0x2f78b5, belly: 0xcfe9f0, accent: 0x7fe3ff, horn: 0xdfeef2,
    glow: 0x66ddff, beats: 'fire',
    breath: 'Tidal Surge', ultimate: 'Glacial Tempest',
    blurb: 'Fluid and relentless. Chills enemies and slows them down.',
    names: ['Nerida', 'Tidus', 'Marin', 'Coral', 'Azura', 'Brine'],
  },
  earth: {
    id: 'earth', name: 'Earth', bonus: 'metal', bonusName: 'Metal',
    color: 0x6d5b3b, belly: 0xb8a57a, accent: 0x9be36b, horn: 0x3a3128,
    glow: 0xb7a27a, beats: 'water',
    breath: 'Boulder Barrage', ultimate: 'Iron Meteor',
    blurb: 'Stubborn and sturdy. Hardens its hide to shrug off blows.',
    names: ['Granite', 'Terra', 'Basalt', 'Moss', 'Onyx', 'Cairn'],
  },
  fire: {
    id: 'fire', name: 'Fire', bonus: 'lightning', bonusName: 'Lightning',
    color: 0x9e2a1c, belly: 0xe2a65a, accent: 0xffb23a, horn: 0x241512,
    glow: 0xff7a2a, beats: 'earth',
    breath: 'Inferno Breath', ultimate: 'Thunder Wrath',
    blurb: 'Fierce and hungry. Sets enemies ablaze for damage over time.',
    names: ['Ember', 'Cinder', 'Ignis', 'Pyra', 'Blaze', 'Scorch'],
  },
};

export const BODIES = {
  quad: {
    id: 'quad', name: 'Agile Quadruped',
    hp: 0.9, atk: 0.85, def: 0.9, spd: 1.35, walk: 4.2, run: 10.5,
    blurb: 'Fast and evasive. Dodges often, hits lighter.',
  },
  biped: {
    id: 'biped', name: 'Mighty Biped',
    hp: 1.25, atk: 1.3, def: 1.15, spd: 0.8, walk: 3.4, run: 8.2,
    blurb: 'Slow and powerful. Huge health and crushing attacks.',
  },
};

export const FOOD = {
  safeLoad: 2,          // feeding below this load is always safe
  riskStep: 0.22,       // chance added per unit of load above safe
  maxRisk: 0.92,
  decaySeconds: 14,     // seconds for one unit of load to fade
  healFrac: 0.25,       // broccoli heal fraction
};

export const COMBAT = {
  maxEnergy: 100,
  breathCost: 30,
  ultimateCost: 60,
  energyPerTurn: 12,
};

export const xpToNext = (level) => 25 + 5 * level;
export const candyXp = (level) => Math.round(20 + 2.5 * level);
export const dragonScale = (level) => 0.55 + 2.25 * (1 - Math.exp(-level / 45));

export function computeStats(d) {
  const b = BODIES[d.body];
  const h = d.handicap ?? 1;
  return {
    maxHp: Math.round(((40 + d.level * 8) * b.hp + d.vigor * 5) * h),
    atk: ((10 + d.level * 3.0) * b.atk + d.vigor * 0.8) * h,
    def: (3 + d.level * 0.5) * b.def,
    spd: (10 + d.level * 0.6) * b.spd + d.agility * 0.5,
  };
}

export const riskChance = (load) =>
  load <= FOOD.safeLoad ? 0 : Math.min(FOOD.maxRisk, (load - FOOD.safeLoad) * FOOD.riskStep);

export function typeMultiplier(attackerElement, defenderElement) {
  if (ELEMENTS[attackerElement].beats === defenderElement) return 1.5;
  if (ELEMENTS[defenderElement].beats === attackerElement) return 0.67;
  return 1;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
