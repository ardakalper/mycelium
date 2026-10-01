//! The boundary the page talks to. No wasm-bindgen: plain C functions that take a world handle and
//! numbers, plus pointers into wasm memory that the page wraps in typed arrays (zero copies).
//! Any pointer returned here stays valid until the next call that may grow the world.
use crate::world::*;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
/// # Safety
/// `p` and `len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, len: usize) { drop(Vec::from_raw_parts(p, 0, len)) }

#[no_mangle]
pub extern "C" fn world_new(seed: u32, biome: u32) -> *mut World { Box::into_raw(Box::new(World::new(seed, biome))) }

macro_rules! w { ($p:expr) => { unsafe { &mut *$p } } }

/// # Safety
/// `p` must be a live handle from `world_new` or `world_load`.
#[no_mangle]
pub unsafe extern "C" fn world_free(p: *mut World) { drop(Box::from_raw(p)) }
#[no_mangle] pub extern "C" fn world_step(p: *mut World, dt: f32) { w!(p).step(dt) }
#[no_mangle] pub extern "C" fn world_set_param(p: *mut World, id: u32, v: f32) { w!(p).set_param(id, v) }
#[no_mangle] pub extern "C" fn world_set_lure(p: *mut World, x: f32, y: f32, on: u32) { w!(p).params.lure = if on != 0 { Some((x, y)) } else { None } }
#[no_mangle] pub extern "C" fn world_take_yield(p: *mut World) -> f64 { w!(p).take_yield() }
#[no_mangle] pub extern "C" fn world_take_sugar(p: *mut World) -> f64 { w!(p).take_sugar() }
#[no_mangle] pub extern "C" fn world_digested(p: *mut World) -> f64 { w!(p).digested }
#[no_mangle] pub extern "C" fn world_initial_total(p: *mut World) -> f64 { w!(p).initial_total }
#[no_mangle] pub extern "C" fn world_remaining(p: *mut World) -> f64 { w!(p).remaining() }
#[no_mangle] pub extern "C" fn world_energy(p: *mut World) -> f32 { w!(p).energy }
#[no_mangle] pub extern "C" fn world_time(p: *mut World) -> f64 { w!(p).time }
#[no_mangle] pub extern "C" fn world_seed(p: *mut World) -> u32 { w!(p).seed }
#[no_mangle] pub extern "C" fn world_biome(p: *mut World) -> u32 { w!(p).biome }
#[no_mangle] pub extern "C" fn world_fusions(p: *mut World) -> u32 { w!(p).fused.len() as u32 }
#[no_mangle] pub extern "C" fn world_colonized(p: *mut World) -> u32 { w!(p).colonized.len() as u32 }
#[no_mangle] pub extern "C" fn world_origin_x(p: *mut World) -> f32 { w!(p).origin.0 }
#[no_mangle] pub extern "C" fn world_origin_y(p: *mut World) -> f32 { w!(p).origin.1 }
#[no_mangle] pub extern "C" fn grid_w() -> u32 { GW as u32 }
#[no_mangle] pub extern "C" fn grid_h() -> u32 { GH as u32 }

