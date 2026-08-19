/**
 * AudioEngine — every sound in the game, generated at runtime.
 *
 * There are no audio files in this project. The engine builds a small graph of
 * oscillators, filtered noise taps and envelopes at unlock, and then only ever
 * changes parameters on it. Nothing is loaded, decoded or streamed.
 *
 * THE SPLIT BETWEEN CONTINUOUS AND DISCRETE IS THE WHOLE DESIGN.
 *
 * `update()` owns only the voices that are always sounding and whose level is a
 * function of state: wind, surface contact, the grind, the boost. Every discrete
 * cue — jump, dash, strike, hit, mount, pickup — is fired by whoever caused it,
 * and in practice that is `PlayerPhysics`, which holds an `IAudio` and calls
 * `playJump` and friends from inside the fixed step.
 *
 * That is not a stylistic preference. `update()` runs once per RENDERED frame
 * while the physics runs at a fixed 120 Hz, so at 60 fps two physics steps land
 * between two updates. The one-step event flags on `PlayerState` — `jumpedThisStep`
 * and the rest — are true for exactly one physics step, so a frame-rate consumer
 * inferring events from them drops every second one at 60 fps and drops five in
 * six at 20 fps. Reading them here would make the game quieter the worse it ran.
 *
 * MIXING AT 74 m/s. At full speed the wind is the loudest thing in the game by a
 * wide margin. Every discrete cue is therefore a transient or a pitched figure
 * placed away from the wind band — see the header of `PlayerVoices.ts`.
 */

import type {
  IAudio,
  MusicIntensity,
  PlayerState,
  SurfaceProperties,
} from '../game/Contracts';
import { AttackKind, MoveMode, PickupKind } from '../game/Contracts';

import { clamp, clamp01, dampHL } from '../core/MathX';
import {
  BoostVoice,
  HornVoice,
  ImpactPool,
  MasterBus,
  NoiseBank,
  TyreVoice,
  UiPool,
  WindVoice,
  type SurfaceTone,
  type UiKind,
} from './Synths';
import {
  AttackVoice,
  DashVoice,
  GrindVoice,
  HitVoice,
  JumpVoice,
  MountVoice,
  MusicBed,
  PickupVoice,
  StingerVoice,
  type StingerKind,
} from './PlayerVoices';

export interface AudioOptions {
  /** Initial master volume, 0..1. */
  volume?: number;
}

/**
 * Layer mixes per intensity: pad, bass, pulse, lead.
 *
 * These are MIXES, not tracks. Moving between any two of them is a cross-fade
 * of four gains over the same harmonic plan, so the score can follow the game
 * moment to moment without ever announcing a transition — which matters because
 * the transitions happen while the player is doing 266 km/h.
 */
const MUSIC_MIX: Record<MusicIntensity, [number, number, number, number]> = {
  explore:  [0.30, 0.10, 0.04, 0.00],
  traverse: [0.24, 0.26, 0.20, 0.10],
  combat:   [0.18, 0.34, 0.30, 0.20],
  boss:     [0.22, 0.38, 0.34, 0.28],
  critical: [0.10, 0.30, 0.40, 0.34],
  victory:  [0.34, 0.20, 0.12, 0.30],
  defeat:   [0.30, 0.08, 0.00, 0.06],
};

/** Tempo and harmonic root per intensity. */
const MUSIC_FEEL: Record<MusicIntensity, { tempo: number; root: number }> = {
  explore:  { tempo: 2.0, root: 110.0 },
  traverse: { tempo: 2.6, root: 110.0 },
  combat:   { tempo: 3.1, root: 116.5 },
  boss:     { tempo: 3.4, root: 98.0 },
  critical: { tempo: 4.0, root: 98.0 },
  victory:  { tempo: 2.4, root: 130.8 },
  defeat:   { tempo: 1.6, root: 87.3 },
};

export class AudioEngine implements IAudio {
  private ctx: AudioContext | null = null;
  private bus: MasterBus | null = null;
  private bank: NoiseBank | null = null;

  // Continuous
  private wind: WindVoice | null = null;
  private contact: TyreVoice | null = null;
  private grind: GrindVoice | null = null;
  private boost: BoostVoice | null = null;
  private music: MusicBed | null = null;

  // Discrete
  private impacts: ImpactPool | null = null;
  private jump: JumpVoice | null = null;
  private dash: DashVoice | null = null;
  private attack: AttackVoice | null = null;
  private hit: HitVoice | null = null;
  private mount: MountVoice | null = null;
  private pickup: PickupVoice | null = null;
  private stinger: StingerVoice | null = null;
  private horn: HornVoice | null = null;
  private ui: UiPool | null = null;

  private built = false;
  private unlocked = false;
  private disposed = false;
  private volume: number;

  private duckTarget = 1;
  private duckValue = 1;

