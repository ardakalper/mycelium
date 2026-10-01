//! The world under the forest floor: a soil cross-section, the mycelial network growing through it,
//! and the trees whose roots it can trade with.
//!
//! Growth follows a few real habits of fungal hyphae:
//! - tips grow forward with a little random wandering;
//! - they turn towards food they can sense (chemotropism) and away from their own network
//!   (negative autotropism), so the colony spreads instead of clumping;
//! - they branch behind the tip, and they fuse with other hyphae they meet (anastomosis),
//!   which closes loops and gives food a shorter way home.
//!
//! Colonised soil is digested at a saturating rate. What it yields is worth less the farther it has
//! to travel through the network to the colony's origin: efficiency = exp(-path length / transport).
//! Hyphae that touch a living tree's roots form a mycorrhizal link, and the tree pays sugar for it.

use crate::rng::{fbm, Rng};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::f32::consts::{FRAC_PI_2, PI};

pub const GW: usize = 320;
pub const GH: usize = 200;
pub const CELLS: usize = GW * GH;
pub const NONE: u32 = u32::MAX;
const SEG: f32 = 0.9; // length of one hyphal segment, in cells
const FUSE_R: f32 = 0.8; // how close two hyphae must come to fuse
// Growth is paid for with food digested locally: a segment costs SEG_COST, the spore starts with
// START_ENERGY, and the store can't grow past MAX_ENERGY. When the soil runs out, so does growth.
pub const SEG_COST: f32 = 0.1;
const START_ENERGY: f32 = 20.0;
const MAX_ENERGY: f32 = 400.0;
/// Food in a new world, before the cap of 5 per cell.
pub const FOOD_PER_WORLD: f32 = 6000.0;

pub const ROCK: u8 = 1;
pub const ROOT: u8 = 2;
pub const COLONIZED: u8 = 4;
pub const LOG: u8 = 8;

#[inline]
pub fn cell(x: f32, y: f32) -> usize { (y as usize).min(GH - 1) * GW + (x as usize).min(GW - 1) }

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tip { pub x: f32, pub y: f32, pub ang: f32, pub node: u32, pub travel: f32, pub stuck: u8 }

#[derive(Clone, Copy, Debug)]
pub struct Tree { pub x: f32, pub size: f32, pub linked: bool, pub link_dist: f32 }

/// What the upgrades change. Set from the game through `set_param`.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub speed: f32,     // cells per second
    pub branch: f32,    // chance to branch at each new segment
    pub max_tips: usize,
    pub digest: f32,    // nutrient units per second per cell, at saturation
    pub sense: f32,     // how far tips can smell food, in cells
    pub transport: f32, // efficiency falls to 1/e after this much path length
    pub reach: i32,     // enzymes digest this many cells around each hypha
    pub fusion: f32,    // chance that two touching hyphae fuse
    pub root_bonus: f32,
    pub lure: Option<(f32, f32)>,
}
impl Default for Params {
    fn default() -> Self {
        Params { speed: 0.9, branch: 0.04, max_tips: 3, digest: 0.12, sense: 0.0, transport: 90.0, reach: 0, fusion: 0.15, root_bonus: 1.0, lure: None }
    }
}

/// Biomes change how the soil is made. Index with the biome number modulo the count.
#[derive(Clone, Copy)]
struct Biome { humus: f32, litter: f32, logs: i32, rocks: i32, stumps: i32, caches: i32, trees: i32 }
const BIOMES: [Biome; 4] = [
    Biome { humus: 0.35, litter: 0.9, logs: 3, rocks: 9, stumps: 2, caches: 6, trees: 4 },  // beech wood
    Biome { humus: 0.25, litter: 0.6, logs: 2, rocks: 14, stumps: 3, caches: 5, trees: 5 }, // pine barrens
    Biome { humus: 0.5, litter: 1.2, logs: 4, rocks: 6, stumps: 2, caches: 8, trees: 3 },   // cloud forest
    Biome { humus: 0.2, litter: 0.5, logs: 2, rocks: 18, stumps: 4, caches: 7, trees: 4 },  // birch taiga
];
pub const BIOME_COUNT: u32 = BIOMES.len() as u32;

