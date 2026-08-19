/**
 * PlayerPhysics — the Spark the Electric Jester movement model.
 *
 * This file is a reimplementation of Spark 3's character controller, anchored
 * to the three values its author published: gravity is 36 units/s², top running
 * speed is 74 units/s (the 185 the HUD shows, divided by 2.5), and the force
 * holding the character down while grounded is a flat -2.0 on Y which is
 * INDEPENDENT of gravity. Everything else in `SparkConstants.ts` is derived
 * from or tuned against those three.
 *
 * Structural decisions that are load-bearing, in the order they bite:
 *
 *  1. ONE MODE PER STEP. `MoveMode` is a real state machine, not a bag of
 *     booleans, because the transitions are where the character lives. Entering
 *     a wall run has a speed condition, a lockout, an additive impulse and an
 *     animation blend, and none of those have anywhere to live if wall running
 *     is a flag.
 *
 *  2. THE GROUNDED BRANCH WORKS IN HORIZONTAL SPEED AND YAW, NOT IN A VELOCITY
 *     VECTOR. Steering rotates a heading; acceleration changes a scalar. That
 *     separation is why Spark turns on a dime at walking pace and carves a wide
 *     arc at 74 m/s from one pair of constants, and it is why a pivot can throw
 *     away exactly `RUN.quickTurnKeep` of the speed instead of whatever a
 *     vector subtraction happened to produce.
 *
 *  3. GRAVITY AND GROUND STICK ARE DIFFERENT FORCES. Airborne integrates
 *     `GRAVITY.accel`. Grounded does not integrate gravity on Y at all — it
 *     adds the along-slope component of gravity to the HORIZONTAL speed (this
 *     is the "running down a mountain gaining momentum" the game is about) and
 *     then sets Y to whatever following the surface requires plus the flat
 *     `GRAVITY.groundStick`. Mixing the two is the classic bug where a
 *     character accelerates downhill and also sinks.
 *
 *  4. SWEPT, SUBSTEPPED. At 74 m/s a 120 Hz step advances 0.62 m. The terrain
 *     resolve runs in substeps no longer than `HULL.maxSubstep` so a single
 *     step cannot pass through a cliff face, and every thin-geometry query
 *     (rails, walls, boosters, pickups) is handed the whole step's segment
 *     rather than a point.
 *
 *  5. THE MODEL AND THE HULL ROTATE SEPARATELY. `orientation` is yaw only and
 *     is what the collision reasons about. `alignedUp` is a slerped floor
 *     normal and is what the rig tilts the MODEL by. Rotating one node by the
 *     floor normal is the documented cause of the jitter `SLOPE.alignRate`
 *     exists to prevent — the character crosses a 2 m heightfield sample 37
 *     times a second at top speed and the raw normal steps at every one.
 *
 * Zero allocation after construction. Every temporary is module scope.
 */

import { Vector3, Quaternion } from 'three';
import { clamp, clamp01, lerp } from '../core/MathX';
import {
  GRAVITY, RUN, SLOPE, JUMP, DASH, WALL, GRIND, SLIDE, HOMING, BOOST, HULL, DAMAGE,
  SPARK_UNITS_PER_MPS,
} from './SparkConstants';
import { MoveMode, TraversalPrompt, AttackKind, SurfaceKind } from '../game/Contracts';
import type {
  PlayerState, PlayerInput, AttackState,
  ITerrain, TerrainSample, SurfaceProperties,
  ITraversal, IEnemyDirector, IAudio, IEffects,
  RailSample, WallHit, HitEvent,
} from '../game/Contracts';

// ── Scratch. Nothing in this file allocates after construction. ─────────────
const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _segA = new Vector3();
const _segB = new Vector3();
const _up = new Vector3(0, 1, 0);
const _q0 = new Quaternion();
const _hits: HitEvent[] = [];

const EPS = 1e-6;

/** Forward unit vector for a yaw. yaw 0 looks down +Z, which is downhill. */
function forwardFromYaw(yaw: number, out: Vector3): Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

