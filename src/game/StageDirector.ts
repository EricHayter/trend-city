/**
 * StageDirector — the stage clock, the objective, the progress down the
 * mountain, the run's statistics, and the HUD model.
 *
 * It is everything the race layer used to own minus the race. There are no
 * rivals, no places and no laps: there is one runner, one descent, and a clock
 * counting toward zero. The director owns the answer to "how is the run going",
 * and it is the ONLY thing that owns it — the HUD asks it, the audio layer is
 * driven by it, and the results table is the same object it has been mutating
 * all run.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not move the player, it does not read input, and it does not touch
 * the scene graph. `step()` is handed a finished `PlayerState` and reads it.
 * That is what makes it safe to run inside the fixed step without the ordering
 * questions a director that also pushes things around would raise.
 *
 * ── THE ALLOCATION RULE ─────────────────────────────────────────────────────
 * `step()` runs 120 times a second and `getHudModel()` runs once per rendered
 * frame, so neither may allocate. There is ONE `HudModel`, ONE `splits` array,
 * ONE `popups` array and ONE route-profile `Float32Array`, all built in the
 * constructor and mutated in place for the life of the stage. This is not a
 * micro-optimisation: `RouteProfileWidget` decides whether to re-bake a
 * 0.19 Mpx silhouette by comparing `m.routeProfile` against the array it baked
 * from BY IDENTITY, so handing back a fresh array is not merely garbage, it is
 * a full canvas re-bake sixty times a second.
 *
 * ── THE CAPTURE HARNESS IS A FIRST-CLASS CALLER ─────────────────────────────
 * `forceRunning()`, `setElapsed()` and `resetRun()` exist because the review
 * harness teleports the player hundreds of metres down the course between
 * stills and shoots all sixteen in ONE page. Every one of them is there to stop
 * the director reacting, correctly, to an event that never happens in play —
 * see the notes on each.
 */

import type {
  HudModel,
  HudPopup,
  IAudio,
  IStageDirector,
  ITerrain,
  ITrack,
  MusicIntensity,
  PlayerState,
  StageStats,
  TrackSampleResult,
} from './Contracts';
import { MoveMode, StagePhase, StageRank, TrackSectionKind, TraversalPrompt } from './Contracts';
import { CHECKPOINT_TS, COUNTDOWN_SECONDS } from './WorldConstants';
import { DAMAGE, RUN, SPARK_UNITS_PER_MPS } from '../player/SparkConstants';
import { clamp01 } from '../core/MathX';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Samples in the route-profile silhouette.
 *
 * 256, which is what `TrackSpline.elevationProfile` has always defaulted to and
 * is not a coincidence: the profile panel is 572 design units wide and the plot
 * inside it is about 500, so 256 samples is a vertex every two design pixels.
 * Below that the ridge line visibly facets on a switchback; above it, every
 * extra sample lands inside a pixel that is already drawn.
 */
const ROUTE_PROFILE_SAMPLES = 256;

/**
 * The pace a competent run averages over the whole descent, m/s.
 *
 * Not `RUN.max`. 74 m/s is the ceiling on a straight, and the course is not a
 * straight — the switchbacks, the rock garden and the technical start are all
 * places where the run is about carrying speed through a shape rather than
 * holding the ceiling. 30 m/s is 75 display units, a bit over 40% of the
 * ceiling, and it is what a run that lands its wall-runs and holds its rails
 * comes out at once the slow sections are averaged back in.
 *
 * Everything time-shaped in this file is expressed as a multiple of the par
 * time this produces, so the numbers survive the course changing length.
 */
const PAR_PACE = 30.0;

/**
 * The stage clock, as a multiple of par.
 *
 * 2.5x. The clock is a FAIL-SAFE, not the challenge — the challenge is the
 * rank. A limit tight enough to threaten a competent run turns every stage into
 * a time trial and makes exploring the mountain, which is the other half of
 * what this movement set is for, a punished activity. At 2.5x par a player who
 * takes the whole course at a walk fails and everybody else finishes; the
 * pressure the clock supplies is the last ten seconds of a bad run, which is
 * exactly where `timeCritical` and the strobing clock plate want to live.
 */
const TIME_LIMIT_PAR_MULTIPLE = 2.5;

/**
 * Seconds left at which the clock starts alarming.
 *
 * 10. At `PAR_PACE` that is 300 m of course, which on an 800 m descent is the
 * last third — far enough out that the warning is information the player can
 * still act on, close enough that it is not on screen for half the run. The
 * clock plate strobes at 5 Hz for the whole of it, so a longer window would be
 * a strobing panel in most captured frames.
 */
