use mycelium_sim::*;
use std::collections::{BinaryHeap, HashMap};

fn grown(seed: u32, secs: f32, tune: impl Fn(&mut World)) -> World {
    let mut w = World::new(seed, seed % BIOME_COUNT);
    tune(&mut w);
    for _ in 0..(secs / 0.05) as usize { w.step(0.05); }
    w
}
fn busy(w: &mut World) {
    w.set_param(0, 4.0);
    w.set_param(1, 0.15);
    w.set_param(2, 40.0);
    w.set_param(4, 6.0);
    w.set_param(7, 0.9);
}

#[test]
fn same_seed_same_soil_and_every_biome_is_sane() {
    for seed in [1, 2, 3, 4, 77, 12345] {
        let a = World::new(seed, seed % BIOME_COUNT);
        let b = World::new(seed, seed % BIOME_COUNT);
        assert_eq!(a.nutrient, b.nutrient);
        assert_eq!(a.flags, b.flags);
        assert!(a.initial_total > 1000.0, "seed {seed}: some food in the soil");
        assert!(a.nutrient.iter().all(|n| n.is_finite() && *n >= 0.0 && *n <= 5.0));
        let (ox, oy) = a.origin;
        assert_eq!(a.flags[cell(ox, oy)] & ROCK, 0, "the spore lands on soil");
        assert!(a.trees.len() >= 3);
        for t in 0..a.trees.len() { assert!(a.root_tree.iter().any(|&r| r as usize == t + 1), "tree {t} has roots"); }
        assert!((0..GW).all(|x| a.flags[(GH - 1) * GW + x] & ROCK != 0), "bedrock at the bottom");
        assert!(!a.roots.is_empty() && !a.objects.is_empty());
    }
    assert_ne!(World::new(1, 0).nutrient, World::new(2, 0).nutrient);
}

#[test]
fn the_colony_grows_inside_the_soil() {
    let w = grown(7, 120.0, busy);
    let n = w.nx.len();
    assert!(n > 400, "grew {n} nodes");
    assert!(w.tips.len() <= 40);
    for i in 0..n {
        let (x, y) = (w.nx[i], w.ny[i]);
        assert!(x >= 0.0 && y >= 0.0 && x < GW as f32 && y < GH as f32);
        assert_eq!(w.flags[cell(x, y)] & ROCK, 0, "node {i} is not inside rock");
        assert!(w.ndist[i].is_finite());
        if i > 0 { assert!((w.npar[i] as usize) < i, "parents come first"); }
    }
}

#[test]
fn digestion_conserves_food_and_distance_costs_yield() {
    let mut near = World::new(9, 0);
    busy(&mut near);
    let mut far = World::new(9, 0);
    busy(&mut far);
    far.set_param(5, 8.0); // food barely gets home
    let (mut y_near, mut y_far) = (0.0, 0.0);
    for _ in 0..1600 { near.step(0.05); far.step(0.05); y_near += near.take_yield(); y_far += far.take_yield(); }
    let eaten = near.initial_total - near.remaining();
    assert!((eaten - near.digested).abs() < near.digested * 0.01 + 1.0, "eaten {eaten} vs digested {}", near.digested);
    assert!(y_near <= near.digested + 1e-6);
    assert!(y_near > 0.0);
    assert!(y_far < y_near * 0.7, "transport matters: {y_far} vs {y_near}");
}

#[test]
fn fusions_make_shortcuts_and_distances_stay_shortest_paths() {
    let mut w = grown(21, 150.0, busy);
    assert!(!w.fused.is_empty(), "hyphae fused");
    // Dijkstra from the origin over hyphae and fusions, from scratch
    let n = w.nx.len();
    let mut adj: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut link = |a: usize, b: usize| { adj.entry(a).or_default().push(b); adj.entry(b).or_default().push(a); };
    for i in 1..n { link(i, w.npar[i] as usize); }
    for &(a, b) in &w.fused { link(a as usize, b as usize); }
    let len = |a: usize, b: usize| ((w.nx[a] - w.nx[b]).powi(2) + (w.ny[a] - w.ny[b]).powi(2)).sqrt() as f64;
    let mut best = vec![f64::INFINITY; n];
    best[0] = 0.0;
    let mut heap = BinaryHeap::new();
    heap.push((std::cmp::Reverse(0u64), 0usize));
    while let Some((std::cmp::Reverse(dk), v)) = heap.pop() {
        let d = dk as f64 / 1e6;
        if d > best[v] + 1e-9 { continue; }
        for &u in adj.get(&v).map(|v| v.as_slice()).unwrap_or(&[]) {
            let nd = d + len(v, u);
            if nd + 1e-9 < best[u] { best[u] = nd; heap.push((std::cmp::Reverse((nd * 1e6) as u64), u)); }
        }
    }
    for (i, &b) in best.iter().enumerate() { assert!((w.ndist[i] as f64 - b).abs() < 0.05 + b * 1e-4, "node {i}: {} vs {b}", w.ndist[i]); }
    w.compute_thickness();
    assert_eq!(w.nsub[0] as usize, n, "everything drains through the origin");
}

#[test]
fn roots_link_trees_and_pay_sugar() {
    let mut w = World::new(5, 0);
    busy(&mut w);
    w.set_param(2, 80.0);
    let mut sugar = 0.0;
    for _ in 0..6000 { w.step(0.05); sugar += w.take_sugar(); }
    assert!(w.trees.iter().any(|t| t.linked), "a tree was reached");
    assert!(!w.links.is_empty());
    assert!(sugar > 0.0);
}

#[test]
fn a_lure_pulls_the_hyphae() {
    let centre = |w: &World| w.nx.iter().sum::<f32>() / w.nx.len() as f32;
    let plain = grown(31, 60.0, busy);
    // this colony drifts right on its own, so put the lure on its left
    let lured = grown(31, 60.0, |w| { busy(w); let (ox, oy) = w.origin; w.params.lure = Some((ox - 80.0, oy + 30.0)); });
    assert!(centre(&lured) < centre(&plain) - 40.0, "{} vs {}", centre(&lured), centre(&plain));
}

#[test]
fn wider_enzymes_reach_more_soil() {
    let mut w = grown(3, 40.0, busy);
    let before = w.colonized.len();
    w.set_param(6, 1.0);
    assert!(w.colonized.len() * 2 > before * 3, "{} vs {before}", w.colonized.len());
}

#[test]
fn a_saved_world_continues_exactly() {
    let mut a = grown(11, 80.0, busy);
    let bytes = a.save().to_vec();
    let mut b = World::load(&bytes).expect("loads");
    assert_eq!(b.nx, a.nx);
    assert_eq!(b.tips, a.tips);
    assert_eq!(b.nutrient, a.nutrient);
    for _ in 0..800 { a.step(0.05); b.step(0.05); }
    assert_eq!(b.nx.len(), a.nx.len());
    assert_eq!(b.nx, a.nx);
    assert_eq!(b.ny, a.ny);
    assert_eq!(b.fused, a.fused);
    assert!((b.digested - a.digested).abs() < a.digested * 1e-3);
    // broken saves are refused, not trusted
    assert!(World::load(b"nope").is_none());
    assert!(World::load(&bytes[..bytes.len() - 3]).is_none());
    let mut bad = bytes.clone();
    bad[0] = b'X';
    assert!(World::load(&bad).is_none());
}