/** Signed shortest angular difference from `a` to `b`, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export interface PlayerPhysicsOptions {
  terrain: ITerrain;
  start?: Vector3;
  facing?: number;
}

export class PlayerPhysics {
  readonly state: PlayerState;

  /** Previous step's transform, for the renderer's `alpha` interpolation. */
  readonly prevPosition = new Vector3();
  prevFacing = 0;
  readonly prevAlignedUp = new Vector3(0, 1, 0);

  private readonly terrain: ITerrain;
  private traversal: ITraversal | null = null;
  private enemies: IEnemyDirector | null = null;
  private audio: IAudio | null = null;
  private effects: IEffects | null = null;

  /** Reused terrain probe. Owns the only `TerrainSample` this class ever holds. */
  private readonly probe: TerrainSample;
  private readonly defaultSurface: SurfaceProperties;

  // ── Timers the contract does not expose. All seconds. ─────────────────────
  /** Since the jump button last went down. One timer, two buffer windows. */
  private jumpPress = 99;
  /** True once this press has produced a jump of any kind. */
  private jumpUsed = true;
  /** Since the character last had a floor, for coyote time. */
  private coyote = 99;
  /** True while a jump is rising and has not yet been release-cut. */
  private jumpRising = false;
  private dashTime = 0;
  /** True if the dash that is running started in the air. */
  private dashAirborne = false;
  private slideTime = 0;
  private stun = 0;
  private homingTime = 0;
  /** Blocks remounting the wall just jumped from. */
  private sameWallLock = 0;
  private lastWallId = -1;
  /** Blocks remounting the rail just jumped from. */
  private railLock = 0;
  private lastRailIndex = -1;
  /** Reduced turn authority after a hard landing. */
  private landRecover = 0;
  /** Set on the step a dive lands, consumed by whoever spawns the shockwave. */
  slamThisStep = false;

  private readonly railSample: RailSample;
  private wallHit: WallHit | null = null;

  constructor(opts: PlayerPhysicsOptions) {
    this.terrain = opts.terrain;

    // One real sample, then never allocate another.
    const start = opts.start ?? new Vector3(0, 0, 0);
    this.probe = this.terrain.sampleAt(start.x, start.z);
    this.defaultSurface = this.probe.surface;

    this.railSample = {
      position: new Vector3(),
      tangent: new Vector3(0, 0, 1),
      up: new Vector3(0, 1, 0),
      distance: 0,
      gradient: 0,
    };

    const attack: AttackState = {
      kind: AttackKind.None,
      phase: 0,
      active: false,
      hitStop: 0,
      combo: 0,
      comboWindow: 0,
      charge: 0,
    };

    this.state = {
      position: new Vector3(),
      velocity: new Vector3(),
      orientation: new Quaternion(),
      facing: opts.facing ?? 0,

      groundSpeed: 0,
      speed: 0,
      forwardSpeed: 0,

      mode: MoveMode.Airborne,
      modeTime: 0,
      previousMode: MoveMode.Airborne,

      groundNormal: new Vector3(0, 1, 0),
      alignedUp: new Vector3(0, 1, 0),
      gradient: 0,
      surface: this.defaultSurface,

      airHeight: 0,
      airTime: 0,
      peakAirHeight: 0,
      takeoffHeight: 0,

      jumpsLeft: 1,
      dashesLeft: DASH.airCharges,
      dashCooldown: 0,

      railIndex: -1,
      railDistance: 0,
      wallNormal: new Vector3(),
      wallId: -1,
      wallTimeLeft: 0,

      boost: 0,
      boosting: false,

      attack,
      health: DAMAGE.maxHealth,
      invulnTime: 0,
      homingTarget: -1,
      prompt: TraversalPrompt.None,

      landedThisStep: false,
      landingImpact: 0,
      hardLanding: false,
      jumpedThisStep: false,
      dashedThisStep: false,
      wallMountedThisStep: false,
      railMountedThisStep: false,
      hurtThisStep: false,
      hurtDirection: new Vector3(),
    };

    this.reset(start, opts.facing ?? 0);
  }

  // ── Wiring. Game sets these after construction so ordering stays free. ────
  setTraversal(t: ITraversal | null): void { this.traversal = t; }
  setEnemies(d: IEnemyDirector | null): void { this.enemies = d; }
  setAudio(a: IAudio | null): void { this.audio = a; }
  setEffects(e: IEffects | null): void { this.effects = e; }

  reset(position: Vector3, facing: number): void {
    const s = this.state;
    s.position.copy(position);
    s.position.y = Math.max(position.y, this.terrain.heightAt(position.x, position.z));
    s.velocity.set(0, 0, 0);
    s.facing = facing;
    s.orientation.setFromAxisAngle(_up, facing);

    s.groundSpeed = 0;
    s.speed = 0;
    s.forwardSpeed = 0;

    s.mode = MoveMode.Grounded;
    s.previousMode = MoveMode.Grounded;
    s.modeTime = 0;

    this.terrain.sampleAt(s.position.x, s.position.z, this.probe);
    s.groundNormal.copy(this.probe.normal);
    s.alignedUp.copy(this.probe.normal);
    s.surface = this.probe.surface;
    s.gradient = 0;

    s.airHeight = 0;
    s.airTime = 0;
    s.peakAirHeight = 0;
    s.takeoffHeight = s.position.y;

    s.jumpsLeft = 1;
    s.dashesLeft = DASH.airCharges;
    s.dashCooldown = 0;

    s.railIndex = -1;
    s.railDistance = 0;
    s.wallNormal.set(0, 0, 0);
    s.wallId = -1;
    s.wallTimeLeft = 0;

    s.boost = 0;
    s.boosting = false;

    s.attack.kind = AttackKind.None;
    s.attack.phase = 0;
    s.attack.active = false;
    s.attack.hitStop = 0;
    s.attack.combo = 0;
    s.attack.comboWindow = 0;
    s.attack.charge = 0;

    s.health = DAMAGE.maxHealth;
    s.invulnTime = 0;
    s.homingTarget = -1;
    s.prompt = TraversalPrompt.None;

    this.clearEvents();

    this.jumpPress = 99;
    this.jumpUsed = true;
    this.coyote = 0;
    this.jumpRising = false;
    this.dashTime = 0;
    this.dashAirborne = false;
    this.slideTime = 0;
    this.stun = 0;
    this.homingTime = 0;
    this.sameWallLock = 0;
    this.lastWallId = -1;
    this.railLock = 0;
    this.lastRailIndex = -1;
    this.landRecover = 0;
    this.slamThisStep = false;
    this.wallHit = null;

    this.prevPosition.copy(s.position);
    this.prevFacing = facing;
    this.prevAlignedUp.copy(s.alignedUp);
  }

  private clearEvents(): void {
    const s = this.state;
    s.landedThisStep = false;
    s.landingImpact = 0;
    s.hardLanding = false;
    s.jumpedThisStep = false;
    s.dashedThisStep = false;
    s.wallMountedThisStep = false;
    s.railMountedThisStep = false;
    s.hurtThisStep = false;
    this.slamThisStep = false;
  }

  private setMode(m: MoveMode): void {
    const s = this.state;
    if (s.mode === m) return;
    s.previousMode = s.mode;
    s.mode = m;
    s.modeTime = 0;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The step
  // ═════════════════════════════════════════════════════════════════════════

  step(input: PlayerInput, dt: number): void {
    const s = this.state;

    this.prevPosition.copy(s.position);
    this.prevFacing = s.facing;
    this.prevAlignedUp.copy(s.alignedUp);

    this.clearEvents();

    // Hit-stop freezes the character completely — this is what sells a hit.
    // Timers that are about the OUTSIDE world (invulnerability, the combo
    // window) keep running; timers that are about this character's motion do
    // not, because it is not moving.
    if (s.attack.hitStop > 0) {
      s.attack.hitStop -= dt;
      s.invulnTime = Math.max(0, s.invulnTime - dt);
      s.modeTime += dt;
      return;
    }

    // ── Timers ────────────────────────────────────────────────────────────
    s.modeTime += dt;
    this.jumpPress += dt;
    if (input.jump) { this.jumpPress = 0; this.jumpUsed = false; }

    s.dashCooldown = Math.max(0, s.dashCooldown - dt);
    s.invulnTime = Math.max(0, s.invulnTime - dt);
    this.sameWallLock = Math.max(0, this.sameWallLock - dt);
    this.railLock = Math.max(0, this.railLock - dt);
    this.landRecover = Math.max(0, this.landRecover - dt);

    if (s.attack.comboWindow > 0) {
      s.attack.comboWindow -= dt;
      if (s.attack.comboWindow <= 0) s.attack.combo = 0;
    }

    // ── Intent ────────────────────────────────────────────────────────────
    // Camera-relative stick to a world heading. `wishMag` is the analogue
    // magnitude and survives all the way to the speed target so a half-pressed
    // stick is a jog rather than a slow sprint.
    let wishMag = Math.hypot(input.moveX, input.moveZ);
    let wishYaw = s.facing;
    if (wishMag > 0.02) {
      if (wishMag > 1) wishMag = 1;
      // Screen-space: +moveZ is "away from camera", +moveX is "right".
      //
      // THE SIGN ON THE moveX TERMS IS NOT FREE, and it was wrong: left and
      // right were swapped, so pressing D steered the character left.
      //
      // Derivation, because guessing this is a coin flip. `cameraYaw` maps to a
      // forward vector the same way `facing` does — f = (sin y, 0, cos y). A
      // three.js camera looks down its own LOCAL -Z, so its local +X (screen
      // right) is cross(f, up), not cross(up, f):
      //
      //     right = cross((sin y, 0, cos y), (0, 1, 0)) = (-cos y, 0, sin y)
      //
      // Sanity check against the default camera, which looks along -Z and has
      // right = +X: f = (0,0,-1) gives cross(f, up) = (1, 0, 0). Correct.
      //
      // The world wish is then moveZ * f + moveX * right, which is what these
      // two lines are. The previous version used +moveX * cy and -moveX * sy —
      // the X axis mirrored, i.e. cross(up, f) — and was self-consistent enough
      // that nothing type-checked or crashed; it just drove the wrong way.
      const cy = Math.cos(input.cameraYaw);
      const sy = Math.sin(input.cameraYaw);
      const wx = input.moveZ * sy - input.moveX * cy;
      const wz = input.moveZ * cy + input.moveX * sy;
      wishYaw = Math.atan2(wx, wz);
    } else {
      wishMag = 0;
    }

    // Damage lockout ignores the stick entirely.
    const controlled = s.mode !== MoveMode.Hurt;
    if (!controlled) wishMag = 0;

    this.updateBoost(input, dt);

    // ── Mode branch ───────────────────────────────────────────────────────
    switch (s.mode) {
      case MoveMode.Grounded:  this.stepGrounded(input, wishMag, wishYaw, dt, false); break;
      case MoveMode.Sliding:   this.stepGrounded(input, wishMag, wishYaw, dt, true);  break;
      case MoveMode.Airborne:  this.stepAirborne(input, wishMag, wishYaw, dt, true);  break;
      case MoveMode.Dashing:   this.stepDashing(input, wishMag, wishYaw, dt);         break;
      case MoveMode.Diving:    this.stepDiving(dt);                                   break;
      case MoveMode.WallRun:   this.stepWallRun(input, wishMag, wishYaw, dt);         break;
      case MoveMode.Grinding:  this.stepGrinding(input, wishMag, dt);                 break;
      case MoveMode.Homing:    this.stepHoming(dt);                                   break;
      case MoveMode.Hurt:      this.stepHurt(dt);                                     break;
      case MoveMode.Finished:  this.stepFinished(dt);                                 break;
    }

    // ── Integrate and resolve ─────────────────────────────────────────────
    _segA.copy(s.position);
    if (s.mode !== MoveMode.Grinding) {
      this.integrate(dt);
    }
    _segB.copy(s.position);

    // ── Swept traversal on the whole step's segment ────────────────────────
    if (controlled) this.probeTraversal(_segA, _segB, input, dt);

    // ── Derived state ─────────────────────────────────────────────────────
    this.updateDerived(dt);
    this.updateAlignment(dt);
    this.updatePrompt();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Grounded and sliding
  // ═════════════════════════════════════════════════════════════════════════

  private stepGrounded(
    input: PlayerInput, wishMag: number, wishYaw: number, dt: number, sliding: boolean,
  ): void {
    const s = this.state;
    const n = s.groundNormal;

    if (sliding) this.slideTime += dt;

    // Jump wins over everything else a grounded character can do this step.
    if (this.tryJump(sliding ? SLIDE.jumpBoost : 0)) return;
    if (this.tryDash(input, wishMag, wishYaw)) return;

    // Enter / leave a slide.
    if (!sliding) {
      if (input.crouch && s.groundSpeed >= SLIDE.minSpeed) {
        this.slideTime = 0;
        this.setMode(MoveMode.Sliding);
        sliding = true;
      }
    } else if (
      (!input.crouch && this.slideTime >= SLIDE.minTime) ||
      s.groundSpeed < SLIDE.minSpeed * 0.5
    ) {
      this.setMode(MoveMode.Grounded);
      sliding = false;
    }

    // ── Steering: rotate a heading, do not lerp a vector ───────────────────
    let h = Math.hypot(s.velocity.x, s.velocity.z);
    let heading = h > 0.2 ? Math.atan2(s.velocity.x, s.velocity.z) : s.facing;

    const fast = clamp01(h / RUN.max);
    let turnRate = lerp(RUN.turnRateLow, RUN.turnRateHigh, fast);
    // A slide trades turn authority for the speed it keeps. A hard landing
    // costs authority for a moment, which is the whole penalty for a big fall.
    if (sliding) turnRate *= 0.45;
    if (this.landRecover > 0) turnRate *= 0.35;

    let braking = false;

    if (wishMag > 0) {
      const d = angleDelta(heading, wishYaw);
      const absD = Math.abs(d);

      // The pivot. Reversing above `pivotSpeed` is a deliberate, costed action
      // that throws away all but `quickTurnKeep` of the speed and turns on the
      // spot, rather than a slow 180 the player fights the physics through.
      if (absD > 2.36 && h > RUN.pivotSpeed && !sliding) {
        h *= RUN.quickTurnKeep;
        heading = wishYaw;
      } else if (absD > 2.36 && !sliding) {
        // Below pivot speed there is nothing to conserve — just face it.
        heading = wishYaw;
      } else {
        const maxTurn = turnRate * dt;
        heading += absD < maxTurn ? d : Math.sign(d) * maxTurn;
      }
    } else if (!sliding) {
      braking = true;
    }

    // ── Speed along the heading ────────────────────────────────────────────
    const boostGain = s.boosting ? BOOST.accel : 0;
    const target = s.boosting
      ? BOOST.max
      : RUN.floorSpeed + (RUN.max - RUN.floorSpeed) * wishMag;

    if (sliding) {
      // A slide never accelerates from input. It coasts, and it keeps speed
      // far better than running does — which is why it is worth doing on a
      // descent and pointless on the flat.
      h = Math.max(0, h - SLIDE.friction * dt);
    } else if (braking) {
      h = Math.max(0, h - RUN.friction * dt);
    } else if (input.crouch && h > 1) {
      h = Math.max(0, h - RUN.brake * dt);
    } else if (h < target) {
      const accel = (h < RUN.gearSpeed ? RUN.accelLow : RUN.accelHigh) + boostGain;
      h = Math.min(target, h + accel * dt);
    } else if (h > RUN.max) {
      // Overspeed from a dash, a slope or a booster decays gently. See
      // RUN.overDecay — using RUN.friction here throws the dash away.
      h = Math.max(RUN.max, h - RUN.overDecay * dt);
    }

    // ── Rebuild the horizontal velocity, then add along-slope gravity ──────
    s.velocity.x = Math.sin(heading) * h;
    s.velocity.z = Math.cos(heading) * h;

    // The horizontal part of a heightfield normal points DOWNHILL, and the
    // horizontal component of gravity resolved into the surface plane is
    // exactly `g * n.y * (n.x, n.z)`. This one line is the mountain.
    const slopeScale = (sliding ? SLIDE.slopeScale : 1) * SLOPE.accelScale;
    const g = GRAVITY.accel * n.y * slopeScale * dt;
    s.velocity.x += n.x * g;
    s.velocity.z += n.z * g;

    // Hard ceiling only. `RUN.max` is an acceleration target, not a limit —
    // a steep gully is supposed to hand you speed you could not run up to.
    h = Math.hypot(s.velocity.x, s.velocity.z);
    if (h > RUN.hardMax) {
      const k = RUN.hardMax / h;
      s.velocity.x *= k;
      s.velocity.z *= k;
      h = RUN.hardMax;
    }

    // ── Y follows the surface, plus the flat ground stick ──────────────────
    // Not gravity. `GRAVITY.groundStick` is a separate, constant force and the
    // collision resolve absorbs whatever of it the surface does not need.
    if (n.y > 0.05) {
      s.velocity.y = -(n.x * s.velocity.x + n.z * s.velocity.z) / n.y + GRAVITY.groundStick;
    } else {
      s.velocity.y = GRAVITY.groundStick;
    }

    s.facing = heading;

    // Walk off an edge, or get launched by a convex crest.
    const ground = this.terrain.heightAt(s.position.x, s.position.z);
    if (s.position.y - ground > HULL.groundProbe + 0.05) {
      this.leaveGround();
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Airborne
  // ═════════════════════════════════════════════════════════════════════════

  private stepAirborne(
    input: PlayerInput, wishMag: number, wishYaw: number, dt: number, allowActions: boolean,
  ): void {
    const s = this.state;

    if (allowActions) {
      if (this.tryWallJump()) return;
      if (this.tryJump(0)) return;
      if (this.tryDash(input, wishMag, wishYaw)) return;
      if (this.tryDive(input)) return;
      if (this.tryHoming(input)) return;
    }

    // Release-cut. Spark's jump height is genuinely variable and this is the
    // whole mechanism: one multiply, once, on the release edge while rising.
    if (this.jumpRising) {
      if (s.velocity.y <= 0) {
        this.jumpRising = false;
      } else if (!input.jumpHeld) {
        s.velocity.y *= JUMP.cutScale;
        this.jumpRising = false;
      }
    }

    // Air control. Steers the heading like the ground does, but can never
    // ACCELERATE past the speed it entered the air with — momentum carried off
    // a ramp is the reward for the run-up, and air-strafing past it is not.
    let h = Math.hypot(s.velocity.x, s.velocity.z);
    const cap = Math.max(h, RUN.max);

    if (wishMag > 0) {
      let heading = h > 0.2 ? Math.atan2(s.velocity.x, s.velocity.z) : s.facing;
      const d = angleDelta(heading, wishYaw);
      // Air turn authority sits between the two ground rates — enough to
      // correct a landing, not enough to make the ground rates irrelevant.
      const maxTurn = lerp(RUN.turnRateLow * 0.55, RUN.turnRateHigh * 1.2, clamp01(h / RUN.max)) * dt;
      heading += Math.abs(d) < maxTurn ? d : Math.sign(d) * maxTurn;

      h = Math.min(cap, h + JUMP.airAccel * wishMag * dt);
      s.velocity.x = Math.sin(heading) * h;
      s.velocity.z = Math.cos(heading) * h;
      s.facing = heading;
    } else if (h > 0) {
      h = Math.max(0, h - JUMP.airFriction * dt);
      const dir = h > EPS ? h / Math.max(EPS, Math.hypot(s.velocity.x, s.velocity.z)) : 0;
      s.velocity.x *= dir;
      s.velocity.z *= dir;
    }

    const scale = s.velocity.y > 0 ? GRAVITY.riseScale : GRAVITY.fallScale;
    s.velocity.y -= GRAVITY.accel * scale * dt;
    if (s.velocity.y < -GRAVITY.maxFall) s.velocity.y = -GRAVITY.maxFall;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Dash
  // ═════════════════════════════════════════════════════════════════════════

  private tryDash(input: PlayerInput, wishMag: number, wishYaw: number): boolean {
    const s = this.state;
    if (!input.dash) return false;

    const grounded = s.mode === MoveMode.Grounded || s.mode === MoveMode.Sliding;
    if (grounded) {
      if (s.dashCooldown > 0) return false;
      s.dashCooldown = DASH.groundCooldown;
    } else {
      if (s.dashesLeft <= 0) return false;
      s.dashesLeft -= 1;
    }

    const yaw = wishMag > 0.1 ? wishYaw : s.facing;
    s.velocity.x = Math.sin(yaw) * DASH.speed;
    s.velocity.z = Math.cos(yaw) * DASH.speed;
    if (!grounded) s.velocity.y = 0;    // the air dash is flat, and hangs
    s.facing = yaw;

    this.dashTime = 0;
    this.dashAirborne = !grounded;
    s.dashedThisStep = true;
    this.setMode(MoveMode.Dashing);
    this.audio?.playDash(false);
    return true;
  }

  private stepDashing(input: PlayerInput, wishMag: number, wishYaw: number, dt: number): void {
    const s = this.state;
    this.dashTime += dt;

    // A dash can be jumped or wall-jumped out of at any point. Cancelling into
    // movement is the point of the move; a dash you have to sit through is a
    // commitment the rest of the kit does not ask for.
    if (this.tryWallJump()) return;
    if (this.tryJump(0)) return;
    if (this.tryDive(input)) return;
    if (this.tryHoming(input)) return;

    // Steering unlocks after `DASH.lockTime`, at the high-speed turn rate.
    if (this.dashTime > DASH.lockTime && wishMag > 0) {
      const h = Math.hypot(s.velocity.x, s.velocity.z);
      let heading = Math.atan2(s.velocity.x, s.velocity.z);
      const d = angleDelta(heading, wishYaw);
      const maxTurn = RUN.turnRateHigh * dt;
      heading += Math.abs(d) < maxTurn ? d : Math.sign(d) * maxTurn;
      s.velocity.x = Math.sin(heading) * h;
      s.velocity.z = Math.cos(heading) * h;
      s.facing = heading;
    }

    if (this.dashAirborne) {
      // The hang. No gravity at all for `DASH.hangTime` — this is what makes
      // an air dash a gap-crossing tool rather than a lunge.
      if (this.dashTime > DASH.hangTime) {
        s.velocity.y -= GRAVITY.accel * dt;
        if (s.velocity.y < -GRAVITY.maxFall) s.velocity.y = -GRAVITY.maxFall;
      } else {
        s.velocity.y = 0;
      }
    } else {
      const n = s.groundNormal;
      if (n.y > 0.05) {
        s.velocity.y = -(n.x * s.velocity.x + n.z * s.velocity.z) / n.y + GRAVITY.groundStick;
      } else {
        s.velocity.y = GRAVITY.groundStick;
      }
      const ground = this.terrain.heightAt(s.position.x, s.position.z);
      if (s.position.y - ground > HULL.groundProbe + 0.05) this.dashAirborne = true;
    }

    if (this.dashTime >= DASH.hangTime + 0.10) {
      // Hand the overspeed to the normal branches. They decay it at
      // `RUN.overDecay`, which is slow on purpose.
      this.setMode(this.dashAirborne ? MoveMode.Airborne : MoveMode.Grounded);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Dive
  // ═════════════════════════════════════════════════════════════════════════

  private tryDive(input: PlayerInput): boolean {
    if (!input.dive) return false;
    const s = this.state;
    if (s.mode === MoveMode.Diving || s.mode === MoveMode.Grounded) return false;
    // Keeps 30% of the horizontal. A perfectly vertical dive is unusable in a
    // game where the ground is moving past at 74 m/s.
    s.velocity.x *= 0.30;
    s.velocity.z *= 0.30;
    s.velocity.y = -DASH.diveSpeed;
    this.setMode(MoveMode.Diving);
    this.audio?.playDash(true);
    return true;
  }

  private stepDiving(dt: number): void {
    const s = this.state;
    s.velocity.y -= GRAVITY.accel * dt;
    if (s.velocity.y < -GRAVITY.maxFall * 1.4) s.velocity.y = -GRAVITY.maxFall * 1.4;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Jump — ground, coyote, double
  // ═════════════════════════════════════════════════════════════════════════

  private tryJump(extraSpeed: number): boolean {
    const s = this.state;
    if (this.jumpUsed || this.jumpPress > JUMP.bufferTime) return false;

    const grounded =
      s.mode === MoveMode.Grounded || s.mode === MoveMode.Sliding ||
      s.mode === MoveMode.Dashing && !this.dashAirborne;
    const coyoteOk = this.coyote <= JUMP.coyoteTime;

    if (grounded || coyoteOk) {
      // Jumping off a descent adds height in proportion to how steeply you
      // were already falling with the slope. Cresting a roller launches.
      const desc = Math.max(0, -s.velocity.y);
      s.velocity.y = JUMP.velocity + Math.min(JUMP.slopeBonus, desc * 0.35);
      if (extraSpeed > 0) {
        const h = Math.hypot(s.velocity.x, s.velocity.z);
        if (h > EPS) {
          const k = (h + extraSpeed) / h;
          s.velocity.x *= k;
          s.velocity.z *= k;
        }
      }
      s.jumpsLeft = 1;
      s.dashesLeft = DASH.airCharges;
    } else if (s.jumpsLeft > 0) {
      // The double jump SETS Y rather than adding, so it is a reliable
      // recovery from any fall speed. The wall jump is the additive one.
      s.velocity.y = JUMP.doubleVelocity;
      s.jumpsLeft -= 1;
    } else {
      return false;
    }

    this.jumpUsed = true;
    this.jumpRising = true;
    this.coyote = 99;
    s.jumpedThisStep = true;
    s.takeoffHeight = s.position.y;
    s.peakAirHeight = 0;
    this.setMode(MoveMode.Airborne);
    this.audio?.playJump(s.jumpsLeft === 0);
    return true;
  }

  private leaveGround(): void {
    const s = this.state;
    if (s.mode === MoveMode.Airborne) return;
    this.coyote = 0;
    s.takeoffHeight = s.position.y;
    s.peakAirHeight = 0;
    this.setMode(MoveMode.Airborne);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Wall run and the additive wall jump
  // ═════════════════════════════════════════════════════════════════════════

  private stepWallRun(input: PlayerInput, wishMag: number, wishYaw: number, dt: number): void {
    const s = this.state;

    if (this.tryWallJump()) return;
    if (this.tryDash(input, wishMag, wishYaw)) return;

    s.wallTimeLeft -= dt;

    const n = s.wallNormal;
    // Re-derive the along-wall direction from the live velocity every step so
    // the run follows a curved face instead of a fixed tangent.
    _v0.copy(s.velocity);
    const into = _v0.dot(n);
    _v0.addScaledVector(n, -into);            // velocity in the wall plane
    _v1.set(_v0.x, 0, _v0.z);
    if (_v1.lengthSq() < 0.04) {
      this.detachWall();
      return;
    }
    _v1.normalize();

    let along = Math.hypot(_v0.x, _v0.z);
    if (wishMag > 0) {
      // Only forward intent accelerates. Steering on a wall is the wall's job.
      const f = Math.max(0, Math.sin(wishYaw) * _v1.x + Math.cos(wishYaw) * _v1.z);
      along = Math.min(RUN.hardMax, along + WALL.accel * f * wishMag * dt);
    }

    s.velocity.x = _v1.x * along;
    s.velocity.z = _v1.z * along;

    // Reduced gravity for the duration, then full gravity, which is what makes
    // the run end by feel rather than by a timer the player cannot see.
    const grav = s.wallTimeLeft > 0 ? WALL.gravity : GRAVITY.accel;
    s.velocity.y = _v0.y - grav * dt;
    if (s.velocity.y < -GRAVITY.maxFall) s.velocity.y = -GRAVITY.maxFall;

    // Hold against the face.
    s.velocity.addScaledVector(n, -WALL.stick);

    if (along < WALL.mountSpeed * 0.5 || s.wallTimeLeft < -0.5) this.detachWall();
  }

  private tryWallJump(): boolean {
    const s = this.state;
    if (s.mode !== MoveMode.WallRun) return false;
    // The generous window the Reddit thread asked for: 0.18 s, not 0.12.
    if (this.jumpUsed || this.jumpPress > WALL.jumpBuffer) return false;

    const n = s.wallNormal;

    // ADDITIVE on Y, Spark 1 style, clamped. Chaining wall jumps up a chimney
    // therefore climbs — each one builds on the last instead of resetting it,
    // and the clamp is the only thing stopping it running away.
    s.velocity.y = Math.min(s.velocity.y + WALL.jumpUp, WALL.jumpUpMax);

    // Push off the face, keeping the along-wall momentum.
    s.velocity.x += n.x * WALL.jumpOut;
    s.velocity.z += n.z * WALL.jumpOut;

    // "I made the wall jump as fast as dashing and it really does feel better."
    // The floor is DASH.speed, so a wall jump never costs speed.
    const h = Math.hypot(s.velocity.x, s.velocity.z);
    if (h < WALL.jumpMinSpeed) {
      const k = WALL.jumpMinSpeed / Math.max(EPS, h);
      s.velocity.x *= k;
      s.velocity.z *= k;
    }
    s.facing = Math.atan2(s.velocity.x, s.velocity.z);

    this.lastWallId = s.wallId;
    this.sameWallLock = WALL.sameWallLockout;
    this.jumpUsed = true;
    this.jumpRising = true;
    s.jumpedThisStep = true;
    this.refreshAirCharges();
    s.takeoffHeight = s.position.y;
    s.peakAirHeight = 0;
    this.detachWall();
    this.audio?.playJump(true);
    return true;
  }

  private detachWall(): void {
    const s = this.state;
    s.wallTimeLeft = 0;
    s.wallId = -1;
    s.wallNormal.set(0, 0, 0);
    this.wallHit = null;
    this.setMode(MoveMode.Airborne);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Grind
  // ═════════════════════════════════════════════════════════════════════════

  private stepGrinding(input: PlayerInput, wishMag: number, dt: number): void {
    const s = this.state;
    const rails = this.traversal?.rails;
    if (!rails || s.railIndex < 0) { this.dismountRail(); return; }

    // Jump off keeps the rail's speed and ADDS height, so a rail is a launcher.
    if (!this.jumpUsed && this.jumpPress <= JUMP.bufferTime) {
      this.jumpUsed = true;
      this.jumpRising = true;
      s.velocity.y += GRIND.jumpUp;
      s.jumpedThisStep = true;
      this.refreshAirCharges();
      this.railLock = GRIND.lockout;
      this.lastRailIndex = s.railIndex;
      s.takeoffHeight = s.position.y;
      s.peakAirHeight = 0;
      this.dismountRail();
      this.audio?.playJump(false);
      return;
    }

    const sample = rails.sampleAt(s.railIndex, s.railDistance, this.railSample);
    const dir = this.railSpeed >= 0 ? 1 : -1;

    // Gravity along the rail. A descending rail is free speed, which is the
    // whole reason to take one.
    this.railSpeed += -GRAVITY.accel * Math.sin(sample.gradient) * GRIND.gravityScale * dt;

    if (wishMag > 0) {
      const f = Math.sin(s.facing) * sample.tangent.x + Math.cos(s.facing) * sample.tangent.z;
      this.railSpeed += GRIND.accel * f * wishMag * dt * dir;
    }
    this.railSpeed -= GRIND.drag * dir * dt;
    this.railSpeed = clamp(this.railSpeed, -RUN.hardMax, RUN.hardMax);

    s.railDistance += this.railSpeed * dt;

    const len = rails.lengthOf(s.railIndex);
    if (s.railDistance <= 0 || s.railDistance >= len) {
      s.railDistance = clamp(s.railDistance, 0, len);
      rails.sampleAt(s.railIndex, s.railDistance, this.railSample);
      s.position.copy(this.railSample.position);
      s.velocity.copy(this.railSample.tangent).multiplyScalar(this.railSpeed);
      this.railLock = GRIND.lockout;
      this.lastRailIndex = s.railIndex;
      this.dismountRail();
      return;
    }

    rails.sampleAt(s.railIndex, s.railDistance, this.railSample);
    s.position.copy(this.railSample.position);
    s.velocity.copy(this.railSample.tangent).multiplyScalar(this.railSpeed);
    s.groundNormal.copy(this.railSample.up);
    s.facing = Math.atan2(s.velocity.x, s.velocity.z);
  }

  private railSpeed = 0;

  private mountRail(index: number, distance: number, sample: RailSample): void {
    const s = this.state;
    const along = s.velocity.dot(sample.tangent);
    const dir = along >= 0 ? 1 : -1;
    // Mounting hands you `GRIND.mountFloor` if you arrived slower than that.
    // A rail should never be a way to lose speed.
    this.railSpeed = Math.max(Math.abs(along), GRIND.mountFloor) * dir;
    s.railIndex = index;
    s.railDistance = distance;
    s.position.copy(sample.position);
    s.velocity.copy(sample.tangent).multiplyScalar(this.railSpeed);
    s.groundNormal.copy(sample.up);
    s.railMountedThisStep = true;
    this.refreshAirCharges();
    this.setMode(MoveMode.Grinding);
    this.audio?.playRailMount();
  }

  private dismountRail(): void {
    const s = this.state;
    s.railIndex = -1;
    s.railDistance = 0;
    this.setMode(MoveMode.Airborne);
    s.jumpsLeft = Math.max(s.jumpsLeft, 1);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Homing
  // ═════════════════════════════════════════════════════════════════════════

  private tryHoming(input: PlayerInput): boolean {
    if (!input.attack) return false;
    const s = this.state;
    const dir = this.enemies;
    if (!dir) return false;
    forwardFromYaw(s.facing, _v0);
    const idx = dir.pickHomingTarget(s.position, _v0);
    if (idx < 0) return false;
    s.homingTarget = idx;
    this.homingTime = 0;
    this.setMode(MoveMode.Homing);
    return true;
  }

  private stepHoming(dt: number): void {
    const s = this.state;
    const dir = this.enemies;
    this.homingTime += dt;
    if (!dir || s.homingTarget < 0 || this.homingTime > HOMING.maxTime) {
      s.homingTarget = -1;
      this.setMode(MoveMode.Airborne);
      return;
    }
    const e = dir.enemies[s.homingTarget];
    if (!e || !e.active || e.health <= 0) {
      s.homingTarget = -1;
      this.setMode(MoveMode.Airborne);
      return;
    }
    _v0.copy(e.position).sub(s.position);
    _v0.y += 0.9;
    const d = _v0.length();
    if (d < HOMING.hitRadius) {
      _hits.length = 0;
      dir.hitTarget(s.homingTarget, s.position, _hits);
      // Bounce off, refreshed. This is what chains a homing sequence into a
      // traversal route rather than a single attack.
      s.velocity.y = HOMING.bounce;
      this.refreshAirCharges();
      s.homingTarget = -1;
      this.setMode(MoveMode.Airborne);
      this.audio?.playHit(false, s.attack.combo);
      this.effects?.sparkBurst(e.position, _v0.normalize(), 1);
      return;
    }
    _v0.multiplyScalar(HOMING.speed / Math.max(EPS, d));
    s.velocity.copy(_v0);
    s.facing = Math.atan2(_v0.x, _v0.z);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Hurt, finished
  // ═════════════════════════════════════════════════════════════════════════

  private stepHurt(dt: number): void {
    const s = this.state;
    this.stun -= dt;
    s.velocity.y -= GRAVITY.accel * dt;
    if (s.velocity.y < -GRAVITY.maxFall) s.velocity.y = -GRAVITY.maxFall;
    const h = Math.hypot(s.velocity.x, s.velocity.z);
    if (h > 0) {
      const k = Math.max(0, h - RUN.friction * 0.5 * dt) / h;
      s.velocity.x *= k;
      s.velocity.z *= k;
    }
    if (this.stun <= 0) {
      const ground = this.terrain.heightAt(s.position.x, s.position.z);
      this.setMode(s.position.y - ground <= HULL.groundProbe ? MoveMode.Grounded : MoveMode.Airborne);
    }
  }

  private stepFinished(dt: number): void {
    // The victory run-out. Still real physics, just no player.
    this.stepGrounded(
      { moveX: 0, moveZ: 0.55, cameraYaw: this.state.facing, jump: false, jumpHeld: false,
        dash: false, crouch: false, attack: false, boost: false, dive: false },
      0.55, this.state.facing, dt, false,
    );
  }

  finish(): void {
    if (this.state.mode !== MoveMode.Finished) this.setMode(MoveMode.Finished);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Boost
  // ═════════════════════════════════════════════════════════════════════════

  private updateBoost(input: PlayerInput, dt: number): void {
    const s = this.state;
    const canBoost =
      s.mode !== MoveMode.Hurt && s.mode !== MoveMode.Diving && s.boost > 0;
    if (input.boost && canBoost && (s.boosting || s.boost >= BOOST.minToStart)) {
      s.boosting = true;
      s.boost = Math.max(0, s.boost - BOOST.drain * dt);
      if (s.boost <= 0) s.boosting = false;
    } else {
      s.boosting = false;
    }
    // Traversal earns boost back. Standing still does not.
    if (
      s.mode === MoveMode.Grinding || s.mode === MoveMode.WallRun ||
      (s.mode === MoveMode.Airborne && s.airTime > 0.4)
    ) {
      s.boost = Math.min(1, s.boost + BOOST.perTraversalSecond * dt);
    }
  }

  addBoost(fraction: number): void {
    this.state.boost = clamp01(this.state.boost + fraction);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Integration and terrain resolve
  // ═════════════════════════════════════════════════════════════════════════

  private integrate(dt: number): void {
    const s = this.state;

    // Substep so a single step cannot cross a cliff face. At 74 m/s and
    // 1/120 s the step is 0.62 m, so this is normally 2 substeps.
    const dist = s.velocity.length() * dt;
    const steps = dist > HULL.maxSubstep ? Math.min(8, Math.ceil(dist / HULL.maxSubstep)) : 1;
    const sdt = dt / steps;

    const wasAirborne =
      s.mode === MoveMode.Airborne || s.mode === MoveMode.Diving ||
      s.mode === MoveMode.WallRun || (s.mode === MoveMode.Dashing && this.dashAirborne);

    for (let i = 0; i < steps; i++) {
      const px = s.position.x;
      const pz = s.position.z;

      s.position.x += s.velocity.x * sdt;
      s.position.y += s.velocity.y * sdt;
      s.position.z += s.velocity.z * sdt;

      let h = this.terrain.heightAt(s.position.x, s.position.z);
      if (s.position.y >= h) continue;

      this.terrain.normalAt(s.position.x, s.position.z, _v2);

      if (_v2.y >= SLOPE.walkableNormalY) {
        // Standable. Snap to it and let the branch logic decide the mode.
        s.position.y = h;
        s.groundNormal.copy(_v2);
        if (wasAirborne) this.land(sdt);
        // Remove the into-surface velocity so the ground stick does not
        // accumulate into a downward drift on a long traverse.
        const into = s.velocity.dot(_v2);
        if (into < 0) s.velocity.addScaledVector(_v2, -into);
      } else {
        // Too steep to stand on. Slide along the face: cancel the horizontal
        // component driving into it, undo this substep's horizontal advance
        // and re-advance along the slide. The horizontal part of a heightfield
        // normal points downhill, so -that is "into the hill".
        const nl = Math.hypot(_v2.x, _v2.z);
        if (nl > EPS) {
          const nx = _v2.x / nl;
          const nz = _v2.z / nl;
          const into = -(s.velocity.x * nx + s.velocity.z * nz);
          if (into > 0) {
            s.velocity.x += nx * into;
            s.velocity.z += nz * into;
          }
          s.position.x = px + s.velocity.x * sdt;
          s.position.z = pz + s.velocity.z * sdt;
          h = this.terrain.heightAt(s.position.x, s.position.z);
        }
        if (s.position.y < h) {
          s.position.y = h;
          // Scrape down the face rather than stopping dead on it.
          if (s.velocity.y < 0) s.velocity.y *= 0.35;
        }
        s.groundNormal.copy(_v2);
        // A face in the wall-runnable band is a wall-run candidate, not ground.
        if (_v2.y > WALL.maxNormalY && s.mode === MoveMode.Grounded) {
          this.slideTime = 0;
          this.setMode(MoveMode.Sliding);
        }
      }
    }

    // Ground probe for the frames the resolve did not trigger — walking across
    // a shallow dip should not produce a one-step airborne blip.
    if (
      s.mode === MoveMode.Grounded || s.mode === MoveMode.Sliding ||
      (s.mode === MoveMode.Dashing && !this.dashAirborne)
    ) {
      const gh = this.terrain.heightAt(s.position.x, s.position.z);
      if (s.position.y - gh <= HULL.groundProbe) {
        s.position.y = gh;
        this.terrain.normalAt(s.position.x, s.position.z, s.groundNormal);
      }
    } else if (
      s.mode === MoveMode.Airborne || s.mode === MoveMode.Diving ||
      (s.mode === MoveMode.Dashing && this.dashAirborne)
    ) {
      const gh = this.terrain.heightAt(s.position.x, s.position.z);
      if (s.velocity.y <= 0 && s.position.y - gh <= HULL.groundProbe) {
        s.position.y = gh;
        this.terrain.normalAt(s.position.x, s.position.z, s.groundNormal);
        if (s.groundNormal.y >= SLOPE.walkableNormalY) this.land(dt);
      }
    }
  }

  private land(_dt: number): void {
    const s = this.state;
    const fall = Math.max(0, s.takeoffHeight - s.position.y);
    const impact = clamp01(Math.max(fall / 24, -s.velocity.y / GRAVITY.maxFall));

    s.landedThisStep = true;
    s.landingImpact = impact;
    s.hardLanding = fall > DAMAGE.hardLandHeight;
    if (s.hardLanding) this.landRecover = DAMAGE.hardLandRecovery;

    const wasDiving = s.mode === MoveMode.Diving;

    this.coyote = 0;
    s.airTime = 0;
    s.airHeight = 0;
    s.jumpsLeft = 1;
    s.dashesLeft = DASH.airCharges;
    this.jumpRising = false;

    if (wasDiving) {
      // The dive resolves into a shockwave and a bounce, not a thud.
      this.slamThisStep = true;
      s.velocity.y = DASH.diveBounce;
      s.attack.kind = AttackKind.Slam;
      s.attack.phase = 0;
      s.attack.active = true;
      this.setMode(MoveMode.Airborne);
      this.audio?.playAttack(AttackKind.Slam, 0);
      this.effects?.impactFrame(0.7);
      return;
    }

    this.setMode(this.state.mode === MoveMode.Sliding ? MoveMode.Sliding : MoveMode.Grounded);
    this.audio?.playImpact(impact, s.surface);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Swept traversal probes
  // ═════════════════════════════════════════════════════════════════════════

  private probeTraversal(from: Vector3, to: Vector3, input: PlayerInput, _dt: number): void {
    const s = this.state;
    const t = this.traversal;
    if (!t) return;

    // ── Boosters first: they change the velocity the other probes see. ─────
    const b = t.boosters.probe(from, to, s.velocity);
    if (b) {
      if (b.absolute) s.velocity.copy(b.impulse);
      else s.velocity.add(b.impulse);
      if (b.refreshes) this.refreshAirCharges();
      s.facing = Math.atan2(s.velocity.x, s.velocity.z);
      if (s.velocity.y > 0.5) {
        s.takeoffHeight = s.position.y;
        s.peakAirHeight = 0;
        this.setMode(MoveMode.Airborne);
        this.jumpRising = false;
      }
      this.audio?.playDash(false);
    }

    // ── Rails ─────────────────────────────────────────────────────────────
    const canGrind =
      s.mode !== MoveMode.Hurt && s.mode !== MoveMode.Homing &&
      s.speed >= GRIND.minSpeed && this.railLock <= 0;
    if (canGrind) {
      const exclude = s.mode === MoveMode.Grinding ? s.railIndex : this.lastRailIndex;
      const m = t.rails.findMount(from, to, s.velocity, exclude);
      if (m && (s.mode !== MoveMode.Grinding || m.index !== s.railIndex)) {
        this.mountRail(m.index, m.distance, m.sample);
        return;
      }
    }

    // ── Walls ─────────────────────────────────────────────────────────────
    const canWall =
      (s.mode === MoveMode.Airborne || s.mode === MoveMode.Dashing) &&
      Math.hypot(s.velocity.x, s.velocity.z) >= WALL.mountSpeed;
    if (canWall) {
      const exclude = this.sameWallLock > 0 ? this.lastWallId : -1;
      const w = t.walls.probe(from, to, s.velocity, exclude);
      if (w && w.normal.y <= WALL.maxNormalY) {
        s.wallNormal.copy(w.normal);
        s.wallId = w.id;
        s.wallTimeLeft = WALL.maxTime;
        s.wallMountedThisStep = true;
        this.wallHit = w;
        // Sit just off the face so the resolve does not fight the stick.
        s.position.copy(w.point).addScaledVector(w.normal, HULL.radius);
        // Project the velocity into the wall plane and keep at least the mount
        // speed, so arriving at a glancing angle still produces a real run.
        const into = s.velocity.dot(w.normal);
        s.velocity.addScaledVector(w.normal, -into);
        const h = Math.hypot(s.velocity.x, s.velocity.z);
        if (h < WALL.mountSpeed) {
          const k = WALL.mountSpeed / Math.max(EPS, h);
          s.velocity.x *= k;
          s.velocity.z *= k;
        }
        s.facing = Math.atan2(s.velocity.x, s.velocity.z);
        this.setMode(MoveMode.WallRun);
        this.audio?.playWallMount();
      }
    }

    void input;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Derived state, alignment, prompt
  // ═════════════════════════════════════════════════════════════════════════

  private updateDerived(dt: number): void {
    const s = this.state;

    s.groundSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    s.speed = s.velocity.length();
    forwardFromYaw(s.facing, _v0);
    s.forwardSpeed = s.velocity.x * _v0.x + s.velocity.z * _v0.z;
    s.gradient = s.groundSpeed > 0.5 ? Math.atan2(s.velocity.y, s.groundSpeed) : 0;

    const grounded =
      s.mode === MoveMode.Grounded || s.mode === MoveMode.Sliding ||
      (s.mode === MoveMode.Dashing && !this.dashAirborne);

    if (grounded) {
      s.airHeight = 0;
      s.airTime = 0;
      this.coyote = 0;
      this.terrain.sampleAt(s.position.x, s.position.z, this.probe);
      s.surface = this.probe.surface;
    } else {
      this.coyote += dt;
      s.airTime += dt;
      const gh = this.terrain.heightAt(s.position.x, s.position.z);
      s.airHeight = Math.max(0, s.position.y - gh);
      const rise = s.position.y - s.takeoffHeight;
      if (rise > s.peakAirHeight) s.peakAirHeight = rise;
      if (s.mode === MoveMode.Grinding || s.mode === MoveMode.WallRun) s.airTime = 0;
    }

    s.orientation.setFromAxisAngle(_up, s.facing);
  }

  private updateAlignment(dt: number): void {
    const s = this.state;

    // Target: the floor normal, but never fully committed to. `SLOPE.maxAlign`
    // keeps a little of the world up in the pose so a 50-degree face reads as
    // a steep face rather than as flat ground the camera happens to have
    // rolled. The slerp is the anti-jitter — see the header note.
    const target = _v1;
    const grounded =
      s.mode === MoveMode.Grounded || s.mode === MoveMode.Sliding ||
      s.mode === MoveMode.Grinding || (s.mode === MoveMode.Dashing && !this.dashAirborne);

    if (grounded) {
      target.copy(_up).lerp(s.groundNormal, SLOPE.maxAlign).normalize();
    } else if (s.mode === MoveMode.WallRun) {
      // On a wall the character's up is the wall normal, tilted back toward
      // world up so the silhouette still reads as a running figure.
      target.copy(s.wallNormal).lerp(_up, 0.35).normalize();
    } else {
      target.copy(_up);
    }

    const k = 1 - Math.exp(-SLOPE.alignRate * dt);
    s.alignedUp.lerp(target, k);
    const l = s.alignedUp.length();
    if (l > EPS) s.alignedUp.multiplyScalar(1 / l);
    else s.alignedUp.copy(_up);
  }

  private updatePrompt(): void {
    const s = this.state;
    const t = this.traversal;
    s.prompt = TraversalPrompt.None;
    if (s.mode === MoveMode.Grinding) { s.prompt = TraversalPrompt.Rail; return; }
    if (s.mode === MoveMode.WallRun) { s.prompt = TraversalPrompt.Wall; return; }

    // A cheap look-ahead: sweep the next 0.25 s of travel and report what it
    // would find. Same swept queries the physics uses, one lookahead segment.
    if (!t) return;
    _v3.copy(s.position).addScaledVector(s.velocity, 0.25);

    if (s.speed >= GRIND.minSpeed && this.railLock <= 0) {
      const m = t.rails.findMount(s.position, _v3, s.velocity, s.railIndex);
      if (m) { s.prompt = TraversalPrompt.Rail; return; }
    }
    if (this.enemies && s.mode !== MoveMode.Grounded) {
      forwardFromYaw(s.facing, _v0);
      if (this.enemies.pickHomingTarget(s.position, _v0) >= 0) {
        s.prompt = TraversalPrompt.Homing;
        return;
      }
    }
    if (s.groundSpeed >= WALL.mountSpeed) {
      const w = t.walls.probe(s.position, _v3, s.velocity, -1);
      if (w) s.prompt = TraversalPrompt.Wall;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // External
  // ═════════════════════════════════════════════════════════════════════════

  damage(amount: number, from: Vector3): boolean {
    const s = this.state;
    if (s.invulnTime > 0 || s.health <= 0 || s.mode === MoveMode.Finished) return false;

    s.health = Math.max(0, s.health - amount);
    s.invulnTime = DAMAGE.invulnTime;
    this.stun = DAMAGE.stunTime;

    _v0.copy(s.position).sub(from);
    _v0.y = 0;
    if (_v0.lengthSq() < EPS) forwardFromYaw(s.facing + Math.PI, _v0);
    _v0.normalize();
    s.hurtDirection.copy(_v0);

    // Knockback keeps `DAMAGE.speedKeep` of the incoming speed so a hit at
    // 74 m/s does not read as hitting a wall.
    const keep = s.groundSpeed * DAMAGE.speedKeep;
    s.velocity.x = _v0.x * DAMAGE.knockback + Math.sin(s.facing) * keep;
    s.velocity.z = _v0.z * DAMAGE.knockback + Math.cos(s.facing) * keep;
    s.velocity.y = DAMAGE.knockbackUp;

    s.hurtThisStep = true;
    s.attack.kind = AttackKind.None;
    s.attack.active = false;
    s.attack.combo = 0;
    s.attack.comboWindow = 0;
    if (s.mode === MoveMode.Grinding) this.dismountRail();
    if (s.mode === MoveMode.WallRun) this.detachWall();
    this.setMode(MoveMode.Hurt);
    this.effects?.impactFrame(0.9);
    return true;
  }

  heal(amount: number): void {
    const s = this.state;
    s.health = Math.min(DAMAGE.maxHealth, s.health + amount);
  }

  refreshAirCharges(): void {
    const s = this.state;
    s.jumpsLeft = 1;
    s.dashesLeft = DASH.airCharges;
  }

  /** Display speed in Spark's HUD units. 74 m/s reads as 185. */
  get displaySpeed(): number {
    return this.state.groundSpeed * SPARK_UNITS_PER_MPS;
  }

  get onGround(): boolean {
    const m = this.state.mode;
    return m === MoveMode.Grounded || m === MoveMode.Sliding ||
      (m === MoveMode.Dashing && !this.dashAirborne);
  }

  get surfaceKind(): SurfaceKind {
    return this.state.surface.kind;
  }
}
