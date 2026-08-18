import { AudioEngine } from './Audio';

// PROCEDURAL SOUNDTRACK
// A lookahead scheduler over four layers: pulse (drums), sub (bass), arp (motion) and
// lead (melody). Layer gains are driven by an intensity value the game feeds from speed,
// combat and the stage timer, so the track escalates with play rather than looping flat.

type Mode = 'title' | 'explore' | 'chase' | 'combat' | 'boss' | 'critical' | 'victory';

const SCALES: Record<string, number[]> = {
  // Semitone offsets. Minor pentatonic for the borough, phrygian for the boss.
  boro: [0, 3, 5, 7, 10, 12, 15],
  lattice: [0, 2, 3, 7, 8, 10, 12],
  boss: [0, 1, 4, 5, 7, 8, 11],
  win: [0, 4, 7, 11, 12, 16],
};

export class Music {
  intensity = 0;
  mode: Mode = 'title';
  private step = 0;
  private nextTime = 0;
  private bpm = 148;
  private scale = SCALES.boro;
  private rootMidi = 45;
  private gains: { pulse: number; sub: number; arp: number; lead: number } = { pulse: 0, sub: 0, arp: 0, lead: 0 };
  private targets = { pulse: 0, sub: 0, arp: 0, lead: 0 };
  private melodySeed = 0;

  constructor(private audio: AudioEngine) {}

  setMode(mode: Mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    switch (mode) {
      case 'title': this.bpm = 124; this.scale = SCALES.boro; this.rootMidi = 45; break;
      case 'explore': this.bpm = 148; this.scale = SCALES.boro; this.rootMidi = 45; break;
      case 'chase': this.bpm = 158; this.scale = SCALES.boro; this.rootMidi = 45; break;
      case 'combat': this.bpm = 156; this.scale = SCALES.lattice; this.rootMidi = 43; break;
      case 'boss': this.bpm = 168; this.scale = SCALES.boss; this.rootMidi = 41; break;
      case 'critical': this.bpm = 172; this.scale = SCALES.lattice; this.rootMidi = 44; break;
      case 'victory': this.bpm = 132; this.scale = SCALES.win; this.rootMidi = 48; break;
    }
    this.melodySeed = Math.floor(Math.random() * 9999);
  }

  private midi(n: number) { return 440 * Math.pow(2, (n - 69) / 12); }

  private note(index: number, octave = 0) {
    const s = this.scale;
    const deg = ((index % s.length) + s.length) % s.length;
    const oct = Math.floor(index / s.length) + octave;
    return this.midi(this.rootMidi + s[deg] + oct * 12);
  }

  /** Called every frame; schedules a little ahead of the audio clock. */
  update(dt: number) {
    const a = this.audio;
    if (!a.ready) return;
    const ctx = a.ctx!;

    const inten = Math.max(0, Math.min(1, this.intensity));
    const boss = this.mode === 'boss';
    this.targets.pulse = this.mode === 'title' ? 0.35 : 0.5 + inten * 0.5;
    this.targets.sub = this.mode === 'title' ? 0.45 : 0.55 + inten * 0.45;
    this.targets.arp = this.mode === 'title' ? 0.5 : Math.max(0, inten * 1.1 - 0.1);
    this.targets.lead = this.mode === 'victory' ? 1 : boss ? 0.7 + inten * 0.3 : Math.max(0, inten * 1.3 - 0.45);
    for (const k of ['pulse', 'sub', 'arp', 'lead'] as const) {
      this.gains[k] += (this.targets[k] - this.gains[k]) * Math.min(1, dt * 1.6);
    }

    const stepDur = 60 / this.bpm / 4;   // sixteenth notes
    if (this.nextTime < ctx.currentTime) this.nextTime = ctx.currentTime + 0.06;
    while (this.nextTime < ctx.currentTime + 0.25) {
      this.schedule(this.step, this.nextTime - ctx.currentTime);
      this.step++;
      this.nextTime += stepDur;
    }
  }

  private schedule(step: number, when: number) {
    const a = this.audio;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const g = this.gains;
    const boss = this.mode === 'boss';
    const vic = this.mode === 'victory';

    // PULSE: kick, snare and hats built from noise bursts and sine thumps.
    if (g.pulse > 0.05) {
      const v = g.pulse;
      if (s % 4 === 0) a.tone(120, 44, 0.16, 'sine', 0.34 * v, 0, 0.06, when);
      if (s === 6 || s === 14 || (boss && s === 11)) a.burst(0.1, 1900, 1.1, 0.16 * v, 'bandpass', 0.1, when);
      if (s % 2 === 1) a.burst(0.035, 8200, 1.6, 0.05 * v, 'highpass', 0.04, when);
      if (boss && s === 8) a.burst(0.2, 340, 0.7, 0.2 * v, 'lowpass', 0.2, when, 90);
      if (vic && s % 8 === 0) a.burst(0.24, 2600, 0.9, 0.14 * v, 'bandpass', 0.3, when);
    }

    // SUB: a driving eighth-note bass that follows a two bar root movement.
    if (g.sub > 0.05) {
      const pattern = [0, 0, 3, 0, 5, 0, 3, 2];
      if (s % 2 === 0) {
        const deg = pattern[(Math.floor(s / 2) + bar * 3) % pattern.length];
        const f = this.note(deg, -1);
        a.tone(f, f * 0.99, 0.14, 'sawtooth', 0.2 * g.sub, 520, 0.05, when);
      }
    }

    // ARP: sixteenth arpeggio, the layer that makes speed feel like speed.
    if (g.arp > 0.05) {
      const seq = [0, 2, 4, 2, 5, 4, 2, 1];
      const deg = seq[(s + bar) % seq.length] + (s % 8 === 7 ? 2 : 0);
      const f = this.note(deg, 1);
      a.tone(f, f, 0.075, 'square', 0.075 * g.arp, 4200, 0.14, when);
    }

    // LEAD: a slower melodic line, deterministic per section so it feels written.
    if (g.lead > 0.05 && s % 4 === 0) {
      const h = Math.abs(Math.sin((bar * 7 + s + this.melodySeed) * 12.9898) * 43758.5453) % 1;
      const deg = Math.floor(h * 5) + (bar % 4 === 3 ? 5 : 2);
      const f = this.note(deg, vic ? 1 : 0);
      a.tone(f, f * (vic ? 1.5 : 1.0), vic ? 0.5 : 0.28, boss ? 'sawtooth' : 'triangle', 0.12 * g.lead, 3600, 0.3, when);
    }

    // Boss tension riser every two bars.
    if (boss && s === 12 && bar % 2 === 1) a.tone(this.note(0, -1), this.note(5, 0), 0.5, 'sawtooth', 0.1, 1800, 0.34, when);
  }
}
