import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/economy.ts';
import { Big } from '../src/big.ts';

const fresh = () => E.newState(42, 0);

test('a new colony and what its upgrades do to the simulation', () => {
  const s = fresh();
  assert.ok(s.nutrients.eq(20));
  const p0 = E.params(s);
  assert.deepEqual(p0, { speed: 0.9, branch: 0.04, maxTips: 3, digest: 0.12, sense: 0, transport: 90, reach: 0, fusion: 0.15, rootBonus: 1 });
  s.levels.growth = 3; s.levels.branching = 2; s.levels.chemotropism = 1; s.levels.exoenzymes = 2; s.levels.anastomosis = 99;
  const p = E.params(s);
  assert.ok(p.speed > p0.speed && p.maxTips === 7 && p.sense > 0 && p.reach === 2 && p.fusion === 1);
  for (const id of E.UPGRADE_IDS) { const u: E.UpgradeDef = E.UPGRADES[id]; assert.equal(typeof u.effect(0), 'string'); assert.ok(u.growth > 1); }
});

test('buying spends the right currency, respects max levels, and buys in bulk', () => {
  const s = fresh();
  s.nutrients = Big.of(1e6); s.sugar = Big.of(50);
  assert.equal(E.buy(s, 'growth', 1), 1);
  assert.ok(Math.abs(s.nutrients.toNumber() - (1e6 - 20)) < 1e-6);
  assert.equal(E.buy(s, 'exoenzymes', 1), 0, 'too little sugar');
  s.sugar = Big.of(1e9);
  assert.equal(E.buy(s, 'exoenzymes', 'max'), 2, 'capped at its max');
  assert.equal(E.buy(s, 'exoenzymes', 1), 0);
  const before = s.nutrients, l = s.levels.enzymes, n = E.buy(s, 'enzymes', 'max');
  assert.ok(n > 5);
  assert.ok(Math.abs(before.sub(s.nutrients).toNumber() - E.upgradeCost('enzymes', l, n).toNumber()) < 1e-6 * before.toNumber());
  assert.ok(s.nutrients.lt(E.upgradeCost('enzymes', s.levels.enzymes)), 'max leaves too little for one more');
  const expect10 = E.canBuyCount(s, 'branching', 10);
  assert.equal(E.buy(s, 'branching', 10), expect10);
  assert.ok(expect10 === 0 || expect10 === 10, 'bulk buys all or nothing');
});

test('income: raw yields become currencies with multipliers', () => {
  const s = fresh();
  E.gain(s, 10, 2);
  assert.ok(s.nutrients.eq(20 + 10 * E.NUTRIENT_VALUE));
  assert.ok(s.sugar.eq(2 * E.SUGAR_VALUE));
  assert.ok(s.runNutrients.eq(10 * E.NUTRIENT_VALUE));
  s.lifetimeSpores = 10; s.strains.appetite = 1; s.levels.saprotrophy = 1;
  assert.ok(Math.abs(E.nutrientMult(s) - E.NUTRIENT_VALUE * 1.3 * 1.5 * 1.5) < 1e-9);
});

test('fruiting: spores, a new forest, and what carries over', () => {
  const s = fresh();
  assert.equal(E.sporesFor(s), 0);
  assert.equal(E.fruit(s, 7, 1000), 0, 'not before the threshold');
  s.runNutrients = E.FRUIT_AT;
  assert.equal(E.sporesFor(s), 1);
  s.runNutrients = E.FRUIT_AT.mul(10);
  const got = E.sporesFor(s);
  assert.equal(got, Math.floor(10 ** 0.6));
  s.levels.growth = 9; s.sugar = Big.of(500); s.strains.vigor = 1; s.strains.memory = 2;
  assert.equal(E.fruit(s, 7, 1000), got);
  assert.equal(s.spores, got); assert.equal(s.lifetimeSpores, got);
  assert.equal(s.forest, 1); assert.equal(s.seed, 7);
  assert.equal(s.levels.growth, 2, 'vigor gives free levels'); assert.equal(s.levels.branching, 2); assert.equal(s.levels.enzymes, 0);
  assert.ok(s.sugar.isZero()); assert.ok(s.runNutrients.isZero());
  assert.ok(s.nutrients.eq(20 + 100 * 100), 'spore memory');
  assert.equal(E.biomeOf(s).name, 'Pine Barrens');
});

test('strains cost spores and stop at their max', () => {
  const s = fresh();
  s.spores = 100;
  assert.ok(E.buyStrain(s, 'appetite'));
  assert.equal(s.spores, 98);
  assert.equal(E.strainCost('appetite', 1), 5);
  let n = 0;
  while (E.buyStrain(s, 'dormancy')) n++;
  assert.equal(n, 4);
  assert.equal(E.offlineRate(4), 1);
  s.spores = 0;
  assert.equal(E.buyStrain(s, 'sweet'), false);
});

test('time away is capped and scaled by dormancy; worms always give something', () => {
  const r = E.offlineGains(Big.of(10), Big.of(1), 3600, 0);
  assert.ok(r.n.eq(10 * 3600 * 0.4));
  const capped = E.offlineGains(Big.of(10), Big.ZERO, 1e9, 4);
  assert.equal(capped.seconds, E.OFFLINE_CAP_S);
  assert.ok(capped.n.eq(10 * E.OFFLINE_CAP_S));
  assert.ok(E.offlineGains(Big.of(10), Big.ZERO, -5, 0).n.isZero());
  const s = fresh();
  assert.ok(E.wormReward(s, Big.ZERO).gt(0));
  assert.ok(E.wormReward(s, Big.of(1000)).eq(30000));
});

test('saves round-trip, and old or broken ones are handled', () => {
  const s = fresh();
  s.nutrients = Big.parse('1.5e400'); s.levels.rhizomorphs = 4; s.strains.sweet = 2; s.spores = 3; s.forest = 5;
  const back = E.fromJSON(E.toJSON(s));
  assert.ok(back.nutrients.eq(s.nutrients));
  assert.deepEqual(back.levels, s.levels); assert.deepEqual(back.strains, s.strains);
  assert.equal(back.forest, 5); assert.equal(back.spores, 3);
  assert.throws(() => E.fromJSON('{"v":9}'));
  const partial = E.fromJSON(JSON.stringify({ v: 1, seed: 1, levels: { growth: 2.7, bogus: 4 } }));
  assert.equal(partial.levels.growth, 2); assert.equal(partial.levels.enzymes, 0);
});