pub struct World {
    pub seed: u32,
    pub biome: u32,
    rng: Rng,
    fx_rng: Rng, // cosmetic only (light pulses), so it never changes how the colony grows
    pub nutrient: Vec<f32>,
    pub initial_total: f64,
    pub flags: Vec<u8>,
    pub root_tree: Vec<u8>,
    pub cell_dist: Vec<f32>,
    pub colonized: Vec<u32>,
    // nodes, structure-of-arrays so the page can read them as typed arrays
    pub nx: Vec<f32>,
    pub ny: Vec<f32>,
    pub npar: Vec<u32>,
    pub ndist: Vec<f32>,
    pub nsub: Vec<f32>,
    first_child: Vec<u32>,
    next_sibling: Vec<u32>,
    pub fused: Vec<(u32, u32)>,
    fused_adj: HashMap<u32, Vec<u32>>,
    cell_head: Vec<u32>,
    node_next: Vec<u32>,
    pub tips: Vec<Tip>,
    pub trees: Vec<Tree>,
    pub roots: Vec<f32>,   // x1, y1, x2, y2, width, tree
    pub objects: Vec<f32>, // kind, x, y, w, h, angle (0 log, 1 buried cache, 2 stump)
    pub params: Params,
    yield_acc: f64,
    sugar_acc: f64,
    pub digested: f64,
    pub sugar_total: f64,
    pub seg_new: Vec<f32>,
    pub pulses: Vec<u32>,
    pub links: Vec<u32>,
    pub nut_u8: Vec<u8>,
    pub time: f64,
    pub energy: f32,
    respawn: f32,
    pub origin: (f32, f32),
    // scratch buffers handed to the page
    pub buf: Vec<f32>,
    pub save_buf: Vec<u8>,
}

#[derive(PartialEq)]
struct Item(f32, u32);
impl Eq for Item {}
impl Ord for Item { fn cmp(&self, o: &Self) -> Ordering { o.0.total_cmp(&self.0).then(self.1.cmp(&o.1)) } }
impl PartialOrd for Item { fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) } }

fn wrap(a: f32) -> f32 {
    let mut a = a % (2.0 * PI);
    if a > PI { a -= 2.0 * PI } else if a < -PI { a += 2.0 * PI }
    a
}
fn quantize(n: f32) -> u8 { ((n.max(0.0).sqrt() / 2.0).min(1.0) * 255.0) as u8 }

impl World {
    pub fn new(seed: u32, biome: u32) -> World {
        let mut w = World {
            seed, biome, rng: Rng::new(seed), fx_rng: Rng::new(seed ^ 0xf00d),
            nutrient: vec![0.0; CELLS], initial_total: 0.0, flags: vec![0; CELLS], root_tree: vec![0; CELLS],
            cell_dist: vec![f32::INFINITY; CELLS], colonized: Vec::new(),
            nx: Vec::new(), ny: Vec::new(), npar: Vec::new(), ndist: Vec::new(), nsub: Vec::new(),
            first_child: Vec::new(), next_sibling: Vec::new(), fused: Vec::new(), fused_adj: HashMap::new(),
            cell_head: vec![NONE; CELLS], node_next: Vec::new(), tips: Vec::new(), trees: Vec::new(),
            roots: Vec::new(), objects: Vec::new(), params: Params::default(),
            yield_acc: 0.0, sugar_acc: 0.0, digested: 0.0, sugar_total: 0.0,
            seg_new: Vec::new(), pulses: Vec::new(), links: Vec::new(), nut_u8: vec![0; CELLS],
            time: 0.0, energy: START_ENERGY, respawn: 0.0, origin: (0.0, 0.0), buf: Vec::new(), save_buf: Vec::new(),
        };
        w.generate();
        w.plant();
        w
    }