  private groundedSmooth = 0;
  private wasBoosting = false;
  private impactCool = 0;

  private intensity: MusicIntensity = 'explore';

  constructor(opts: AudioOptions = {}) {
    this.volume = opts.volume ?? 0.85;
    this.createContext();
  }

  private createContext(): void {
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      // No Web Audio (or blocked). Every method below no-ops from here.
      this.ctx = null;
    }
  }

  /** True once the context is running and the graph is live. */
  get ready(): boolean {
    return this.unlocked && !!this.ctx && this.ctx.state === 'running';
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.ctx) this.createContext();
    const ctx = this.ctx;
    if (!ctx) return;

    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      return;
    }

    if (!this.built) this.build(ctx);
    this.unlocked = true;
  }

  /**
   * Rebuild nothing, just resume. Safe to call from a visibilitychange handler;
   * browsers suspend the context when a tab is hidden and do not always resume
   * it on their own.
   */
  async resume(): Promise<void> {
    if (!this.ctx || this.disposed) return;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
  }

  private build(ctx: AudioContext): void {
    this.built = true;
    const t = ctx.currentTime + 0.02;

    this.bus = new MasterBus(ctx);
    this.bus.setVolume(this.volume, ctx.currentTime);
    this.bank = new NoiseBank(ctx);

    const loop = this.bus.loop;
    const sfx = this.bus.sfx;
    const uiBus = this.bus.ui;

    this.wind = new WindVoice(ctx, this.bank, loop);
    this.contact = new TyreVoice(ctx, this.bank, loop);
    this.grind = new GrindVoice(ctx, this.bank, loop);
    this.boost = new BoostVoice(ctx, this.bank, loop);
    this.music = new MusicBed(ctx, this.bank, loop);

    this.impacts = new ImpactPool(ctx, this.bank, sfx, 8);
    this.jump = new JumpVoice(ctx, this.bank, sfx);
    this.dash = new DashVoice(ctx, this.bank, sfx);
    this.attack = new AttackVoice(ctx, this.bank, sfx);
    this.hit = new HitVoice(ctx, this.bank, sfx);
    this.mount = new MountVoice(ctx, this.bank, sfx);
    this.pickup = new PickupVoice(ctx, sfx, 6);
    this.stinger = new StingerVoice(ctx, sfx, 5);
    this.horn = new HornVoice(ctx, sfx);
    this.ui = new UiPool(ctx, this.bank, uiBus, 4);

    // Everything starts at the same instant so the shared noise sources are
    // phase-consistent with the voices that read them.
    this.bank.start(t);
    this.wind.start(t);
    this.contact.start(t);
    this.grind.start(t);
    this.boost.start(t);
    this.music.start(t);
    this.impacts.start(t);
    this.jump.start(t);
    this.dash.start(t);
    this.attack.start(t);
    this.hit.start(t);
    this.mount.start(t);
    this.pickup.start(t);
    this.stinger.start(t);
    this.horn.start(t);
    this.ui.start(t);

    this.applyIntensity(t);
  }

  // ── Mix control ───────────────────────────────────────────────────────────

  setMasterVolume(v: number): void {
    this.volume = clamp(v, 0, 1.5);
    if (this.bus && this.ctx) this.bus.setVolume(this.volume, this.ctx.currentTime);
  }

  /** 1 = full, 0 = world audio silent. Menus and results pull this down. */
  setDuck(amount: number): void {
    this.duckTarget = clamp01(amount);
  }

  setMusicIntensity(kind: MusicIntensity): void {
    if (kind === this.intensity) return;
    this.intensity = kind;
    if (this.ctx) this.applyIntensity(this.ctx.currentTime);
  }

  private applyIntensity(t: number): void {
    if (!this.music) return;
    const mix = MUSIC_MIX[this.intensity] ?? MUSIC_MIX.explore;
    const feel = MUSIC_FEEL[this.intensity] ?? MUSIC_FEEL.explore;
    this.music.setTempo(feel.tempo);
    this.music.setRoot(feel.root);
    this.music.setMix(t, mix[0], mix[1], mix[2], mix[3], this.duckValue);
  }

  // ── The frame ─────────────────────────────────────────────────────────────

  /**
   * Continuous voices only. See the header for why the one-step event flags on
   * `state` are deliberately not read here.
   */
  update(state: PlayerState, surface: SurfaceProperties, dt: number): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    if (!ctx || !this.ready || !this.wind || !this.contact || !this.grind || !this.boost) return;

    const t = ctx.currentTime;
    const step = Math.min(Math.max(dt, 1 / 240), 0.1);

    this.duckValue = dampHL(this.duckValue, this.duckTarget, 0.10, step);
    const duck = this.duckValue;

    const tone = (surface?.audioTone ?? 'hardpack') as SurfaceTone;

    const mode = state.mode;
    const grounded = mode === MoveMode.Grounded || mode === MoveMode.Sliding ? 1 : 0;
    // A hard 0/1 makes the contact bed chatter over every ledge; a 50 ms
    // half-life reads as footfalls skipping instead.
    this.groundedSmooth = dampHL(this.groundedSmooth, grounded, 0.05, step);

    const speed = state.groundSpeed;
    const air = clamp01(state.airHeight / 8) * (1 - this.groundedSmooth);

    // Sliding scrubs; running does not. That difference is the whole reason the
    // surface voice keeps its lateral-slip and lockup channels after the pivot.
    const sliding = mode === MoveMode.Sliding ? 1 : 0;
    const lateral = sliding * clamp01(speed / 30) * 5;

    this.contact.setSurface(tone);
    this.contact.update(t, step, speed, 1, lateral, sliding, this.groundedSmooth, duck);
    this.wind.update(t, speed, air, duck);
    this.grind.update(t, mode === MoveMode.Grinding, speed, duck);
    this.boost.update(t, state.boosting, speed, duck);

    if (state.boosting && !this.wasBoosting) this.boost.fire(t, duck);
    this.wasBoosting = state.boosting;

    this.music?.update(t);
    if (this.music) {
      const mix = MUSIC_MIX[this.intensity] ?? MUSIC_MIX.explore;
      this.music.setMix(t, mix[0], mix[1], mix[2], mix[3], duck);
    }

    if (this.impactCool > 0) this.impactCool -= step;
  }

  // ── Discrete cues, fired by whoever caused them ───────────────────────────

  playImpact(severity: number, surface: SurfaceProperties): void {
    if (!this.ready || !this.impacts || !this.ctx) return;
    if (this.impactCool > 0) return;
    const tone = (surface?.audioTone ?? 'hardpack') as SurfaceTone;
    this.impacts.trigger(this.ctx.currentTime, severity, tone, this.duckValue);
    this.impactCool = 0.04;
  }

  playJump(doubleJump: boolean): void {
    if (!this.ready || !this.jump || !this.ctx) return;
    this.jump.fire(this.ctx.currentTime, doubleJump, this.duckValue);
  }

  playDash(air: boolean): void {
    if (!this.ready || !this.dash || !this.ctx) return;
    this.dash.fire(this.ctx.currentTime, air, this.duckValue);
  }

  playAttack(kind: AttackKind, combo: number): void {
    if (!this.ready || !this.attack || !this.ctx) return;
    const heavy = kind === AttackKind.Slam || kind === AttackKind.Charged;
    this.attack.fire(this.ctx.currentTime, combo, heavy, this.duckValue);
  }

  playHit(killed: boolean, combo: number): void {
    if (!this.ready || !this.hit || !this.ctx) return;
    this.hit.fire(this.ctx.currentTime, killed, combo, this.duckValue);
  }

  playRailMount(): void {
    if (!this.ready || !this.mount || !this.ctx) return;
    this.mount.fire(this.ctx.currentTime, true, this.duckValue);
  }

  playWallMount(): void {
    if (!this.ready || !this.mount || !this.ctx) return;
    this.mount.fire(this.ctx.currentTime, false, this.duckValue);
  }

  playPickup(kind: PickupKind, streak: number): void {
    if (!this.ready || !this.pickup || !this.ctx) return;
    const rare = kind !== PickupKind.Fragment;
    this.pickup.fire(this.ctx.currentTime, streak, rare, this.duckValue);
  }

  playStinger(kind: 'boss' | 'phase' | 'clear' | 'fail' | 'shortcut'): void {
    if (!this.ready || !this.stinger || !this.ctx) return;
    this.stinger.fire(this.ctx.currentTime, kind as StingerKind, this.duckValue);
  }

  /**
   * @param pitch multiplier on the horn's base note. The convention the stage
   *              director uses is 1.0 for each of the three countdown blips and
   *              1.335 (a perfect fourth up) for the start blast.
   */
  playStartHorn(pitch = 1): void {
    if (!this.ready || !this.horn || !this.ctx) return;
    this.horn.play(this.ctx.currentTime, pitch, pitch > 1.15, 1);
  }

  playUi(kind: UiKind): void {
    if (!this.ready || !this.ui || !this.ctx) return;
    // UI never ducks — a menu blip that gets quieter when the menu opens is a
    // blip you cannot hear at exactly the moment you need it.
    this.ui.play(this.ctx.currentTime, kind, 1);
  }

  /** Silence the continuous voices without tearing the graph down. */
  silence(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind?.silence(t);
    this.contact?.silence(t);
    this.grind?.silence(t);
    this.music?.silence(t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.silence();
    this.bank?.dispose();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      // close() rejects if the context is already closed; there is nothing to
      // do about it either way.
      ctx.close().catch(() => { /* ignore */ });
    }
  }
}