const TIME_CRITICAL = 10.0;

/**
 * How long `Cleared` and `Failed` hold before `Results`.
 *
 * 2.6 s. `VerdictWidget` eases its bar open over 0.3 s and sets the word at
 * k > 0.5, so the banner is not fully legible until ~0.2 s in; the rest is the
 * run-out, which is the only moment in the stage the player is allowed to look
 * AT the screen rather than through it. Cutting to a menu before it has played
 * throws that moment away and it is the single cheapest thing a stage can have.
 */
const VERDICT_HOLD = 2.6;

/** Progress at which the goal counts as reached. */
const FINISH_PROGRESS = 0.999;

// ── Wrong way ────────────────────────────────────────────────────────────────
//
// The readout is derived from the sign of the along-track velocity, and the
// naive version of that — `alongSpeed < 0` — is a warning banner that strobes.
// It fires on a wall-run that carries the player laterally across a switchback,
// on the backswing of a homing attack, and on every single frame a hard corner
// puts the tangent momentarily behind the velocity.
//
// Two independent pieces of hysteresis, because there are two ways it chatters:
//
//   A SPEED DEAD BAND. Arm at -6 m/s and clear at -1 m/s. Six metres a second
//   backwards is a deliberate turn — at `RUN.max` it is under a tenth of the
//   ceiling, and nothing that happens sideways through a corner reaches it.
//   The five metres a second between the two thresholds is the band a player
//   oscillating around "stopped" lives in, and inside it the flag holds
//   whatever it already was.
//
//   A DWELL. Even a deliberate turn takes a moment to become a mistake, so the
//   flag arms only after 0.55 s below the entry threshold. It clears three
//   times faster than it arms: a player who has turned around and is now going
//   the right way has already understood the message, and leaving the banner
//   up for another half second is scolding them for a decision they have made.
const WRONG_WAY_ENTER = -6.0;
const WRONG_WAY_EXIT = -1.0;
const WRONG_WAY_DWELL = 0.55;
const WRONG_WAY_CLEAR_RATE = 3.0;

/**
 * Floor under the speed gauge's denominator, as a fraction of `RUN.max`.
 *
 * `HudModel.speedFraction` is documented as "0..1 of the run's top speed", so
 * the denominator is the run's own maximum — which is zero when the run starts.
 * Taken literally, the first step of every stage divides by a top speed of
 * 0.1 m/s and the needle is pinned at full deflection while the character is
 * still walking off the start line, which is both wrong and the exact frame the
 * capture harness shoots for the `start` pose.
 *
 * So the denominator is `max(runTopSpeed, RUN.max * 0.5)`: 37 m/s, half the
 * ceiling. Below that the gauge is ABSOLUTE — the needle means what it means
 * against a fixed scale, and walking reads as walking. Above it the gauge is
 * RELATIVE, which is what the field is for: it stretches to the run the player
 * is actually having, so a run that tops out at 55 m/s still sees the needle
 * reach the stop instead of sitting at three quarters all stage.
 *
 * The crossover is invisible because at the moment the run's top speed passes
 * the floor the two definitions agree by construction.
 */
const SPEED_FRACTION_FLOOR = 0.5;

/**
 * Ring size for the popup records.
 *
 * `PopupWidget` drains `model.popups` every rendered frame (`m.popups.length =
 * 0`), so a slot is free again one frame after it is used and this only has to
 * cover the worst single frame. Twelve covers the worst case in the codebase —
 * a capture teleport crossing several checkpoints inside one physics step, plus
 * whatever the pickup and combat layers add later — and the widget's own pool
 * is the real limit on what reaches the screen anyway.
 */
const POPUP_RING = 12;

/** Speed above which the score moves off its exploration layer, m/s. */
const TRAVERSE_SPEED = RUN.max * 0.45;

/**
 * The objective line, per section of the course.
 *
 * It is clipped to the space between the profile panel's title and its
 * percentage — about 300 design units at 15 units of type — so every one of
 * these is short enough to survive that, and the last word of each is the one
 * that matters in case one does not.
 */
const SECTION_OBJECTIVE: Record<TrackSectionKind, string> = {
  [TrackSectionKind.TechnicalStart]: 'Pick a line',
  [TrackSectionKind.ScreeRun]: 'Build speed',
  [TrackSectionKind.Switchbacks]: 'Hold the inside',
  [TrackSectionKind.RockGarden]: 'Stay off the rocks',
  [TrackSectionKind.Tabletop]: 'Send it',
  [TrackSectionKind.RavineGap]: 'Clear the ravine',
  [TrackSectionKind.RidgeSprint]: 'Open it up',
  [TrackSectionKind.StreamBed]: 'Follow the water',
  [TrackSectionKind.FinalSprint]: 'Reach the valley',
};