    // ---------- generation ----------
    fn generate(&mut self) {
        let b = BIOMES[(self.biome % BIOME_COUNT) as usize];
        let s = self.seed;
        for y in 0..GH {
            for x in 0..GW {
                let (fx, fy) = (x as f32, y as f32);
                let depth = fy / GH as f32;
                let mut n = fbm(s, fx / 38.0, fy / 22.0, 4).powf(1.5) * b.humus * 1.6 * (1.0 - depth).powf(1.6);
                if y < 9 { n += b.litter * (0.35 + 0.65 * fbm(s ^ 0x51, fx / 10.0, fy / 3.0, 3)) * (1.0 - fy / 9.0); }
                self.nutrient[y * GW + x] = n;
                // bedrock with an uneven top
                if fy > GH as f32 - 4.0 - fbm(s ^ 0x77, fx / 16.0, 0.0, 3) * 7.0 { self.flags[y * GW + x] |= ROCK; }
            }
        }
        // trees first, spread across the surface, so rocks and logs can keep clear of them
        let tn = b.trees;
        for t in 0..tn {
            let x = (t as f32 + 0.5) * GW as f32 / tn as f32 + self.rng.range(-18.0, 18.0);
            let size = self.rng.range(0.6, 1.4);
            self.trees.push(Tree { x, size, linked: false, link_dist: f32::INFINITY });
        }
        for _ in 0..b.rocks {
            let cy = self.rng.range(22.0, GH as f32 - 12.0);
            let depth = cy / GH as f32;
            let cx = self.rng.range(8.0, GW as f32 - 8.0);
            let rx = self.rng.range(4.0, 12.0) * (0.6 + depth);
            let ry = self.rng.range(2.5, 7.0) * (0.6 + depth);
            self.blob(cx, cy, rx, ry, |w, i, _| w.flags[i] |= ROCK);
        }
        for _ in 0..b.caches {
            let (cx, cy, r) = (self.rng.range(10.0, GW as f32 - 10.0), self.rng.range(30.0, GH as f32 - 25.0), self.rng.range(2.0, 4.5));
            let rich = self.rng.range(2.0, 4.0);
            self.blob(cx, cy, r, r * 0.8, |w, i, k| { if w.flags[i] & ROCK == 0 { w.nutrient[i] += rich * (1.0 - k) } });
            self.objects.extend_from_slice(&[1.0, cx, cy, r, r * 0.8, 0.0]);
        }
        for _ in 0..b.logs {
            let len = self.rng.range(18.0, 44.0);
            let x0 = self.rng.range(4.0, GW as f32 - len - 4.0);
            let th = self.rng.range(2.0, 3.5);
            for y in 0..(th.ceil() as usize + 1) {
                for x in (x0 as usize)..((x0 + len) as usize) {
                    let i = y * GW + x;
                    self.nutrient[i] += 1.6;
                    self.flags[i] |= LOG;
                }
            }
            self.objects.extend_from_slice(&[0.0, x0, 0.0, len, th, 0.0]);
        }
        for _ in 0..b.stumps {
            let x = self.rng.range(10.0, GW as f32 - 10.0);
            self.objects.extend_from_slice(&[2.0, x, 0.0, 3.0, 0.0, 0.0]);
            let len = self.rng.range(18.0, 30.0);
            self.branch_line(x, 1.0, FRAC_PI_2, len, 3, &mut |w, cx, cy, _| { let i = cell(cx, cy); if w.flags[i] & ROCK == 0 { w.nutrient[i] += 1.1 } });
        }
        // living roots
        for t in 0..self.trees.len() {
            let Tree { x, size, .. } = self.trees[t];
            let tag = t as u8 + 1;
            for k in 0..3 {
                let ang = FRAC_PI_2 + (k as f32 - 1.0) * 0.55 + self.rng.range(-0.15, 0.15);
                let len = (16.0 + 18.0 * size) * self.rng.range(0.8, 1.1);
                self.branch_line(x + (k as f32 - 1.0) * 1.5, 1.0, ang, len, 4, &mut |w, cx, cy, width| {
                    let i = cell(cx, cy);
                    w.flags[i] |= ROOT;
                    w.flags[i] &= !ROCK;
                    w.root_tree[i] = tag;
                    let _ = width;
                });
            }
        }
        // every forest holds about the same amount of food, however it is spread out
        for i in 0..CELLS { if self.flags[i] & ROCK != 0 { self.nutrient[i] = 0.0; } }
        let total: f32 = self.nutrient.iter().sum();
        let k = FOOD_PER_WORLD / total.max(1.0);
        for i in 0..CELLS {
            self.nutrient[i] = (self.nutrient[i] * k).min(5.0);
            self.nut_u8[i] = quantize(self.nutrient[i]);
        }
        self.initial_total = self.nutrient.iter().map(|&n| n as f64).sum();
    }

