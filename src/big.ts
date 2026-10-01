// Big numbers for an idle game: value = m × 10^e with 1 ≤ |m| < 10 (or m = 0).
// Doubles stop at about 1e308; this keeps going as long as the exponent fits in a double.
// Immutable: every operation returns a new Big.

const LOG10 = Math.log10;
// Below this exponent gap, the smaller number still shows in the sum
const PRECISION = 17;

export class Big {
  readonly m: number;
  readonly e: number;

  private constructor(m: number, e: number) {
    this.m = m;
    this.e = e;
  }

  static readonly ZERO = new Big(0, 0);
  static readonly ONE = new Big(1, 0);

  // normalise any mantissa/exponent pair
  static of(m: number, e = 0): Big {
    if (!Number.isFinite(m) || !Number.isFinite(e)) throw new RangeError(`not a finite number: ${m}e${e}`);
    if (m === 0) return Big.ZERO;
    const shift = Math.floor(LOG10(Math.abs(m)));
    let mm = m / 10 ** shift;
    let ee = e + shift;
    // floating error can leave 9.9999… or 10.0000…
    if (Math.abs(mm) >= 10) { mm /= 10; ee += 1; }
    if (Math.abs(mm) < 1) { mm *= 10; ee -= 1; }
    if (!Number.isInteger(ee)) {
      // fractional exponents (from pow/log math) move into the mantissa
      const fe = Math.floor(ee);
      return Big.of(mm * 10 ** (ee - fe), fe);
    }
    return new Big(mm, ee);
  }

  static from(v: number | Big | string): Big {
    if (v instanceof Big) return v;
    if (typeof v === 'string') return Big.parse(v);
    return Big.of(v, 0);
  }

  // "1.5e300" or a plain number
  static parse(s: string): Big {
    const t = s.trim();
    const i = t.search(/e/i);
    if (i < 0) return Big.of(Number(t));
    return Big.of(Number(t.slice(0, i)), Number(t.slice(i + 1)));
  }

  // 10^x for any real x (also huge ones)
  static pow10(x: number): Big {
    const e = Math.floor(x);
    return Big.of(10 ** (x - e), e);
  }

  get sign(): number { return Math.sign(this.m); }
  isZero(): boolean { return this.m === 0; }

  add(o: Big | number): Big {
    const b = Big.from(o);
    if (this.m === 0) return b;
    if (b.m === 0) return this;
    const [big, small] = this.e >= b.e ? [this, b] : [b, this];
    const gap = big.e - small.e;
    if (gap > PRECISION) return big;
    return Big.of(big.m + small.m / 10 ** gap, big.e);
  }
  sub(o: Big | number): Big { const b = Big.from(o); return this.add(new Big(-b.m, b.e)); }
  mul(o: Big | number): Big { const b = Big.from(o); return Big.of(this.m * b.m, this.e + b.e); }
  div(o: Big | number): Big {
    const b = Big.from(o);
    if (b.m === 0) throw new RangeError('division by zero');
    return Big.of(this.m / b.m, this.e - b.e);
  }
  // this^p for a real power (this must be positive unless p is an integer)
  pow(p: number): Big {
    if (this.m === 0) return p === 0 ? Big.ONE : Big.ZERO;
    if (this.m < 0) {
      if (!Number.isInteger(p)) throw new RangeError('fractional power of a negative number');
      const r = this.neg().pow(p);
      return p % 2 ? r.neg() : r;
    }
    return Big.pow10(this.log10() * p);
  }
  neg(): Big { return this.m === 0 ? this : new Big(-this.m, this.e); }
  abs(): Big { return this.m < 0 ? this.neg() : this; }
  log10(): number {
    if (this.m <= 0) throw new RangeError('log of a non-positive number');
    return LOG10(this.m) + this.e;
  }
  floor(): Big {
    if (this.e >= PRECISION) return this;
    if (this.e < 0) return this.m < 0 ? Big.of(-1) : Big.ZERO;
    return Big.of(Math.floor(this.toNumber()));
  }

  cmp(o: Big | number): number {
    const b = Big.from(o);
    if (this.sign !== b.sign) return this.sign > b.sign ? 1 : -1;
    if (this.m === 0) return 0;
    if (this.e !== b.e) return (this.e > b.e ? 1 : -1) * this.sign;
    return this.m === b.m ? 0 : this.m > b.m ? 1 : -1;
  }
  gte(o: Big | number): boolean { return this.cmp(o) >= 0; }
  gt(o: Big | number): boolean { return this.cmp(o) > 0; }
  lt(o: Big | number): boolean { return this.cmp(o) < 0; }
  lte(o: Big | number): boolean { return this.cmp(o) <= 0; }
  eq(o: Big | number): boolean { return this.cmp(o) === 0; }
  static max(a: Big, b: Big): Big { return a.gte(b) ? a : b; }
  static min(a: Big, b: Big): Big { return a.lte(b) ? a : b; }

  // Infinity once it no longer fits a double
  toNumber(): number { return this.m * 10 ** this.e; }
  toJSON(): string { return this.m === 0 ? '0' : `${this.m}e${this.e}`; }
  toString(): string { return this.toJSON(); }

  // 1,234 · 12.3K · 4.56M … 7.89Dc, then 1.23e45
  format(digits = 3): string {
    if (this.m === 0) return '0';
    if (this.m < 0) return `-${this.neg().format(digits)}`;
    if (this.e < 3) {
      const n = this.toNumber();
      return n < 10 && !Number.isInteger(n) ? n.toFixed(1).replace(/\.0$/, '') : Math.floor(n).toLocaleString('en-US');
    }
    const tier = Math.floor(this.e / 3);
    if (tier < SUFFIX.length) {
      const scaled = this.m * 10 ** (this.e - tier * 3);
      return `${trim(scaled, digits)}${SUFFIX[tier]}`;
    }
    return `${trim(this.m, digits)}e${this.e}`;
  }
}

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
// at most `digits` significant digits, never rounding up past the next unit (999.99K stays 999K)
function trim(v: number, digits: number): string {
  const whole = Math.floor(v).toString().length;
  const dec = Math.max(0, digits - whole);
  const f = 10 ** dec;
  return (Math.floor(v * f) / f).toFixed(dec).replace(/\.?0+$/, '');
}

// Sum of a geometric cost series: base·r^k for k = level … level+n-1
export function seriesCost(base: Big, r: number, level: number, n: number): Big {
  const first = base.mul(Big.of(r).pow(level));
  if (n <= 0) return Big.ZERO;
  if (r === 1) return first.mul(n);
  return first.mul(Big.of(r).pow(n).sub(1)).div(r - 1);
}

// How many levels `money` buys, starting at `level` (the largest n with seriesCost ≤ money)
export function affordable(base: Big, r: number, level: number, money: Big): number {
  const first = base.mul(Big.of(r).pow(level));
  if (money.lt(first)) return 0;
  // money ≥ first·(r^n − 1)/(r − 1)  ⇔  n ≤ log_r(money·(r − 1)/first + 1)
  let n = Math.floor(Math.log10(money.mul(r - 1).div(first).add(1).toNumber() || Infinity) / Math.log10(r));
  if (!Number.isFinite(n)) n = Math.floor((money.mul(r - 1).div(first).add(1).log10()) / Math.log10(r));
  // correct floating error at the boundary
  while (n > 0 && seriesCost(base, r, level, n).gt(money)) n--;
  while (seriesCost(base, r, level, n + 1).lte(money)) n++;
  return n;
}
