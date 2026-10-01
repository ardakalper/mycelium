import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Big, seriesCost, affordable } from '../src/big.ts';

const close = (a: number, b: number, rel = 1e-9) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-12, `${a} ≈ ${b}`);

test('normalises any mantissa and exponent', () => {
  for (const [m, e, wm, we] of [[1234, 0, 1.234, 3], [0.005, 2, 5, -1], [-42, 10, -4.2, 11], [10, 0, 1, 1], [9.999999999999998, 0, 9.999999999999998, 0]] as const) {
    const b = Big.of(m, e);
    close(b.m, wm); assert.equal(b.e, we);
  }
  assert.ok(Big.of(0, 99).isZero());
  assert.throws(() => Big.of(Infinity));
  assert.throws(() => Big.of(NaN));
});

test('arithmetic matches doubles where doubles work', () => {
  const xs = [0, 1, 2.5, -3, 1e-5, 123456.789, 9.99e15, -7.25e20];
  for (const a of xs) for (const b of xs) {
    close(Big.of(a).add(b).toNumber(), a + b, 1e-12);
    close(Big.of(a).sub(b).toNumber(), a - b, 1e-12);
    close(Big.of(a).mul(b).toNumber(), a * b, 1e-12);
    if (b !== 0) close(Big.of(a).div(b).toNumber(), a / b, 1e-12);
    assert.equal(Big.of(a).cmp(b), Math.sign(a - b), `${a} vs ${b}`);
  }
  close(Big.of(2).pow(10).toNumber(), 1024);
  close(Big.of(-2).pow(3).toNumber(), -8);
  close(Big.of(1e6).log10(), 6);
  assert.equal(Big.of(7.9).floor().toNumber(), 7);
});

test('keeps going past the largest double', () => {
  const huge = Big.parse('1e300').mul(Big.parse('1e300'));
  assert.equal(huge.e, 600);
  assert.equal(huge.toNumber(), Infinity);
  assert.ok(huge.gt(Big.parse('9.99e599')));
  assert.equal(Big.parse('3e5000').div(Big.parse('1.5e4999')).toNumber(), 20);
  assert.equal(Big.pow10(1234.5).e, 1234);
  close(Big.pow10(1234.5).m, Math.sqrt(10));
  // adding something 17+ orders smaller changes nothing
  assert.ok(Big.parse('1e40').add(1).eq(Big.parse('1e40')));
});

test('formats for the screen and round-trips through JSON', () => {
  const f = (v: string | number) => Big.from(v).format();
  assert.equal(f(0), '0');
  assert.equal(f(7.25), '7.3');
  assert.equal(f(999), '999');
  assert.equal(f(1234), '1.23K');
  assert.equal(f(999999), '999K');
  assert.equal(f(15000000), '15M');
  assert.equal(f('4.567e33'), '4.56Dc');
  assert.equal(f('4.567e36'), '4.56e36');
  assert.equal(f(-2500), '-2.5K');
  for (const v of ['0', '1.5e3', '-2.25e-7', '8.125e123456']) assert.ok(Big.parse(Big.parse(v).toJSON()).eq(Big.parse(v)));
});

test('geometric costs: series sums and how many levels money buys', () => {
  const base = Big.of(15), r = 1.55;
  close(seriesCost(base, r, 0, 3).toNumber(), 15 + 15 * 1.55 + 15 * 1.55 ** 2);
  close(seriesCost(base, 1, 4, 5).toNumber(), 75);
  for (const money of [0, 14, 15, 38, 39, 100, 1e4, 1e9]) for (const level of [0, 3, 20]) {
    const n = affordable(base, r, level, Big.of(money));
    // brute force
    let k = 0, spent = 0;
    for (;;) { const c = 15 * r ** (level + k); if (spent + c > money * (1 + 1e-12)) break; spent += c; k++; }
    assert.equal(n, k, `money ${money}, level ${level}`);
  }
  assert.ok(affordable(base, r, 0, Big.parse('1e400')) > 2000);
});