    fn blob(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, mut f: impl FnMut(&mut World, usize, f32)) {
        let s = self.seed;
        for y in ((cy - ry - 2.0).max(1.0) as usize)..((cy + ry + 2.0).min(GH as f32 - 1.0) as usize) {
            for x in ((cx - rx - 2.0).max(1.0) as usize)..((cx + rx + 2.0).min(GW as f32 - 1.0) as usize) {
                let (dx, dy) = ((x as f32 - cx) / rx, (y as f32 - cy) / ry);
                let k = dx * dx + dy * dy;
                let edge = 1.0 + 0.35 * (fbm(s ^ 0x99, x as f32 / 4.0, y as f32 / 4.0, 2) - 0.5);
                if k < edge {
                    f(self, y * GW + x, (k / edge).min(1.0));
                }
            }
        }
    }

    // A branching line (roots, old dead roots), calling `f` for every cell it passes.
    fn branch_line(&mut self, x: f32, y: f32, ang: f32, len: f32, depth: u32, f: &mut dyn FnMut(&mut World, f32, f32, f32)) {
        let (mut x, mut y, mut a) = (x, y, ang);
        let steps = (len / 0.7) as i32;
        let mut last = (x, y);
        for k in 0..steps {
            a += self.rng.range(-0.18, 0.18);
            a = a.clamp(0.15, PI - 0.15); // roots grow downwards
            x += a.cos() * 0.7;
            y += a.sin() * 0.7;
            if x < 1.0 || x >= GW as f32 - 1.0 || y >= GH as f32 - 6.0 { break; }
            let width = depth as f32 * 0.6;
            f(self, x, y, width);
            if k % 6 == 5 {
                self.roots.extend_from_slice(&[last.0, last.1, x, y, width, depth as f32]);
                last = (x, y);
            }
            if depth > 1 && k > 4 && self.rng.chance(0.07) {
                let side = if self.rng.chance(0.5) { 1.0 } else { -1.0 };
                let sub = len * self.rng.range(0.3, 0.55);
                let turn = side * self.rng.range(0.5, 1.0);
                self.branch_line(x, y, a + turn, sub, depth - 1, f);
            }
        }
        if (last.0 - x).abs() + (last.1 - y).abs() > 0.01 {
            self.roots.extend_from_slice(&[last.0, last.1, x, y, depth as f32 * 0.6, depth as f32]);
        }
    }

    // the spore lands near the middle of the surface
    fn plant(&mut self) {
        let mut ox = GW as f32 / 2.0 + self.rng.range(-30.0, 30.0);
        while self.flags[cell(ox, 5.0)] & (ROCK | ROOT) != 0 { ox += 3.0; }
        self.origin = (ox, 5.0);
        self.nx.push(ox); self.ny.push(5.0); self.npar.push(NONE); self.ndist.push(0.0); self.nsub.push(1.0);
        self.first_child.push(NONE); self.next_sibling.push(NONE);
        let c = cell(ox, 5.0);
        self.node_next.push(self.cell_head[c]); self.cell_head[c] = 0;
        self.colonize(ox, 5.0, 0.0, 0);
        for k in 0..3 {
            let ang = FRAC_PI_2 + (k as f32 - 1.0) * 0.9;
            self.tips.push(Tip { x: ox, y: 5.0, ang, node: 0, travel: 0.0, stuck: 0 });
        }
    }

    // ---------- growth ----------
    fn blocked(&self, x: f32, y: f32) -> bool {
        x < 0.5 || y < 0.6 || x >= GW as f32 - 0.5 || y >= GH as f32 - 0.5 || self.flags[cell(x, y)] & ROCK != 0
    }

    // food minus crowding along a direction, for steering
    fn smell(&self, x: f32, y: f32, a: f32, range: f32) -> f32 {
        let (c, s) = (a.cos(), a.sin());
        let mut sum = 0.0;
        let mut d = 1.0;
        while d <= range {
            let (px, py) = (x + c * d, y + s * d);
            if self.blocked(px, py) { sum -= 0.5; break; }
            let i = cell(px, py);
            sum += self.nutrient[i] / d.sqrt();
            if self.flags[i] & COLONIZED != 0 { sum -= 0.12; }
            d += 1.5;
        }
        sum
    }

