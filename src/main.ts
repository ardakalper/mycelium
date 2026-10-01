// The page: loads the simulation, runs the game loop, saves, handles time away, lures, earthworms,
// the upgrade cards, strains, fruiting and the settings.
import { SimModule, type World } from './sim.ts';
import { Renderer } from './render.ts';
import { Ambience } from './audio.ts';
import { Big } from './big.ts';
import * as E from './economy.ts';

const $ = <T extends HTMLElement = HTMLElement>(q: string) => document.querySelector(q) as T;
const params = new URLSearchParams(location.search);
const SAVE_KEY = 'mycelium:save';
const SETTINGS_KEY = 'mycelium:settings';
const TICK = 0.05;
const SPEED = Math.max(1, Number(params.get('speed')) || 1); // fast-forward, for testing
const LURE_S = 20, LURE_COOLDOWN_S = 12;

interface Saved { state: unknown; world: string; rateN: string; rateC: string }

let mod: SimModule;
let world: World;
let state: E.State;
let rateN = Big.ZERO, rateC = Big.ZERO; // smoothed income per second
let buyAmount: number | 'max' = 1;
let lureReadyAt = 0;
let wormAt = 0;
let fruiting = false;
const settings = { sound: true, ...readJSON(SETTINGS_KEY) };
const renderer = new Renderer($<HTMLCanvasElement>('#world'));
const audio = new Ambience();
audio.on = settings.sound;

function readJSON(key: string): Record<string, unknown> { try { return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { return {}; } }
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

// ---------- bytes ↔ text (deflate + base64) ----------
async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
}
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const pack = async (u: Uint8Array) => b64(await pipe(u, new CompressionStream('deflate-raw')));
const unpack = async (s: string) => pipe(unb64(s), new DecompressionStream('deflate-raw'));

// ---------- saving ----------
async function exportSave(): Promise<string> {
  const data: Saved = { state: JSON.parse(E.toJSON(state)), world: await pack(world.save()), rateN: rateN.toJSON(), rateC: rateC.toJSON() };
  return JSON.stringify(data);
}
async function save(): Promise<void> {
  if (!state || fruiting) return;
  state.lastSeen = Date.now();
  try { localStorage.setItem(SAVE_KEY, await exportSave()); } catch { toast('Saving failed: the browser storage is full or blocked.'); }
}
async function restore(text: string): Promise<{ s: E.State; w: World; rn: Big; rc: Big } | null> {
  try {
    const o = JSON.parse(text) as Saved;
    const s = E.fromJSON(JSON.stringify(o.state));
    const w = mod.restore(await unpack(o.world));
    if (!w) return null;
    return { s, w, rn: Big.parse(o.rateN ?? '0'), rc: Big.parse(o.rateC ?? '0') };
  } catch { return null; }
}

// keep the world clear of the side panel on wide screens
function setInsets(): void {
  renderer.insets = innerWidth > 860 ? { left: 0, right: 384, top: 76, bottom: 64 } : { left: 0, right: 0, top: 44, bottom: 0 };
}

// ---------- a forest ----------
function startWorld(w: World): void {
  world = w;
  world.setParams(E.params(state));
  renderer.setWorld(world, E.biomeOf(state).tree);
  updateBiome();
}

// The game step: one tick of soil time, and what it earned.
function tick(): void {
  world.step(TICK);
  const g = E.gain(state, world.takeYield(), world.takeSugar());
  const k = 1 - Math.exp(-TICK / 8); // ~8 s smoothing
  rateN = rateN.mul(1 - k).add(g.n.div(TICK).mul(k));
  rateC = rateC.mul(1 - k).add(g.c.div(TICK).mul(k));
}

