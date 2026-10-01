// TypeScript side of the Rust simulation (sim/src/ffi.rs). The module exports plain functions; arrays
// are read straight out of wasm memory through typed-array views, so nothing is copied. Views are
// rebuilt on every read because memory.grow() detaches the old buffer.

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  world_new(seed: number, biome: number): number;
  world_free(w: number): void;
  world_step(w: number, dt: number): void;
  world_set_param(w: number, id: number, v: number): void;
  world_set_lure(w: number, x: number, y: number, on: number): void;
  world_take_yield(w: number): number;
  world_take_sugar(w: number): number;
  world_digested(w: number): number;
  world_initial_total(w: number): number;
  world_remaining(w: number): number;
  world_time(w: number): number;
  world_seed(w: number): number;
  world_biome(w: number): number;
  world_fusions(w: number): number;
  world_colonized(w: number): number;
  world_origin_x(w: number): number;
  world_origin_y(w: number): number;
  grid_w(): number;
  grid_h(): number;
  nodes_len(w: number): number;
  nodes_x(w: number): number;
  nodes_y(w: number): number;
  nodes_parent(w: number): number;
  nodes_dist(w: number): number;
  nodes_thickness(w: number): number;
  fused_len(w: number): number;
  fused_ptr(w: number): number;
  segs_len(w: number): number;
  segs_ptr(w: number): number;
  segs_clear(w: number): void;
  tips_len(w: number): number;
  tips_ptr(w: number): number;
  pulses_len(w: number): number;
  pulses_ptr(w: number): number;
  pulses_clear(w: number): void;
  links_len(w: number): number;
  links_ptr(w: number): number;
  links_clear(w: number): void;
  soil_nutrient(w: number): number;
  soil_flags(w: number): number;
  roots_len(w: number): number;
  roots_ptr(w: number): number;
  objects_len(w: number): number;
  objects_ptr(w: number): number;
  trees_len(w: number): number;
  trees_ptr(w: number): number;
  world_save(w: number): number;
  world_save_ptr(w: number): number;
  world_load(ptr: number, len: number): number;
}

export const PARAM = { speed: 0, branch: 1, maxTips: 2, digest: 3, sense: 4, transport: 5, reach: 6, fusion: 7, rootBonus: 8 } as const;
export type ParamName = keyof typeof PARAM;
export type Params = Record<ParamName, number>;

export const FLAG = { rock: 1, root: 2, colonized: 4, log: 8 } as const;

export interface TreeInfo { x: number; size: number; linked: boolean; efficiency: number }
export interface SoilObject { kind: 'log' | 'cache' | 'stump'; x: number; y: number; w: number; h: number }

export class SimModule {
  readonly x: Exports;
  readonly gw: number;
  readonly gh: number;

  private constructor(x: Exports) {
    this.x = x;
    this.gw = x.grid_w();
    this.gh = x.grid_h();
  }

  static async load(source: BufferSource | Response | Promise<Response>): Promise<SimModule> {
    let instance: WebAssembly.Instance;
    if (source instanceof Response || source instanceof Promise) {
      const res = await source;
      if (!res.ok) throw new Error(`could not load the simulation (${res.status})`);
      try {
        ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), {}));
      } catch {
        // servers that send the wrong MIME type: fall back to bytes
        ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {}));
      }
    } else {
      ({ instance } = await WebAssembly.instantiate(source, {}));
    }
    return new SimModule(instance.exports as unknown as Exports);
  }

  create(seed: number, biome: number): World { return new World(this, this.x.world_new(seed >>> 0, biome >>> 0)); }

  // null if the save is damaged
  restore(bytes: Uint8Array): World | null {
    const ptr = this.x.alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    const w = this.x.world_load(ptr, bytes.length);
    this.x.dealloc(ptr, bytes.length);
    return w ? new World(this, w) : null;
  }
}

export class World {
  private readonly m: SimModule;
  private readonly x: Exports;
  private h: number;

  constructor(m: SimModule, handle: number) {
    this.m = m;
    this.x = m.x;
    this.h = handle;
  }

  private f32(ptr: number, len: number): Float32Array { return new Float32Array(this.x.memory.buffer, ptr, len); }
  private u32(ptr: number, len: number): Uint32Array { return new Uint32Array(this.x.memory.buffer, ptr, len); }
  private u8(ptr: number, len: number): Uint8Array { return new Uint8Array(this.x.memory.buffer, ptr, len); }