    pub fn step(&mut self, dt: f32) {
        self.time += dt as f64;
        let mut i = 0;
        while i < self.tips.len() {
            if self.grow_tip(i, dt) { i += 1 } else { self.tips.swap_remove(i); }
        }
        // keep the colony growing: new tips sprout from recent hyphae
        self.respawn += dt;
        if self.respawn >= 0.4 {
            self.respawn = 0.0;
            let n = self.nx.len();
            if self.tips.len() < self.params.max_tips && n > 0 {
                let lo = n.saturating_sub(1200);
                let id = self.rng.int(lo as i32, n as i32 - 1) as usize;
                let ang = self.rng.range(-PI, PI);
                self.tips.push(Tip { x: self.nx[id], y: self.ny[id], ang, node: id as u32, travel: 0.0, stuck: 0 });
            }
        }
        self.digest(dt);
        self.symbiosis(dt);
    }

    fn grow_tip(&mut self, i: usize, dt: f32) -> bool {
        let p = self.params;
        let mut t = self.tips[i];
        // starving tips creep on at a fifth of their speed, living off the colony's reserves
        let starving = self.energy < SEG_COST;
        let mut turn = 0.0;
        if p.sense >= 1.0 {
            let (l, c, r) = (self.smell(t.x, t.y, t.ang - 0.5, p.sense), self.smell(t.x, t.y, t.ang, p.sense), self.smell(t.x, t.y, t.ang + 0.5, p.sense));
            if l > c && l >= r { turn -= 1.4 } else if r > c && r > l { turn += 1.4 }
        } else {
            // even without a sense of smell, hyphae avoid their own crowd
            if self.flags[cell(t.x + t.ang.cos() * 2.0, t.y + t.ang.sin() * 2.0)] & COLONIZED != 0 { turn += if self.rng.chance(0.5) { 0.8 } else { -0.8 } }
        }
        if let Some((lx, ly)) = p.lure {
            let (dx, dy) = (lx - t.x, ly - t.y);
            if dx * dx + dy * dy < 140.0 * 140.0 {
                let diff = wrap(dy.atan2(dx) - t.ang);
                turn += diff.clamp(-1.0, 1.0) * 2.4;
            }
        }
        if t.y < 7.0 { turn += wrap(FRAC_PI_2 - t.ang) * 0.9; } // gravitropism near the surface
        t.ang = wrap(t.ang + turn * dt + self.rng.normal() * 0.45 * dt.sqrt());
        let step = p.speed * dt * if starving { 0.2 } else { 1.0 };
        let (nx, ny) = (t.x + t.ang.cos() * step, t.y + t.ang.sin() * step);
        if self.blocked(nx, ny) {
            let mut freed = false;
            for _ in 0..4 {
                let side = if self.rng.chance(0.5) { 1.0 } else { -1.0 };
                let a = t.ang + side * self.rng.range(0.6, 2.2);
                if !self.blocked(t.x + a.cos() * step, t.y + a.sin() * step) { t.ang = wrap(a); freed = true; break; }
            }
            t.stuck = t.stuck.saturating_add(1);
            self.tips[i] = t;
            return freed || t.stuck < 8;
        }
        t.stuck = 0;
        t.x = nx;
        t.y = ny;
        t.travel += step;
        if t.travel >= SEG {
            t.travel = 0.0;
            self.energy = (self.energy - SEG_COST).max(0.0);
            let n = self.add_node(t.x, t.y, t.node);
            if p.fusion > 0.0 {
                if let Some(o) = self.find_fusion(n, t.node) {
                    if self.rng.chance(p.fusion) {
                        self.fuse(n, o);
                        self.tips[i] = t;
                        return false;
                    }
                }
            }
            t.node = n;
            if self.tips.len() < p.max_tips && self.rng.chance(p.branch) {
                let side = if self.rng.chance(0.5) { 1.0 } else { -1.0 };
                let ang = wrap(t.ang + side * self.rng.range(0.5, 1.1));
                self.tips.push(Tip { x: t.x, y: t.y, ang, node: n, travel: 0.0, stuck: 0 });
            }
        }
        self.tips[i] = t;
        true
    }

    fn add_node(&mut self, x: f32, y: f32, parent: u32) -> u32 {
        let id = self.nx.len() as u32;
        let (px, py) = (self.nx[parent as usize], self.ny[parent as usize]);
        let d = self.ndist[parent as usize] + ((x - px).powi(2) + (y - py).powi(2)).sqrt();
        self.nx.push(x); self.ny.push(y); self.npar.push(parent); self.ndist.push(d); self.nsub.push(1.0);
        self.first_child.push(NONE);
        self.next_sibling.push(self.first_child[parent as usize]);
        self.first_child[parent as usize] = id;
        let c = cell(x, y);
        self.node_next.push(self.cell_head[c]);
        self.cell_head[c] = id;
        self.seg_new.extend_from_slice(&[px, py, x, y]);
        self.colonize(x, y, d, id);
        id
    }

