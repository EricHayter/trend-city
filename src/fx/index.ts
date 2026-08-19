/**
 * FX — the facade.
 *
 * createEffects() wires the five subsystems into one object that implements
 * IEffects, and then does the thing that actually matters for integration:
 * it DERIVES almost everything from PlayerState on its own.
 *
 * Hand it the player's PlayerState once per frame and it will emit dust under
 * the feet at the right rate for the surface and the gait, throw gravel out of
 * a slide, splash the stream, detect the landing from the mode transition (not
 * just the single-physics-step flag, which a 120Hz sim can raise and clear
 * between two rendered frames), fire the dust burst, decide whether the landing
 * earned an impact hold, drive the speed lines, and smear the character. The
 * Game never has to know what a puff is.
 *
 * ── PORTED FROM THE BIKE ────────────────────────────────────────────────────
 * The emission below used to run off two `WheelState` contacts, each with its
 * own load, slip ratio and lateral slip. A runner has one contact and none of
 * those channels, so what drives the rate now is the surface, the ground speed
 * and whether the body is sliding or grinding — see `emitFeet`. The
 * reconstructions the whole subsystem shares live in `PlayerSignals.ts`.
 *
 * Manual control is still there — every IEffects method does exactly what it
 * says — but the automatic path is the intended one, because the alternative
 * is a hundred lines of emission policy living in Game.ts where nobody will
 * ever tune it.
 *
 * TIME SCALE. Two systems can slow or stop the clock: the camera's big-air
 * hold and the impact freeze. The facade publishes the minimum of the two as
 * `timeScale`, and beginFrame() exists so the Game can read it BEFORE it scales
 * this frame's dt rather than a frame late — which matters enormously for a
 * one-frame freeze and not at all for a 300ms slow-mo.
 */

import {
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Camera,
} from 'three';

import {
  MoveMode,
  SurfaceKind,
  type PlayerState,
  type IEffects,
  type ITerrain,
  type SurfaceProperties,
} from '../game/Contracts';
import { contactPoint, hurtSeverity, isAttached, isGrounded } from './PlayerSignals';

/**
 * PlayerState plus two OPTIONAL monotonic event counters.
 *
 * `PlayerPhysics` does not currently publish these, so what actually runs is
 * the flag-and-mode-edge path below. The widening is kept because it is the
 * only correct mechanism if it ever does, and because the reasoning is worth
 * not having to rediscover:
 *
 * `landedThisStep` / `hurtThisStep` are true for exactly one 120 Hz physics
 * step. A rendered frame consumes two of those, so a flag raised and cleared
 * inside one frame is invisible here; and the mode-edge fallback cannot see a
 * hit that begins and resolves between two frames at all. A counter compared
 * against a remembered value is correct for any number of steps per frame,
 * survives two events in one frame, and needs nobody to clear it.
 *
 * The landing path is covered either way — `prevAirborne && !airborneNow` is an
 * edge that survives any frame rate. A hit inside one frame is not, and that is
 * the case these would fix.
 */
type EventCounters = { landCount?: number; hurtCount?: number };
import { clamp01 } from '../core/MathX';
import { Rng } from '../core/RNG';
import { SURFACES } from '../game/WorldConstants';
import { HUD_PALETTE } from '../npr/Palette';

import { CameraDirector, CAMERA_TUNING, type CameraDirectorOptions } from './CameraDirector';
import { DustSystem } from './DustSystem';
import { DebrisSystem } from './Debris';
import { SpeedFX, SpinSmear } from './SpeedFX';
import { ImpactFrames, IMPACT_TUNING } from './ImpactFrames';

export { CameraDirector, CAMERA_TUNING } from './CameraDirector';
export { DustSystem, dustTintFor, puffAtlas, QuadParticlePool } from './DustSystem';
export { DebrisSystem, chipAtlas } from './Debris';
export { SpeedFX, SpinSmear, SPEED_TUNING } from './SpeedFX';
export { ImpactFrames, IMPACT_TUNING } from './ImpactFrames';
export type { CameraDirectorOptions } from './CameraDirector';

const _fallbackPos = new Vector3();
const _fallbackNrm = new Vector3(0, 1, 0);
/** Scratch for the one-off smear-rig scene scan. */
const _scanPos = new Vector3();

/**
 * Used when the physics has not filled in a contact yet (first frame, or a
 * crash in mid-air). Dirt is the least surprising default and the numbers come
 * straight from WorldConstants.
 */
