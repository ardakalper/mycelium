// Generative ambience with plain Web Audio: a low drone that breathes, and soft drips from a
// pentatonic scale when food reaches the colony, echoing as if in a cave. Starts on the first click.

const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private echo: DelayNode | null = null;
  private lastDrip = 0;
  on = true;

  start(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.on ? 0.55 : 0;
    master.connect(ctx.destination);
    // cave echo
    const echo = (this.echo = ctx.createDelay(1.5)), fb = ctx.createGain(), tone = ctx.createBiquadFilter();
    echo.delayTime.value = 0.42; fb.gain.value = 0.38; tone.type = 'lowpass'; tone.frequency.value = 1800;
    echo.connect(tone).connect(fb).connect(echo);
    tone.connect(master);
    // drone: two detuned voices through a slowly swaying filter
    const filt = ctx.createBiquadFilter(), dg = ctx.createGain(), lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    filt.type = 'lowpass'; filt.frequency.value = 320; filt.Q.value = 2;
    dg.gain.value = 0.07;
    lfo.frequency.value = 0.05; lfoAmt.gain.value = 180;
    lfo.connect(lfoAmt).connect(filt.frequency);
    for (const [f, type] of [[midi(33), 'sawtooth'], [midi(40) * 1.003, 'triangle'], [midi(45) * 0.997, 'sine']] as const) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(filt); o.start();
    }
    filt.connect(dg).connect(master);
    lfo.start();
  }

  setOn(on: boolean): void {
    this.on = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.3);
  }
  get running(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  private tone(freq: number, { type = 'triangle' as OscillatorType, gain = 0.12, attack = 0.005, decay = 1.2, wet = 0.6, at = 0 } = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.on) return;
    const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(g); g.connect(this.master);
    if (this.echo && wet) { const send = ctx.createGain(); send.gain.value = wet; g.connect(send).connect(this.echo); }
    o.start(t); o.stop(t + attack + decay + 0.05);
  }

  // food arriving home: at most a few drips a second
  drip(): void {
    const now = performance.now();
    if (now - this.lastDrip < 380) return;
    this.lastDrip = now;
    const n = 69 + SCALE[Math.floor(Math.random() * SCALE.length)] + (Math.random() < 0.3 ? 12 : 0);
    this.tone(midi(n), { gain: 0.06, decay: 0.9 });
  }
  // a tree joins the network: a low bell
  bell(): void { this.tone(midi(45), { type: 'sine', gain: 0.18, decay: 3.5, attack: 0.02 }); this.tone(midi(45) * 2.76, { type: 'sine', gain: 0.05, decay: 2.5, attack: 0.02 }); }
  pluck(): void { this.tone(midi(76), { gain: 0.09, decay: 0.5, wet: 0.3 }); this.tone(midi(81), { gain: 0.07, decay: 0.6, wet: 0.3, at: 0.07 }); }
  buy(): void { this.tone(midi(81 + SCALE[Math.floor(Math.random() * 5)]), { type: 'sine', gain: 0.06, decay: 0.35, wet: 0.2 }); }
  // fruiting: a rising arpeggio that blooms
  bloom(): void { [57, 60, 64, 67, 69, 72, 76, 79].forEach((n, i) => this.tone(midi(n), { type: 'sine', gain: 0.09, decay: 2.2, at: i * 0.14 })); }
}