    fn colonize(&mut self, x: f32, y: f32, d: f32, _node: u32) {
        let r = self.params.reach;
        let (cx, cy) = (x as i32, y as i32);
        for oy in -r..=r {
            for ox in -r..=r {
                if ox * ox + oy * oy > r * r + r { continue; }
                let (gx, gy) = (cx + ox, cy + oy);
                if gx < 0 || gy < 0 || gx >= GW as i32 || gy >= GH as i32 { continue; }
                let i = gy as usize * GW + gx as usize;
                if self.flags[i] & ROCK != 0 { continue; }
                let dd = d + (ox.abs() + oy.abs()) as f32;
                if self.flags[i] & COLONIZED == 0 {
                    self.flags[i] |= COLONIZED;
                    self.colonized.push(i as u32);
                    self.cell_dist[i] = dd;
                } else if dd < self.cell_dist[i] {
                    self.cell_dist[i] = dd;
                }
                if self.flags[i] & ROOT != 0 {
                    let t = self.root_tree[i] as usize - 1;
                    let tree = &mut self.trees[t];
                    if !tree.linked { tree.linked = true; self.links.push(t as u32); }
                    if dd < tree.link_dist { tree.link_dist = dd; }
                }
            }
        }
    }

    /// A node of another hypha close to `n`; nodes only a few steps away along the network don't count.
    fn find_fusion(&self, n: u32, parent: u32) -> Option<u32> {
        let (x, y) = (self.nx[n as usize], self.ny[n as usize]);
        let d = self.ndist[n as usize];
        for oy in -1..=1i32 {
            for ox in -1..=1i32 {
                let (gx, gy) = (x as i32 + ox, y as i32 + oy);
                if gx < 0 || gy < 0 || gx >= GW as i32 || gy >= GH as i32 { continue; }
                let mut o = self.cell_head[gy as usize * GW + gx as usize];
                while o != NONE {
                    if o != n && o != parent && (self.ndist[o as usize] - d).abs() > 6.0 {
                        let (dx, dy) = (self.nx[o as usize] - x, self.ny[o as usize] - y);
                        if dx * dx + dy * dy < FUSE_R * FUSE_R { return Some(o); }
                    }
                    o = self.node_next[o as usize];
                }
            }
        }
        None
    }

    fn fuse(&mut self, a: u32, b: u32) {
        let len = ((self.nx[a as usize] - self.nx[b as usize]).powi(2) + (self.ny[a as usize] - self.ny[b as usize]).powi(2)).sqrt();
        self.fused.push((a, b));
        self.fused_adj.entry(a).or_default().push(b);
        self.fused_adj.entry(b).or_default().push(a);
        self.seg_new.extend_from_slice(&[self.nx[a as usize], self.ny[a as usize], self.nx[b as usize], self.ny[b as usize]]);
        let (da, db) = (self.ndist[a as usize], self.ndist[b as usize]);
        if da + len < db { self.relax(b, da + len) } else if db + len < da { self.relax(a, db + len) }
    }

    fn neighbours(&self, v: u32, out: &mut Vec<u32>) {
        out.clear();
        let p = self.npar[v as usize];
        if p != NONE { out.push(p) }
        let mut c = self.first_child[v as usize];
        while c != NONE { out.push(c); c = self.next_sibling[c as usize]; }
        if let Some(f) = self.fused_adj.get(&v) { out.extend_from_slice(f) }
    }

    /// Dijkstra from `start` with a new, shorter distance: a fusion opened a shortcut home.
    fn relax(&mut self, start: u32, d: f32) {
        let mut heap = BinaryHeap::new();
        self.ndist[start as usize] = d;
        heap.push(Item(d, start));
        let mut nb = Vec::new();
        while let Some(Item(dv, v)) = heap.pop() {
            if dv > self.ndist[v as usize] { continue; }
            let c = cell(self.nx[v as usize], self.ny[v as usize]);
            if dv < self.cell_dist[c] { self.cell_dist[c] = dv; }
            if self.flags[c] & ROOT != 0 {
                let t = &mut self.trees[self.root_tree[c] as usize - 1];
                if dv < t.link_dist { t.link_dist = dv; }
            }
            self.neighbours(v, &mut nb);
            for &u in &nb {
                let len = ((self.nx[u as usize] - self.nx[v as usize]).powi(2) + (self.ny[u as usize] - self.ny[v as usize]).powi(2)).sqrt();
                let nd = dv + len;
                if nd + 1e-4 < self.ndist[u as usize] { self.ndist[u as usize] = nd; heap.push(Item(nd, u)); }
            }
        }
    }