const DEFAULT_SURFACE: SurfaceProperties = {
  kind: SurfaceKind.Dirt,
  ...SURFACES.dirt,
  audioTone: 'hardpack',
};

/** Boost ignition flash colour, resolved once. */
const BOOST_FLASH_HEX = HUD_PALETTE.boost.getHex();
/**
 * Default spark colour: the hot end of the gold. Sparks are the one effect in
 * the game allowed to be brighter than the paper — they are the only thing on
 * screen that is genuinely incandescent — so this is `goldHot` rather than
 * `gold`, and it is the colour that carries the grind read at distance.
 */
const SPARK_TINT = HUD_PALETTE.goldHot.clone();
/** Scratch for a caller-supplied spark tint, so an override costs no allocation. */
const _sparkTint = HUD_PALETTE.goldHot.clone();

export interface EffectsDeps {
  /** The FX object is added to this scene by createEffects. */
  scene: Scene;
  /** The camera the CameraDirector will drive — pass the Engine's. */
  camera: PerspectiveCamera;
  terrain?: ITerrain | null;
  seed?: number | string;
  dustCapacity?: number;
  debrisCapacity?: number;
  /** Character local forward axis, only used as a heading fallback. Default +Z. */
  forwardAxis?: Vector3;
  /**
   * Derive dust, debris and impact frames from the subject PlayerState.
   * Off means every emission is a manual call.
   */
  autoEmit?: boolean;
  /** Extra options forwarded to the CameraDirector. */
  cameraOptions?: Partial<Omit<CameraDirectorOptions, 'camera' | 'terrain'>>;
}

export class Effects implements IEffects {
  readonly object: Object3D;
  readonly dust: DustSystem;
  readonly debris: DebrisSystem;
  readonly speed: SpeedFX;
  readonly impact: ImpactFrames;
  readonly cameraDirector: CameraDirector;

  private rng: Rng;
  private subject: PlayerState | null = null;
  private autoEmit: boolean;
  private terrain: ITerrain | null;

  // Independent edge detection. The CameraDirector runs its own copy for its
  // own shake; keeping them separate means neither depends on the other's
  // update order, and each fires its own effects exactly once.
  private prevAirborne = false;
  private prevCrashing = false;
  private prevBoosting = false;
  private landCooldown = 0;
  private crashCooldown = 0;
  /** Last seen values of the optional event counters. -1 = not primed. */
  private seenLandCount = -1;
  private seenHurtCount = -1;

  // ── Crash ground strikes ──────────────────────────────────────────────────
  // A crash is not an instant, it is a process: the bike goes down, tumbles,
  // and hits the ground two or three more times on the way to a stop. The old
  // code punctuated only the ENTRY, so in the review capture — where the entry
  // happens during the harness's settle frames — the whole visible crash had
  // no dust and no accent anywhere in it. These track the slide so each strike
  // gets its own.
  private prevSpeed = 0;
  private prevContact = false;
  private crashStrikeCooldown = 0;

  private impactSteppedThisFrame = false;

  // ── Self-wiring smear ──────────────────────────────────────────────────────
  // The scene is kept solely so the facade can find the subject's own meshes.
  // See resolveSmearRig().
  private scene: Scene;
  private smearWired = false;
  private smearAttempts = 0;
  private smearTargets: Object3D[] = [];

