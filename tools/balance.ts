// Balance check: a greedy player (always buys the cheapest upgrade it can afford) plays one forest
// in fast-forward against the real simulation. Prints how the run unfolds and when it can fruit.
// Usage: npm run balance [-- seed minutes]
import { readFileSync } from 'node:fs';
import { SimModule } from '../src/sim.ts';
import * as E from '../src/economy.ts';
import { Big } from '../src/big.ts';

export async function loadModule(): Promise<SimModule> {
  const path = new URL('../sim/target/wasm32-unknown-unknown/release/mycelium_sim.wasm', import.meta.url);
  return SimModule.load(readFileSync(path));
}

export interface RunReport { fruitAt: number | null; timeline: string[]; state: E.State; nodes: number; eaten: number }

export async function greedyRun(mod: SimModule, seed: number, minutes: number, setup?: (s: E.State) => void): Promise<RunReport> {
  const s = E.newState(seed, 0);
  setup?.(s);
  const w = mod.create(seed, s.forest % 4);
  w.setParams(E.params(s));
  const timeline: string[] = [];
  let fruitAt: number | null = null;
  const dt = 0.05, steps = (minutes * 60) / dt;
  for (let i = 1; i <= steps; i++) {
    w.step(dt);
    E.gain(s, w.takeYield(), w.takeSugar());
    if (i % 20 === 0) {
      // buy the cheapest affordable upgrade, repeatedly
      for (;;) {
        let best: E.UpgradeId | null = null, bestCost: Big | null = null;
        for (const id of E.UPGRADE_IDS) {
          if (!E.canBuyCount(s, id, 1)) continue;
          const c = E.upgradeCost(id, s.levels[id]);
          // compare across currencies roughly: sugar is worth ~20 nutrients
          const norm = E.UPGRADES[id].currency === 'sugar' ? c.mul(20) : c;
          if (!bestCost || norm.lt(bestCost)) { best = id; bestCost = norm; }
        }
        if (!best) break;
        E.buy(s, best, 1);
        w.setParams(E.params(s));
      }
    }
    const t = i * dt;
    if (fruitAt == null && E.sporesFor(s) > 0) fruitAt = t;
    if (i % ((60 / dt) * 5) === 0) {
      const lv = E.UPGRADE_IDS.map((k) => `${k.slice(0, 4)}${s.levels[k]}`).join(' ');
      timeline.push(`${String(t / 60).padStart(3)} min  run ${s.runNutrients.format().padStart(7)}  nodes ${String(w.nodeCount).padStart(6)}  eaten ${(100 * w.digested / w.initialFood).toFixed(1).padStart(5)}%  sugar ${s.sugar.format().padStart(6)}  ${lv}`);
    }
  }
  const report = { fruitAt, timeline, state: s, nodes: w.nodeCount, eaten: w.digested / w.initialFood };
  w.free();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 1), minutes = Number(process.argv[3] ?? 60);
  const mod = await loadModule();
  const t0 = performance.now();
  const r = await greedyRun(mod, seed, minutes);
  console.log(r.timeline.join('\n'));
  console.log(`first fruiting possible after ${r.fruitAt == null ? 'never' : `${(r.fruitAt / 60).toFixed(1)} min`}; spores now ${E.sporesFor(r.state)}; simulated ${minutes} min in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
