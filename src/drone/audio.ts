/**
 * Synthesised motor sound: four slightly detuned props (sawtooth band, low-passed) plus rotor
 * wash (band-passed noise). Pitch and level follow spin-up and load. No audio files.
 * Browsers only start audio after a user gesture, so `unlock()` is called from key handlers.
 */
const HOVER_HZ = 182;
const DETUNE = [1, 1.0063, 0.9942, 1.0121];
const MASTER = 0.11;

export class MotorAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private body: BiquadFilterNode | null = null;
  private air: GainNode | null = null;
  private noise: AudioBufferSourceNode | null = null;
  muted = false;

  unlock(): void {
    try {
      if (this.ctx == null) this.build();
      if (this.ctx?.state === 'suspended') void this.ctx.resume();
    } catch {
      // no audio available: stay silent
    }
  }

  private build(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx == null) return;
    const ctx = new Ctx();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 1300;
    body.Q.value = 0.9;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.22;
    body.connect(bodyGain).connect(master);

    for (const k of DETUNE) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = HOVER_HZ * k;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      osc.connect(g).connect(body);
      osc.start();
      this.oscillators.push(osc);
    }

    // Rotor wash: looping white noise through a broad band-pass.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 850;
    band.Q.value = 0.55;
    const air = ctx.createGain();
    air.gain.value = 0;
    noise.connect(band).connect(air).connect(master);
    noise.start();

    this.ctx = ctx;
    this.master = master;
    this.body = body;
    this.air = air;
    this.noise = noise;
  }

  /**
   * @param spin 0 = motors stopped, 1 = hover rpm
   * @param load 0..1 extra effort (climbing, speed, yaw)
   */
  update(spin: number, load: number): void {
    const ctx = this.ctx;
    if (ctx == null || this.master == null || this.air == null || this.body == null) return;
    const now = ctx.currentTime;
    const s = Math.max(0, Math.min(1.2, spin));
    const l = Math.max(0, Math.min(1, load));
    const hz = HOVER_HZ * (0.3 + 0.7 * s) * (1 + 0.22 * l);
    this.oscillators.forEach((osc, i) => osc.frequency.setTargetAtTime(hz * DETUNE[i]!, now, 0.06));
    this.body.frequency.setTargetAtTime(900 + 900 * s + 600 * l, now, 0.08);
    this.air.gain.setTargetAtTime((0.25 + 0.35 * l) * s, now, 0.08);
    const level = this.muted ? 0 : MASTER * Math.min(1, s * 1.2) * (0.85 + 0.3 * l);
    this.master.gain.setTargetAtTime(level, now, 0.1);
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx == null) return;
    try {
      this.master?.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      window.setTimeout(() => {
        this.oscillators.forEach((o) => o.stop());
        this.noise?.stop();
        void ctx.close();
      }, 200);
    } catch {
      // already closed
    }
  }
}