/** The line the stage opens with, once the gun goes. */
const OPENING_TRANSMISSION = 'Drop in. The valley floor, before the clock runs out.';

// ─────────────────────────────────────────────────────────────────────────────

export interface StageDirectorDeps {
  terrain: ITerrain;
  track: ITrack;
  /** Optional. Stingers, the countdown horn and the UI ticks go through it. */
  audio?: IAudio | null;
}

/** One checkpoint's row in the HUD model. Shape fixed by `HudModel.splits`. */
interface SplitRow {
  index: number;
  time: number | null;
  delta: number | null;
}

export class StageDirector implements IStageDirector {
  private readonly track: ITrack;
  private readonly terrain: ITerrain;
  private audio: IAudio | null;

  // ── Phase ──────────────────────────────────────────────────────────────────
  private _phase: StagePhase = StagePhase.Title;
  /** The phase `resume()` returns to. See `pause()`. */
  private resumePhase: StagePhase = StagePhase.Running;
  private countdownLeft = 0;
  /** Whole seconds already announced by the horn, so each tick fires once. */
  private hornTick = -1;
  private verdictLeft = 0;

  // ── Clock ──────────────────────────────────────────────────────────────────
  private _elapsed = 0;
  private readonly timeLimit: number;
  private readonly parTime: number;

  // ── Progress ───────────────────────────────────────────────────────────────
  private _routeDistance = 0;
  private _routeProgress = 0;
  /**
   * The RAW projection distance from last step, used as the projection hint.
   *
   * Deliberately not `_routeDistance`, which is monotonic. A player who runs
   * sixty metres back uphill still has to be projected where they actually are;
   * feeding the monotonic maximum back in as the hint means the true position
   * sits on the edge of the search window, the spline correctly declares the
   * hint stale, and every step falls back to a global sweep of the centreline.
   */
  private hintDistance = 0;

  // ── Wrong way ──────────────────────────────────────────────────────────────
  private wrongWayDwell = 0;
  private _wrongWay = false;

  // ── Splits ─────────────────────────────────────────────────────────────────
  /**
   * The live split table. Same array object as `model.splits` for the life of
   * the director — the rows are mutated, never replaced.
   *
   * ── WHY IT STARTS AT CHECKPOINT 1 ────────────────────────────────────────
   * `CHECKPOINT_TS[0]` is 0.0, which is the start line, not a checkpoint. Left
   * in, it is crossed on the first step of every run and announces a split of
   * 0:00.00 over the top of the countdown's GO. `Widgets.ts` takes the SET of
   * checkpoints from this array alone, so leaving it out is how it stops being
   * drawn — there is no second list to keep in agreement.
   */
  private readonly splits: SplitRow[] = [];
  /** Index into `splits` of the next checkpoint to cross. */
  private splitCursor = 0;
  /** Best run's split times, or null where there is no best yet. */
  private readonly bestSplits: (number | null)[] = [];
  /** `CP 1` .. `CP 8`, built once. A split popup must not mint a string. */
  private readonly splitLabels: string[] = [];
  private bestTime: number | null = null;

  // ── Popups ─────────────────────────────────────────────────────────────────
  private readonly popupRing: HudPopup[] = [];
  private popupNext = 0;

  // ── Per-run accumulators ───────────────────────────────────────────────────
  private runTopSpeed = 0;
  /** Whether the run that produced `_stats` reached the goal. Drives the score. */
  private clearedRun = false;
  /** Annotated: `DAMAGE.maxHealth` is a literal type, and inference would
   *  narrow this to `5` and reject every real health reading. */
  private lastHealth: number = DAMAGE.maxHealth;
  private transmissionLeft = 0;

  // ── Audio ──────────────────────────────────────────────────────────────────
  /** Last intensity actually sent, so a cross-fade is not re-triggered at 120 Hz. */
  private lastIntensity: MusicIntensity | null = null;

  private disposed = false;

  // ── The one model, and the one route profile ───────────────────────────────
  private readonly routeProfile: Float32Array;
  private readonly _stats: StageStats;
  private readonly model: HudModel;
  /** Reused by the construction-time profile sweep only. */
  private readonly sampleOut: TrackSampleResult;

