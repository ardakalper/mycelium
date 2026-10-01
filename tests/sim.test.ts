import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule, greedyRun } from '../tools/balance.ts';
import * as E from '../src/economy.ts';

const mod = await loadModule();

test('the wasm module builds a world and grows it', () => {
  const w = mod.create(99, 1);
  assert.equal(w.gw, 320); assert.equal(w.gh, 200);
  assert.equal(w.seed, 99); assert.equal(w.biome, 1);
  assert.equal(w.nodeCount, 1);
  assert.ok(Math.abs(w.initialFood - 6000) < 60, `food ${w.initialFood}`);
  w.setParams(E.params(E.newState(99, 0)));
  for (let i = 0; i < 1200; i++) w.step(0.05);
  assert.ok(w.nodeCount > 100);
  const { x, y, parent } = w.nodes();
  for (let i = 1; i < w.nodeCount; i++) { assert.ok(parent[i] < i); assert.ok(x[i] >= 0 && x[i] < 320 && y[i] >= 0 && y[i] < 200); }
  assert.ok(w.takeYield() > 0);
  assert.equal(w.takeYield(), 0, 'taking empties the counter');
  assert.ok(w.digested > 0 && w.remainingFood < w.initialFood);
  assert.ok(w.trees().length >= 3 && w.objects().length > 0 && w.roots().length > 0);
  assert.equal(w.nutrients().length, 320 * 200);
  w.free();
  assert.equal(w.alive, false);
});

test('typed-array views survive memory growth', () => {
  const w = mod.create(5, 0);
  w.setParams({ speed: 4, maxTips: 60, branch: 0.2, digest: 1 });
  const first = w.nodes().x[0];
  const others = Array.from({ length: 6 }, (_, i) => mod.create(100 + i, i)); // grow wasm memory
  for (let i = 0; i < 2000; i++) w.step(0.05);
  assert.equal(w.nodes().x[0], first);
  assert.equal(w.thickness()[0], w.nodeCount, 'everything drains through the origin');
  const segs = w.takeSegments();
  assert.equal(segs.length % 4, 0);
  assert.equal(w.takeSegments().length, 0);
  others.forEach((o) => o.free()); w.free();
});

test('a saved world restores and continues identically', () => {
  const a = mod.create(17, 2);
  a.setParams({ speed: 3, maxTips: 30, branch: 0.12, sense: 5, fusion: 0.8, digest: 0.4 });
  for (let i = 0; i < 1500; i++) a.step(0.05);
  const bytes = a.save();
  const b = mod.restore(bytes)!;
  assert.ok(b);
  for (let i = 0; i < 600; i++) { a.step(0.05); b.step(0.05); }
  assert.equal(b.nodeCount, a.nodeCount);
  assert.deepEqual(Array.from(b.nodes().x), Array.from(a.nodes().x));
  assert.equal(mod.restore(bytes.slice(0, 100)), null);
  assert.equal(mod.restore(new Uint8Array([1, 2, 3])), null);
  a.free(); b.free();
});

test('a greedy player can fruit within 40 minutes', async () => {
  const r = await greedyRun(mod, 3, 40);
  assert.ok(r.fruitAt != null, 'reached the fruiting threshold');
  assert.ok(r.fruitAt! > 5 * 60, `not too fast: ${r.fruitAt}`);
  assert.ok(r.nodes < 80000, `the network stays a sensible size: ${r.nodes}`);
});
