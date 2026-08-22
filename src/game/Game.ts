/**
 * Game — the orchestrator.
 *
 * Every subsystem in this project is written against `Contracts.ts` and nothing
 * else. This file is the only place that knows all of them exist, and its job
 * is to build them in dependency order and then call them in the right order,
 * every frame, forever.
 *
 * The order is not arbitrary and changing it will break things:
 *
 *   FIXED STEP (120 Hz, from the engine's accumulator)
 *     buildPlayerInput   drain the queued button pulses, resolve the move
 *                        vector against the camera yaw
 *     player.step        collision, modes, attachments
 *     stage.step         clock, progress, splits, stats
 *
 *   RENDER (once per displayed frame, on interpolated state)
 *     input              the player's raw intent for THIS frame
 *     queueEdges         latch this frame's press edges for the next step
 *     effects.beginFrame returns the time-scaled dt (slow-mo lives here)
 *     player.updateVisual the rig solves IK on an INTERPOLATED transform
 *     camera             reads the finished player transform, never a stale one
 *     effects.update     dust/debris/speed lines follow the camera it just set
 *     hud / audio        read the resolved frame
 *     post.render        shadows -> G-buffer -> hulls -> cel -> lines -> grade
 *     hud.render         drawn over the graded frame, never through the LUT
 *
 * The rig MUST solve after the physics has been placed and before the camera
 * reads anything, or the character lags the camera by one frame.
 *
 * ── WHY INPUT IS QUEUED RATHER THAN READ ────────────────────────────────────
 * `Engine.advance()` runs every fixed step for a frame and THEN calls the render
 * function, and `Input.clearEdges()` is called at the end of that render. So a
 * `justPressed` edge exists only inside `render()` — no `fixedUpdate` can ever
 * observe one. A jump read directly off the button state would therefore either
 * be missed entirely or, worse, be seen as "pressed" by every one of the frame's
 * two-plus steps: `PlayerPhysics` re-arms its double jump on any step where
 * `input.jump` is true, so a held key would spend the whole air-charge budget in
 * 16 ms.
 *
 * `queueEdges()` latches each press during render; `buildPlayerInput()` drains
 * the latch on the next step that runs. The latch PERSISTS across a frame that
 * produces no fixed steps at all, which happens at high refresh rates and is
 * exactly when a dropped jump would be least explicable.
 */

import { PerspectiveCamera, Vector3 } from 'three';

import { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import { Sky } from '../npr/Sky';
import { NPR, POST_STATE, updateNprGlobals } from '../npr/NprGlobals';
import { initGeneratedTextures } from '../npr/GeneratedTextures';
import { PostPipeline, decayPostState, type PostDebugView } from '../npr/PostPipeline';
import { CHARACTER_COLORS } from '../npr/Palette';

import { createTerrain, type Terrain } from '../terrain';
import { createTrack, type Track } from '../track';
import { createPlayer, type Player } from '../player';
import { createEffects, type Effects } from '../fx';
import { Hud } from '../hud';
import { AudioEngine } from '../audio';
import { createStageDirector, type StageDirector } from './StageDirector';
import { createTraversal, type TraversalBundle } from '../traversal';

import {
  CameraMode,
  PickupKind,
  StagePhase,
  type PickupEvent,
  type PlayerInput,
} from './Contracts';
import { clamp01 } from '../core/MathX';
import { RUN } from '../player/SparkConstants';

export interface GameOptions {
  params: URLSearchParams;
}

/**
 * The surface the Playwright harness drives. Kept deliberately small: take the
 * clock, set a named situation, step a fixed dt, shoot. Anything the harness
 * needs that isn't expressible as "a named pose" belongs in the game, not here.
 */
export interface CaptureApi {
  takeControl(): void;
  releaseControl(): void;
  step(dt: number): void;
  /**
   * Redraw the current state without advancing it.
   *
   * For A/B probes, which need two frames of the SAME instant with one uniform
   * changed between them — an override on `PostPipeline`'s composite is the only
   * difference that may exist, so stepping physics between the grabs is not an
   * option. Several probes were already calling `capture.render?.()`, which
   * silently did nothing because the method did not exist; the optional-call
   * turned a missing handle into a stale framebuffer, and the diff came back as
   * a flat zero for a control that could not possibly be zero.
   */
  render(): void;
  setPose(name: string): boolean;
  setSequence(name: string): boolean;
  listPoses(): string[];
  listSequences(): string[];
  setDebugView(view: string): void;
}

/**
 * A capture setup. `t` is the fraction along the route the player is teleported
 * to; the camera is placed by `camera` (+ `orbit` when framing by hand), and
 * `input` is held for every step until the next setup.
 */
interface Situation {
  /**
   * Where on the route, as a fraction of track length. Anchored to the REAL
   * section boundaries reported by `track.sectionRanges`, not guessed — a pose
   * sitting exactly on a boundary reads as the previous section, which is how
   * the first review set ended up with a `rockgarden` frame labelled
   * SWITCHBACKS and a `tabletop` frame labelled ROCK GARDEN. Half the set was
   * reviewing the wrong feature.
   */
  t: number;
  /** Ground speed along the route tangent at spawn, m/s. */
  speed: number;
  /** Height above the ground at spawn — greater than 0 puts the player in the air. */
  lift?: number;
  /**
   * Vertical launch velocity, m/s. An air pose needs the character to be
   * genuinely ballistic over the feature; dropping one in at a fixed height
   * just makes a figure hanging in space, and the settle frames put it straight
   * back on the ground before the shutter opens.
   */
  launch?: number;
  /**
   * Fixed physics steps to run before the shutter, at 120 Hz.
   *
   * An air pose should be REACHED by running into it, not faked with a vertical
   * impulse: an artificial launch on the old `ravine-gap` flew the rider past
   * the receiving ramp and 13 m into the far hillside. The harness only settles
   * 12 frames before shooting, which at these speeds is a long way, so a pose
   * that needs to cover ground on the run-in has to say so.
   *
   * A word on scale. What a preroll must hold constant is the DISTANCE from the
   * spawn to the feature — a fixed number of metres on the mountain — so a
   * preroll is really a distance expressed in steps, and it stays correct only
   * while the speed it was divided by does. `RUN.max` was read as 74 m/s when
   * these were authored; the unit fix (`SPARK_UNIT_METRES`) made it 20.17, which
   * cut what every preroll covered to 27% of its intended reach and left the
   * ballistic poses shooting the run-in rather than the feature. Each is now
   * 3.67x longer, which restores the metres exactly.
   *
   * 120 steps — one second — covers 20 m at top speed. A preroll tuned against
   * the old number, or against the bike before it, falls short of the feature.
   */
  preroll?: number;
  camera: CameraMode;
  orbit?: { yaw: number; pitch: number; dist: number; spin?: number };
  input?: Partial<PlayerInput>;
  /** Take a scripted hit partway into the captured window. */
  hurt?: boolean;
}

// Section boundaries as a fraction of the course, measured from the built track
// rather than assumed:
//   technical-start 0.000–0.109   scree-run    0.109–0.269
//   switchbacks     0.269–0.518   rock-garden  0.518–0.600
//   tabletop        0.600–0.651   ravine-gap   0.651–0.702
//   ridge-sprint    0.702–0.811   stream-bed   0.811–0.887
//   final-sprint    0.887–1.000
// The ravine's actual hole is at 0.675–0.678.
const SITUATIONS: Record<string, Situation> = {
  'summit-wide':        { t: 0.004, speed: 0,  camera: CameraMode.Orbit, orbit: { yaw: 0.35, pitch: 0.22, dist: 52, spin: 0 } },
  'summit-rider':       { t: 0.020, speed: RUN.max * 0.081,   camera: CameraMode.Orbit, orbit: { yaw: 0.95, pitch: 0.18, dist: 9 } },
  // Tight enough to read the face and the hands. The character is 1.8 m, so a
  // 3.4 m stand-off is a chest-up crop rather than the full figure.
  'rider-closeup':      { t: 0.075, speed: RUN.max * 0.162, camera: CameraMode.Orbit, orbit: { yaw: 2.30, pitch: 0.10, dist: 3.4 } },
  'rider-threequarter': { t: 0.075, speed: RUN.max * 0.162, camera: CameraMode.Orbit, orbit: { yaw: 0.95, pitch: 0.20, dist: 5.0 } },
  // Side-on and low, so the run cycle is a readable silhouette rather than a
  // three-quarter rear view half-occluded by the character's own leg. This is
  // the pose the locomotion rig is judged on.
  'run-cycle':          { t: 0.075, speed: RUN.max * 0.297, camera: CameraMode.Orbit, orbit: { yaw: 1.57, pitch: 0.04, dist: 5.2 } },
  'scree-speed':        { t: 0.189, speed: RUN.max * 0.595, camera: CameraMode.Chase, input: { moveZ: 1 } },
  'switchback-lean':    { t: 0.394, speed: RUN.max * 0.459, camera: CameraMode.Chase, input: { moveX: 0.38, moveZ: 1 } },
  'treeline-silhouette':{ t: 0.470, speed: RUN.max * 0.351, camera: CameraMode.Orbit, orbit: { yaw: 2.65, pitch: 0.06, dist: 16 } },
  'rockgarden-low':     { t: 0.559, speed: RUN.max * 0.351, camera: CameraMode.Orbit, orbit: { yaw: 0.60, pitch: -0.08, dist: 6.5 } },
  // Genuinely ballistic off the table, not parked in the air above it. Placed on
  // the run-in and run off the lip. No impulse.
  'tabletop-air':       { t: 0.6100, speed: RUN.max * 0.541, preroll: 330, camera: CameraMode.Chase, input: { moveZ: 1 } },
  // The ravine is MEASURED, not guessed: `planLayout` reports one gap, 1494 to
  // 1506 m, on a 2000 m course. This pose used to sit at t 0.669 — 156 m short
  // of it, a leftover from before the course scale went to 1.0 — so the frame
  // whose whole purpose is a ravine crossing contained no ravine.
  //
  // There is now a kicker on the near lip at 1484 m, so the launch is the RAMP's
  // rather than an injected impulse: spawn 26 m back, run at it, and the wedge
  // converts the speed into the arc. 0.729 * 2000 = 1458, and 12.5 m/s for the
  // 220-step preroll covers 23 m, which puts the shutter on the lip. Both of
  // those numbers moved with the unit fix; the 23 m is what did not, which is
  // the invariant `preroll` explains.
  'ravine-gap':         { t: 0.7290, speed: RUN.max * 0.622, preroll: 220, camera: CameraMode.Orbit, orbit: { yaw: 2.10, pitch: 0.26, dist: 11 } },
  'ridge-exposure':     { t: 0.757, speed: RUN.max * 0.432, camera: CameraMode.Orbit, orbit: { yaw: 0.20, pitch: 0.30, dist: 26 } },
  streambed:            { t: 0.849, speed: RUN.max * 0.324, camera: CameraMode.Chase },
  // A slide down a gradient: the hull drops, the dust rate changes, and the
  // camera sits low enough to see both.
  slide:                { t: 0.230, speed: RUN.max * 0.541, camera: CameraMode.Chase, input: { moveZ: 1, crouch: true } },
  // Short of the line, so the goal is ahead of the character and in frame.
  'finish-sprint':      { t: 0.955, speed: RUN.max * 0.703, camera: CameraMode.Chase, input: { moveZ: 1 } },
  // Was `crash`. The name is kept because the capture harness's default pose
  // list uses it, and because it is still the pose that reviews impact
  // punctuation — it is now a scripted hit rather than a bike going down.
  crash:                { t: 0.559, speed: RUN.max * 0.459, camera: CameraMode.Orbit, orbit: { yaw: 1.25, pitch: 0.18, dist: 8 }, hurt: true },
  'valley-vista':       { t: 0.300, speed: 0,  camera: CameraMode.Orbit, orbit: { yaw: 0.0, pitch: 0.06, dist: 180, spin: 0 } },

  // ── Traversal ──────────────────────────────────────────────────────────────
  //
  // Every t here is read off `planLayout`'s own census rather than eyeballed,
  // because the affordances move whenever the course scale or a density changes
  // and a traversal pose that misses its rail by 40 m is a frame that proves
  // nothing. Current course: route rail 1033-1158 m, booster pad 945 m, chimney
  // 1055-1111 m, kicker 1484 m into the 1494-1506 m gap with a dash ring at
  // 1500 m.

  // Side-on and level with the trail, so the rail's tube, its struts and its
  // entry chevrons are all in silhouette. The rail is only 8.5 cm across — this
  // is the pose that says whether it reads at all or whether the chevrons are
  // carrying it single-handed.
  'rail-line':          { t: 0.5220, speed: RUN.max * 0.243, camera: CameraMode.Orbit, orbit: { yaw: 1.57, pitch: 0.05, dist: 15 } },
  // Looking back up the corridor between the two facing plates. Pitched up,
  // because the whole claim of a chimney is 15.5 m of climb.
  chimney:              { t: 0.5350, speed: RUN.max * 0.189, camera: CameraMode.Orbit, orbit: { yaw: 2.90, pitch: 0.34, dist: 21 } },
  // Chase, closing on the pad, so the chevrons are read the way a player reads
  // them: head-on and with a third of a second to do it.
  'boost-pad':          { t: 0.4680, speed: RUN.max * 0.541, camera: CameraMode.Chase, input: { moveZ: 1 } },
  // Through the ring on the far side of the ravine. Same launch as `ravine-gap`
  // but chase-framed and later, so the ring is the subject rather than the arc.
  'dash-ring':          { t: 0.7290, speed: RUN.max * 0.703, preroll: 352, camera: CameraMode.Chase, input: { moveZ: 1 } },
};

/**
 * Motion setups. Each is a DISTINCT run that contains its own event.
 *
 * They previously all pointed at a handful of shared situations and differed
 * only by an `input` field, which for the air sequences was inert because the
 * subject was never airborne. A motion review found the result: three of the
 * eight sequences were byte-for-intent the same capture (mean absolute pixel
 * difference 1.18 on 0-255). Five of eight sequences were two runs.
 *
 * `preroll` is in 120 Hz physics steps and is the whole game here. A sequence
 * settles 4 render frames (8 steps) before its first shutter, so the preroll has
 * to put the event a few captured frames IN — inside the window a reviewer is
 * looking at, rather than before it.
 */
const SEQUENCES: Record<string, { from: string; input?: Partial<PlayerInput>; preroll?: number }> = {
  launch:         { from: 'summit-rider', input: { moveZ: 1 } },
  // 0.35, not 0.9. Full stick leaves a 3.7 m half-width ribbon almost
  // immediately at these speeds, and every downstream "defect" measured in the
  // old capture followed from the subject being off the trail and then in free
  // fall down the side of it. The sequence is meant to show a switchback being
  // carved, not a departure.
  switchback:     { from: 'switchback-lean', input: { moveX: 0.35, moveZ: 1 } },
  'tabletop-air': { from: 'tabletop-air', preroll: 84, input: { moveZ: 1 } },
  // Starts later on the same run-in so the whole capture is the descent, the
  // touchdown and the absorption chain that follows it.
  landing:        { from: 'tabletop-air', preroll: 128, input: { moveZ: 1 } },
  crash:          { from: 'crash' },
  'scree-speed':  { from: 'scree-speed', input: { moveZ: 1 } },
  // The air dash. `dash` is a PULSE — see `setScripted` — so it fires on the
  // first step of the sequence and then the coast is what gets photographed,
  // which is the whole point: a dash held every step would re-fire until the
  // air charges ran out and the capture would be of the charge budget emptying.
  'air-dash':     { from: 'tabletop-air', preroll: 96, input: { moveZ: 1, dash: true } },
  slide:          { from: 'slide', input: { moveZ: 1, crouch: true } },
};

const _v = new Vector3();
const _fwd = new Vector3();
/** Where a scripted capture hit comes from. See `pendingHurtSteps`. */
const _hurtFrom = new Vector3();
/** The step's start position, for the swept pickup test. See `collectPickups`. */
const _pickFrom = new Vector3();
/** Collect bursts throw sparks upward, away from the ground. */
const _pickUp = new Vector3(0, 1, 0);

/**
 * Scratch for `Input.drainLook`. Module-scoped because `render()` runs every
 * frame and a two-field object literal there is a per-frame allocation for no
 * reason.
 */
const _look = { x: 0, y: 0 };

/**
 * Seconds Enter must be held to throw a live run away. See `handleUiInput`.
 *
 * Long enough to be a decision and short enough not to feel like the key is
 * broken. A tap does nothing at all, which is the point.
 */
const RESTART_HOLD = 0.55;

/**
 * Seconds a menu screen ignores Enter after appearing.
 *
 * The results screen is the case that matters: it arrives while the player's
 * finger is still on the key that got them there.
 */
const MENU_ARM_DELAY = 0.7;

/**
 * Collection radius, metres.
 *
 * 1.5 — a little wider than the character's hull, because the pickup line is a
 * suggestion of a racing line rather than a corridor to be threaded, and a
 * fragment that needs to be hit within 40 cm at 74 m/s is a fragment nobody
 * gets. Tested against the step's whole segment, so this is the radius of a
 * CAPSULE around the path, not of a sphere around a sampled point.
 */
const PICKUP_REACH = 1.5;

/** Boost meter, 0..1, that one charge pickup fills. */
const CHARGE_PICKUP_BOOST = 0.34;

/** Seconds a pickup streak survives without another pickup. */
const PICKUP_STREAK_WINDOW = 1.1;

/** Spark tint per collectible, matched to each kind's own palette ramp. */
const PICKUP_TINT: Record<PickupKind, number> = {
  [PickupKind.Fragment]: 0xffc27a,
  [PickupKind.Shard]: 0x7fc0c4,
  [PickupKind.Cell]: 0xd0709a,
  [PickupKind.Charge]: 0xd0709a,
  [PickupKind.Time]: 0xd8d4dd,
};

export class Game {
  private engine: Engine;
  private input: Input;

  sky!: Sky;
  terrain!: Terrain;
  track!: Track;
  player!: Player;
  stage!: StageDirector;
  effects!: Effects;
  hud!: Hud;
  audio!: AudioEngine;
  post!: PostPipeline;
  traversal!: TraversalBundle;

  private captureControlled = false;
  /**
   * Frames left to suppress HUD popups for after a capture teleport.
   *
   * Jumping the player 700 m down the route crosses three checkpoints inside a
   * single physics step, so the stage layer legitimately fires three split
   * popups at once and the HUD stacks them for their full life. That is correct
   * behaviour reacting to an event that never happens in play — it is the review
   * harness contaminating the thing it exists to review.
   */
  private suppressPopupFrames = 0;

  /** Seconds Enter has been held during a live run. See `handleUiInput`. */
  private restartHeld = 0;
  /** Seconds the current menu screen has been up, for the Enter arm delay. */
  private menuAge = 0;
  /** The frame's real dt, so the UI timers do not run on the slow-mo clock. */
  private uiDt = 0;
  /** Physics steps until a scripted capture hit fires. 0 = none pending. */
  private pendingHurtSteps = 0;
  /**
   * Collected-pickup events, retained and reused. See `collectPickups`.
   */
  private readonly pickupEvents: PickupEvent[] = [];
  /** Consecutive collectibles, for the rising pickup chime. */
  private pickupStreak = 0;
  /** Seconds left before the streak lapses. */
  private pickupStreakLeft = 0;
  private scriptedInput: PlayerInput | null = null;
  private debugOverlay = false;
  private headless: boolean;

  /**
   * The one `PlayerInput` the physics ever sees, mutated in place.
   *
   * A fresh object per step is 120 allocations a second on the hot path, and
   * this codebase does not do that anywhere else in a physics path.
   */
  private readonly playerInput: PlayerInput = {
    moveX: 0, moveZ: 0, cameraYaw: 0,
    jump: false, jumpHeld: false, dash: false, crouch: false,
    attack: false, boost: false, dive: false,
  };

  // Press latches. Set during render, drained by the next step that runs.
  private queuedJump = false;
  private queuedDash = false;
  private queuedAttack = false;
  private queuedDive = false;

  readonly capture: CaptureApi;

  constructor(engine: Engine, options: GameOptions) {
    this.engine = engine;
    this.input = new Input(window);
    // The mouse needs an element to lock to, and `Input` is deliberately ignorant
    // of the renderer, so the canvas is handed over here. A click on it locks; the
    // browser's own Escape releases.
    this.input.attachPointerLock(this.engine.renderer.domElement);
    this.headless = options.params.get('capture') === '1';

    this.capture = {
      takeControl: () => {
        this.captureControlled = true;
        this.input.setScripted(true);
        this.engine.stop();
        this.engine.setFixedPixelRatio(this.engine.stats.pixelRatio || 2);
        this.stage?.forceRunning();
      },
      releaseControl: () => {
        this.captureControlled = false;
        this.scriptedInput = null;
        this.input.setScripted(false);
        this.engine.setFixedPixelRatio(null);
        this.engine.start();
      },
      step: (dt: number) => this.engine.stepManual(dt),
      // A zero-dt step. `Engine.advance` adds dt to the accumulator, runs no
      // fixed steps because nothing crossed the threshold, and then renders
      // unconditionally — so this is a pure redraw. See `CaptureApi.render`.
      render: () => this.engine.stepManual(0),
      setPose: (name: string) => this.applySituation(name),
      setSequence: (name: string) => {
        const s = SEQUENCES[name];
        if (!s) return false;
        if (!this.applySituation(s.from, s.preroll)) return false;
        if (s.input) this.setScripted(s.input);
        return true;
      },
      listPoses: () => Object.keys(SITUATIONS),
      listSequences: () => Object.keys(SEQUENCES),
      setDebugView: (view: string) => this.post?.setDebugView(view as PostDebugView),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Build
  // ───────────────────────────────────────────────────────────────────────────

  async load(progress: (p: number, label?: string) => void): Promise<void> {
    const scene = this.engine.scene;
    const camera = this.engine.camera as PerspectiveCamera;

    progress(0.04, 'Generating textures');
    initGeneratedTextures(NPR);
    await frame();

    progress(0.10, 'Building sky');
    this.sky = new Sky();
    this.sky.buildShafts();
    scene.add(this.sky.group);
    await frame();

    // The mountain is the long pole: noise, then hydraulic erosion, then thermal
    // settling, then zone classification. It reports its own sub-progress.
    progress(0.14, 'Raising the mountain');
    this.terrain = await createTerrain({
      onProgress: (p: number, label?: string) => progress(0.14 + p * 0.46, label ?? 'Eroding'),
    });
    scene.add(this.terrain.object);
    await frame();

    progress(0.62, 'Cutting the route');
    this.track = createTrack(this.terrain, { geometry: true, applyCarve: true });
    scene.add(this.track.object);
    await frame();

    progress(0.72, 'Compiling the NPR pipeline');
    this.post = new PostPipeline(this.engine.renderer, {
      width: this.engine.renderSize.x,
      height: this.engine.renderSize.y,
      lineScale: 1,
    });
    await frame();

    // Make the terrain's own zone ids authoritative for the line pass.
    //
    // LinesPass needs to know which material ids are PAINTED terrain zones,
    // because on those a material-id edge is a colour step and must never carry
    // a stroke — the terrain prepass writes its normal from the blurred normal
    // map and its depth from the rasteriser, so the two channels describe
    // different surfaces and an id edge there is paint, not geometry. It
    // otherwise rebuilds that list from the same `terrain:<name>` naming
    // convention TerrainMaterial uses, which is correct today and would drift
    // silently if either side were renamed. Handing it the real array closes
    // that.
    const zoneIds = this.terrain.materials?.shared?.uZoneIds?.value as number[] | undefined;
    if (zoneIds) this.post.lines.setPaintIds?.(zoneIds);

    progress(0.78, 'Effects');
    this.effects = createEffects({
      scene,
      camera,
      terrain: this.terrain,
      autoEmit: true,
    });
    await frame();

    progress(0.84, 'HUD and audio');
    this.hud = new Hud(this.engine.renderSize.x, this.engine.renderSize.y, {
      initialPhase: StagePhase.Title,
    });
    this.audio = new AudioEngine({ volume: this.headless ? 0 : 0.8 });
    await frame();

    progress(0.88, 'Rails, walls and springs');
    // Planned before the player exists, because the player has to be handed the
    // facade at construction — `PlayerPhysics` holds it for the life of the run
    // and there is no re-wiring path.
    this.traversal = createTraversal({ track: this.track, terrain: this.terrain });
    scene.add(this.traversal.object);
    await frame();

    progress(0.90, 'The character');
    this.startTransform(_v, _fwd);
    this.player = createPlayer({
      terrain: this.terrain,
      start: _v,
      facing: yawFromForward(_fwd),
      rig: { name: 'player' },
    });
    scene.add(this.player.object);

    // Wiring the physics reaches, and the rig never does.
    //
    // Enemies are still deliberately null: `src/combat/` is geometry and
    // constants with no `IEnemyDirector`, and `PlayerPhysics` handles the null
    // throughout, so homing attacks are unreachable. That is a missing
    // subsystem, not a broken one. Traversal is NOT null any more — grinding,
    // wall-running, springs, pads and dash rings all run.
    this.player.setAudio(this.audio);
    this.player.setEffects(this.effects);
    this.player.setTraversal(this.traversal.traversal);
    this.player.setEnemies(null);

    this.effects.setSubject(this.player.state);
    this.effects.cameraDirector.resetTo(this.player.state);
    await frame();

    progress(0.94, 'Stage');
    this.stage = createStageDirector({
      terrain: this.terrain,
      track: this.track,
      audio: this.audio,
    });
    this.stage.setPickupTotals(
      this.traversal.pickups.totals[PickupKind.Fragment],
      this.traversal.pickups.totals[PickupKind.Shard],
    );
    await frame();

    progress(0.97, 'Wiring loop');
    this.engine.onFixedUpdate((dt) => this.fixedUpdate(dt));
    this.engine.onRender((dt, alpha, elapsed) => this.render(dt, alpha, elapsed));
    this.engine.onResize((w, h) => this.resize(w, h));

    if (this.headless) this.stage.forceRunning();
    else this.stage.begin();

    progress(1.0, 'Ready');
  }

  /**
   * Where the character starts, and which way it faces.
   *
   * `startTransform` puts it on the centreline of the trail rather than on a
   * grid — there is nobody to line up beside — and the height is then taken from
   * the HEIGHTFIELD rather than from the ribbon.
   *
   * That is not a detail. `PlayerPhysics` collides with `terrain.heightAt`; the
   * ribbon mesh is only what you see, and it sits proud of the heightfield by
   * design. Spawning feet on the ribbon leaves the character standing in the air
   * with no contact, which means no ground dust and no run cycle on frame zero —
   * a defect an FX reviewer correctly saw on the old build and could not have
   * fixed, because it was not in the FX.
   */
  private startTransform(outPos: Vector3, outFwd: Vector3): void {
    this.track.startTransform(0, outPos, outFwd, 1);
    outPos.y = this.terrain.heightAt(outPos.x, outPos.z);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Loop
  // ───────────────────────────────────────────────────────────────────────────

  private fixedUpdate(dt: number): void {
    if (this.pendingHurtSteps > 0 && --this.pendingHurtSteps === 0) {
      // From straight ahead, so the knockback throws the character back down the
      // slope it came up and the hit reads in a chase or a side-on orbit.
      forwardFromYaw(this.player.state.facing, _hurtFrom);
      _hurtFrom.multiplyScalar(4).add(this.player.state.position);
      this.player.damage(1, _hurtFrom);
    }

    if (this.pickupStreakLeft > 0) {
      this.pickupStreakLeft -= dt;
      if (this.pickupStreakLeft <= 0) this.pickupStreak = 0;
    }

    // Window every traversal affordance on where the player is NOW, BEFORE the
    // step probes them. The step's own probes read the windows this sets, so
    // doing it afterwards would test the rails against last step's window.
    //
    // That lag is one step of travel — 0.17 m at `RUN.max` on a 120 Hz step —
    // which is nothing next to `WALL_TUNING.activeRange` at 300 m, so the
    // ordering is not about the window's EDGE. It is about `RailNetwork` and
    // `WallSet` holding a per-frame active LIST: probing before the update
    // probes a list built around wherever the player was last frame, and after
    // a teleport (a capture pose, a respawn, a restart) that list can be a
    // kilometre away and contain nothing the player can reach.
    const route = this.stage.routeDistance;
    this.traversal.traversal.update(route, dt);
    this.traversal.pickups.setRoute(route);

    // The whole step's segment, for the swept collection below. Copied before
    // the step because `state.position` is mutated in place.
    _pickFrom.copy(this.player.state.position);

    const input = this.scriptedInput ? this.applyScripted() : this.buildPlayerInput();
    this.player.step(input, dt);
    this.collectPickups(_pickFrom, this.player.state.position);
    this.stage.step(this.player.state, dt);
  }

  /**
   * Collect anything the step's segment passed through.
   *
   * Swept, for the same reason every other traversal probe is: at 74 m/s a step
   * covers 0.62 m and a fragment's radius is about a metre, so a point test drops
   * roughly a third of them and drops more of them the faster the player goes.
   *
   * `pickupEvents` is retained and reused — `PickupField.collect` overwrites
   * entries in place, so a step that collects nothing allocates nothing and a
   * step that collects three reuses the three slots from the last time it did.
   */
  private collectPickups(from: Vector3, to: Vector3): void {
    const n = this.traversal.pickups.collect(from, to, PICKUP_REACH, this.pickupEvents);
    if (n === 0) return;

    for (let i = 0; i < n; i++) {
      const event = this.pickupEvents[i];
      this.stage.notePickup(event.kind);

      // The two kinds the stage does not own. See `StageDirector.notePickup`.
      if (event.kind === PickupKind.Cell) this.player.heal(1);
      else if (event.kind === PickupKind.Charge) this.player.addBoost(CHARGE_PICKUP_BOOST);

      this.pickupStreak++;
      this.pickupStreakLeft = PICKUP_STREAK_WINDOW;
      this.audio.playPickup(event.kind, this.pickupStreak);
      this.effects.sparkBurst(event.position, _pickUp, 10, PICKUP_TINT[event.kind]);
    }
  }

  /**
   * This step's input, from the live intent.
   *
   * The four verbs are drained latches; the rest are levels read straight off
   * the buttons. See the header for why the verbs cannot be read directly.
   */
  private buildPlayerInput(): PlayerInput {
    const i = this.input.intent;
    const b = i.buttons;
    const p = this.playerInput;

    p.moveX = i.moveX;
    p.moveZ = i.moveZ;
    // The move vector is in camera space, so it is meaningless without the yaw
    // it is relative to. `CameraDirector.yaw` is `inputYaw` — a plain damped
    // follow of the character's facing, deliberately free of the corner-lead
    // arc, the lateral swing, the roll and the buffet.
    //
    // It used to be the finished lens direction (`lensYaw`), on the argument
    // that the stick should resolve against what the player can see. That
    // argument is right about the goal and wrong about the value: the lens
    // carries a term proportional to the character's own turn rate, so
    // resolving the stick against it closed a feedback loop with no fixed
    // point. Holding forward and a touch of right drove a perfect circle at 115
    // deg/s forever. See `CameraDirector.inputYaw`.
    p.cameraYaw = this.effects.cameraDirector.yaw;

    p.jump = this.queuedJump;
    p.dash = this.queuedDash;
    p.attack = this.queuedAttack;
    p.dive = this.queuedDive;
    this.queuedJump = false;
    this.queuedDash = false;
    this.queuedAttack = false;
    this.queuedDive = false;

    p.jumpHeld = b.jump.pressed;
    p.crouch = b.crouch.pressed;
    p.boost = b.boost.pressed;
    return p;
  }

  /**
   * A scripted step, for the capture harness.
   *
   * The levels are held for every step of the sequence; the verbs fire ONCE and
   * are then cleared out of the scripted template. A held `jump` re-arms the
   * double jump on every step and a held `dash` empties the air charges in a
   * frame — see the header — so a sequence that asks for a dash gets exactly one.
   */
  private applyScripted(): PlayerInput {
    const s = this.scriptedInput!;
    const p = this.playerInput;
    p.moveX = s.moveX;
    p.moveZ = s.moveZ;
    // A SCRIPTED STICK IS RESOLVED AGAINST THE CHARACTER, NOT THE CAMERA.
    //
    // The live path resolves the move vector against the camera's view yaw,
    // which is correct because that is what the player is looking down. A
    // capture cannot use it. `applySituation` runs its whole preroll inside
    // `setPose` with no render in between, so `cameraDirector.yaw` is still
    // whatever the PREVIOUS pose composed — an Orbit pose 180 degrees away, in
    // the general case. A sequence asking for `moveZ: 1` would then run the
    // character sideways off the trail, and every reading taken downstream of
    // that would be a measurement of the wrong run. RESUME.md documents five
    // separate defects that were artefacts of the harness rather than the game;
    // this is that shape of bug, caught before it produced one.
    //
    // Against `facing`, `moveZ: 1` means "forward along the route" and
    // `moveX: 1` means "to the character's right", for every pose, with no
    // dependence on where a camera happens to be pointing. It is also what
    // `PlayerPhysics.stepFinished` does for the victory run-out, so the
    // convention is already in the codebase.
    p.cameraYaw = this.player.state.facing;
    p.jumpHeld = s.jumpHeld;
    p.crouch = s.crouch;
    p.boost = s.boost;

    p.jump = s.jump;
    p.dash = s.dash;
    p.attack = s.attack;
    p.dive = s.dive;
    s.jump = false;
    s.dash = false;
    s.attack = false;
    s.dive = false;
    return p;
  }

  /** Latch this frame's press edges. See the header. */
  private queueEdges(): void {
    const b = this.input.intent.buttons;
    if (b.jump.justPressed) this.queuedJump = true;
    if (b.dash.justPressed) this.queuedDash = true;
    if (b.attack.justPressed) this.queuedAttack = true;
    if (b.dive.justPressed) this.queuedDive = true;
  }

  private render(realDt: number, alpha: number, elapsed: number): void {
    this.input.update(realDt);
    if (!this.captureControlled) this.queueEdges();
    this.handleUiInput(realDt);

    // Slow-mo and the impact-frame hold both live in the effects layer, and
    // everything downstream of here runs on the SCALED dt so a held frame holds
    // the animation, the dust and the camera together.
    const dt = this.effects.beginFrame(realDt);
    const camera = this.engine.camera as PerspectiveCamera;

    // 1. The rig solves IK on an interpolated transform. At 74 m/s a 120 Hz step
    //    covers 0.62 m, so a rig drawn on the raw physics state judders by up to
    //    two thirds of a metre whenever the display and step rates beat.
    this.player.updateVisual(alpha, dt, elapsed);

    // 2. Camera reads the resolved player transform.
    //
    // Look and steer are handed over FIRST, because both are inputs to the same
    // update: the look delta moves the orbit, and the steer angle decides whether
    // the input basis is allowed to keep following the character this frame. On
    // the real dt, not the scaled one — a slow-mo frame must not make the mouse
    // feel heavy, and `look()` takes a delta that is already in radians.
    // NOT behind `captureControlled`, and that matters. Both of these read
    // `input.intent`, which is exactly what a scripted caller writes — gating them
    // on hardware input is the same trap `Input.synthMoveFromButtons` documents:
    // the harness sets the stick, the game ignores it, and the failure is silent.
    // `_circle.mjs` measured a camera fix as having changed nothing at all for
    // this reason. Under capture `lookX` is always 0, so the drain is a no-op
    // there rather than a hazard.
    this.input.drainLook(_look);
    this.effects.cameraDirector.look(_look.x, _look.y);
    this.effects.cameraDirector.steer(this.input.intent.moveX, this.input.intent.moveZ);
    const state = this.player.state;
    this.effects.cameraDirector.update(state, dt, elapsed, realDt);

    // 3. FX follow the camera the director just placed.
    this.effects.update(dt, elapsed, camera, realDt);

    // 4. Readouts.
    const hudModel = this.stage.getHudModel();
    if (this.suppressPopupFrames > 0) {
      this.suppressPopupFrames--;
      hudModel.popups.length = 0;
    }
    this.hud.update(hudModel, dt, elapsed);
    this.audio.update(state, state.surface, dt);

    // 5. Globals, sky, streaming, then the whole pipeline.
    //
    // Collectibles bob and spin, so their instance matrices are rebuilt here at
    // display rate rather than in `fixedUpdate` — the physics loop already keeps
    // their route window current via `setRoute`, and composing ~75 matrices three
    // times per displayed frame would buy nothing a viewer could see.
    updateNprGlobals(elapsed, camera, this.engine.renderSize.x, this.engine.renderSize.y);
    this.sky.update(camera, this.sunVisibility());
    this.terrain.update(camera, dt);
    this.traversal.pickups.update(this.stage.routeDistance, dt, elapsed);

    this.post.render(this.engine.scene, camera, dt, elapsed);
    this.hud.render(this.engine.renderer);

    decayPostState(realDt);
    this.input.clearEdges();
  }

  /**
   * How much of the sun disc is unobstructed, 0..1. Deliberately crude: it only
   * drives the intensity of the shafts and the sky's sun tint, and a real
   * occlusion query for that would cost more than the effect is worth.
   */
  private sunVisibility(): number {
    const cam = this.engine.camera;
    const h = this.terrain.heightAt(cam.position.x, cam.position.z);
    return clamp01(0.25 + (cam.position.y - h) * 0.02 + h / 900);
  }

  private handleUiInput(realDt: number): void {
    if (this.captureControlled) return;
    this.uiDt = realDt;
    const b = this.input.intent.buttons;
    if (b.pause.justPressed) {
      if (this.stage.phase === StagePhase.Paused) this.stage.resume();
      else {
        this.stage.pause();
        // A pause menu the player cannot point at is not a menu. Releasing the
        // lock also stops mouse movement over the menu from swinging the camera
        // behind it.
        this.input.releasePointerLock();
      }
    }

    // RESTART, AND WHY IT IS NOT A BARE `justPressed` ANY MORE.
    //
    // Enter was bound straight through to `restart()`. Two separate problems with
    // that, and the player hits both:
    //
    //   Mid-run it means one keystroke throws the descent away, with no gesture
    //   that distinguishes intent from a mistyped key. On the mountain it now
    //   wants `RESTART_HOLD` seconds of contact.
    //
    //   On a results screen the player's hand is ALREADY on Enter — they pressed
    //   it to get there, or they are holding it from the run — so the restart
    //   fired on the first frame the screen existed and the screen was gone
    //   before it could be read. Menu screens now arm after `MENU_ARM_DELAY`, and
    //   because `heldFor` is the time the key has been down, a key that was
    //   already down when the screen appeared cannot satisfy the arm either.
    //
    // KeyR ('reset') is still instant, and should be: it only moves the character
    // back to the line and leaves the clock alone.
    const inMenu =
      this.stage.phase === StagePhase.Results ||
      this.stage.phase === StagePhase.Cleared ||
      this.stage.phase === StagePhase.Failed ||
      this.stage.phase === StagePhase.Paused ||
      this.stage.phase === StagePhase.Title;
    if (inMenu) {
      this.menuAge += this.uiDt;
      if (b.restart.justPressed && this.menuAge >= MENU_ARM_DELAY) this.restart();
    } else {
      this.menuAge = 0;
      this.restartHeld = b.restart.pressed ? this.restartHeld + this.uiDt : 0;
      if (this.restartHeld >= RESTART_HOLD) {
        this.restartHeld = 0;
        this.restart();
      }
    }
    if (b.reset.justPressed) this.respawn();
    if (b.toggleDebug.justPressed) {
      this.debugOverlay = !this.debugOverlay;
      this.post.setDebugView(this.debugOverlay ? 'lines' : 'off');
    }
  }

  /**
   * Whole run from the top.
   *
   * `stage.restart()` ALREADY calls `begin()`, so the third line used to run it a
   * second time and every restart went through two Countdown entries with a
   * `resetRun()` wipe between them. Ordered so the wipe happens once and last:
   * `respawn()` calls `stage.resetRun()` and `hud.resetRun()` itself, and it is
   * what sets `suppressPopupFrames`, so anything that pushes a popup has to run
   * before it rather than after.
   */
  private restart(): void {
    this.stage.restart();
    this.respawn();
  }

  /**
   * Put the character back on the start line without touching the clock.
   *
   * Everything stateful downstream of the transform has to be told, or the
   * character arrives wearing the dust it kicked up before it moved and the
   * camera spends half a second flying across the mountain to catch up. The
   * camera's own teleport guard would re-seat it anyway, but doing it here means
   * the first rendered frame after a respawn is already correct rather than
   * correct-on-the-second-frame.
   */
  private respawn(): void {
    this.startTransform(_v, _fwd);
    this.player.reset(_v, yawFromForward(_fwd));
    this.effects.reset();
    this.effects.cameraDirector.resetTo(this.player.state);
    // `stage.resetRun` puts the fragment and shard counters back to zero, so the
    // field has to give the collectibles back or the HUD reads 0/300 on a course
    // whose fragments are all already taken.
    this.traversal.pickups.reset();
    this.stage.resetRun();
    this.hud.resetRun();
    this.suppressPopupFrames = 4;
  }

  private resize(width: number, height: number): void {
    this.post?.resize(width, height);
    this.hud?.resize(width, height);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Capture
  // ───────────────────────────────────────────────────────────────────────────

  private applySituation(name: string, prerollOverride?: number): boolean {
    const s = SITUATIONS[name];
    if (!s || !this.stage) return false;

    this.stage.forceRunning();
    this.scriptedInput = null;

    const total = this.track.length;
    const d = Math.max(1, Math.min(total - 2, s.t * total));
    const sample = this.track.sampleAtDistance(d);

    _v.copy(sample.position);
    _fwd.copy(sample.tangent);

    // Spawn on the surface the character COLLIDES with, and guard the ravine.
    //
    // The physics rides the heightfield; the ribbon is only what you see, and
    // the two disagree by as much as 8 m in places (measured: scree +1.06 to
    // +2.15, tabletop -7.92 to +1.89, streambed -4.22 to +3.15). Taking the
    // heightfield means the character is never spawned inside the mountain. The
    // exception is the ravine, where the terrain is genuinely 13 m below the
    // ribbon because that IS the gap: past a metre and a half of disagreement,
    // trust the ribbon rather than spawn into the hole.
    const groundY = this.terrain.heightAt(_v.x, _v.z);
    if (Math.abs(groundY - _v.y) < 1.5 || groundY > _v.y) _v.y = groundY;
    _v.y += s.lift ?? 0;

    this.player.reset(_v, yawFromForward(_fwd));
    this.player.state.velocity.copy(_fwd).multiplyScalar(s.speed);
    if (s.launch) this.player.state.velocity.y += s.launch;

    const dir = this.effects.cameraDirector;
    dir.mode = s.camera;
    if (s.camera === CameraMode.Orbit && s.orbit) {
      dir.setOrbit(s.orbit.yaw, s.orbit.pitch, s.orbit.dist, s.orbit.spin ?? 0.35);
    }
    dir.resetTo(this.player.state);

    // Wipe every stateful effect before the situation is set up.
    //
    // The harness shoots all 16 poses in ONE page, 12 settle frames apart. Any
    // FX that latches therefore leaks from one review frame into the next, and
    // that is invisible to a single-pose capture — which is how a motion smear
    // pinned at 0.821 by the `crash` pose came to dissolve the rider in
    // `rider-closeup`, a pose that asks for 0.0. The reviewer sees a defect in
    // a frame whose own state is innocent. Any stateful system added here later
    // needs to be wiped in this call too.
    this.effects.reset();
    this.traversal.pickups.reset();

    // Make the CLOCK agree with the position we teleported to.
    //
    // A capture jumps the player straight to a fraction of the route without
    // running there, so the elapsed timer stayed near zero: the old review set
    // had frames reading DESCENT PROFILE 96% at 72 km/h beside TIME 0:00.19. A
    // reviewer judging composition and readability is entitled to a frame whose
    // own HUD is internally consistent, and a nonsense clock is a defect they
    // will and did report. Estimated from the distance covered at a nominal pace
    // rather than simulated, because simulating the whole route per pose would
    // cost minutes per capture run.
    this.stage.setElapsed(d / NOMINAL_PACE);

    // Set the scripted input BEFORE the preroll, or the preroll runs on a
    // neutral stick and the situation is reached by coasting rather than by
    // being driven into. That was inert on the bike, where the spawn velocity
    // did the work; it is not inert here, because a character with no stick
    // input decelerates.
    if (s.input) this.setScripted(s.input);

    const preroll = prerollOverride ?? s.preroll ?? 0;
    for (let i = 0; i < preroll; i++) this.fixedUpdate(1 / 120);

    // Swallow the checkpoint splits the teleport just crossed, and wipe any
    // popup already on screen from the previous pose.
    this.suppressPopupFrames = 4;
    this.stage.resetRun();
    this.hud.resetRun();

    // Deferred, so the hit lands INSIDE the captured window.
    //
    // It used to fire here, which is before the preroll and before the harness's
    // settle frames — so the flash, the freeze and the camera push-in had all
    // burned off screen before the shutter opened. The sequence whose entire
    // purpose is to show an impact never contained one. Counted in 120 Hz steps:
    // 8 for the harness settle plus ~20 to put the hit about ten captured frames
    // in.
    this.pendingHurtSteps = s.hurt ? 28 : 0;

    return true;
  }

  private setScripted(partial: Partial<PlayerInput>): void {
    this.scriptedInput = {
      moveX: 0, moveZ: 0, cameraYaw: 0,
      jump: false, jumpHeld: false, dash: false, crouch: false,
      attack: false, boost: false, dive: false,
      ...partial,
    };
  }

  dispose(): void {
    this.input.dispose();
    this.stage?.dispose();
    this.player?.dispose();
    this.effects?.dispose();
    this.hud?.dispose();
    this.audio?.dispose();
    this.track?.dispose();
    this.terrain?.dispose();
    this.traversal?.dispose();
    this.post?.dispose();
    this.sky?.dispose();
  }
}

/**
 * m/s averaged over the descent, for the capture clock estimate.
 *
 * Kept equal to `StageDirector`'s `PAR_PACE`. The two answer the same question —
 * "how long should being HERE have taken?" — and a capture whose clock disagrees
 * with the stage's own par is a frame whose HUD contradicts itself, which is a
 * defect a reviewer will report and be right about.
 */
const NOMINAL_PACE = 30;

/**
 * Yaw from a forward vector, matching `PlayerState.facing`'s convention.
 *
 * The physics uses `forward = (sin yaw, 0, cos yaw)`, so the inverse is
 * `atan2(x, z)` and NOT the `atan2(z, x)` a reader coming from a maths text
 * would write. Getting this backwards spawns the character facing across the
 * route instead of down it.
 */
function yawFromForward(fwd: Vector3): number {
  return Math.atan2(fwd.x, fwd.z);
}

/** The same convention, forwards. Writes into `out` and returns it. */
function forwardFromYaw(yaw: number, out: Vector3): Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

function frame(): Promise<void> {
  return new Promise((res) => requestAnimationFrame(() => res()));
}

/** Re-exported so main.ts does not need to know where the palette lives. */
export { CHARACTER_COLORS, POST_STATE };