  constructor(deps: EffectsDeps) {
    this.rng = new Rng(deps.seed ?? 'fx');
    this.autoEmit = deps.autoEmit ?? true;
    this.terrain = deps.terrain ?? null;
    this.scene = deps.scene;

    this.object = new Object3D();
    this.object.name = 'fx';
    this.object.matrixAutoUpdate = false;

    // 2600, not 1100. A scree plume plus a landing spray plus a skid can be
    // ~900 live puffs once the marks are small enough to have to overlap, and
    // the ring recycles its OLDEST live instance when it wraps — so a capacity
    // that merely "usually" fits shows up as puffs vanishing mid-life at exactly
    // the busiest moment, and the oldest puff is the far end of the trail, so
    // what wrapping deletes is precisely the tail the effect exists to draw.
    // Headroom here is a 180 kB float buffer and one draw call either way.
    this.dust = new DustSystem({
      capacity: deps.dustCapacity ?? 2600,
      rng: this.rng.fork('dust'),
    });
    this.debris = new DebrisSystem({
      capacity: deps.debrisCapacity ?? 640,
      rng: this.rng.fork('debris'),
      terrain: this.terrain,
    });
    this.speed = new SpeedFX();
    this.impact = new ImpactFrames();

    this.cameraDirector = new CameraDirector({
      camera: deps.camera,
      terrain: this.terrain,
      forwardAxis: deps.forwardAxis,
      rng: this.rng.fork('camera'),
      ...(deps.cameraOptions ?? {}),
    });

    this.object.add(this.dust.object);
    this.object.add(this.debris.object);
    this.object.add(this.speed.object);
    deps.scene.add(this.object);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /** The PlayerState everything automatic is derived from. Null outside a race. */
  setSubject(state: PlayerState | null): void {
    this.subject = state;
    // A new subject invalidates whatever rig we resolved for the old one.
    this.smearWired = false;
    this.smearAttempts = 0;
    this.primeCounters(state);
    if (state) {
      this.prevAirborne = state.mode === MoveMode.Airborne;
      this.prevCrashing = state.mode === MoveMode.Hurt;
      this.prevSpeed = state.speed;
    }
  }

  /**
   * Take the event counters' CURRENT values as the baseline.
   *
   * The timing here is the whole point and it is easy to get backwards. If the
   * baseline is adopted lazily, on the first update() that sees the subject,
   * then any event that happens between the reset and that first frame is
   * swallowed — and that is exactly the order Game.applySituation runs in: it
   * calls effects.reset(), then prerolls the physics, then forces the crash,
   * and only then does a frame render. Adopting late means the one pose in the
   * review set named `crash` is the one pose whose crash is never announced.
   * Adopting HERE, at the reset, makes the baseline mean "everything before
   * this moment is history" and everything after it an event.
   */
  private primeCounters(state: PlayerState | null): void {
    const ev = state as (PlayerState & EventCounters) | null;
    this.seenLandCount = typeof ev?.landCount === 'number' ? ev.landCount : -1;
    this.seenHurtCount = typeof ev?.hurtCount === 'number' ? ev.hurtCount : -1;
  }

  /**
   * Find the subject's own meshes and wire the smear systems to them.
   *
   * This exists because there is a genuine hole in the contracts: PlayerState is
   * pure data — position, velocity, normals — and carries no Object3D at all,
   * while `setSmearTargets` needs scene nodes. Nothing in the codebase bridged
   * that gap, so SpeedFX's geometry-smear system was fully implemented, fully
   * tested by its own shaders, and called by absolutely nobody.
   *
   * Rather than require the Game to reach into another subsystem and hand us its
   * internals, we resolve it here from the scene the facade was already given.
   * `Player` names its root `player` and `CharacterRig` names its own group
   * `character`; the rig is preferred because the limbs are what streak, and the
   * root is the fallback so a Game that builds the physics without the rig still
   * smears something.
   *
   * The nearest candidate to the subject's own position wins, which needs no id
   * convention at all and stays correct if a ghost or a replay double is ever
   * added to the scene.
   *
   * Retried for a few frames and then given up on: the rig is built during load
   * and a missed frame is invisible, but an unbounded retry would walk the whole
   * scene graph every frame forever if a name ever changed.
   */
  private resolveSmearRig(state: PlayerState): void {
    this.smearWired = true;
    this.smearAttempts++;

    let best: Object3D | null = null;
    let bestD = Infinity;
    this.scene.traverse((o) => {
      if (o.name !== 'character' && o.name !== 'player') return;
      o.getWorldPosition(_scanPos);
      const d = _scanPos.distanceToSquared(state.position);
      // A tie goes to the rig: `character` is a child of `player`, so both sit
      // at the same world point and only one of them holds the limbs.
      if (d < bestD || (d <= bestD && o.name === 'character')) {
        bestD = d;
        best = o;
      }
    });

    const root = best as Object3D | null;
    // Nothing found yet (still loading) — allow a handful of retries.
    if (!root || bestD > 400) {
      if (this.smearAttempts < 240) this.smearWired = false;
      return;
    }

    // Drop any clones built for a previous subject before adopting the new
    // list — SpeedFX caps simultaneous targets, so stale entries would
    // eventually starve the real ones.
    const targets: Object3D[] = [root];
    for (const old of this.smearTargets) {
      if (!targets.includes(old)) this.speed.release(old);
    }
    this.smearTargets = targets;
    this.setSmearTargets(targets);
  }

  setTerrain(t: ITerrain | null): void {
    this.terrain = t;
    this.debris.setTerrain(t);
    this.cameraDirector.setTerrain(t);
  }

  /** Objects that automatically smear at speed / during trick rotation. */
  setSmearTargets(objects: Object3D[]): void {
    this.speed.setAutoSmearTargets(objects);
  }

  /**
   * Register a rotating part for radial spin smear. See SpeedFX.addSpinSmear.
   *
   * The bike wired its two wheels to this automatically. The character has no
   * continuously spinning part, so nothing calls it now — it is kept because the
   * system behind it is complete and a boss's rotor or a set-piece turbine is
   * exactly what it is for.
   */
  addSpinSmear(anchor: Object3D, radius: number, axis: Vector3): SpinSmear {
    return this.speed.addSpinSmear(anchor, radius, axis);
  }

  // ── Time ──────────────────────────────────────────────────────────────────

  /** Minimum of the camera's slow-mo and the impact freeze. */
  get timeScale(): number {
    return Math.min(this.cameraDirector.timeScale, this.impact.timeScale);
  }

  /**
   * Advance the impact-frame state machine and return the SCALED dt for THIS
   * frame — `realDt * timeScale`, in SECONDS. Call first, with the real
   * (unscaled) frame delta; feed the result to everything visual.
   *
   * IT RETURNS A DELTA, NOT A SCALE, and that distinction was the single most
   * destructive bug in the project. It used to return `timeScale` — a bare
   * multiplier, 1.0 in the overwhelmingly common case — while its only caller
   * (Game.render) took the result and used it as the frame delta for the rider
   * rigs, the camera, the terrain streamer, the HUD, the audio and every
   * particle system. So the entire visual half of the game advanced by ONE
   * SECOND per rendered frame.
   *
   * Dust was where it showed first and worst. A puff is emitted stamped with
   * the current FX clock; the same frame, DustSystem.update advanced that clock
   * by a full second; the vertex shader computed age = 1.0 / life >= 1 and
   * collapsed every instance to a degenerate clip position. Particles were
   * emitted, pooled and killed without ever surviving to a single draw — which
   * is exactly the measured signature: trail() called, pool filled, nothing on
   * screen, ever.
   *
   * Optional — if you never call it, update() advances the impact machine
   * itself and the freeze simply lands one frame later.
   */
  beginFrame(realDt: number): number {
    this.impact.update(realDt);
    this.impactSteppedThisFrame = true;
    return realDt * this.timeScale;
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  /**
   * `dt` is the SCALED delta. `realDt` defaults to it; pass the unscaled delta
   * (or use beginFrame) so a freeze can end.
   */
  update(dt: number, _time: number, camera: Camera, realDt?: number): void {
    const rd = realDt ?? dt;
    if (!this.impactSteppedThisFrame) this.impact.update(rd);
    this.impactSteppedThisFrame = false;

    const cam = (camera as PerspectiveCamera).isPerspectiveCamera
      ? (camera as PerspectiveCamera)
      : this.cameraDirector.camera;

    // BEFORE ANY EMISSION. Dust culls emissions against the camera position it
    // was last told about, and on the frame the subject teleports that
    // position is still hundreds of metres away — so every burst fired on a
    // respawn or a capture cut was silently thrown away. See
    // DustSystem.syncCamera.
    this.dust.syncCamera(cam);

    const s = this.subject;

    // Tell the dust what the shot is framed on, EVERY FRAME.
    //
    // DustSystem has a lens-corridor rule built for exactly one job: fade a
    // puff that comes between the camera and the rider and covers him. It keys
    // off `uSubject`, whose w component is the legible radius, and whose own
    // documentation says "radius 0 disables the rule entirely".
    //
    // `setShotSubject` WAS NEVER CALLED. Not from here, not from the camera,
    // not from the game — the whole corridor was dead code and the radius sat
    // at 0 for every frame this project has ever rendered. The result is the
    // defect a player reported three times and I misdiagnosed three times: at
    // speed the wheel plume is trail-coloured, opaque, and directly between the
    // lens and the bike, so it reads as GROUND. The bike looks half-buried in
    // the track. It is not: with the dust material silenced the wheels, cranks
    // and legs are all there, the physics contact patch never penetrated the
    // ground (max 0.000 m over a full run), and the drawn axle sits at 0.271 m
    // against a 0.267 m wheel radius.
    //
    // Two full sessions went into terrain, ribbon, carve and camera geometry
    // looking for a surface that was never there. The elimination that found it
    // was silencing one material at a time.
    //
    // The radius covers rider and bike as one object: the pivot is the chest,
    // roughly 0.95 m over the bike origin, and the bike extends about the same
    // again below and ahead of it.
    if (s) this.dust.setShotSubject(s.position.x, s.position.y + 0.55, s.position.z, 1.45);
    else this.dust.clearShotSubject();

    if (s && this.autoEmit) {
      if (!this.smearWired) this.resolveSmearRig(s);
      this.detectEvents(s, rd);
      if (dt > 0) this.emitFromState(s, dt);
    }

    this.dust.update(dt, cam);
    this.debris.update(dt, cam);
    this.speed.update(dt, cam, s);
  }

  // ── Automatic emission ────────────────────────────────────────────────────

  private detectEvents(s: PlayerState, dt: number): void {
    if (this.landCooldown > 0) this.landCooldown -= dt;
    if (this.crashCooldown > 0) this.crashCooldown -= dt;
    if (this.crashStrikeCooldown > 0) this.crashStrikeCooldown -= dt;

    const airborneNow = s.mode === MoveMode.Airborne;
    const hurtNow = s.mode === MoveMode.Hurt;

    // ── Counters first, flags as the fallback ─────────────────────────────────
    const ev = s as PlayerState & EventCounters;
    let landed: boolean;
    let hurt: boolean;
    if (typeof ev.landCount === 'number' && typeof ev.hurtCount === 'number') {
      if (this.seenLandCount < 0) {
        // Never primed (no reset, no setSubject). Adopt rather than replay: the
        // counters are monotonic across a whole run and a fresh consumer must
        // not fire an effect for every landing that already happened.
        this.seenLandCount = ev.landCount;
        this.seenHurtCount = ev.hurtCount;
      }
      landed = ev.landCount > this.seenLandCount;
      hurt = ev.hurtCount > this.seenHurtCount;
      this.seenLandCount = ev.landCount;
      this.seenHurtCount = ev.hurtCount;
    } else {
      landed = s.landedThisStep || (this.prevAirborne && !airborneNow && !hurtNow);
      hurt = s.hurtThisStep || (!this.prevCrashing && hurtNow);
    }

    if (landed && !hurtNow && this.landCooldown <= 0) {
      this.landCooldown = 0.08;
      this.notifyLanding(s);
    }

    if (hurt && this.crashCooldown <= 0) {
      this.crashCooldown = 0.40;
      this.notifyHurt(s);
    }

    // ── The rest of the hit ───────────────────────────────────────────────────
    // Everything above fires once, on the frame the body goes down. What the
    // audience actually watches is the second that follows, and until the bike
    // version of this was written none of it was drawn: a capture of a crash
    // measured zero live puffs across the entire window in which the speed fell
    // from 19 to 9 km/h. A body tumbling across a rock garden throws material
    // continuously and bangs down two or three times on the way to a stop, and
    // a stunned character knocked 28 m/s backwards does exactly the same.
    if (hurtNow) this.hurtStrikes(s, dt);
    this.prevSpeed = s.speed;

    // Boost ignition gets a flash but never a freeze — it happens far too
    // often to spend a hold on, and a hold would fight the acceleration.
    if (s.boosting && !this.prevBoosting) this.impact.flashOnly(0.32, BOOST_FLASH_HEX);
    this.prevBoosting = s.boosting;

    this.prevAirborne = airborneNow;
    this.prevCrashing = hurtNow;
  }

  /**
   * Dust and punctuation for the body of a hit.
   *
   * Two signals, both derived from state that already exists:
   *
   *  • A STRIKE is the body arriving back on the ground — either a contact
   *    rising edge, or a single-frame loss of speed too large to be friction.
   *    That is the frame the eye reads as the hit, and it is the window the old
   *    entry-only code left empty.
   *
   *  • A SLIDE throws a continuous trail while the body is anywhere near the
   *    ground, whether or not the physics calls it grounded — during a tumble it
   *    usually does not, and "no contact is technically registered" is not a
   *    reason for a body scraping along at 20 km/h to be dustless.
   */
  private hurtStrikes(s: PlayerState, dt: number): void {
    const surf = s.surface ?? DEFAULT_SURFACE;
    const nrm = s.groundNormal.lengthSq() > 1e-6 ? s.groundNormal : _fallbackNrm;
    const pos = contactPoint(s, this.terrain, _fallbackPos);

    const contact = isAttached(s);
    const drop = this.prevSpeed - s.speed;
    // 6 m/s² of friction over a 60 Hz frame is 0.1 m/s. Anything four times
    // that in one frame is the ground arriving, not the ground rubbing.
    const hardHit = drop > 0.42 && s.speed > 0.8;
    const struck = (contact && !this.prevContact) || hardHit;
    this.prevContact = contact;

    if (struck && this.crashStrikeCooldown <= 0) {
      this.crashStrikeCooldown = 0.12;
      const force = clamp01(0.30 + drop * 0.9 + s.speed * 0.035);
      // IMPACT DUST IGNORES A STINGY SURFACE. A hit staged in the rock garden,
      // dustAmount 0.18, turns a 16-puff impact into three. 0.85 rather than
      // 0.62: the hit is the one moment in the whole sequence the audience is
      // looking at, and at this mark size 0.62 buys sixteen puffs where the
      // read needs about twenty-five.
      this.dust.burst(pos, nrm, s.velocity, 0.55 + force * 0.45, surf, 0.85);
      this.debris.screeSpray(pos, nrm, s.velocity, force * 0.7, surf);
      // Flash only — the freeze belongs to the hit's own entry, and stopping the
      // world three times inside one tumble is a stutter, not punctuation. Two
      // frames for a real bang, one for a scuff.
      if (force > 0.34) this.impact.flashOnly(0.30 + force * 0.55, undefined, force > 0.55 ? 2 : 1);
    }

    // The slide. Gated on height above the ground rather than on contact.
    if (s.airHeight < 1.4 && s.speed > 1.2) {
      this.dust.trail(pos, nrm, s.velocity, 40 + s.speed * 9, dt, surf, 0.70);
    }
  }

  /**
   * The steady-state emission: what the feet are doing to the ground.
   *
   * WHAT REPLACED THE WHEELS. The bike ran this off two contacts with a load, a
   * slip ratio and a lateral slip each, and the rate was a sum of a rolling term
   * and a skid term. The character has one contact and none of those channels,
   * so the two terms are rebuilt from what a runner actually has:
   *
   *  • ROLLING becomes the footfall term — material thrown by feet pushing off,
   *    scaled by ground speed.
   *  • SKID becomes the slide term — `Sliding` is the mode that drags a whole
   *    body across the surface, and it is the only one that earns the old
   *    locked-wheel rates.
   *
   * `Grinding` and `WallRun` emit nothing here on purpose: the character is on a
   * rail or a wall, and the mountain under it is not being touched. The rail's
   * own sparks are the physics layer's call, through `sparkBurst`.
   */
  private emitFromState(s: PlayerState, dt: number): void {
    const grounded = isGrounded(s);
    const sliding = s.mode === MoveMode.Sliding;
    const surf = s.surface ?? DEFAULT_SURFACE;
    const nrm = s.groundNormal.lengthSq() > 1e-6 ? s.groundNormal : _fallbackNrm;

    if (grounded) {
      const pos = contactPoint(s, this.terrain, _fallbackPos);
      this.emitFeet(pos, nrm, surf, s, sliding, dt);
      return;
    }

    // ── THE SKIM ──────────────────────────────────────────────────────────────
    //
    // `grounded` is a solver predicate, not a photograph. Down anything rough
    // the character spends a large fraction of its frames a few centimetres
    // clear, and feet 60 mm off scree at 20 m/s are still dragging a wake
    // through loose material. Gating the whole effect on a boolean that chatters
    // at 120 Hz is what makes the tail read as intermittent.
    //
    // It is also why the first still of a fast capture is a character at 70 km/h
    // with ZERO dust anywhere in frame: the harness teleports the player, the
    // ground probe has not settled, no contact is reported on the shutter frame.
    //
    // So: below a stride of clearance, at a speed worth drawing, emit a reduced
    // trail from the ground under the character. Nothing new is remembered — the
    // height and the terrain are both already in hand — so there is no state
    // here for `Game.applySituation`'s `effects.reset()` to have to wipe.
    if (
      s.airHeight < 0.30 &&
      s.speed > 5 &&
      s.mode !== MoveMode.Hurt &&
      s.mode !== MoveMode.Grinding &&
      s.mode !== MoveMode.WallRun
    ) {
      const pos = contactPoint(s, this.terrain, _fallbackPos);
      const near = clamp01(1 - s.airHeight / 0.30);
      this.dust.trail(pos, nrm, s.velocity, clamp01((s.speed - 4) / 14) * 95 * near, dt, surf);
    }
  }

  private emitFeet(
    pos: Vector3,
    nrm: Vector3,
    surf: SurfaceProperties,
    s: PlayerState,
    sliding: boolean,
    dt: number,
  ): void {
    // ── PUFFS PER METRE, NOT PER SECOND ───────────────────────────────────────
    //
    // Emission authored as a constant number of marks per SECOND, by a contact
    // that covers ever more ground per second, spaces consecutive puffs in
    // direct proportion to speed — so the trail gets THINNER the faster you go.
    // Measured on the bike at 83 km/h: 172 live puffs strung over 34 m, five per
    // metre of marks 0.3 m across, a dotted line. The same emitter at 17 km/h
    // piled the same marks 0.05 m apart and read as a wall. One number cannot be
    // right for both because the wrong quantity is being held constant.
    //
    // Linear density is what the eye reads, so that is what is authored: puffs
    // per metre of travel, converted to a rate by multiplying by speed.
    //
    // AND THE NUMBER IS SET BY WHAT THE CHASE CAMERA CAN SEE, NOT BY THE LENGTH
    // OF THE TRAIL. The boom sits a few metres behind looking forward, so of a
    // plume streaming 33 m the frame contains only the first few metres of it —
    // everything older is behind the lens. A density authored against the whole
    // trail is authored against a length nobody is looking down. 18 puts ~11
    // marks on every metre of the visible strip, which at 0.09 m spacing and
    // 0.33-0.51 m marks is continuous rather than dotted.
    //
    // The fade-in below 2.5 m/s keeps a character at walking pace clean. Note
    // this is GROUND speed: the vertical channel is the ground-stick velocity
    // while grounded and has nothing to do with what the feet scuff up.
    const perMetre = 18.0 * clamp01((s.groundSpeed - 2.5) / 6.5);
    const roll = perMetre * s.groundSpeed;

    // The slide term. A body dragged along the ground throws material at a rate
    // set by how hard it is being dragged rather than by how far it has
    // travelled, so unlike the footfall term this is authored per second.
    const skid = sliding ? clamp01(s.groundSpeed / 22) : 0;

    const isWater = surf.kind === SurfaceKind.Water;
    // Water carries its read in droplets, not in airborne particulate, so the
    // dust channel is cut right back there and the splash below does the work.
    // Left at full rate, water's 1.8 dustAmount made it the single dustiest
    // surface on the mountain, which is the opposite of true.
    const rate = Math.min(roll + skid * 240, 460) * (isWater ? 0.09 : 1);
    if (rate > 0.5) this.dust.trail(pos, nrm, s.velocity, rate, dt, surf);

    if (isWater) {
      if (s.groundSpeed > 2.5 && this.rng.next() < clamp01(dt * (4 + s.groundSpeed * 0.7))) {
        this.debris.splash(pos, nrm, s.velocity, clamp01(0.25 + s.groundSpeed / 22));
      }
    } else if (skid > 0.30 && surf.dustAmount > 0.45) {
      // Gravel is gated stochastically rather than accumulated, so it stays
      // correct in expectation without needing per-frame carry state.
      if (this.rng.next() < clamp01(skid * dt * 7)) {
        this.debris.screeSpray(pos, nrm, s.velocity, clamp01(skid * 0.55), surf);
      }
    }
  }

  /** Public so a caller with exact physics-step timing can drive it instead. */
  notifyLanding(s: PlayerState): void {
    const impact = clamp01(s.landingImpact);
    const surf = s.surface ?? DEFAULT_SURFACE;
    const pos = contactPoint(s, this.terrain, _fallbackPos);
    const nrm = s.groundNormal.lengthSq() > 1e-6 ? s.groundNormal : _fallbackNrm;

    // Landings always throw dust, even a soft one — the dust is the read that
    // the feet touched. Only the SIZE tracks the impact. The 0.45 floor means a
    // landing on rock still throws something: the surface decides how MUCH
    // material is loose, not whether an 80 kg impact disturbs any.
    this.dust.burst(pos, nrm, s.velocity, Math.max(impact, 0.58), surf, 0.45);
    if (impact > 0.12) this.debris.screeSpray(pos, nrm, s.velocity, impact * 0.85, surf);
    if (surf.kind === SurfaceKind.Water) {
      this.debris.splash(pos, nrm, s.velocity, 0.45 + impact * 0.55);
    }
    this.impact.trigger(impact);
  }

  /**
   * The character taking damage. Was `notifyCrash`.
   *
   * Severity is reconstructed rather than read: the player physics publishes a
   * mode and a health count where the bike published a `crashSeverity`. See
   * `hurtSeverity`.
   */
  notifyHurt(s: PlayerState): void {
    const sev = hurtSeverity(s);
    const surf = s.surface ?? DEFAULT_SURFACE;
    const pos = contactPoint(s, this.terrain, _fallbackPos);
    const nrm = s.groundNormal.lengthSq() > 1e-6 ? s.groundNormal : _fallbackNrm;

    this.dust.burst(pos, nrm, s.velocity, 0.85 + sev * 0.15, surf, 0.70);
    // `hurtDirection` is the axis the knockback travels, so it is already the
    // direction the debris should be thrown.
    this.debris.crashDebris(pos, s.velocity, s.hurtDirection, sev, surf);
    this.impact.trigger(0.45 + sev * 0.55, undefined, true);
    // Arm the strike tracker so the first frame of the tumble does not read as
    // a fresh contact and fire a second burst on top of this one.
    this.prevContact = isAttached(s);
    this.prevSpeed = s.speed;
    this.crashStrikeCooldown = 0.16;
  }

  // ── IEffects ──────────────────────────────────────────────────────────────

  dustBurst(
    position: Vector3,
    normal: Vector3,
    velocity: Vector3,
    amount: number,
    surface: SurfaceProperties,
  ): void {
    this.dust.burst(position, normal, velocity, amount, surface ?? DEFAULT_SURFACE);
  }

  /**
   * Continuous dust. `rate` is puffs per second before the surface multiplier.
   *
   * The contract has no dt, so this uses a fixed nominal step of one 60Hz
   * frame. If you are calling it from the 120Hz physics step, halve the rate
   * or use `dust.trail(..., dt, ...)` directly — that overload takes a real dt.
   */
  dustTrail(
    position: Vector3,
    normal: Vector3,
    velocity: Vector3,
    rate: number,
    surface: SurfaceProperties,
  ): void {
    this.dust.trail(position, normal, velocity, rate, 1 / 60, surface ?? DEFAULT_SURFACE);
  }

  /**
   * IEffects. Sparks off a rail, a wall or a parried hit.
   *
   * The physics layer calls this directly — see `PlayerPhysics`, which fires one
   * on a homing connect — so it must be safe at 120 Hz. It is: `DebrisSystem`
   * caps the count, culls by distance, and recycles from a fixed ring.
   */
  sparkBurst(position: Vector3, direction: Vector3, amount: number, tint?: number): void {
    let c = SPARK_TINT;
    if (tint !== undefined) {
      _sparkTint.setHex(tint);
      c = _sparkTint;
    }
    this.debris.sparks(position, direction, amount, c);
  }

  impactFrame(intensity: number, tint?: number): void {
    this.impact.trigger(intensity, tint);
  }

  /**
   * IEffects. Brief time dilation.
   *
   * Delegated to the camera director, which owns the slow-motion envelope
   * because it is the thing that also has to decide when the automatic big-air
   * hold fires — two independent owners of the clock would fight. The facade's
   * `timeScale` is the minimum of that and the impact freeze, so this shows up
   * in `beginFrame`'s scaled dt on the very next frame.
   */
  slowMotion(scale: number, duration: number): void {
    this.cameraDirector.slowMotion(scale, duration);
  }

  smear(target: Object3D, amount: number): void {
    this.speed.smear(target, amount);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Clear every live particle and post dial. Use on race restart, and on every
   * capture pose — `Game.applySituation` calls this before each of the sixteen.
   *
   * DUST IS NOW IN HERE. It was not, and the only thing covering it was
   * CameraDirector.resetTo() calling clearAllDust() on the side. That works
   * today and it is the wrong place for it to live: a caller that resets the
   * effects without resetting the camera got a rider wearing the dust he kicked
   * up before he was teleported.
   */
  reset(): void {
    this.dust.clear();
    this.debris.clear();
    this.speed.reset();
    this.impact.reset();
    this.landCooldown = 0;
    this.crashCooldown = 0;
    this.crashStrikeCooldown = 0;
    this.prevAirborne = false;
    this.prevCrashing = false;
    this.prevBoosting = false;
    this.prevContact = false;
    this.prevSpeed = this.subject?.speed ?? 0;
    this.primeCounters(this.subject);
  }

  dispose(): void {
    this.dust.dispose();
    this.debris.dispose();
    this.speed.dispose();
    this.cameraDirector.dispose();
    this.object.removeFromParent();
  }
}

export function createEffects(deps: EffectsDeps): Effects {
  return new Effects(deps);
}

/** Build only the camera, for a Game that does not want the particle systems. */
export function createCameraDirector(opts: CameraDirectorOptions): CameraDirector {
  return new CameraDirector(opts);
}