    // ---------- economy of the soil ----------
    fn digest(&mut self, dt: f32) {
        let rate = self.params.digest;
        let trans = self.params.transport;
        for k in 0..self.colonized.len() {
            let c = self.colonized[k] as usize;
            let n = self.nutrient[c];
            if n <= 1e-4 { continue; }
            let take = (rate * dt * n / (0.6 + n)).min(n);
            self.nutrient[c] = n - take;
            let eff = (-self.cell_dist[c] / trans).exp();
            self.yield_acc += (take * eff) as f64;
            self.digested += take as f64;
            self.energy = (self.energy + take).min(MAX_ENERGY);
            self.nut_u8[c] = quantize(self.nutrient[c]);
            if self.pulses.len() < 256 && self.cell_head[c] != NONE && self.fx_rng.chance(take * 1.5) {
                self.pulses.push(self.cell_head[c]);
            }
        }
    }

    fn symbiosis(&mut self, dt: f32) {
        let trans = self.params.transport;
        for t in &self.trees {
            if t.linked {
                let s = t.size * self.params.root_bonus * 0.12 * (-t.link_dist / trans).exp() * dt;
                self.sugar_acc += s as f64;
                self.sugar_total += s as f64;
            }
        }
    }

    pub fn take_yield(&mut self) -> f64 { std::mem::take(&mut self.yield_acc) }
    pub fn take_sugar(&mut self) -> f64 { std::mem::take(&mut self.sugar_acc) }
    pub fn remaining(&self) -> f64 { self.nutrient.iter().map(|&n| n as f64).sum() }

    /// Size of the network downstream of every node (how much it carries), for line thickness.
    /// Parents always come before their children, so one reverse pass is enough.
    pub fn compute_thickness(&mut self) {
        for v in self.nsub.iter_mut() { *v = 1.0 }
        for i in (1..self.nx.len()).rev() {
            let p = self.npar[i] as usize;
            self.nsub[p] += self.nsub[i];
        }
    }

    pub fn set_param(&mut self, id: u32, v: f32) {
        let p = &mut self.params;
        match id {
            0 => p.speed = v,
            1 => p.branch = v,
            2 => p.max_tips = v.max(1.0) as usize,
            3 => p.digest = v,
            4 => p.sense = v,
            5 => p.transport = v.max(1.0),
            6 => {
                let old = p.reach;
                p.reach = v as i32;
                // wider enzymes reach soil around hyphae that already exist
                if p.reach > old { for i in 0..self.nx.len() { let (x, y, d) = (self.nx[i], self.ny[i], self.ndist[i]); self.colonize(x, y, d, i as u32); } }
            }
            7 => p.fusion = v,
            8 => p.root_bonus = v,
            _ => {}
        }
    }

    // ---------- saving ----------
    // The soil is rebuilt from the seed; the save keeps what changed: nutrients, the network, tips.
    pub fn save(&mut self) -> &[u8] {
        let mut b = Vec::with_capacity(64 + CELLS * 2 + self.nx.len() * 12);
        b.extend_from_slice(b"MYC1");
        for v in [self.seed, self.biome, self.rng.0, self.nx.len() as u32, self.fused.len() as u32, self.tips.len() as u32] { b.extend_from_slice(&v.to_le_bytes()); }
        for v in [self.time, self.digested, self.sugar_total] { b.extend_from_slice(&v.to_le_bytes()); }
        b.extend_from_slice(&self.respawn.to_le_bytes());
        b.extend_from_slice(&self.energy.to_le_bytes());
        let p = self.params;
        for v in [p.speed, p.branch, p.max_tips as f32, p.digest, p.sense, p.transport, p.reach as f32, p.fusion, p.root_bonus] { b.extend_from_slice(&v.to_le_bytes()); }
        for &n in &self.nutrient { b.extend_from_slice(&n.to_le_bytes()); }
        for i in 0..self.nx.len() {
            b.extend_from_slice(&self.nx[i].to_le_bytes());
            b.extend_from_slice(&self.ny[i].to_le_bytes());
            b.extend_from_slice(&self.npar[i].to_le_bytes());
        }
        for &(a, c) in &self.fused { b.extend_from_slice(&a.to_le_bytes()); b.extend_from_slice(&c.to_le_bytes()); }
        for t in &self.tips {
            for v in [t.x, t.y, t.ang, t.travel] { b.extend_from_slice(&v.to_le_bytes()); }
            b.extend_from_slice(&t.node.to_le_bytes());
            b.push(t.stuck);
        }
        self.save_buf = b;
        &self.save_buf
    }