  constructor(deps: StageDirectorDeps) {
    this.track = deps.track;
    this.terrain = deps.terrain;
    this.audio = deps.audio ?? null;

    this.parTime = this.track.length / PAR_PACE;
    this.timeLimit = this.parTime * TIME_LIMIT_PAR_MULTIPLE;

    // The split table: one row per checkpoint after the start line.
    for (let i = 1; i < CHECKPOINT_TS.length; i++) {
      this.splits.push({ index: i, time: null, delta: null });
      this.bestSplits.push(null);
      this.splitLabels.push(`CP ${i}`);
    }

    for (let i = 0; i < POPUP_RING; i++) {
      this.popupRing.push({ text: '', value: 0, kind: 'split' });
    }

    this.sampleOut = this.track.sampleAtT(0);
    this.routeProfile = this.buildRouteProfile();

    this._stats = {
      time: 0,
      timeLeft: this.timeLimit,
      fragments: 0,
      fragmentsTotal: 0,
      shards: 0,
      shardsTotal: 0,
      enemiesDefeated: 0,
      enemiesTotal: 0,
      damageTaken: 0,
      bestCombo: 0,
      styleScore: 0,
      shortcuts: 0,
      shortcutsTotal: 0,
      grindDistance: 0,
      wallRunDistance: 0,
      topSpeed: 0,
      rank: StageRank.D,
      isNewBest: false,
    };

    this.model = {
      phase: this._phase,
      speedDisplay: 0,
      speedFraction: 0,
      mode: MoveMode.Grounded,

      timeLeft: this.timeLimit,
      time: 0,
      timeCritical: false,

      health: DAMAGE.maxHealth,
      maxHealth: DAMAGE.maxHealth,
      boost: 0,
      boosting: false,

      combo: 0,
      comboWindow: 0,
      styleScore: 0,
      styleGrade: '',

      fragments: 0,
      fragmentsTotal: 0,
      shards: 0,
      shardsTotal: 0,

      routeProgress: 0,
      routeProfile: this.routeProfile,
      objective: SECTION_OBJECTIVE[TrackSectionKind.TechnicalStart],
      prompt: TraversalPrompt.None,

      splits: this.splits,
      popups: [],

      boss: null,
      transmission: null,
      countdown: null,
      results: null,
      wrongWay: false,
    };
  }

  /**
   * Bake the descent silhouette. Called once, from the constructor.
   *
   * The centreline's own y is the profile, not the terrain under it: the ground
   * has been carved to follow the ribbon and the ribbon is the surface the run
   * actually happens on, so sampling the heightfield instead would draw the
   * hillside beside the trail rather than the trail. `terrain.heightAt` is here
   * only as a NaN guard, which is the same guarantee `TrackSpline` makes about
   * its own centreline for the same reason: a single NaN in this array poisons
   * the widget's baked path and the panel renders empty with nothing in the log.
   */
  private buildRouteProfile(): Float32Array {
    const out = new Float32Array(ROUTE_PROFILE_SAMPLES);
    for (let i = 0; i < ROUTE_PROFILE_SAMPLES; i++) {
      const s = this.track.sampleAtT(i / (ROUTE_PROFILE_SAMPLES - 1), this.sampleOut);
      let y = s.position.y;
      if (!Number.isFinite(y)) y = this.terrain.heightAt(s.position.x, s.position.z);
      out[i] = Number.isFinite(y) ? y : 0;
    }
    return out;
  }

  // ── IStageDirector ─────────────────────────────────────────────────────────

  get phase(): StagePhase {
    return this._phase;
  }

  get stats(): StageStats {
    return this._stats;
  }

  get routeDistance(): number {
    return this._routeDistance;
  }

  get routeProgress(): number {
    return this._routeProgress;
  }

  /** Seconds since the clock started — i.e. since the countdown ended. */
  get elapsed(): number {
    return this._elapsed;
  }

  begin(): void {
    this.resetRun();
    this.setPhase(StagePhase.Countdown);
    this.countdownLeft = COUNTDOWN_SECONDS;
    this.hornTick = -1;
    this.model.countdown = this.countdownLeft;
  }

  restart(): void {
    this._routeDistance = 0;
    this._routeProgress = 0;
    this.hintDistance = 0;
    this.begin();
  }

  /**
   * Skip the countdown and go straight to `Running`.
   *
   * The capture harness's entry point. A still shot 24 physics steps into a
   * pose must not be a still of the number 3 — and the harness has already
   * teleported the player to where the pose wants them, so there is nothing for
   * a countdown to count into.
   */
  forceRunning(): void {
    this.countdownLeft = 0;
    this.model.countdown = null;
    this.setPhase(StagePhase.Running);
  }

