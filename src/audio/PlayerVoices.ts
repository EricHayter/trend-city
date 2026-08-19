/**
 * PlayerVoices — the platformer's own synth voices.
 *
 * The DESCENT synth bank (`Synths.ts`) covers everything that is about a body
 * moving through air and over ground: wind, surface contact, impacts, the bus,
 * the UI. All of that survived the pivot unchanged, because none of it was ever
 * about a bicycle. What did not survive was the drivetrain — a freewheel and a
 * chain are not sounds this game makes any more — and what was missing is
 * everything a character does that a bike cannot: jump, dash, strike, grind a
 * rail, mount a wall, collect a thing, and be scored for it.
 *
 * Two rules shape every voice in here:
 *
 *  1. NOTHING IS A SAMPLE. Every sound is oscillators, filtered noise and
 *     envelopes, built at unlock and retriggered from a pool. The project
 *     ships zero external assets and audio is not an exception.
 *
 *  2. THE MIX HAS TO SURVIVE 74 m/s OF WIND. At full speed the wind voice is
 *     the loudest thing in the game, so an action cue that lives in the same
 *     band as the wind simply is not heard. Every cue here is therefore either
 *     transient (a click or a strike the ear localises in time, not in
 *     frequency) or pitched somewhere the wind is not. This is why the jump is
 *     a pitch sweep rather than a whoosh: a whoosh at speed is inaudible.
 */

import { Rng } from '../core/RNG';
import { clamp, clamp01 } from '../core/MathX';
import {
  NoiseBank,
  Smooth,
  biquad,
  gain,
  pitchDrop,
  strike,
  swell,
} from './Synths';

