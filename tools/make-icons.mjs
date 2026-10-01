// App icons: a glowing branching network on a night-soil disc, rasterised without dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// branches in unit space, grown from the centre top
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const segs = [];
function grow(x, y, a, len, w, depth) {
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    a += (rnd() - 0.5) * 0.35;
    const nx = x + Math.cos(a) * len / steps, ny = y + Math.sin(a) * len / steps;
    segs.push([x, y, nx, ny, w]);
    x = nx; y = ny;
    if (depth > 0 && i % 4 === 2 && rnd() < 0.8) grow(x, y, a + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.5), len * 0.55, w * 0.62, depth - 1);
  }
}
for (const a of [Math.PI / 2, Math.PI / 2 - 0.9, Math.PI / 2 + 0.9]) grow(0.5, 0.3, a, 0.42, 0.035, 3);
function icon(size, pad, round) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const i = (py * size + px) * 4, r = size * 0.22, c = size / 2;
    const dx = Math.max(Math.abs(px + 0.5 - c) - (c - r), 0), dy = Math.max(Math.abs(py + 0.5 - c) - (c - r), 0);
    if (round && Math.hypot(dx, dy) > r) continue;
    const u = (px + 0.5) / size, v = (py + 0.5) / size;
    // night above, soil below a gentle horizon
    const soil = v > 0.3 ? 1 : 0;
    let col = soil ? [26 - v * 8, 20 - v * 6, 24, 255] : [12, 20, 38, 255];
    const uu = (u - pad) / (1 - 2 * pad), vv = (v - pad) / (1 - 2 * pad);
    let glow = 0, core = 0;
    for (const [x1, y1, x2, y2, w] of segs) {
      const lx = x2 - x1, ly = y2 - y1, t = Math.max(0, Math.min(1, ((uu - x1) * lx + (vv - y1) * ly) / (lx * lx + ly * ly)));
      const d = Math.hypot(uu - (x1 + lx * t), vv - (y1 + ly * t));
      if (d < w * 0.5) core = 1;
      glow = Math.max(glow, Math.exp(-((d / (w * 2.2)) ** 2)));
    }
    col = [col[0] + 110 * glow, col[1] + 230 * glow, col[2] + 190 * glow, 255];
    if (core) col = [236, 252, 244, 255];
    out.set(col.map((v) => Math.min(255, v)), i);
  }
  return png(size, out);
}
mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const s of [192, 512]) writeFileSync(new URL(`../public/icons/icon-${s}.png`, import.meta.url), icon(s, 0.08, true));
writeFileSync(new URL('../public/icons/maskable-512.png', import.meta.url), icon(512, 0.18, false));
console.log('icons written');