  pause(): void {
    if (this._phase === StagePhase.Paused) return;
    this.resumePhase = this._phase;
    this.setPhase(StagePhase.Paused);
  }

  resume(): void {
    if (this._phase !== StagePhase.Paused) return;
    this.setPhase(this.resumePhase);
  }

  /**
   * Make the clock agree with a position the harness teleported to.
   *
   * The defect this fixes is in RESUME.md: the review set had frames reading
   * DESCENT PROFILE 96% beside TIME 0:00.19, because a pose jumps the player
   * down the course without riding there. A reviewer judging composition is
   * entitled to a frame whose own HUD is internally consistent.
   *
   * It also BACKFILLS the split table, silently. The alternative is a table of
   * nulls at 96% of the descent — a profile panel with no checkpoint lit and a
   * clock claiming a minute has passed, which is the same internal contradiction
   * one field over. The times are interpolated from the checkpoint's normalised
   * position rather than simulated, for the same reason the clock is: simulating
   * the run to each pose would cost minutes per capture.
   *
   * Call it AFTER `resetRun()`, not before — `resetRun` is a full wipe and will
   * take the backfill with it.
   */
  setElapsed(seconds: number): void {
    this._elapsed = Math.max(0, seconds);
    this.syncClock();

    this.splitCursor = 0;
    for (let i = 0; i < this.splits.length; i++) {
      const row = this.splits[i];
      const t = CHECKPOINT_TS[row.index];
      if (t <= this._routeProgress) {
        row.time = this._elapsed * (this._routeProgress > 1e-6 ? t / this._routeProgress : 0);
        row.delta = this.deltaFor(i, row.time);
        this.splitCursor = i + 1;
      } else {
        row.time = null;
        row.delta = null;
      }
    }
  }

  /**
   * Drop live popups and per-run state.
   *
   * Called on restart and on every capture pose. The capture case is why the
   * split cursor is RESYNCED rather than zeroed: `--poses` shoots all sixteen
   * stills in one page, so a table wiped back to checkpoint 0 while the player
   * stands at 96% of the course re-crosses all eight on the next physics step
   * and hands the next review frame a stack of split cards it did not earn.
   * Clearing what is shown and moving the cursor to where the player actually
   * is says the same thing without the storm.
   */
  resetRun(): void {
    this._elapsed = 0;
    this.verdictLeft = 0;
    this.runTopSpeed = 0;
    this.clearedRun = false;
    this.lastHealth = DAMAGE.maxHealth;
    this.transmissionLeft = 0;
    this.wrongWayDwell = 0;
    this._wrongWay = false;

    this.model.popups.length = 0;
    this.popupNext = 0;
    this.model.transmission = null;
    this.model.results = null;
    this.model.wrongWay = false;

    this.splitCursor = 0;
    for (let i = 0; i < this.splits.length; i++) {
      this.splits[i].time = null;
      this.splits[i].delta = null;
      // Everything already behind the player is passed, not pending.
      if (CHECKPOINT_TS[this.splits[i].index] <= this._routeProgress) this.splitCursor = i + 1;
    }

    this._stats.time = 0;
    this._stats.timeLeft = this.timeLimit;
    this._stats.damageTaken = 0;
    this._stats.bestCombo = 0;
    this._stats.styleScore = 0;
    this._stats.grindDistance = 0;
    this._stats.wallRunDistance = 0;
    this._stats.topSpeed = 0;
    this._stats.rank = StageRank.D;
    this._stats.isNewBest = false;

    this.syncClock();
  }

  /**
   * Queue a popup.
   *
   * The record is COPIED into a ring rather than retained, so a caller may
   * build its argument on the stack and the director never allocates. The ring
   * is sized against one frame because `PopupWidget` empties `model.popups`
   * every rendered frame.
   */
  pushPopup(p: HudPopup): void {
    this.emitPopup(p.text, p.value, p.kind);
  }

  /**
   * The internal path. `pushPopup` takes a record because that is the contract
   * the rest of the game will call through; everything inside this file uses
   * this instead, so a director-raised popup does not mint an object literal
   * just to have its three fields copied straight back out of it.
   */
  private emitPopup(text: string, value: number, kind: HudPopup['kind']): void {
    const slot = this.popupRing[this.popupNext];
    this.popupNext = (this.popupNext + 1) % POPUP_RING;
    slot.text = text;
    slot.value = value;
    slot.kind = kind;
    this.model.popups.push(slot);
  }