/** Semitone ratio. */
function st(n: number): number {
  return Math.pow(2, n / 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// Jump
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rising pitch blip with a noise chuff under it.
 *
 * The double jump is the SAME voice a fifth up rather than a second sound.
 * Pitch is how a player reads "again, but different" without having to learn a
 * second cue, and it means the two never mask each other in a chain.
 */
export class JumpVoice {
  private osc: OscillatorNode;
  private env: GainNode;
  private chuffBp: BiquadFilterNode;
  private chuff: GainNode;

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'triangle';
    this.osc.frequency.value = 220;
    this.env = gain(ctx, 0);
    this.osc.connect(this.env).connect(out);

    this.chuffBp = biquad(ctx, 'bandpass', 900, 1.1);
    this.chuff = gain(ctx, 0);
    bank.tap('white', 1).connect(this.chuffBp).connect(this.chuff).connect(out);
  }

  start(t: number): void {
    this.osc.start(t);
  }

  fire(t: number, doubleJump: boolean, duck: number): void {
    const base = doubleJump ? 330 : 220;
    // Rising, not falling: up means leaving the ground.
    pitchDrop(this.osc.frequency, t, base, base * st(12), 0.13);
    strike(this.env.gain, t, 0.22 * duck, 0.005, 0.18);
    pitchDrop(this.chuffBp.frequency, t, 700, 2600, 0.12);
    strike(this.chuff.gain, t, 0.14 * duck, 0.004, 0.14);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dash
// ─────────────────────────────────────────────────────────────────────────────

/** A hard transient and a fast downward sweep. The most percussive cue here. */
export class DashVoice {
  private bp: BiquadFilterNode;
  private burst: GainNode;
  private sub: OscillatorNode;
  private subGain: GainNode;

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.bp = biquad(ctx, 'bandpass', 1800, 1.6);
    this.burst = gain(ctx, 0);
    bank.tap('white', 2).connect(this.bp).connect(this.burst).connect(out);

    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 90;
    this.subGain = gain(ctx, 0);
    this.sub.connect(this.subGain).connect(out);
  }

  start(t: number): void {
    this.sub.start(t);
  }

  fire(t: number, air: boolean, duck: number): void {
    // The air dash sits higher so it reads over the wind, which is loud by
    // definition whenever the character is airborne at speed.
    const top = air ? 5200 : 3800;
    pitchDrop(this.bp.frequency, t, top, 420, 0.20);
    strike(this.burst.gain, t, (air ? 0.30 : 0.34) * duck, 0.002, 0.22);
    pitchDrop(this.sub.frequency, t, air ? 150 : 120, 44, 0.24);
    strike(this.subGain.gain, t, 0.26 * duck, 0.003, 0.26);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Attack and hit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The swing. Pitch climbs with the combo index so a three-hit chain is a rising
 * figure rather than the same noise three times — the combo is audible before
 * the HUD has drawn it.
 */
export class AttackVoice {
  private bp: BiquadFilterNode;
  private env: GainNode;
  private body: OscillatorNode;
  private bodyGain: GainNode;

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.bp = biquad(ctx, 'bandpass', 2200, 2.4);
    this.env = gain(ctx, 0);
    bank.tap('white', 3).connect(this.bp).connect(this.env).connect(out);

    this.body = ctx.createOscillator();
    this.body.type = 'sawtooth';
    this.body.frequency.value = 180;
    this.bodyGain = gain(ctx, 0);
    const lp = biquad(ctx, 'lowpass', 1400, 0.7);
    this.body.connect(lp).connect(this.bodyGain).connect(out);
  }

  start(t: number): void {
    this.body.start(t);
  }

  fire(t: number, combo: number, heavy: boolean, duck: number): void {
    const step = st(Math.min(combo, 6) * 2);
    pitchDrop(this.bp.frequency, t, 3400 * step, 900, heavy ? 0.20 : 0.13);
    strike(this.env.gain, t, (heavy ? 0.28 : 0.20) * duck, 0.003, heavy ? 0.22 : 0.14);
    pitchDrop(this.body.frequency, t, 260 * step, 90, 0.16);
    strike(this.bodyGain.gain, t, (heavy ? 0.22 : 0.14) * duck, 0.004, 0.18);
  }
}

/**
 * Contact. A crunch, plus a bright ring when the target actually died — the
 * kill confirmation is a different SOUND, not a louder one, because at speed
 * the player cannot reliably compare two volumes half a second apart.
 */
export class HitVoice {
  private crunchBp: BiquadFilterNode;
  private crunch: GainNode;
  private ring: OscillatorNode;
  private ringGain: GainNode;
  private thud: OscillatorNode;
  private thudGain: GainNode;

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.crunchBp = biquad(ctx, 'bandpass', 1100, 1.0);
    this.crunch = gain(ctx, 0);
    bank.tap('grain').connect(this.crunchBp).connect(this.crunch).connect(out);

    this.ring = ctx.createOscillator();
    this.ring.type = 'sine';
    this.ring.frequency.value = 1320;
    this.ringGain = gain(ctx, 0);
    this.ring.connect(this.ringGain).connect(out);

    this.thud = ctx.createOscillator();
    this.thud.type = 'sine';
    this.thud.frequency.value = 110;
    this.thudGain = gain(ctx, 0);
    this.thud.connect(this.thudGain).connect(out);
  }

  start(t: number): void {
    this.ring.start(t);
    this.thud.start(t);
  }

  fire(t: number, killed: boolean, combo: number, duck: number): void {
    pitchDrop(this.crunchBp.frequency, t, 2400, 600, 0.12);
    strike(this.crunch.gain, t, 0.26 * duck, 0.002, 0.15);
    pitchDrop(this.thud.frequency, t, 190, 60, 0.14);
    strike(this.thudGain.gain, t, 0.24 * duck, 0.002, 0.18);

    if (killed) {
      this.ring.frequency.setValueAtTime(1180 * st(Math.min(combo, 8)), t);
      strike(this.ringGain.gain, t, 0.16 * duck, 0.004, 0.42);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sustained metal-on-metal while grinding, with a sparking layer that only
 * appears at speed.
 *
 * This is a continuous voice rather than a loop, so it has no loop point to go
 * audible — the same reason `TyreVoice` wanders its texture filter.
 */
export class GrindVoice {
  private bodyBp: BiquadFilterNode;
  private body: GainNode;
  private sparkHp: BiquadFilterNode;
  private spark: GainNode;
  private ring: OscillatorNode;
  private ringGain: GainNode;

  private sBody: Smooth;
  private sBodyF: Smooth;
  private sSpark: Smooth;
  private sRing: Smooth;
  private sRingF: Smooth;

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.bodyBp = biquad(ctx, 'bandpass', 1500, 3.0);
    this.body = gain(ctx, 0);
    bank.tap('white', 4).connect(this.bodyBp).connect(this.body).connect(out);

    this.sparkHp = biquad(ctx, 'highpass', 4200, 0.8);
    this.spark = gain(ctx, 0);
    bank.tap('grain', 1).connect(this.sparkHp).connect(this.spark).connect(out);

    // A faint resonant tone gives the rail a pitch, which is what makes a grind
    // feel like it is on a specific object rather than on abstract friction.
    this.ring = ctx.createOscillator();
    this.ring.type = 'sawtooth';
    this.ring.frequency.value = 320;
    this.ringGain = gain(ctx, 0);
    const rl = biquad(ctx, 'bandpass', 900, 6);
    this.ring.connect(rl).connect(this.ringGain).connect(out);

    this.sBody = new Smooth(this.body.gain, 0.05, 0.005);
    this.sBodyF = new Smooth(this.bodyBp.frequency, 0.08, 0.01);
    this.sSpark = new Smooth(this.spark.gain, 0.06, 0.005);
    this.sRing = new Smooth(this.ringGain.gain, 0.07, 0.005);
    this.sRingF = new Smooth(this.ring.frequency, 0.09, 0.01);
  }

  start(t: number): void {
    this.ring.start(t);
  }

  update(t: number, on: boolean, speed: number, duck: number): void {
    const s = clamp01(speed / 60);
    const lvl = on ? duck : 0;
    this.sBody.set(lvl * (0.05 + s * 0.16), t);
    this.sBodyF.set(900 + s * 2600, t);
    this.sSpark.set(lvl * s * s * 0.14, t);
    this.sRing.set(lvl * (0.02 + s * 0.05), t);
    this.sRingF.set(240 + s * 420, t);
  }

  silence(t: number): void {
    this.sBody.set(0, t);
    this.sSpark.set(0, t);
    this.sRing.set(0, t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mounts
// ─────────────────────────────────────────────────────────────────────────────

/** The click of latching onto a rail or a wall. Short, dry, unmistakable. */
export class MountVoice {
  private bp: BiquadFilterNode;
  private env: GainNode;
  private tone: OscillatorNode;
  private toneGain: GainNode;

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.bp = biquad(ctx, 'bandpass', 2600, 3.0);
    this.env = gain(ctx, 0);
    bank.tap('white', 5).connect(this.bp).connect(this.env).connect(out);

    this.tone = ctx.createOscillator();
    this.tone.type = 'square';
    this.tone.frequency.value = 520;
    this.toneGain = gain(ctx, 0);
    const lp = biquad(ctx, 'lowpass', 2200, 0.8);
    this.tone.connect(lp).connect(this.toneGain).connect(out);
  }

  start(t: number): void {
    this.tone.start(t);
  }

  /** `rail` picks the metallic variant; a wall is duller and lower. */
  fire(t: number, rail: boolean, duck: number): void {
    pitchDrop(this.bp.frequency, t, rail ? 4200 : 1800, rail ? 1400 : 520, 0.09);
    strike(this.env.gain, t, 0.20 * duck, 0.002, rail ? 0.11 : 0.16);
    this.tone.frequency.setValueAtTime(rail ? 660 : 300, t);
    strike(this.toneGain.gain, t, 0.12 * duck, 0.003, rail ? 0.10 : 0.14);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pickups
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bell that climbs a scale with the collection streak.
 *
 * The streak resets on a miss, so the pitch falling back to the root is the
 * feedback that the chain broke — again, information carried by pitch, which
 * survives a loud mix in a way that level never does.
 */
export class PickupVoice {
  private voices: { osc: OscillatorNode; env: GainNode; freeAt: number }[] = [];
  private next = 0;
  /** A pentatonic climb: no interval in it can sound wrong against the score. */
  private static readonly STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

  constructor(ctx: AudioContext, out: AudioNode, count = 6) {
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 880;
      const env = gain(ctx, 0);
      const bp = biquad(ctx, 'bandpass', 1800, 1.4);
      osc.connect(bp).connect(env).connect(out);
      this.voices.push({ osc, env, freeAt: 0 });
    }
  }

  start(t: number): void {
    for (const v of this.voices) v.osc.start(t);
  }

  fire(t: number, streak: number, rare: boolean, duck: number): void {
    let v = this.voices[this.next];
    for (const c of this.voices) if (c.freeAt < v.freeAt) v = c;
    this.next = (this.next + 1) % this.voices.length;

    const S = PickupVoice.STEPS;
    const step = S[Math.min(streak, S.length - 1)];
    const base = rare ? 1174 : 880;
    v.osc.frequency.setValueAtTime(base * st(step), t);
    const decay = rare ? 0.52 : 0.24;
    strike(v.env.gain, t, (rare ? 0.20 : 0.13) * duck, 0.003, decay);
    v.freeAt = t + decay;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stingers
// ─────────────────────────────────────────────────────────────────────────────

export type StingerKind = 'boss' | 'phase' | 'clear' | 'fail' | 'shortcut';

/** Chord shapes, in semitones over the root, plus the root and the feel. */
const STINGERS: Record<StingerKind, { root: number; chord: number[]; hold: number; up: boolean }> = {
  // Minor with a flat fifth under it — the only genuinely unpleasant chord here.
  boss: { root: 110, chord: [0, 3, 6, 12], hold: 0.55, up: false },
  phase: { root: 146.8, chord: [0, 3, 7, 10], hold: 0.30, up: true },
  clear: { root: 261.6, chord: [0, 4, 7, 11, 16], hold: 0.70, up: true },
  fail: { root: 98, chord: [0, 1, 6, 8], hold: 0.80, up: false },
  shortcut: { root: 392, chord: [0, 5, 7, 12], hold: 0.22, up: true },
};

/** Chorded hits for the moments the stage director wants underlined. */
export class StingerVoice {
  private oscs: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private out: AudioNode;
  private ctx: AudioContext;

  constructor(ctx: AudioContext, out: AudioNode, voices = 5) {
    this.ctx = ctx;
    this.out = out;
    for (let i = 0; i < voices; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sawtooth';
      osc.frequency.value = 220;
      const g = gain(ctx, 0);
      const lp = biquad(ctx, 'lowpass', 3000, 0.7);
      osc.connect(lp).connect(g).connect(out);
      this.oscs.push(osc);
      this.gains.push(g);
    }
  }

  start(t: number): void {
    for (const o of this.oscs) o.start(t);
  }

  fire(t: number, kind: StingerKind, duck: number): void {
    const s = STINGERS[kind] ?? STINGERS.phase;
    for (let i = 0; i < this.oscs.length; i++) {
      const note = s.chord[i % s.chord.length];
      const oct = Math.floor(i / s.chord.length) * 12;
      const f = s.root * st(note + oct);
      this.oscs[i].frequency.setValueAtTime(f, t);
      // Arpeggiate slightly so the chord arrives as a gesture, not a block.
      const off = i * (s.up ? 0.028 : 0.045);
      swell(this.gains[i].gain, t + off, (0.13 / this.oscs.length) * 3 * duck, 0.012, s.hold, 0.45);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Score
// ─────────────────────────────────────────────────────────────────────────────

export type MusicLayer = 'pad' | 'bass' | 'pulse' | 'lead';

/**
 * The procedural score.
 *
 * Four layers over one harmonic plan, cross-faded by intensity rather than
 * switched — a stage that swaps tracks at a boss door announces the door, and
 * this game's boss arrives while the player is doing 200 km/h and has no
 * attention to spend on a transition.
 *
 * Notes are scheduled ahead of the audio clock in `update()`, on a lookahead
 * window, which is the only way to get sample-accurate timing out of Web Audio
 * — scheduling from a rendered frame puts every note on a frame boundary and
 * the groove audibly stutters whenever the frame rate does.
 */
export class MusicBed {
  private ctx: AudioContext;
  private layers: Record<MusicLayer, GainNode>;
  private smooth: Record<MusicLayer, Smooth>;

  private padOscs: OscillatorNode[] = [];
  private bassOsc: OscillatorNode;
  private bassGain: GainNode;
  private bassFilter: BiquadFilterNode;
  private pulseGain: GainNode;
  private leadOsc: OscillatorNode;
  private leadGain: GainNode;

  private rng = new Rng(0x5c04e);
  private nextNote = 0;
  private stepIndex = 0;
  private started = false;

  /** Beats per second. */
  private tempo = 2.6;
  /** Root of the current harmonic area, Hz. */
  private root = 110;

  /** A minor-pentatonic bass figure. Deliberately short: it is a bed. */
  private static readonly BASS: number[] = [0, 0, 7, 0, 10, 7, 5, 3];
  private static readonly LEAD: number[] = [12, 15, 19, 15, 22, 19, 15, 12];

  constructor(ctx: AudioContext, bank: NoiseBank, out: AudioNode) {
    this.ctx = ctx;

    const mk = (): GainNode => {
      const g = gain(ctx, 0);
      g.connect(out);
      return g;
    };
    this.layers = { pad: mk(), bass: mk(), pulse: mk(), lead: mk() };
    this.smooth = {
      pad: new Smooth(this.layers.pad.gain, 0.9, 0.004),
      bass: new Smooth(this.layers.bass.gain, 0.6, 0.004),
      pulse: new Smooth(this.layers.pulse.gain, 0.5, 0.004),
      lead: new Smooth(this.layers.lead.gain, 0.7, 0.004),
    };

    // Pad: three detuned saws through a slow filter. Always present, so the
    // score never fully disappears and the silence never has to be explained.
    const padLp = biquad(ctx, 'lowpass', 900, 0.9);
    padLp.connect(this.layers.pad);
    for (const d of [0.997, 1, 1.004]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 110 * d;
      const g = gain(ctx, 0.16);
      o.connect(g).connect(padLp);
      this.padOscs.push(o);
    }

    this.bassFilter = biquad(ctx, 'lowpass', 420, 3);
    this.bassOsc = ctx.createOscillator();
    this.bassOsc.type = 'square';
    this.bassOsc.frequency.value = 55;
    this.bassGain = gain(ctx, 0);
    this.bassOsc.connect(this.bassFilter).connect(this.bassGain).connect(this.layers.bass);

    // Pulse: a filtered noise tick, the rhythmic spine.
    const pulseBp = biquad(ctx, 'bandpass', 2600, 2.0);
    this.pulseGain = gain(ctx, 0);
    bank.tap('white', 6).connect(pulseBp).connect(this.pulseGain).connect(this.layers.pulse);

    this.leadOsc = ctx.createOscillator();
    this.leadOsc.type = 'triangle';
    this.leadOsc.frequency.value = 440;
    this.leadGain = gain(ctx, 0);
    const leadBp = biquad(ctx, 'bandpass', 1600, 1.2);
    this.leadOsc.connect(leadBp).connect(this.leadGain).connect(this.layers.lead);
  }

  start(t: number): void {
    for (const o of this.padOscs) o.start(t);
    this.bassOsc.start(t);
    this.leadOsc.start(t);
    this.nextNote = t + 0.1;
    this.started = true;
  }

  /** Cross-fade the layers. Each intensity is a mix, not a track. */
  setMix(t: number, pad: number, bass: number, pulse: number, lead: number, duck: number): void {
    this.smooth.pad.set(pad * duck, t);
    this.smooth.bass.set(bass * duck, t);
    this.smooth.pulse.set(pulse * duck, t);
    this.smooth.lead.set(lead * duck, t);
  }

  setTempo(bps: number): void {
    this.tempo = clamp(bps, 1.2, 5.0);
  }

  setRoot(hz: number): void {
    this.root = clamp(hz, 55, 220);
  }

  /**
   * Schedule any notes falling inside the lookahead window. Called once per
   * rendered frame; the notes themselves land on the audio clock, not on the
   * frame clock.
   */
  update(now: number): void {
    if (!this.started) return;
    const lookahead = 0.20;
    const beat = 1 / this.tempo;
    let guard = 0;

    while (this.nextNote < now + lookahead && guard++ < 32) {
      const t = this.nextNote;
      const i = this.stepIndex;

      const bassNote = MusicBed.BASS[i % MusicBed.BASS.length];
      this.bassOsc.frequency.setValueAtTime(this.root * 0.5 * st(bassNote), t);
      strike(this.bassGain.gain, t, 0.30, 0.006, beat * 0.85);
      this.bassFilter.frequency.setValueAtTime(320 + this.rng.range(0, 260), t);

      // Pulse on every step, accented on the downbeat.
      const accent = i % 4 === 0 ? 1 : 0.45;
      strike(this.pulseGain.gain, t, 0.22 * accent, 0.002, beat * 0.30);

      // The lead only plays two steps in four, so it phrases instead of running.
      if (i % 4 === 0 || i % 8 === 3) {
        const n = MusicBed.LEAD[i % MusicBed.LEAD.length];
        this.leadOsc.frequency.setValueAtTime(this.root * st(n), t);
        strike(this.leadGain.gain, t, 0.20, 0.008, beat * 1.4);
      }

      for (let k = 0; k < this.padOscs.length; k++) {
        const d = [0.997, 1, 1.004][k];
        this.padOscs[k].frequency.setTargetAtTime(this.root * d, t, 0.4);
      }

      this.stepIndex = (i + 1) % 32;
      this.nextNote += beat;
    }

    // A long stall (a paused tab) must not schedule a burst of catch-up notes.
    if (this.nextNote < now - 0.5) this.nextNote = now + 0.05;
  }

  silence(t: number): void {
    this.setMix(t, 0, 0, 0, 0, 1);
  }
}