  get alive(): boolean { return this.h !== 0; }
  free(): void { if (this.h) { this.x.world_free(this.h); this.h = 0; } }

  step(dt: number): void { this.x.world_step(this.h, dt); }
  setParams(p: Partial<Params>): void {
    for (const [k, v] of Object.entries(p)) this.x.world_set_param(this.h, PARAM[k as ParamName], v as number);
  }
  setLure(at: { x: number; y: number } | null): void { this.x.world_set_lure(this.h, at?.x ?? 0, at?.y ?? 0, at ? 1 : 0); }
  takeYield(): number { return this.x.world_take_yield(this.h); }
  takeSugar(): number { return this.x.world_take_sugar(this.h); }

  get seed(): number { return this.x.world_seed(this.h); }
  get biome(): number { return this.x.world_biome(this.h); }
  get time(): number { return this.x.world_time(this.h); }
  get digested(): number { return this.x.world_digested(this.h); }
  get initialFood(): number { return this.x.world_initial_total(this.h); }
  get remainingFood(): number { return this.x.world_remaining(this.h); }
  get fusions(): number { return this.x.world_fusions(this.h); }
  get colonized(): number { return this.x.world_colonized(this.h); }
  get origin(): { x: number; y: number } { return { x: this.x.world_origin_x(this.h), y: this.x.world_origin_y(this.h) }; }
  get gw(): number { return this.m.gw; }
  get gh(): number { return this.m.gh; }

  get nodeCount(): number { return this.x.nodes_len(this.h); }
  nodes(): { x: Float32Array; y: Float32Array; parent: Uint32Array } {
    const n = this.nodeCount;
    return { x: this.f32(this.x.nodes_x(this.h), n), y: this.f32(this.x.nodes_y(this.h), n), parent: this.u32(this.x.nodes_parent(this.h), n) };
  }
  // how much of the network drains through each node (computed on demand)
  thickness(): Float32Array { const p = this.x.nodes_thickness(this.h); return this.f32(p, this.nodeCount); }
  distances(): Float32Array { return this.f32(this.x.nodes_dist(this.h), this.nodeCount); }
  fused(): Uint32Array { return this.u32(this.x.fused_ptr(this.h), this.x.fused_len(this.h) * 2); }

  // segments grown since the last call: x1, y1, x2, y2, …
  takeSegments(): Float32Array {
    const s = this.f32(this.x.segs_ptr(this.h), this.x.segs_len(this.h)).slice();
    this.x.segs_clear(this.h);
    return s;
  }
  tips(): Float32Array { const n = this.x.tips_len(this.h); return this.f32(this.x.tips_ptr(this.h), n * 3); }
  takePulses(): Uint32Array {
    const s = this.u32(this.x.pulses_ptr(this.h), this.x.pulses_len(this.h)).slice();
    this.x.pulses_clear(this.h);
    return s;
  }
  takeLinks(): number[] {
    const s = Array.from(this.u32(this.x.links_ptr(this.h), this.x.links_len(this.h)));
    this.x.links_clear(this.h);
    return s;
  }
  nutrients(): Uint8Array { return this.u8(this.x.soil_nutrient(this.h), this.gw * this.gh); }
  flags(): Uint8Array { return this.u8(this.x.soil_flags(this.h), this.gw * this.gh); }
  roots(): Float32Array { return this.f32(this.x.roots_ptr(this.h), this.x.roots_len(this.h)); }
  objects(): SoilObject[] {
    const o = this.f32(this.x.objects_ptr(this.h), this.x.objects_len(this.h)), out: SoilObject[] = [];
    for (let i = 0; i < o.length; i += 6) out.push({ kind: (['log', 'cache', 'stump'] as const)[o[i]], x: o[i + 1], y: o[i + 2], w: o[i + 3], h: o[i + 4] });
    return out;
  }
  trees(): TreeInfo[] {
    const n = this.x.trees_len(this.h), t = this.f32(this.x.trees_ptr(this.h), n * 4), out: TreeInfo[] = [];
    for (let i = 0; i < n; i++) out.push({ x: t[i * 4], size: t[i * 4 + 1], linked: t[i * 4 + 2] > 0, efficiency: t[i * 4 + 3] });
    return out;
  }
  save(): Uint8Array {
    const len = this.x.world_save(this.h);
    return this.u8(this.x.world_save_ptr(this.h), len).slice();
  }
}