  /**
   * Put a line of dialogue on the transmission plate.
   *
   * The widget owns the typing, the caret and the hold; the model's job is only
   * to hold the line up long enough for it to be typed out and then drop it to
   * null, which is the signal the widget reads to start its own hold. The
   * duration is derived from the length of the line for that reason and not
   * guessed — a line that outruns its own reveal never finishes typing.
   */
  say(line: string): void {
    this.model.transmission = line;
    // ~24 characters a second to reveal, plus two seconds to read the whole.
    this.transmissionLeft = 2.0 + line.length / 24;
  }

  dispose(): void {
    this.disposed = true;
    this.audio = null;
    this.model.popups.length = 0;
  }

  /**
   * The frame's HUD model.
   *
   * The SAME object every call. `step()` has already written every field into
   * it on the fixed step, so this is a return and not a build — there is no
   * per-frame work here to skip and nothing to allocate.
   */
  getHudModel(): HudModel {
    return this.model;
  }

  // ── The step ───────────────────────────────────────────────────────────────

  /**
   * Advance the stage. Called on the FIXED 120 Hz step, never from a frame.
   *
   * The order is deliberate: progress first, because the phase transitions
   * (reaching the goal) read it; then the clock, because `Failed` reads it;
   * then the readouts, so the model a paused frame hands back is the model of
   * the step the pause landed on rather than a stale one.
   */
  step(player: PlayerState, dt: number): void {
    if (this.disposed) return;

    switch (this._phase) {
      case StagePhase.Countdown:
        this.stepCountdown(dt);
        break;
      case StagePhase.Running:
      case StagePhase.Boss:
        this._elapsed += dt;
        break;
      case StagePhase.Cleared:
      case StagePhase.Failed:
        this.verdictLeft -= dt;
        if (this.verdictLeft <= 0) this.setPhase(StagePhase.Results);
        break;
      default:
        // Title, Intro, Paused, Results: the world may still be rendering, but
        // nothing about the run is advancing.
        break;
    }

    // Progress tracks in EVERY phase — the profile marker follows the player
    // through the attract loop and through a pause, and a marker that freezes
    // where the pause happened to land is a panel disagreeing with the picture
    // behind it. Splits and statistics do not: a checkpoint crossed during the
    // title screen is not a checkpoint, and metres of rail ground while the
    // game is paused are not mastery.
    const live = this._phase === StagePhase.Running || this._phase === StagePhase.Boss;
    this.stepProgress(player, dt, live);
    if (live) this.stepStats(player, dt);
    this.syncClock();

    if (this._phase === StagePhase.Running || this._phase === StagePhase.Boss) {
      if (this._routeProgress >= FINISH_PROGRESS) this.finish(true);
      else if (this._stats.timeLeft <= 0) this.finish(false);
    }

    if (this.transmissionLeft > 0) {
      this.transmissionLeft -= dt;
      if (this.transmissionLeft <= 0) this.model.transmission = null;
    }

    this.syncReadouts(player);
    this.stepMusic(player);
  }

  private stepCountdown(dt: number): void {
    this.countdownLeft -= dt;
    this.model.countdown = this.countdownLeft;

    // One horn per whole second remaining. `CountdownWidget` clamps its digit
    // to 3, so the fractional head of `COUNTDOWN_SECONDS` (3.4) is silent and
    // the first horn lands on the 3.
    const tick = Math.ceil(this.countdownLeft - 1e-4);
    if (tick !== this.hornTick && tick >= 1 && tick <= 3) {
      this.hornTick = tick;
      // Rising: 3 -> 0.92, 2 -> 1.0, 1 -> 1.08. The gun is a fifth above.
      this.audio?.playStartHorn(1.0 + (2 - tick) * 0.08);
    }

    if (this.countdownLeft <= 0) {
      this.model.countdown = 0;
      this.audio?.playStartHorn(1.3);
      this.setPhase(StagePhase.Running);
      this._elapsed = 0;
      this.say(OPENING_TRANSMISSION);
    }
  }

  /**
   * Project the player onto the route and advance progress.
   *
   * Progress is MONOTONIC. A player who runs back uphill does not un-earn it,
   * because everything downstream of it reads as a mistake if they do: the
   * profile marker walks backwards, the header percentage counts down, and the
   * checkpoint cursor un-crosses a gate the player would then re-cross for a
   * second split card. The raw projection is still tracked — that is what the
   * wrong-way flag is derived from, and it is what feeds the hint.
   */
  private stepProgress(player: PlayerState, dt: number, live: boolean): void {
    const proj = this.track.project(player.position, this.hintDistance);
    this.hintDistance = proj.distance;

    if (proj.distance > this._routeDistance) this._routeDistance = proj.distance;
    const len = this.track.length;
    this._routeProgress = len > 0 ? clamp01(this._routeDistance / len) : 0;

    this.model.objective = SECTION_OBJECTIVE[proj.sample.section] ?? '';

    // Along-track velocity. `tangent` is unit and points down the course, so
    // this is signed metres per second of actual progress being made.
    const along = player.velocity.dot(proj.sample.tangent);
    this.stepWrongWay(along, dt);

    if (live) this.stepSplits();
  }

