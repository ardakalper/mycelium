// The idle-game layer: currencies, upgrades and their costs, what they do to the simulation,
// fruiting (the prestige reset), spore strains, and offline gains. Pure functions over a State.
import { Big, seriesCost, affordable } from './big.ts';
import type { Params } from './sim.ts';

export type Currency = 'nutrients' | 'sugar';

export interface UpgradeDef {
  name: string;
  text: string;
  currency: Currency;
  base: number;
  growth: number;
  max?: number;
  effect: (level: number) => string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (x: number, d = 1) => x.toFixed(d).replace(/\.0+$/, '');

// Formulas the upgrades feed into the simulation
export const F = {
  speed: (l: number) => 0.9 * 1.16 ** l,
  branch: (l: number) => Math.min(0.22, 0.04 + 0.012 * l),
  maxTips: (l: number) => 3 + 2 * l,
  digest: (l: number) => 0.12 * 1.28 ** l,
  sense: (l: number) => (l === 0 ? 0 : 2 + 1.4 * l),
  transport: (l: number) => 90 * 1.2 ** l,
  fusion: (l: number) => Math.min(1, 0.15 + 0.1 * l),
  rootBonus: (l: number) => 1.6 ** l,
  saprotrophy: (l: number) => 1.3 ** l,
};

export const UPGRADES = {
  growth: { name: 'Hyphal growth', text: 'Tips push through the soil faster.', currency: 'nutrients', base: 20, growth: 1.85, effect: (l) => `${fixed(F.speed(l), 2)} mm/s` },
  branching: { name: 'Branching', text: 'More tips at once, and they fork more often.', currency: 'nutrients', base: 50, growth: 2.0, effect: (l) => `${F.maxTips(l)} tips, ${pct(F.branch(l))} fork` },
  enzymes: { name: 'Enzymes', text: 'Colonised soil is digested faster.', currency: 'nutrients', base: 80, growth: 1.9, effect: (l) => `×${fixed(F.digest(l) / F.digest(0), 2)} digestion` },
  chemotropism: { name: 'Chemotropism', text: 'Tips smell food ahead and turn towards it.', currency: 'nutrients', base: 300, growth: 2.6, max: 10, effect: (l) => (l ? `smell ${fixed(F.sense(l))} mm` : 'growing blind') },
  rhizomorphs: { name: 'Rhizomorphs', text: 'Thick cords carry food home with less loss.', currency: 'nutrients', base: 600, growth: 2.1, effect: (l) => `half-way loss at ${Math.round(F.transport(l) * Math.LN2)} mm` },
  anastomosis: { name: 'Anastomosis', text: 'Hyphae that touch fuse, opening shortcuts home.', currency: 'nutrients', base: 400, growth: 2.3, max: 9, effect: (l) => `${pct(F.fusion(l))} fuse` },
  exoenzymes: { name: 'Exoenzymes', text: 'Enzymes seep out and digest the soil around each hypha.', currency: 'sugar', base: 400, growth: 25, max: 2, effect: (l) => (l ? `${l} mm around` : 'touch only') },
  symbiosis: { name: 'Mycorrhizal trade', text: 'Trees pay more sugar for what your network brings their roots.', currency: 'sugar', base: 15, growth: 2.2, effect: (l) => `×${fixed(F.rootBonus(l), 2)} sugar` },
  saprotrophy: { name: 'Saprotrophy', text: 'Wring more value out of every crumb of rot.', currency: 'sugar', base: 60, growth: 2.0, effect: (l) => `×${fixed(F.saprotrophy(l), 2)} nutrients` },
} satisfies Record<string, UpgradeDef>;
export type UpgradeId = keyof typeof UPGRADES;
export const UPGRADE_IDS = Object.keys(UPGRADES) as UpgradeId[];

export interface StrainDef { name: string; text: string; base: number; growth: number; max?: number; effect: (level: number) => string }
export const STRAINS = {
  vigor: { name: 'Vigorous', text: 'Each new forest starts with free levels of growth and branching.', base: 1, growth: 2, max: 5, effect: (l) => `+${2 * l} levels each` },
  appetite: { name: 'Hungry', text: 'Every nutrient is worth more.', base: 2, growth: 2.2, effect: (l) => `×${fixed(1.5 ** l, 2)} nutrients` },
  sweet: { name: 'Sweet-toothed', text: 'Trees trade more sugar with you.', base: 3, growth: 2.5, effect: (l) => `×${2 ** l} sugar` },
  dormancy: { name: 'Dormant', text: 'Keep more of what grows while you are away.', base: 2, growth: 2, max: 4, effect: (l) => `${pct(offlineRate(l))} offline` },
  memory: { name: 'Spore memory', text: 'Each new forest starts with a store of nutrients.', base: 1, growth: 3, max: 6, effect: (l) => `start with ${Big.of(100).mul(Big.pow10(l)).format()}` },
  abundance: { name: 'Abundant', text: 'Fruiting releases more spores.', base: 5, growth: 3, effect: (l) => `×${fixed(1 + 0.25 * l, 2)} spores` },
} satisfies Record<string, StrainDef>;
export type StrainId = keyof typeof STRAINS;
export const STRAIN_IDS = Object.keys(STRAINS) as StrainId[];

export const BIOMES = [
  { name: 'Beech Wood', tree: 'beech' },
  { name: 'Pine Barrens', tree: 'pine' },
  { name: 'Cloud Forest', tree: 'oak' },
  { name: 'Birch Taiga', tree: 'birch' },
] as const;

// what a raw unit of digested soil and of tree sugar is worth before multipliers
export const NUTRIENT_VALUE = 8;
export const SUGAR_VALUE = 5;
// nutrients gathered in one forest before it can fruit
export const FRUIT_AT = Big.of(1.5e4);
export const OFFLINE_CAP_S = 12 * 3600;

export interface State {
  v: 1;
  nutrients: Big;
  sugar: Big;
  spores: number;
  lifetimeSpores: number;
  runNutrients: Big;
  lifetimeNutrients: Big;
  levels: Record<UpgradeId, number>;
  strains: Record<StrainId, number>;
  forest: number;
  seed: number;
  started: number;
  runStarted: number;
  lastSeen: number;
  worms: number;
}

const zeroLevels = () => Object.fromEntries(UPGRADE_IDS.map((k) => [k, 0])) as Record<UpgradeId, number>;
export const startingNutrients = (memory: number) => (memory ? Big.of(100).mul(Big.pow10(memory)) : Big.ZERO);

export function newState(seed: number, now: number): State {
  return {
    v: 1, nutrients: Big.of(20), sugar: Big.ZERO, spores: 0, lifetimeSpores: 0,
    runNutrients: Big.ZERO, lifetimeNutrients: Big.ZERO, levels: zeroLevels(),
    strains: Object.fromEntries(STRAIN_IDS.map((k) => [k, 0])) as Record<StrainId, number>,
    forest: 0, seed, started: now, runStarted: now, lastSeen: now, worms: 0,
  };
}

export const biomeOf = (s: State) => BIOMES[s.forest % BIOMES.length];

// ---------- simulation parameters ----------
export function params(s: State): Params {
  const l = s.levels;
  return {
    speed: F.speed(l.growth), branch: F.branch(l.branching), maxTips: F.maxTips(l.branching), digest: F.digest(l.enzymes),
    sense: F.sense(l.chemotropism), transport: F.transport(l.rhizomorphs), reach: l.exoenzymes, fusion: F.fusion(l.anastomosis),
    rootBonus: F.rootBonus(l.symbiosis),
  };
}

// ---------- income ----------
export const sporeBonus = (s: State) => 1 + 0.05 * s.lifetimeSpores;
export const nutrientMult = (s: State) => NUTRIENT_VALUE * F.saprotrophy(s.levels.saprotrophy) * sporeBonus(s) * 1.5 ** s.strains.appetite;
export const sugarMult = (s: State) => SUGAR_VALUE * sporeBonus(s) * 2 ** s.strains.sweet;

// raw yields from the simulation → currencies
export function gain(s: State, rawNutrients: number, rawSugar: number): { n: Big; c: Big } {
  const n = Big.of(rawNutrients * nutrientMult(s)), c = Big.of(rawSugar * sugarMult(s));
  s.nutrients = s.nutrients.add(n);
  s.runNutrients = s.runNutrients.add(n);
  s.lifetimeNutrients = s.lifetimeNutrients.add(n);
  s.sugar = s.sugar.add(c);
  return { n, c };
}

// ---------- buying ----------
export function upgradeCost(id: UpgradeId, level: number, n = 1): Big {
  const u: UpgradeDef = UPGRADES[id];
  return seriesCost(Big.of(u.base), u.growth, level, n);
}
export function canBuyCount(s: State, id: UpgradeId, want: number | 'max'): number {
  const u: UpgradeDef = UPGRADES[id], l = s.levels[id];
  const room = u.max != null ? u.max - l : Infinity;
  if (room <= 0) return 0;
  const most = Math.min(room, affordable(Big.of(u.base), u.growth, l, s[u.currency]));
  return want === 'max' ? most : most >= want ? Math.min(want, room) : 0;
}
export function buy(s: State, id: UpgradeId, want: number | 'max' = 1): number {
  const n = canBuyCount(s, id, want);
  if (!n) return 0;
  const u: UpgradeDef = UPGRADES[id];
  s[u.currency] = s[u.currency].sub(upgradeCost(id, s.levels[id], n));
  if (s[u.currency].sign < 0) s[u.currency] = Big.ZERO; // rounding at the boundary
  s.levels[id] += n;
  return n;
}

export function strainCost(id: StrainId, level: number): number {
  const d: StrainDef = STRAINS[id];
  return Math.ceil(d.base * d.growth ** level);
}
export function buyStrain(s: State, id: StrainId): boolean {
  const d: StrainDef = STRAINS[id], l = s.strains[id], cost = strainCost(id, l);
  if ((d.max != null && l >= d.max) || s.spores < cost) return false;
  s.spores -= cost;
  s.strains[id] = l + 1;
  return true;
}

// ---------- fruiting ----------
export function sporesFor(s: State): number {
  if (s.runNutrients.lt(FRUIT_AT)) return 0;
  return Math.floor(s.runNutrients.div(FRUIT_AT).pow(0.6).toNumber() * (1 + 0.25 * s.strains.abundance));
}
export const fruitProgress = (s: State) => Math.min(1, s.runNutrients.div(FRUIT_AT).toNumber());

// The colony fruits: mushrooms push up, spores drift to a new forest, and the run starts over.
export function fruit(s: State, nextSeed: number, now: number): number {
  const got = sporesFor(s);
  if (!got) return 0;
  s.spores += got;
  s.lifetimeSpores += got;
  s.forest += 1;
  s.seed = nextSeed;
  s.levels = zeroLevels();
  s.levels.growth = s.levels.branching = 2 * s.strains.vigor;
  s.nutrients = Big.of(20).add(startingNutrients(s.strains.memory));
  s.sugar = Big.ZERO;
  s.runNutrients = Big.ZERO;
  s.runStarted = now;
  return got;
}

// ---------- time away ----------
export const offlineRate = (dormancy: number) => Math.min(1, 0.4 + 0.15 * dormancy);
export function offlineGains(rateN: Big, rateC: Big, seconds: number, dormancy: number): { n: Big; c: Big; seconds: number } {
  const t = Math.max(0, Math.min(seconds, OFFLINE_CAP_S)), k = offlineRate(dormancy) * t;
  return { n: rateN.mul(k), c: rateC.mul(k), seconds: t };
}

// an earthworm turns the soil: half a minute of income, never less than a small handful
export function wormReward(s: State, rateN: Big): Big {
  return Big.max(rateN.mul(30), Big.of(50 * nutrientMult(s) / NUTRIENT_VALUE));
}

// ---------- saving ----------
export function toJSON(s: State): string { return JSON.stringify(s); }
export function fromJSON(text: string): State {
  const o = JSON.parse(text);
  if (o.v !== 1) throw new Error('unknown save version');
  const big = (v: unknown) => Big.parse(String(v ?? '0'));
  const s = newState(o.seed >>> 0, o.started ?? Date.now());
  Object.assign(s, {
    nutrients: big(o.nutrients), sugar: big(o.sugar), spores: Number(o.spores) || 0, lifetimeSpores: Number(o.lifetimeSpores) || 0,
    runNutrients: big(o.runNutrients), lifetimeNutrients: big(o.lifetimeNutrients), forest: Number(o.forest) || 0,
    runStarted: o.runStarted ?? s.started, lastSeen: o.lastSeen ?? s.started, worms: o.worms ?? 0,
  });
  for (const k of UPGRADE_IDS) s.levels[k] = Math.max(0, Math.floor(o.levels?.[k] ?? 0));
  for (const k of STRAIN_IDS) s.strains[k] = Math.max(0, Math.floor(o.strains?.[k] ?? 0));
  return s;
}
