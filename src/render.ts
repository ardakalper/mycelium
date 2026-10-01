// Canvas renderer: the night forest above, the soil cross-section below, and the glowing network.
// Layers: a painted background (sky, trees, soil, rocks, logs, roots) redrawn only on resize;
// a soil-richness overlay refreshed twice a second; the network, drawn incrementally as it grows and
// fully every few seconds so trunks thicken; and live effects on top (tips, pulses, lure, worm…).
import type { World, TreeInfo } from './sim.ts';
import { FLAG } from './sim.ts';

export const SKY = 64; // rows of sky above the soil, in world cells
type Species = 'beech' | 'pine' | 'oak' | 'birch';

interface Pulse { node: number; t: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number; colour: string; size: number }
interface Mushroom { x: number; y: number; h: number; cap: number; t0: number }
export interface Worm { x: number; y: number; dir: number; t: number }

// small seeded noise for painting (cosmetic only)
function hash(x: number, y: number, s = 0): number {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) & 0xffff) / 65535;
}
function noise(x: number, y: number, s = 0): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s) + (hash(x0 + 1, y0, s) - hash(x0, y0, s)) * sx;
  const b = hash(x0, y0 + 1, s) + (hash(x0 + 1, y0 + 1, s) - hash(x0, y0 + 1, s)) * sx;
  return a + (b - a) * sy;
}
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: World | null = null;
  private species: Species = 'beech';
  private bg = document.createElement('canvas');
  private fg = document.createElement('canvas'); // dead wood, roots, trees, grass: drawn over the soil overlay
  private net = document.createElement('canvas');
  private soil = document.createElement('canvas');
  private dot = document.createElement('canvas');
  scale = 3;
  ox = 0;
  oy = 0;
  private dpr = 1;
  private pulses: Pulse[] = [];
  private sparks: Spark[] = [];
  private mushrooms: Mushroom[] = [];
  private fireflies: { x: number; y: number; p: number }[] = [];
  private lastFull = 0;
  private fullAt = 0;
  private lastSoil = 0;
  private treeGlow: number[] = [];
  lure: { x: number; y: number; until: number; t0: number } | null = null;
  insets = { left: 0, right: 0, top: 0, bottom: 0 }; // CSS px kept clear for the panels
  worm: Worm | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    // a soft glow sprite for tips and pulses
    this.dot.width = this.dot.height = 32;
    const g = this.dot.getContext('2d')!, grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(240,255,248,1)'); grad.addColorStop(0.25, 'rgba(170,255,225,0.75)'); grad.addColorStop(1, 'rgba(120,255,210,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 14; i++) this.fireflies.push({ x: hash(i, 1) * 320, y: -4 - hash(i, 2) * 40, p: hash(i, 3) * 10 });
  }

  setWorld(w: World, species: Species): void {
    this.world = w;
    this.species = species;
    this.pulses = []; this.sparks = []; this.mushrooms = [];
    this.treeGlow = w.trees().map((t) => (t.linked ? 1 : 0));
    this.soil.width = w.gw; this.soil.height = w.gh;
    this.layout();
  }

  // fit the world (sky + soil) into the canvas
  layout(): void {
    const w = this.world;
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    if (!w) return;
    const cw = this.canvas.width, ch = this.canvas.height, d = this.dpr, ins = this.insets;
    const aw = cw - (ins.left + ins.right) * d, ah = ch - (ins.top + ins.bottom) * d;
    this.scale = Math.min(aw / w.gw, ah / (w.gh + SKY));
    this.ox = ins.left * d + (aw - w.gw * this.scale) / 2;
    this.oy = ins.top * d + (ah - (w.gh + SKY) * this.scale) / 2 + SKY * this.scale;
    for (const c of [this.bg, this.fg, this.net]) { c.width = cw; c.height = ch; }
    this.paintBackground();
    this.refreshSoil();
    this.redrawNetwork();
  }

  // screen (CSS px in the canvas) → world cell coordinates
  toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px * this.dpr - this.ox) / this.scale, y: (py * this.dpr - this.oy) / this.scale };
  }
  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: (this.ox + x * this.scale) / this.dpr, y: (this.oy + y * this.scale) / this.dpr };
  }

  // ---------- the painted background ----------
  private paintBackground(): void {
    const w = this.world!, s = this.scale, X = (x: number) => this.ox + x * s, Y = (y: number) => this.oy + y * s;
    let c = this.bg.getContext('2d')!;
    const seed = w.seed;
    c.clearRect(0, 0, this.bg.width, this.bg.height);
    // sky
    const sky = c.createLinearGradient(0, Y(-SKY), 0, Y(0));
    sky.addColorStop(0, '#060814'); sky.addColorStop(0.6, '#0c1426'); sky.addColorStop(1, '#16233a');
    c.fillStyle = sky; c.fillRect(X(0), Y(-SKY), w.gw * s, SKY * s);
    for (let i = 0; i < 140; i++) {
      const x = hash(i, 7, seed) * w.gw, y = -SKY + hash(i, 8, seed) * SKY * 0.7, a = 0.25 + hash(i, 9, seed) * 0.6;
      c.fillStyle = `rgba(220,230,255,${a})`; c.fillRect(X(x), Y(y), Math.max(1, s * 0.25), Math.max(1, s * 0.25));
    }
    // moon
    const mx = X(w.gw * (0.15 + hash(1, 1, seed) * 0.7)), my = Y(-SKY * 0.78), mr = s * 4.5;
    const glow = c.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 5);
    glow.addColorStop(0, 'rgba(200,215,255,0.18)'); glow.addColorStop(1, 'rgba(200,215,255,0)');
    c.fillStyle = glow; c.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
    c.fillStyle = '#e6ecf7'; c.beginPath(); c.arc(mx, my, mr, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(160,175,200,0.35)'; c.beginPath(); c.arc(mx - mr * 0.3, my - mr * 0.2, mr * 0.25, 0, 7); c.arc(mx + mr * 0.35, my + mr * 0.3, mr * 0.18, 0, 7); c.fill();
    // far hills and a misty treeline
    for (const [k, col] of [[0, '#0d1626'], [1, '#101b2b']] as const) {
      c.fillStyle = col; c.beginPath(); c.moveTo(X(0), Y(0));
      for (let x = 0; x <= w.gw; x += 2) c.lineTo(X(x), Y(-6 - k * 3 - noise(x / 30, k, seed) * (12 - k * 4) - noise(x / 4, k + 5, seed) * 3));
      c.lineTo(X(w.gw), Y(0)); c.fill();
    }
    // distant trees in the mist
    for (let k = 0; k < 26; k++) {
      const x = hash(k, 21, seed) * w.gw, h = 14 + hash(k, 22, seed) * 16, r = 4 + hash(k, 23, seed) * 4;
      c.fillStyle = '#0e1a28'; c.fillRect(X(x - 0.5), Y(-h * 0.7), s, h * 0.7 * s);
      for (let j = 0; j < 5; j++) { c.beginPath(); c.arc(X(x + (hash(k, j, seed) - 0.5) * r * 1.6), Y(-h + (hash(j, k, seed) - 0.5) * r), r * (0.6 + hash(j, k + 3, seed) * 0.5) * s, 0, 7); c.fill(); }
    }
    const mist = c.createLinearGradient(0, Y(-22), 0, Y(0));
    mist.addColorStop(0, 'rgba(22,35,58,0)'); mist.addColorStop(1, 'rgba(30,46,70,0.45)');
    c.fillStyle = mist; c.fillRect(X(0), Y(-22), w.gw * s, 22 * s);
    // soil: strata with mottling, painted at cell resolution then scaled up softly
    const img = new ImageData(w.gw, w.gh), flags = w.flags();
    const top = [44, 34, 28], mid = [33, 27, 26], deep = [24, 21, 27], clay = [30, 26, 34];
    for (let y = 0; y < w.gh; y++) for (let x = 0; x < w.gw; x++) {
      const d = y / w.gh, band = noise(x / 40, y / 6, seed + 3);
      let col = d < 0.15 ? mix(top, mid, d / 0.15) : d < 0.6 ? mix(mid, deep, (d - 0.15) / 0.45) : mix(deep, clay, (d - 0.6) / 0.4);
      col = col.map((v) => v + (band - 0.5) * 10 + (hash(x, y, seed) - 0.5) * 6);
      const i = (y * w.gw + x) * 4, f = flags[y * w.gw + x];
      if (f & FLAG.rock) {
        const above = y > 0 && !(flags[(y - 1) * w.gw + x] & FLAG.rock), below = y < w.gh - 1 && !(flags[(y + 1) * w.gw + x] & FLAG.rock);
        const n = noise(x / 3, y / 3, seed + 9);
        col = mix([52, 58, 72], [78, 86, 102], n);
        if (above) col = mix(col, [120, 130, 150], 0.5);
        if (below) col = mix(col, [22, 24, 32], 0.5);
      }
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = w.gw; tmp.height = w.gh;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(tmp, X(0), Y(0), w.gw * s, w.gh * s);
    // everything below goes on the front layer
    c = this.fg.getContext('2d')!;
    c.clearRect(0, 0, this.fg.width, this.fg.height);
    // dead wood, buried caches, old stumps
    for (const o of w.objects()) {
      if (o.kind === 'log') this.paintLog(c, X(o.x), Y(o.y), o.w * s, (o.h + 1) * s, seed);
      else if (o.kind === 'cache') {
        for (let k = 0; k < 6; k++) {
          const ax = X(o.x + (hash(k, 1, o.x) - 0.5) * o.w * 1.2), ay = Y(o.y + (hash(k, 2, o.x) - 0.5) * o.h);
          c.fillStyle = '#4c3a2c'; c.beginPath(); c.ellipse(ax, ay, s * 0.9, s * 1.2, hash(k, 3) * 3, 0, 7); c.fill();
          c.fillStyle = '#2c231d'; c.beginPath(); c.ellipse(ax, ay - s * 0.9, s * 0.95, s * 0.45, 0, 0, 7); c.fill();
        }
      } else {
        c.fillStyle = '#2b221d'; c.fillRect(X(o.x - 2.2), Y(-2.5), 4.4 * s, 2.6 * s);
        c.fillStyle = '#5a4a3d'; c.beginPath(); c.ellipse(X(o.x), Y(-2.5), 2.2 * s, 0.7 * s, 0, 0, 7); c.fill();
        c.strokeStyle = '#3a2f27'; c.lineWidth = Math.max(1, s * 0.2); c.beginPath(); c.ellipse(X(o.x), Y(-2.5), 1.3 * s, 0.4 * s, 0, 0, 7); c.stroke();
      }
    }
    // living roots
    const roots = w.roots();
    c.lineCap = 'round';
    for (let i = 0; i < roots.length; i += 6) {
      c.strokeStyle = 'rgba(78,60,46,0.9)'; c.lineWidth = Math.max(1, roots[i + 4] * s * 0.75);
      c.beginPath(); c.moveTo(X(roots[i]), Y(roots[i + 1])); c.lineTo(X(roots[i + 2]), Y(roots[i + 3])); c.stroke();
    }
    // trees on the surface
    w.trees().forEach((t, i) => this.paintTree(c, t, i, seed));
    // grass along the surface
    c.lineWidth = Math.max(1, s * 0.25);
    for (let x = 0; x < w.gw; x += 0.6) {
      const h = 0.8 + hash(x * 10, 5, seed) * 2.2, lean = (hash(x * 10, 6, seed) - 0.5) * 1.2;
      c.strokeStyle = hash(x * 10, 7, seed) > 0.85 ? '#2f4a3a' : '#1b2d26';
      c.beginPath(); c.moveTo(X(x), Y(0.2)); c.quadraticCurveTo(X(x + lean * 0.3), Y(-h * 0.6), X(x + lean), Y(-h)); c.stroke();
    }
  }

  private paintLog(c: CanvasRenderingContext2D, x: number, y: number, len: number, th: number, seed: number): void {
    const r = th / 2;
    c.fillStyle = '#33271f';
    c.beginPath(); c.roundRect(x, y - r * 0.6, len, th, r); c.fill();
    c.strokeStyle = 'rgba(20,14,10,0.6)'; c.lineWidth = Math.max(1, th * 0.06);
    for (let k = 0; k < len / (th * 0.7); k++) {
      const bx = x + (k + hash(k, 1, seed)) * th * 0.7;
      c.beginPath(); c.moveTo(bx, y - r * 0.5); c.lineTo(bx + th * 0.2, y + th * 0.3); c.stroke();
    }
    c.fillStyle = 'rgba(70,110,72,0.85)';
    for (let k = 0; k < len; k += th * 0.35) { c.beginPath(); c.ellipse(x + k, y - r * 0.6, th * 0.25, th * 0.12, 0, 0, 7); c.fill(); }
    c.fillStyle = '#6b5644'; c.beginPath(); c.ellipse(x + len, y - r * 0.6 + r, r * 0.55, r, 0, 0, 7); c.fill();
    c.strokeStyle = '#4a3a2e'; c.beginPath(); c.ellipse(x + len, y - r * 0.6 + r, r * 0.3, r * 0.55, 0, 0, 7); c.stroke();
  }

  private paintTree(c: CanvasRenderingContext2D, t: TreeInfo, i: number, seed: number): void {
    const s = this.scale, X = (x: number) => this.ox + x * s, Y = (y: number) => this.oy + y * s;
    const h = 36 + 22 * t.size, trunk = 1.4 + 1.5 * t.size, sp = this.species;
    const leaf = sp === 'pine' ? '#0f2420' : sp === 'birch' ? '#1a2e24' : '#13261f', leaf2 = sp === 'birch' ? '#25402f' : '#1b3329';
    // trunk
    c.fillStyle = sp === 'birch' ? '#c9c6bb' : '#1b1512';
    c.beginPath(); c.moveTo(X(t.x - trunk), Y(0.5)); c.lineTo(X(t.x - trunk * 0.45), Y(-h * 0.75)); c.lineTo(X(t.x + trunk * 0.45), Y(-h * 0.75)); c.lineTo(X(t.x + trunk), Y(0.5)); c.fill();
    if (sp === 'birch') { c.fillStyle = '#2b2a2a'; for (let k = 0; k < 9; k++) c.fillRect(X(t.x - trunk * 0.7 + hash(k, i, seed) * trunk), Y(-hash(k, i + 9, seed) * h * 0.7), s * 0.9, s * 0.35); }
    const blob = (x: number, y: number, r: number, col: string) => { c.fillStyle = col; c.beginPath(); c.arc(X(x), Y(y), r * s, 0, Math.PI * 2); c.fill(); };
    if (sp === 'pine') {
      for (let k = 0; k < 6; k++) {
        const yy = -h * 0.25 - k * h * 0.13, ww = (7 - k) * 1.6 * t.size;
        c.fillStyle = k % 2 ? leaf : leaf2;
        c.beginPath(); c.moveTo(X(t.x - ww), Y(yy)); c.lineTo(X(t.x), Y(yy - h * 0.22)); c.lineTo(X(t.x + ww), Y(yy)); c.fill();
      }
    } else {
      const n = sp === 'oak' ? 30 : 24, spread = sp === 'oak' ? 16 : sp === 'birch' ? 9 : 13;
      // boughs, then leaf masses over them
      c.strokeStyle = sp === 'birch' ? '#a9a69c' : '#1b1512'; c.lineCap = 'round';
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k - 2) * 0.45, l = spread * 0.8 * t.size;
        c.lineWidth = trunk * 0.5 * s; c.beginPath(); c.moveTo(X(t.x), Y(-h * 0.6)); c.lineTo(X(t.x + Math.cos(a) * l), Y(-h * 0.6 + Math.sin(a) * l * 0.7)); c.stroke();
      }
      for (let k = 0; k < n; k++) {
        const a = hash(k, i, seed) * Math.PI * 2, r = Math.sqrt(hash(k, i + 3, seed)) * spread * t.size;
        blob(t.x + Math.cos(a) * r, -h * 0.8 + Math.sin(a) * r * 0.5, (3.5 + hash(k, i + 5, seed) * 4) * t.size, k % 3 ? leaf : leaf2);
      }
      // moonlit rim on the top leaves
      for (let k = 0; k < 8; k++) {
        const a = -Math.PI * (0.15 + hash(k, i + 7, seed) * 0.7), r = spread * t.size * (0.6 + hash(k, i + 8, seed) * 0.4);
        blob(t.x + Math.cos(a) * r, -h * 0.8 + Math.sin(a) * r * 0.5 - 2, 2 * t.size, 'rgba(60,96,84,0.55)');
      }
      if (sp === 'oak') {
        c.strokeStyle = 'rgba(90,120,95,0.5)'; c.lineWidth = Math.max(1, s * 0.3);
        for (let k = 0; k < 10; k++) { const x = t.x + (hash(k, i + 11, seed) - 0.5) * spread * 1.8 * t.size; c.beginPath(); c.moveTo(X(x), Y(-h * 0.72)); c.lineTo(X(x + 0.3), Y(-h * 0.72 + 3 + hash(k, 2, seed) * 6)); c.stroke(); }
      }
    }
  }

  // ---------- soil richness ----------
  refreshSoil(): void {
    const w = this.world!, n = w.nutrients(), img = new ImageData(w.gw, w.gh), flags = w.flags();
    for (let i = 0; i < n.length; i++) {
      if (flags[i] & FLAG.rock) continue;
      const t = Math.min(1, (n[i] / 255) * 1.8);
      const col = flags[i] & FLAG.colonized ? mix([72, 74, 80], [104, 82, 48], t) : mix([20, 17, 19], [110, 84, 46], t);
      img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2];
      img.data[i * 4 + 3] = flags[i] & FLAG.colonized ? Math.round(70 + 60 * (1 - t)) : Math.round(20 + 150 * t);
    }
    this.soil.getContext('2d')!.putImageData(img, 0, 0);
  }

  // ---------- the network ----------
  redrawNetwork(): void {
    const w = this.world!, c = this.net.getContext('2d')!, s = this.scale, ox = this.ox, oy = this.oy;
    c.clearRect(0, 0, this.net.width, this.net.height);
    const n = w.nodeCount;
    if (n < 2) return;
    const thick = w.thickness(), { x, y, parent } = w.nodes();
    // bucket segments by width so each bucket is one path
    const B = 7, paths: Path2D[] = Array.from({ length: B }, () => new Path2D());
    for (let i = 1; i < n; i++) {
      const p = parent[i], k = Math.min(B - 1, Math.floor(Math.log2(thick[i]) * 0.55));
      paths[k].moveTo(ox + x[p] * s, oy + y[p] * s); paths[k].lineTo(ox + x[i] * s, oy + y[i] * s);
    }
    const fused = w.fused(), fp = new Path2D();
    for (let i = 0; i < fused.length; i += 2) { const a = fused[i], b = fused[i + 1]; fp.moveTo(ox + x[a] * s, oy + y[a] * s); fp.lineTo(ox + x[b] * s, oy + y[b] * s); }
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < B; k++) { c.strokeStyle = `rgba(110,255,205,${0.04 + k * 0.012})`; c.lineWidth = (0.6 + k * 0.55) * s * 0.6; c.stroke(paths[k]); }
    c.globalCompositeOperation = 'source-over';
    for (let k = 0; k < B; k++) { c.strokeStyle = `rgba(232,250,240,${0.42 + k * 0.09})`; c.lineWidth = Math.max(0.5, (0.07 + k * k * 0.018) * s); c.stroke(paths[k]); }
    c.strokeStyle = 'rgba(190,255,225,0.6)'; c.lineWidth = Math.max(0.5, 0.08 * s); c.stroke(fp);
    w.takeSegments(); // everything is drawn now
    this.lastFull = n;
  }
  private drawNewSegments(): void {
    const segs = this.world!.takeSegments();
    if (!segs.length) return;
    const c = this.net.getContext('2d')!, s = this.scale;
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(226,246,234,0.5)'; c.lineWidth = Math.max(0.5, 0.07 * s);
    c.beginPath();
    for (let i = 0; i < segs.length; i += 4) { c.moveTo(this.ox + segs[i] * s, this.oy + segs[i + 1] * s); c.lineTo(this.ox + segs[i + 2] * s, this.oy + segs[i + 3] * s); }
    c.stroke();
  }

  // ---------- effects ----------
  addPulses(nodes: Uint32Array): void {
    for (const n of nodes) if (this.pulses.length < 160) this.pulses.push({ node: n, t: 0 });
  }
  burst(x: number, y: number, colour: string, n = 12, speed = 6): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life: 0.8 + Math.random() * 0.8, age: 0, colour, size: 0.4 + Math.random() * 0.5 });
    }
  }
  treeLinked(i: number): void {
    const t = this.world!.trees()[i];
    this.treeGlow[i] = 0.01;
    this.burst(t.x, 1, '#c9b6ff', 30, 10);
  }
  // mushrooms push up over the hyphae nearest the surface
  fruit(t0: number): void {
    const w = this.world!, { x, y } = w.nodes(), picks: number[] = [];
    for (let i = 0; i < w.nodeCount && picks.length < 400; i++) if (y[i] < 7) picks.push(i);
    const chosen: Mushroom[] = [];
    for (const i of picks.sort((a, b) => hash(a, 3) - hash(b, 3))) {
      if (chosen.length >= 14) break;
      if (chosen.some((m) => Math.abs(m.x - x[i]) < 9)) continue;
      chosen.push({ x: x[i], y: 0, h: 4 + hash(i, 1) * 6, cap: 2.2 + hash(i, 2) * 2.5, t0: t0 + chosen.length * 120 });
    }
    if (!chosen.length) chosen.push({ x: w.origin.x, y: 0, h: 7, cap: 3.5, t0 });
    this.mushrooms = chosen;
  }

  // ---------- one frame ----------
  frame(now: number, dt: number): void {
    const w = this.world;
    const c = this.ctx, s = this.scale;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#05060b'; c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!w || !w.alive) return;
    const X = (x: number) => this.ox + x * s, Y = (y: number) => this.oy + y * s;
    c.drawImage(this.bg, 0, 0);
    if (now - this.lastSoil > 500) { this.refreshSoil(); this.lastSoil = now; }
    c.imageSmoothingEnabled = true;
    c.drawImage(this.soil, X(0), Y(0), w.gw * s, w.gh * s);
    c.drawImage(this.fg, 0, 0);
    // linked trees: their roots light up, slowly
    const trees = w.trees(), roots = w.roots();
    trees.forEach((t, i) => { if (t.linked) this.treeGlow[i] = Math.min(1, (this.treeGlow[i] || 0) + dt * 0.5); });
    if (this.treeGlow.some((g) => g > 0)) {
      c.lineCap = 'round'; c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < roots.length; i += 6) {
        const g = this.treeGlow[this.treeOfRoot(roots[i], trees)] || 0;
        if (!g) continue;
        c.strokeStyle = `rgba(180,150,255,${0.28 * g})`; c.lineWidth = Math.max(1, roots[i + 4] * s * 0.9);
        c.beginPath(); c.moveTo(X(roots[i]), Y(roots[i + 1])); c.lineTo(X(roots[i + 2]), Y(roots[i + 3])); c.stroke();
      }
      c.globalCompositeOperation = 'source-over';
    }
    // the network
    const n = w.nodeCount;
    if (n > this.lastFull * 1.08 + 50 || now - this.fullAt > 5000) { this.redrawNetwork(); this.fullAt = now; } else this.drawNewSegments();
    c.drawImage(this.net, 0, 0);
    // pulses of food travelling home along the hyphae
    const { x, y, parent } = w.nodes();
    c.globalCompositeOperation = 'lighter';
    const ds = s * 2.2;
    this.pulses = this.pulses.filter((p) => {
      p.t += dt * 30;
      while (p.t >= 1) { p.t -= 1; const par = parent[p.node]; if (par === 0xffffffff || par === undefined) return false; p.node = par; }
      const par = parent[p.node];
      if (par === 0xffffffff || par === undefined) return false;
      const px = x[p.node] + (x[par] - x[p.node]) * p.t, py = y[p.node] + (y[par] - y[p.node]) * p.t;
      c.globalAlpha = 0.85; c.drawImage(this.dot, X(px) - ds / 2, Y(py) - ds / 2, ds, ds);
      return true;
    });
    // growing tips
    const tips = w.tips(), ts = s * (2.6 + Math.sin(now / 300) * 0.4);
    for (let i = 0; i < tips.length; i += 3) { c.globalAlpha = 0.95; c.drawImage(this.dot, X(tips[i]) - ts / 2, Y(tips[i + 1]) - ts / 2, ts, ts); }
    c.globalAlpha = 1;
    // origin
    const o = w.origin, os = s * (5 + Math.sin(now / 700));
    c.drawImage(this.dot, X(o.x) - os / 2, Y(o.y) - os / 2, os, os);
    c.globalCompositeOperation = 'source-over';
    // fireflies above the ground
    for (const f of this.fireflies) {
      const fx = f.x + Math.sin(now / 1700 + f.p) * 6, fy = f.y + Math.sin(now / 1100 + f.p * 2) * 3, a = 0.4 + 0.6 * Math.max(0, Math.sin(now / 600 + f.p * 3));
      c.globalAlpha = a; c.drawImage(this.dot, X(fx) - s, Y(fy) - s, s * 2, s * 2);
    }
    c.globalAlpha = 1;
    // lure
    if (this.lure) {
      const l = this.lure, left = Math.max(0, (l.until - now) / (l.until - l.t0));
      const R = s * (3 + Math.sin(now / 200) * 0.5);
      c.strokeStyle = 'rgba(201,182,255,0.9)'; c.lineWidth = Math.max(1, s * 0.4);
      c.beginPath(); c.arc(X(l.x), Y(l.y), R * 1.6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); c.stroke();
      c.fillStyle = 'rgba(220,205,255,0.95)'; c.beginPath(); c.arc(X(l.x), Y(l.y), R * 0.5, 0, 7); c.fill();
      if (now > l.until) this.lure = null;
    }
    // earthworm
    if (this.worm) this.paintWorm(c, this.worm, now);
    // mushrooms
    for (const m of this.mushrooms) this.paintMushroom(c, m, now);
    // sparks
    for (const p of this.sparks) {
      p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 4 * dt;
      c.globalAlpha = Math.max(0, 1 - p.age / p.life); c.fillStyle = p.colour;
      c.beginPath(); c.arc(X(p.x), Y(p.y), p.size * s * 0.5, 0, 7); c.fill();
    }
    c.globalAlpha = 1;
    this.sparks = this.sparks.filter((p) => p.age < p.life);
  }

  private treeOfRoot(rx: number, trees: TreeInfo[]): number {
    let best = 0;
    for (let i = 1; i < trees.length; i++) if (Math.abs(trees[i].x - rx) < Math.abs(trees[best].x - rx)) best = i;
    return best;
  }

  private paintWorm(c: CanvasRenderingContext2D, wm: Worm, now: number): void {
    const s = this.scale, X = (x: number) => this.ox + x * s, Y = (y: number) => this.oy + y * s;
    for (let k = 9; k >= 0; k--) {
      const x = wm.x - wm.dir * k * 0.9, y = wm.y + Math.sin(now / 180 + k * 0.7) * 0.5;
      c.fillStyle = k === 0 ? '#e7a3b8' : k % 3 === 0 ? '#c9879b' : '#d895aa';
      c.beginPath(); c.arc(X(x), Y(y), s * (0.95 - k * 0.03), 0, 7); c.fill();
    }
  }

  private paintMushroom(c: CanvasRenderingContext2D, m: Mushroom, now: number): void {
    const s = this.scale, X = (x: number) => this.ox + x * s, Y = (y: number) => this.oy + y * s;
    const g = Math.max(0, Math.min(1, (now - m.t0) / 1400));
    if (!g) return;
    const ease = 1 - (1 - g) ** 3, h = m.h * ease, cap = m.cap * ease;
    c.fillStyle = '#e9e4d6'; c.fillRect(X(m.x - 0.45), Y(-h), 0.9 * s, h * s + s);
    const glow = c.createRadialGradient(X(m.x), Y(-h), 0, X(m.x), Y(-h), cap * s * 3);
    glow.addColorStop(0, 'rgba(190,170,255,0.35)'); glow.addColorStop(1, 'rgba(190,170,255,0)');
    c.fillStyle = glow; c.fillRect(X(m.x - cap * 3), Y(-h - cap * 3), cap * 6 * s, cap * 6 * s);
    c.fillStyle = '#f2ecdf'; c.beginPath(); c.ellipse(X(m.x), Y(-h), cap * s, cap * 0.6 * s, 0, Math.PI, 0); c.fill();
    c.fillStyle = '#b9a3ff'; c.fillRect(X(m.x - cap * 0.85), Y(-h), cap * 1.7 * s, Math.max(1, s * 0.35));
    if (g >= 1 && Math.random() < 0.3) this.sparks.push({ x: m.x + (Math.random() - 0.5) * cap, y: -h, vx: (Math.random() - 0.5) * 3, vy: -3 - Math.random() * 4, life: 2.5, age: 0, colour: '#f3e9b8', size: 0.35 });
  }
}