  private stepWrongWay(along: number, dt: number): void {
    if (along < WRONG_WAY_ENTER) {
      this.wrongWayDwell = Math.min(WRONG_WAY_DWELL, this.wrongWayDwell + dt);
    } else if (along > WRONG_WAY_EXIT) {
      this.wrongWayDwell = Math.max(0, this.wrongWayDwell - dt * WRONG_WAY_CLEAR_RATE);
    }
    // Between the two thresholds the dwell holds: that band is where a player
    // hovering around a standstill lives, and it must not decide anything.

    if (!this._wrongWay && this.wrongWayDwell >= WRONG_WAY_DWELL) this._wrongWay = true;
    else if (this._wrongWay && this.wrongWayDwell <= 0) this._wrongWay = false;
  }

  /**
   * Cross any checkpoints the monotonic progress has just passed.
   *
   * A `while` and not an `if`: a capture teleport legitimately crosses three
   * gates inside a single physics step, and swallowing two of them to avoid the
   * popup storm would leave the split table permanently wrong. The storm is
   * suppressed by the caller (`Game.render` drops `popups` for a few frames
   * after a teleport) and by `resetRun`, which is where the harness's problem
   * belongs — not in the rule about what a checkpoint is.
   */
  private stepSplits(): void {
    while (
      this.splitCursor < this.splits.length &&
      this._routeProgress >= CHECKPOINT_TS[this.splits[this.splitCursor].index]
    ) {
      const i = this.splitCursor++;
      const row = this.splits[i];
      row.time = this._elapsed;
      row.delta = this.deltaFor(i, row.time);

      this.audio?.playUi('checkpoint');
      this.emitPopup(this.splitLabels[i], row.time, 'split');
    }
  }

  /** Delta against the saved best for split `i`, or null if there is no best. */
  private deltaFor(i: number, time: number): number | null {
    const best = this.bestSplits[i];
    return best === null ? null : time - best;
  }

  private stepStats(player: PlayerState, dt: number): void {
    const s = this._stats;

    if (player.groundSpeed > this.runTopSpeed) this.runTopSpeed = player.groundSpeed;
    s.topSpeed = this.runTopSpeed;

    // Traversal mastery. Measured in metres of course rather than seconds of
    // attachment, because a slow grind and a fast one are not the same
    // achievement and the second one is the point of the movement set.
    if (player.mode === MoveMode.Grinding) s.grindDistance += player.groundSpeed * dt;
    else if (player.mode === MoveMode.WallRun) s.wallRunDistance += player.groundSpeed * dt;

    // Damage is accumulated from the health that actually left, not counted in
    // hits: a hit that lands during invulnerability costs nothing and must not
    // appear on the results table as though it did.
    if (player.health < this.lastHealth) s.damageTaken += this.lastHealth - player.health;
    this.lastHealth = player.health;
  }

  /** Push the clock into the stats and the model. */
  private syncClock(): void {
    const s = this._stats;
    s.time = this._elapsed;
    s.timeLeft = Math.max(0, this.timeLimit - this._elapsed);

    this.model.time = s.time;
    this.model.timeLeft = s.timeLeft;
    this.model.timeCritical = s.timeLeft <= TIME_CRITICAL;
  }

  /** Everything the HUD reads that is a plain view of the player or the run. */
  private syncReadouts(player: PlayerState): void {
    const m = this.model;

    m.speedDisplay = player.groundSpeed * SPARK_UNITS_PER_MPS;
    // See SPEED_FRACTION_FLOOR. `runTopSpeed` has already taken this step's
    // speed into account, so the fraction can never exceed 1 and is not clamped
    // to hide a bug.
    m.speedFraction = clamp01(
      player.groundSpeed / Math.max(this.runTopSpeed, RUN.max * SPEED_FRACTION_FLOOR),
    );
    m.mode = player.mode;

    m.health = player.health;
    m.maxHealth = DAMAGE.maxHealth;
    m.boost = player.boost;
    m.boosting = player.boosting;

    m.routeProgress = this._routeProgress;
    // Straight off the physics. The player layer already decided what is in
    // reach this step and recomputing it here would be a second opinion on a
    // question that has an owner.
    m.prompt = player.prompt;

    m.wrongWay = this._wrongWay;

    m.styleScore = this._stats.styleScore;
    m.combo = 0;
    m.comboWindow = 0;
    m.styleGrade = '';
  }