// network
#[no_mangle] pub extern "C" fn nodes_len(p: *mut World) -> u32 { w!(p).nx.len() as u32 }
#[no_mangle] pub extern "C" fn nodes_x(p: *mut World) -> *const f32 { w!(p).nx.as_ptr() }
#[no_mangle] pub extern "C" fn nodes_y(p: *mut World) -> *const f32 { w!(p).ny.as_ptr() }
#[no_mangle] pub extern "C" fn nodes_parent(p: *mut World) -> *const u32 { w!(p).npar.as_ptr() }
#[no_mangle] pub extern "C" fn nodes_dist(p: *mut World) -> *const f32 { w!(p).ndist.as_ptr() }
#[no_mangle] pub extern "C" fn nodes_thickness(p: *mut World) -> *const f32 { let w = w!(p); w.compute_thickness(); w.nsub.as_ptr() }
#[no_mangle] pub extern "C" fn fused_len(p: *mut World) -> u32 { w!(p).fused.len() as u32 }
#[no_mangle] pub extern "C" fn fused_ptr(p: *mut World) -> *const u32 { w!(p).fused.as_ptr() as *const u32 }
// new segments since the last clear: x1, y1, x2, y2
#[no_mangle] pub extern "C" fn segs_len(p: *mut World) -> u32 { w!(p).seg_new.len() as u32 }
#[no_mangle] pub extern "C" fn segs_ptr(p: *mut World) -> *const f32 { w!(p).seg_new.as_ptr() }
#[no_mangle] pub extern "C" fn segs_clear(p: *mut World) { w!(p).seg_new.clear() }
// growing tips: x, y, angle
#[no_mangle]
pub extern "C" fn tips_ptr(p: *mut World) -> *const f32 {
    let w = w!(p);
    w.buf.clear();
    for t in &w.tips { w.buf.extend_from_slice(&[t.x, t.y, t.ang]); }
    w.buf.as_ptr()
}
#[no_mangle] pub extern "C" fn tips_len(p: *mut World) -> u32 { w!(p).tips.len() as u32 }
// nodes where something was just digested (for the light pulses travelling home)
#[no_mangle] pub extern "C" fn pulses_len(p: *mut World) -> u32 { w!(p).pulses.len() as u32 }
#[no_mangle] pub extern "C" fn pulses_ptr(p: *mut World) -> *const u32 { w!(p).pulses.as_ptr() }
#[no_mangle] pub extern "C" fn pulses_clear(p: *mut World) { w!(p).pulses.clear() }
// trees that just formed a mycorrhizal link
#[no_mangle] pub extern "C" fn links_len(p: *mut World) -> u32 { w!(p).links.len() as u32 }
#[no_mangle] pub extern "C" fn links_ptr(p: *mut World) -> *const u32 { w!(p).links.as_ptr() }
#[no_mangle] pub extern "C" fn links_clear(p: *mut World) { w!(p).links.clear() }

// soil
#[no_mangle] pub extern "C" fn soil_nutrient(p: *mut World) -> *const u8 { w!(p).nut_u8.as_ptr() }
#[no_mangle] pub extern "C" fn soil_flags(p: *mut World) -> *const u8 { w!(p).flags.as_ptr() }
#[no_mangle] pub extern "C" fn roots_len(p: *mut World) -> u32 { w!(p).roots.len() as u32 }
#[no_mangle] pub extern "C" fn roots_ptr(p: *mut World) -> *const f32 { w!(p).roots.as_ptr() }
#[no_mangle] pub extern "C" fn objects_len(p: *mut World) -> u32 { w!(p).objects.len() as u32 }
#[no_mangle] pub extern "C" fn objects_ptr(p: *mut World) -> *const f32 { w!(p).objects.as_ptr() }
// trees: x, size, linked, link efficiency
#[no_mangle] pub extern "C" fn trees_len(p: *mut World) -> u32 { w!(p).trees.len() as u32 }
#[no_mangle]
pub extern "C" fn trees_ptr(p: *mut World) -> *const f32 {
    let w = w!(p);
    let trans = w.params.transport;
    w.buf.clear();
    for t in &w.trees { w.buf.extend_from_slice(&[t.x, t.size, t.linked as u32 as f32, if t.linked { (-t.link_dist / trans).exp() } else { 0.0 }]); }
    w.buf.as_ptr()
}

// saving
#[no_mangle] pub extern "C" fn world_save(p: *mut World) -> u32 { w!(p).save().len() as u32 }
#[no_mangle] pub extern "C" fn world_save_ptr(p: *mut World) -> *const u8 { w!(p).save_buf.as_ptr() }
/// # Safety
/// `data` must point to `len` readable bytes (from `alloc`). Returns null if the save is broken.
#[no_mangle]
pub unsafe extern "C" fn world_load(data: *const u8, len: usize) -> *mut World {
    let bytes = std::slice::from_raw_parts(data, len);
    match World::load(bytes) { Some(w) => Box::into_raw(Box::new(w)), None => std::ptr::null_mut() }
}