    pub fn load(data: &[u8]) -> Option<World> {
        let mut r = Reader { d: data, p: 0 };
        if r.bytes(4)? != b"MYC1" { return None; }
        let (seed, biome, rng, nodes, fused, tips) = (r.u32()?, r.u32()?, r.u32()?, r.u32()? as usize, r.u32()? as usize, r.u32()? as usize);
        let (time, digested, sugar_total) = (r.f64()?, r.f64()?, r.f64()?);
        let respawn = r.f32()?;
        let energy = r.f32()?;
        let mut w = World::new(seed, biome);
        let pv: Vec<f32> = (0..9).map(|_| r.f32()).collect::<Option<_>>()?;
        w.params = Params { speed: pv[0], branch: pv[1], max_tips: pv[2] as usize, digest: pv[3], sense: pv[4], transport: pv[5], reach: pv[6] as i32, fusion: pv[7], root_bonus: pv[8], lure: None };
        for i in 0..CELLS {
            w.nutrient[i] = r.f32()?;
            w.nut_u8[i] = quantize(w.nutrient[i]);
        }
        // forget the fresh colony and rebuild the saved one
        w.nx.clear(); w.ny.clear(); w.npar.clear(); w.ndist.clear(); w.nsub.clear();
        w.first_child.clear(); w.next_sibling.clear(); w.node_next.clear(); w.tips.clear(); w.colonized.clear(); w.seg_new.clear();
        w.cell_head.iter_mut().for_each(|h| *h = NONE);
        w.cell_dist.iter_mut().for_each(|d| *d = f32::INFINITY);
        for f in w.flags.iter_mut() { *f &= !COLONIZED }
        for t in w.trees.iter_mut() { t.linked = false; t.link_dist = f32::INFINITY }
        for i in 0..nodes {
            let (x, y, par) = (r.f32()?, r.f32()?, r.u32()?);
            if i == 0 {
                w.nx.push(x); w.ny.push(y); w.npar.push(NONE); w.ndist.push(0.0); w.nsub.push(1.0);
                w.first_child.push(NONE); w.next_sibling.push(NONE);
                let c = cell(x, y); w.node_next.push(w.cell_head[c]); w.cell_head[c] = 0;
                w.origin = (x, y);
                w.colonize(x, y, 0.0, 0);
            } else {
                if par as usize >= i { return None; }
                w.add_node(x, y, par);
            }
        }
        for _ in 0..fused { let (a, c) = (r.u32()?, r.u32()?); if a as usize >= nodes || c as usize >= nodes { return None; } w.fuse(a, c); }
        for _ in 0..tips {
            let (x, y, ang, travel, node, stuck) = (r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.u32()?, r.bytes(1)?[0]);
            if node as usize >= nodes { return None; }
            w.tips.push(Tip { x, y, ang, node, travel, stuck });
        }
        w.links.clear();
        w.seg_new.clear();
        w.rng = Rng(rng);
        w.time = time; w.digested = digested; w.sugar_total = sugar_total; w.respawn = respawn; w.energy = energy;
        if r.p != data.len() { return None; }
        Some(w)
    }
}

struct Reader<'a> { d: &'a [u8], p: usize }
impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> { let s = self.d.get(self.p..self.p + n)?; self.p += n; Some(s) }
    fn u32(&mut self) -> Option<u32> { Some(u32::from_le_bytes(self.bytes(4)?.try_into().ok()?)) }
    fn f32(&mut self) -> Option<f32> { Some(f32::from_le_bytes(self.bytes(4)?.try_into().ok()?)) }
    fn f64(&mut self) -> Option<f64> { Some(f64::from_le_bytes(self.bytes(8)?.try_into().ok()?)) }
}
