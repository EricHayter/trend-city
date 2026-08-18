// AUDIO
// Every sound in the game is synthesised at runtime with the Web Audio API. There are
// no audio files anywhere in the project. Noise buffers, the reverb impulse and the
// music are all generated in code on the first user gesture.

export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  reverbBus: GainNode;
  private noise: AudioBuffer;
  private started = false;
  private windSource: AudioBufferSourceNode | null = null;
  private windGain: GainNode;
  private windFilter: BiquadFilterNode;
  private speedOsc: OscillatorNode | null = null;
  private speedGain: GainNode;
  private grindNoise: AudioBufferSourceNode | null = null;
  private grindGain: GainNode;
  private grindFilter: BiquadFilterNode;
  muted = false;

  /** Called on the first click or key press, as browsers require. */
  init(): boolean {
    if (this.started) return true;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return false;
    this.ctx = new Ctor();
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0.82;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.5;
    this.musicBus.connect(this.master);

    // Reverb impulse: exponentially decaying noise, generated, never loaded.
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.7);
    const imp = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = imp.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.1) * (0.5 + 0.5 * Math.sin(t * 40 + c));
      }
    }
    conv.buffer = imp;
    this.reverbBus = ctx.createGain();
    this.reverbBus.gain.value = 0.3;
    this.reverbBus.connect(conv);
    conv.connect(this.master);

    // White noise buffer, reused by every noise-based sound.
    const nlen = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    // Continuous wind layer, driven by speed.
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.7;
    this.windGain.connect(this.master);
    this.windFilter.connect(this.windGain);
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = this.noise;
    this.windSource.loop = true;
    this.windSource.connect(this.windFilter);
    this.windSource.start();

    // Grind layer: filtered noise plus a metallic resonance, gated by the grind state.
    this.grindGain = ctx.createGain();
    this.grindGain.gain.value = 0;
    this.grindFilter = ctx.createBiquadFilter();
    this.grindFilter.type = 'bandpass';
    this.grindFilter.frequency.value = 2400;
    this.grindFilter.Q.value = 6;
    this.grindGain.connect(this.sfxBus);
    this.grindFilter.connect(this.grindGain);
    this.grindNoise = ctx.createBufferSource();
    this.grindNoise.buffer = this.noise;
    this.grindNoise.loop = true;
    this.grindNoise.connect(this.grindFilter);
    this.grindNoise.start();

    // Speed tone: a quiet sub-harmonic that rises with velocity.
    this.speedGain = ctx.createGain();
    this.speedGain.gain.value = 0;
    this.speedGain.connect(this.master);
    this.speedOsc = ctx.createOscillator();
    this.speedOsc.type = 'sawtooth';
    this.speedOsc.frequency.value = 60;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    this.speedOsc.connect(lp);
    lp.connect(this.speedGain);
    this.speedOsc.start();

    this.started = true;
    return true;
  }

  get ready() { return this.started && !!this.ctx; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  private env(node: AudioNode, gain: number, attack: number, decay: number, when = 0): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime + when;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    return g;
  }

  /** Core tonal one-shot: oscillator with pitch sweep, filter and envelope. */
  tone(freq: number, endFreq: number, dur: number, type: OscillatorType, gain = 0.3, filter = 0, reverb = 0.12, when = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
    let node: AudioNode = osc;
    if (filter > 0) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(filter, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(120, filter * 0.35), t + dur);
      osc.connect(f);
      node = f;
    }
    const g = this.env(node, gain, Math.min(0.012, dur * 0.2), dur, when);
    g.connect(this.sfxBus);
    if (reverb > 0) {
      const rg = ctx.createGain();
      rg.gain.value = reverb;
      g.connect(rg);
      rg.connect(this.reverbBus);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Core noise one-shot: filtered noise burst, the backbone of every impact. */
  burst(dur: number, freq: number, q: number, gain = 0.3, type: BiquadFilterType = 'bandpass', reverb = 0.16, when = 0, sweepTo = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo > 0) f.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t + dur);
    f.Q.value = q;
    src.connect(f);
    const g = this.env(f, gain, Math.min(0.008, dur * 0.15), dur, when);
    g.connect(this.sfxBus);
    const rg = ctx.createGain();
    rg.gain.value = reverb;
    g.connect(rg);
    rg.connect(this.reverbBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // ---- gameplay sounds -----------------------------------------------------
  jump() { this.tone(320, 780, 0.16, 'triangle', 0.26, 2600, 0.1); this.burst(0.08, 900, 1.2, 0.1); }
  doubleJump() { this.tone(520, 1180, 0.18, 'triangle', 0.24, 3200, 0.14); this.tone(780, 1560, 0.12, 'sine', 0.12); }
  wallJump() { this.burst(0.12, 1400, 2.4, 0.2, 'bandpass', 0.2, 0, 500); this.tone(420, 900, 0.14, 'square', 0.14, 2400); }
  dash(air: boolean) {
    this.burst(0.2, air ? 2200 : 1500, 1.6, 0.26, 'bandpass', 0.18, 0, air ? 500 : 300);
    this.tone(air ? 900 : 620, air ? 240 : 180, 0.22, 'sawtooth', 0.16, 2600, 0.12);
  }
  homing() { this.tone(220, 1800, 0.2, 'sawtooth', 0.2, 4200, 0.2); this.burst(0.14, 3000, 3, 0.14); }
  land(hard: boolean, speed: number) {
    const g = Math.min(0.5, 0.14 + speed * 0.004);
    this.burst(hard ? 0.34 : 0.16, hard ? 180 : 420, hard ? 0.8 : 1.4, g, 'lowpass', hard ? 0.34 : 0.16);
    this.tone(hard ? 90 : 160, hard ? 46 : 90, hard ? 0.3 : 0.14, 'sine', g * 0.9, 0, 0.2);
    if (hard) this.burst(0.5, 2600, 1.1, 0.1, 'highpass', 0.3, 0.02);
  }
  footstep(speed: number) {
    this.burst(0.06, 900 + speed * 12, 1.6, Math.min(0.14, 0.03 + speed * 0.0022), 'bandpass', 0.05);
  }
  attack(combo: number) {
    const base = 180 + combo * 60;
    this.burst(0.12, 1800 + combo * 400, 1.2, 0.22, 'bandpass', 0.12, 0, 400);
    this.tone(base * 3, base, 0.14, 'square', 0.14, 3000, 0.1);
  }
  hitEnemy(heavy: boolean) {
    this.burst(heavy ? 0.2 : 0.11, heavy ? 260 : 520, 0.9, heavy ? 0.4 : 0.3, 'lowpass', 0.2);
    this.tone(heavy ? 140 : 260, heavy ? 60 : 120, heavy ? 0.2 : 0.12, 'square', 0.2, 1800, 0.16);
    this.burst(0.06, 5200, 2.4, 0.16, 'highpass', 0.1);
  }
  destroy() {
    this.burst(0.4, 300, 0.7, 0.36, 'lowpass', 0.34, 0, 90);
    this.burst(0.3, 3400, 1.2, 0.18, 'highpass', 0.2, 0.02);
    this.tone(180, 40, 0.34, 'sawtooth', 0.2, 1200, 0.24);
  }
  pickup(kind: string) {
    if (kind === 'time') { this.tone(880, 1320, 0.1, 'square', 0.2, 5000, 0.16); this.tone(1320, 1760, 0.12, 'square', 0.16, 5000, 0.2, 0.08); }
    else if (kind === 'health') { this.tone(520, 780, 0.14, 'triangle', 0.2, 4000, 0.2); this.tone(780, 1040, 0.16, 'sine', 0.14, 0, 0.2, 0.07); }
    else if (kind === 'boost') { this.tone(300, 1400, 0.2, 'sawtooth', 0.2, 4200, 0.2); }
    else this.tone(1180 + Math.random() * 220, 1760, 0.08, 'square', 0.13, 6000, 0.12);
  }
  boost(on: boolean) {
    if (on) { this.burst(0.5, 700, 0.9, 0.3, 'lowpass', 0.3, 0, 2600); this.tone(120, 420, 0.4, 'sawtooth', 0.2, 2200, 0.24); }
    else this.tone(420, 120, 0.24, 'sawtooth', 0.12, 1400, 0.2);
  }
  bounce() { this.tone(200, 1100, 0.2, 'sine', 0.28, 3400, 0.2); this.burst(0.1, 1200, 2, 0.12); }
  booster() { this.tone(260, 1600, 0.26, 'sawtooth', 0.24, 5200, 0.24); this.burst(0.2, 2600, 1.4, 0.16, 'bandpass', 0.2, 0, 800); }
  hurt() {
    this.burst(0.24, 340, 0.7, 0.34, 'lowpass', 0.24, 0, 120);
    this.tone(300, 90, 0.26, 'sawtooth', 0.26, 900, 0.2);
  }
  ui(kind: 'move' | 'confirm' | 'back' | 'rank') {
    if (kind === 'move') this.tone(720, 720, 0.05, 'square', 0.1, 5000, 0.05);
    else if (kind === 'confirm') { this.tone(520, 1040, 0.1, 'square', 0.16, 6000, 0.12); this.tone(1040, 1560, 0.12, 'square', 0.12, 6000, 0.16, 0.07); }
    else if (kind === 'back') this.tone(420, 240, 0.1, 'square', 0.12, 3000, 0.08);
    else { this.tone(660, 990, 0.18, 'triangle', 0.22, 6000, 0.3); this.tone(990, 1320, 0.3, 'triangle', 0.18, 6000, 0.34, 0.12); }
  }
  goal() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => this.tone(n, n * 1.5, 0.4, 'triangle', 0.24, 6000, 0.36, i * 0.09));
    this.burst(0.7, 2200, 0.8, 0.2, 'bandpass', 0.4);
  }
  bossTelegraph(kind: string) {
    if (kind === 'beam') this.tone(90, 1400, 0.9, 'sawtooth', 0.22, 2600, 0.4);
    else if (kind === 'slam') this.tone(160, 40, 0.7, 'square', 0.26, 900, 0.4);
    else if (kind === 'charge') { this.burst(0.6, 500, 0.8, 0.26, 'lowpass', 0.4, 0, 3200); this.tone(70, 210, 0.6, 'sawtooth', 0.24, 1400, 0.4); }
    else this.tone(240, 620, 0.5, 'square', 0.2, 3400, 0.34);
  }
  bossImpact(power: number) {
    this.burst(0.6, 140, 0.6, Math.min(0.6, 0.3 * power), 'lowpass', 0.5, 0, 50);
    this.tone(70, 30, 0.7, 'sine', 0.4 * power, 0, 0.4);
    this.burst(0.4, 4200, 1.1, 0.18, 'highpass', 0.3, 0.03);
  }
  bossDefeat() {
    for (let i = 0; i < 7; i++) {
      this.burst(0.5, 200 + i * 90, 0.8, 0.3, 'lowpass', 0.5, i * 0.16, 60);
      this.tone(220 - i * 18, 40, 0.5, 'sawtooth', 0.2, 1400, 0.4, i * 0.16);
    }
  }
  stinger() {
    [392, 523, 659, 880].forEach((n, i) => this.tone(n, n, 0.5, 'sawtooth', 0.16, 3000, 0.4, i * 0.05));
  }
  countdown(low: boolean) {
    this.tone(low ? 1200 : 880, low ? 1200 : 880, 0.09, 'square', low ? 0.24 : 0.16, 6000, 0.1);
  }
  transmission() { this.tone(1400, 900, 0.07, 'square', 0.1, 6000, 0.06); }

  // ---- continuous layers ---------------------------------------------------
  setSpeed(speedN: number, boosting: boolean) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const wind = Math.min(0.3, Math.pow(speedN, 2.1) * 0.32);
    this.windGain.gain.setTargetAtTime(this.muted ? 0 : wind, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(320 + speedN * 2200, t, 0.15);
    this.speedGain.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.13, speedN * 0.14 + (boosting ? 0.05 : 0)), t, 0.15);
    this.speedOsc!.frequency.setTargetAtTime(46 + speedN * 74, t, 0.2);
  }

  setGrind(active: boolean, speedN: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.grindGain.gain.setTargetAtTime(this.muted ? 0 : (active ? 0.2 + speedN * 0.14 : 0), t, 0.05);
    this.grindFilter.frequency.setTargetAtTime(1600 + speedN * 3200, t, 0.08);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ready) this.master.gain.setTargetAtTime(m ? 0 : 0.82, this.ctx!.currentTime, 0.05);
  }
}