  private stepMusic(player: PlayerState): void {
    if (!this.audio) return;

    let want: MusicIntensity;
    if (
      this._phase === StagePhase.Cleared ||
      this._phase === StagePhase.Failed ||
      this._phase === StagePhase.Results
    ) {
      // Read from how the run ENDED, not from the stats. A slow clear can leave
      // rank D with the clock still running and a failure leaves rank D with it
      // stopped, and inferring the difference back out of two numbers that
      // happen to differ is how the results screen ends up playing the wrong
      // cue on the one run nobody tests.
      want = this.clearedRun ? 'victory' : 'defeat';
    } else if (this._phase === StagePhase.Boss) {
      want = 'boss';
    } else if (
      this.model.timeCritical ||
      (DAMAGE.maxHealth > 0 && player.health / DAMAGE.maxHealth <= 0.34)
    ) {
      // The same 0.34 the health widget lifts its CRITICAL frame at. One
      // definition of "in trouble", so the score and the HUD agree.
      want = 'critical';
    } else if (player.groundSpeed >= TRAVERSE_SPEED) {
      want = 'traverse';
    } else {
      want = 'explore';
    }

    if (want !== this.lastIntensity) {
      this.lastIntensity = want;
      this.audio.setMusicIntensity(want);
    }
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  private setPhase(p: StagePhase): void {
    this._phase = p;
    this.model.phase = p;
    if (p !== StagePhase.Countdown) this.model.countdown = null;
    this.model.results = p === StagePhase.Results ? this._stats : null;
  }

  private finish(cleared: boolean): void {
    const s = this._stats;
    this.clearedRun = cleared;
    s.rank = cleared ? this.computeRank() : StageRank.D;

    if (cleared && (this.bestTime === null || s.time < this.bestTime)) {
      s.isNewBest = true;
      this.bestTime = s.time;
      for (let i = 0; i < this.splits.length; i++) this.bestSplits[i] = this.splits[i].time;
    }

    this.verdictLeft = VERDICT_HOLD;
    this.setPhase(cleared ? StagePhase.Cleared : StagePhase.Failed);
    this.audio?.playStinger(cleared ? 'clear' : 'fail');
  }

  /**
   * The rank, computed on a clear.
   *
   * Two inputs, per the design: the time, expressed against `parTime` so the
   * ladder survives the course changing length, and MASTERY — the fraction of
   * the descent the player spent attached to the mountain rather than falling
   * down it, which is the one number that separates a fast line from a fast
   * line ridden well.
   */
  private computeRank(): StageRank {
    const s = this._stats;
    /** Time as a multiple of par. 1.0 is a par run; lower is faster. */
    const pace = this.parTime > 0 ? s.time / this.parTime : Infinity;
    /**
     * 0..1. Metres of rail and wall carried, over the length of the course.
     * Capped at 1 because a course can be more than 100% covered — a rail run
     * back and forth accumulates distance the descent does not.
     */
    const mastery = clamp01(
      this.track.length > 0 ? (s.grindDistance + s.wallRunDistance) / this.track.length : 0,
    );
    /** 0..1. Fraction of the health bar spent. */
    const hurt = DAMAGE.maxHealth > 0 ? clamp01(s.damageTaken / DAMAGE.maxHealth) : 0;

    // TODO(human): the rank ladder.
    //
    // Map (pace, mastery, hurt) onto S / A / B / C / D and return it. Write
    // down the reasoning for the thresholds you pick, the way the rest of this
    // file does — the numbers are the design, and a ladder with no argument
    // behind it is the thing a later reader deletes.
    //
    // Some of the shape of the problem:
    //   - `pace` is the primary axis. 1.0 is the run PAR_PACE describes; the
    //     clock does not run out until 2.5.
    //   - `mastery` at 1.0 means the player spent the whole course length
    //     attached to rails and walls, which is not achievable — a realistic
    //     good run is somewhere well under half.
    //   - `hurt` at 1.0 means the whole health bar. It is a gate or a demotion
    //     rather than an axis of its own; decide which.
    //   - Whether S should be reachable on pace alone is the actual design
    //     question. If it is, the movement set is decoration.
    return StageRank.D;
  }
}

export function createStageDirector(deps: StageDirectorDeps): StageDirector {
  return new StageDirector(deps);
}
