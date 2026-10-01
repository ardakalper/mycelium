//! Small deterministic generator (xorshift32 plus a mixer). Every run is reproducible from its seed.

#[derive(Clone)]
pub struct Rng(pub u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        // splitmix-style scramble so nearby seeds give unrelated streams; never zero
        let mut z = seed.wrapping_add(0x9e37_79b9);
        z = (z ^ (z >> 16)).wrapping_mul(0x85eb_ca6b);
        z = (z ^ (z >> 13)).wrapping_mul(0xc2b2_ae35);
        z ^= z >> 16;
        Rng(if z == 0 { 0x1234_5678 } else { z })
    }
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// uniform in [0, 1)
    pub fn f32(&mut self) -> f32 { (self.next_u32() >> 8) as f32 / 16_777_216.0 }
    pub fn range(&mut self, a: f32, b: f32) -> f32 { a + (b - a) * self.f32() }
    pub fn int(&mut self, a: i32, b: i32) -> i32 { a + (self.f32() * (b - a + 1) as f32) as i32 }
    pub fn chance(&mut self, p: f32) -> bool { self.f32() < p }
    /// roughly normal, mean 0, sd 1 (sum of four uniforms)
    pub fn normal(&mut self) -> f32 {
        (self.f32() + self.f32() + self.f32() + self.f32() - 2.0) * 1.732
    }
}

/// Smooth value noise in [0, 1], used for soil and nutrient fields.
pub fn value_noise(seed: u32, x: f32, y: f32) -> f32 {
    let hash = |ix: i32, iy: i32| -> f32 {
        let mut h = (ix as u32).wrapping_mul(374_761_393) ^ (iy as u32).wrapping_mul(668_265_263) ^ seed.wrapping_mul(2_246_822_519);
        h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
        ((h ^ (h >> 16)) & 0xffff) as f32 / 65_535.0
    };
    let (x0, y0) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let a = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx;
    let b = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx;
    a + (b - a) * sy
}

pub fn fbm(seed: u32, x: f32, y: f32, octaves: u32) -> f32 {
    let (mut sum, mut amp, mut freq, mut norm) = (0.0, 1.0, 1.0, 0.0);
    for o in 0..octaves {
        sum += value_noise(seed.wrapping_add(o * 977), x * freq, y * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}