// ---------- time away ----------
async function catchUp(seconds: number): Promise<void> {
  const dlg = $<HTMLDialogElement>('#dlg-away');
  const before = { n: state.nutrients, c: state.sugar, nodes: world.nodeCount };
  // the first few minutes are really simulated, in big steps; the rest is estimated from the income rate
  const simulated = Math.min(seconds, 300), steps = Math.floor(simulated / 0.2);
  $('#away-time').textContent = duration(seconds);
  $('#away-body').textContent = 'The colony kept growing…';
  dlg.showModal();
  for (let i = 0; i < steps; i++) {
    world.step(0.2);
    E.gain(state, world.takeYield(), world.takeSugar());
    if (i % 100 === 99) await new Promise((r) => setTimeout(r));
  }
  world.takePulses(); world.takeLinks();
  const rest = E.offlineGains(rateN, rateC, seconds - simulated, state.strains.dormancy);
  state.nutrients = state.nutrients.add(rest.n); state.runNutrients = state.runNutrients.add(rest.n); state.lifetimeNutrients = state.lifetimeNutrients.add(rest.n);
  state.sugar = state.sugar.add(rest.c);
  renderer.redrawNetwork();
  const dn = state.nutrients.sub(before.n), dc = state.sugar.sub(before.c);
  $('#away-body').innerHTML = `+<b class="nut">${dn.format()}</b> nutrients, +<b class="sug">${dc.format()}</b> sugar, and ${world.nodeCount - before.nodes} new hyphae.` +
    (seconds > simulated ? ` <small>Beyond five minutes you keep ${Math.round(E.offlineRate(state.strains.dormancy) * 100)}% of your income.</small>` : '');
}
function duration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${Math.round(s)} s`;
}

// ---------- toasts ----------
function toast(html: string, kind = ''): void {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.innerHTML = html;
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 5000);
}

// ---------- the panel ----------
function buildCards(): void {
  $('#tab-grow').replaceChildren(...E.UPGRADE_IDS.map((id) => {
    const u: E.UpgradeDef = E.UPGRADES[id];
    const b = document.createElement('button');
    b.className = `card ${u.currency}`; b.dataset.id = id;
    b.innerHTML = `<span class="name">${u.name} <i class="lvl"></i></span><span class="text">${u.text}</span><span class="row"><span class="effect"></span><span class="cost"></span></span>`;
    b.addEventListener('click', () => {
      const n = E.buy(state, id, buyAmount);
      if (n) { world.setParams(E.params(state)); audio.buy(); refresh(); }
    });
    return b;
  }));
  $('#tab-strains').replaceChildren(
    Object.assign(document.createElement('p'), { className: 'muted', id: 'strain-intro' }),
    ...E.STRAIN_IDS.map((id) => {
      const d: E.StrainDef = E.STRAINS[id];
      const b = document.createElement('button');
      b.className = 'card spore'; b.dataset.strain = id;
      b.innerHTML = `<span class="name">${d.name} <i class="lvl"></i></span><span class="text">${d.text}</span><span class="row"><span class="effect"></span><span class="cost"></span></span>`;
      b.addEventListener('click', () => { if (E.buyStrain(state, id)) { audio.buy(); refresh(); void save(); } });
      return b;
    }),
  );
}

function refresh(): void {
  $('#r-nut').textContent = state.nutrients.format();
  $('#r-nut-rate').textContent = `${rateN.format()}/s`;
  $('#r-sug').textContent = state.sugar.format();
  $('#r-sug-rate').textContent = `${rateC.format()}/s`;
  $('#r-spo').textContent = String(state.spores);
  $('#res-spo').hidden = state.lifetimeSpores === 0;
  $('#res-sug').classList.toggle('dim', state.sugar.isZero() && rateC.isZero());
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tab-grow .card')) {
    const id = b.dataset.id as E.UpgradeId, u: E.UpgradeDef = E.UPGRADES[id], l = state.levels[id];
    const maxed = u.max != null && l >= u.max;
    const n = maxed ? 0 : buyAmount === 'max' ? Math.max(1, E.canBuyCount(state, id, 'max')) : buyAmount;
    const room = u.max != null ? Math.min(n, u.max - l) : n;
    const cost = E.upgradeCost(id, l, Math.max(1, room));
    b.querySelector('.lvl')!.textContent = l ? `${l}` : '';
    b.querySelector('.effect')!.textContent = u.effect(l) + (maxed ? '' : ` → ${u.effect(l + room)}`);
    b.querySelector('.cost')!.textContent = maxed ? 'max' : `${room > 1 ? `×${room} ` : ''}${cost.format()} ${u.currency === 'sugar' ? 'sugar' : ''}`.trim();
    b.disabled = maxed || !E.canBuyCount(state, id, buyAmount === 'max' ? 1 : buyAmount);
    b.hidden = u.currency === 'sugar' && state.sugar.isZero() && rateC.isZero() && l === 0 && state.forest === 0 && !world.trees().some((t) => t.linked);
  }
  $('#strain-intro').textContent = state.spores ? `You have ${state.spores} spore${state.spores === 1 ? '' : 's'} to spend. Strains last through every forest, and every spore you have ever made adds 5% to all income.` : 'Strains last through every forest. Fruit to earn spores.';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tab-strains .card')) {
    const id = b.dataset.strain as E.StrainId, d: E.StrainDef = E.STRAINS[id], l = state.strains[id], maxed = d.max != null && l >= d.max;
    b.querySelector('.lvl')!.textContent = l ? `${l}` : '';
    b.querySelector('.effect')!.textContent = maxed ? d.effect(l) : `${d.effect(l)} → ${d.effect(l + 1)}`;
    b.querySelector('.cost')!.textContent = maxed ? 'max' : `${E.strainCost(id, l)} spores`;
    b.disabled = maxed || state.spores < E.strainCost(id, l);
  }
  $('[data-tab="strains"]').hidden = state.lifetimeSpores === 0;
  // fruiting
  const spores = E.sporesFor(state), p = E.fruitProgress(state);
  $('#fruit-bar').style.width = `${p * 100}%`;
  $('#btn-fruit').classList.toggle('ready', spores > 0);
  $<HTMLButtonElement>('#btn-fruit').disabled = !spores || fruiting;
  $('#fruit-info').textContent = spores ? `release ${spores} spore${spores === 1 ? '' : 's'}` : `gather ${E.FRUIT_AT.sub(state.runNutrients).format()} more`;
  // colony stats
  const trees = world.trees();
  const eaten = 1 - world.remainingFood / world.initialFood;
  $('#s-length').textContent = `${(world.nodeCount * 0.9 / 100).toFixed(1)} m`;
  $('#s-tips').textContent = String(world.tips().length / 3);
  $('#s-fusions').textContent = String(world.fusions);
  $('#s-eaten').textContent = `${(eaten * 100).toFixed(1)}%`;
  $('#s-trees').textContent = `${trees.filter((t) => t.linked).length} / ${trees.length}`;
  $('#s-forest').textContent = String(state.forest + 1);
  $('#s-lifetime').textContent = state.lifetimeNutrients.format();
  $('#s-mult').textContent = `×${(E.nutrientMult(state) / E.NUTRIENT_VALUE).toFixed(2)}`;
  const lure = performance.now() < lureReadyAt ? `lure ready in ${Math.ceil((lureReadyAt - performance.now()) / 1000)} s` : 'Click the soil to lay a sugar lure';
  $('#hint').textContent = eaten > 0.6 && spores ? 'The soil is nearly spent. Fruit to start again in a richer forest.' : lure;
}

function updateBiome(): void {
  $('#biome-name').textContent = E.biomeOf(state).name;
  $('#forest-n').textContent = `Forest ${state.forest + 1}`;
}

// ---------- fruiting ----------
async function doFruit(): Promise<void> {
  const got = E.sporesFor(state);
  if (!got || fruiting) return;
  fruiting = true;
  $<HTMLDialogElement>('#dlg-fruit').close();
  audio.bloom();
  renderer.fruit(performance.now());
  await new Promise((r) => setTimeout(r, 4200 / Math.min(SPEED, 4)));
  E.fruit(state, randomSeed(), Date.now());
  world.free();
  startWorld(mod.create(state.seed, state.forest % 4));
  rateN = Big.ZERO; rateC = Big.ZERO;
  fruiting = false;
  toast(`<b>+${got} spores</b> drift on the wind to the <b>${E.biomeOf(state).name}</b>.`, 'spore');
  if (state.forest === 1) { toast('Spend spores on <b>strains</b>: they last through every forest.', 'spore'); showTab('strains'); }
  await save();
  refresh();
}

function showTab(tab: string): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const s of document.querySelectorAll<HTMLElement>('.tab')) s.hidden = s.id !== `tab-${tab}`;
  $('.buy-amount').hidden = tab !== 'grow';
}

// ---------- input ----------
function wire(): void {
  const canvas = renderer.canvas;
  canvas.addEventListener('pointerdown', (e) => {
    audio.start();
    const r = canvas.getBoundingClientRect(), p = renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
    // the earthworm first
    const wm = renderer.worm;
    if (wm && Math.hypot(p.x - wm.x, p.y - wm.y) < 5) {
      const reward = E.wormReward(state, rateN);
      state.nutrients = state.nutrients.add(reward); state.runNutrients = state.runNutrients.add(reward); state.lifetimeNutrients = state.lifetimeNutrients.add(reward);
      state.worms += 1;
      renderer.burst(wm.x, wm.y, '#f0b3c6', 24, 8);
      renderer.worm = null;
      audio.pluck();
      toast(`An earthworm turns the soil: <b class="nut">+${reward.format()}</b> nutrients.`);
      refresh();
      return;
    }
    if (p.x < 0 || p.y < 1 || p.x >= world.gw || p.y >= world.gh) return;
    const now = performance.now();
    if (now < lureReadyAt) return;
    world.setLure(p);
    renderer.lure = { x: p.x, y: p.y, t0: now, until: now + (LURE_S * 1000) / SPEED };
    lureReadyAt = now + ((LURE_S + LURE_COOLDOWN_S) * 1000) / SPEED;
    setTimeout(() => world.setLure(null), (LURE_S * 1000) / SPEED);
    renderer.burst(p.x, p.y, '#c9b6ff', 10, 4);
  });
  for (const b of document.querySelectorAll<HTMLElement>('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab!));
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-amount]')) b.addEventListener('click', () => {
    buyAmount = b.dataset.amount === 'max' ? 'max' : Number(b.dataset.amount);
    for (const o of document.querySelectorAll('[data-amount]')) o.classList.toggle('on', o === b);
    refresh();
  });
  $('#btn-fruit').addEventListener('click', () => {
    const n = E.sporesFor(state);
    if (!n) return;
    $('#fruit-gain').textContent = `${n} spore${n === 1 ? '' : 's'}`;
    $('#fruit-next').textContent = E.BIOMES[(state.forest + 1) % E.BIOMES.length].name;
    $<HTMLDialogElement>('#dlg-fruit').showModal();
  });
  $('#fruit-yes').addEventListener('click', () => void doFruit());
  for (const b of document.querySelectorAll<HTMLElement>('[data-close]')) b.addEventListener('click', () => b.closest('dialog')!.close());
  $('#intro-go').addEventListener('click', () => { audio.start(); $<HTMLDialogElement>('#dlg-intro').close(); });
  $('#set-sound').addEventListener('click', () => {
    settings.sound = !settings.sound; audio.setOn(settings.sound);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    $('#set-sound').setAttribute('aria-pressed', String(settings.sound));
  });
  $('#set-sound').setAttribute('aria-pressed', String(settings.sound));
  $('#set-export').addEventListener('click', async () => {
    const text = btoa(await exportSave());
    try { await navigator.clipboard.writeText(text); toast('Save copied to the clipboard.'); } catch { toast('Copying is blocked here.'); }
    $('#set-export').dataset.save = text;
  });
  $('#set-import').addEventListener('click', () => { $<HTMLTextAreaElement>('#import-text').value = ''; $<HTMLDialogElement>('#dlg-import').showModal(); });
  $('#import-go').addEventListener('click', async () => {
    let text = $<HTMLTextAreaElement>('#import-text').value.trim();
    try { text = atob(text); } catch { /* plain JSON */ }
    const r = await restore(text);
    if (!r) { $('#import-msg').textContent = 'That save could not be read.'; return; }
    world.free();
    state = r.s; rateN = r.rn; rateC = r.rc;
    startWorld(r.w);
    $<HTMLDialogElement>('#dlg-import').close();
    toast('Save loaded.');
    await save(); refresh();
  });
  $('#set-reset').addEventListener('click', async () => {
    if (!confirm('Start over from a single spore? Everything, spores included, will be lost.')) return;
    localStorage.removeItem(SAVE_KEY);
    world.free();
    state = E.newState(randomSeed(), Date.now());
    rateN = rateC = Big.ZERO;
    startWorld(mod.create(state.seed, 0));
    refresh();
  });
  addEventListener('resize', () => { setInsets(); renderer.layout(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void save(); });
  addEventListener('pagehide', () => void save());
}

// ---------- the loop ----------
let last = performance.now(), acc = 0, uiAt = 0, saveAt = 0;
function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!fruiting) {
    acc += dt * SPEED;
    let n = 0;
    while (acc >= TICK && n < 40 * SPEED) { tick(); acc -= TICK; n++; }
    if (acc > 1) acc = 0; // a background tab came back: time away is handled on load, not here
    const pulses = world.takePulses();
    if (pulses.length) { renderer.addPulses(pulses); audio.drip(); }
    for (const t of world.takeLinks()) {
      renderer.treeLinked(t);
      audio.bell();
      toast(`A ${E.biomeOf(state).tree} joins your network. It will trade <b class="sug">sugar</b> for nutrients.`, 'sug');
      refresh();
    }
    // earthworms wander by now and then
    if (!renderer.worm && now > wormAt) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      renderer.worm = { x: dir > 0 ? -8 : world.gw + 8, y: 12 + Math.random() * 60, dir, t: now };
      wormAt = now + (70 + Math.random() * 70) * 1000 / SPEED;
    }
    const wm = renderer.worm;
    if (wm) { wm.x += wm.dir * dt * 9 * SPEED; if (wm.x < -12 || wm.x > world.gw + 12) renderer.worm = null; }
  }
  renderer.frame(now, dt);
  if (now - uiAt > 200) { uiAt = now; refresh(); }
  if (now - saveAt > 15000) { saveAt = now; void save(); }
  requestAnimationFrame(frame);
}

// ---------- start ----------
async function main(): Promise<void> {
  mod = await SimModule.load(fetch('sim.wasm'));
  setInsets();
  const saved = params.has('fresh') ? null : localStorage.getItem(SAVE_KEY);
  const r = saved ? await restore(saved) : null;
  if (r) {
    state = r.s; rateN = r.rn; rateC = r.rc;
    startWorld(r.w);
  } else {
    const seed = params.has('seed') ? Number(params.get('seed')) >>> 0 : randomSeed();
    state = E.newState(seed, Date.now());
    startWorld(mod.create(seed, 0));
    if (saved) toast('Your old save could not be read, so a new colony has started.');
    else $<HTMLDialogElement>('#dlg-intro').showModal();
  }
  buildCards();
  wire();
  showTab('grow');
  refresh();
  wormAt = performance.now() + 40000 / SPEED;
  document.body.classList.add('ready');
  const away = r ? (Date.now() - state.lastSeen) / 1000 : 0;
  if (away > 60) await catchUp(away);
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !params.has('nosw')) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// test hook
Object.assign(window, {
  __myc: {
    get state() { return state; }, get world() { return world; }, get rates() { return { n: rateN, c: rateC }; }, renderer, audio, E, Big,
    tick: (n = 1) => { for (let i = 0; i < n; i++) tick(); refresh(); },
    save, refresh, catchUp,
  },
});

main().catch((e) => {
  console.error(e);
  $('#fatal').hidden = false;
  $('#fatal').textContent = `Mycelium could not start: ${e instanceof Error ? e.message : e}`;
});
