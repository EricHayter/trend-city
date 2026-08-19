/**
 * CharacterRig — procedural animation for the player character.
 *
 * A pure consumer of `PlayerState`. It never writes physics, never reads input
 * and never allocates after construction. Everything it draws is derived from
 * the state the physics already resolved this step.
 *
 * THE CONTRACT THAT MATTERS IS PLANTED FEET. A procedural locomotion rig that
 * lets the support foot drift is the single most obvious tell that a character
 * is not really running, and at 74 m/s it is worse, not better: the faster the
 * body travels, the further a foot slides during the frames it is supposed to
 * be bearing weight. So the gait here is driven by DISTANCE, not by time, and a
 * foot in stance is pinned to a WORLD position that does not move until the
 * foot lifts. The body travels past a stationary foot, which is what running is.
 *
 * Three consequences of the speed that shape everything below:
 *
 *  1. A LITERAL RUN CYCLE STOPS BEING A RUN CYCLE. `RUN.max` is 74 m/s. Hold a
 *     believable 1.8 m stride and that is 41 steps a second — a strobing blur
 *     with no readable silhouette. So cadence is capped and the stride stretches
 *     under it, and past ~30 m/s the whole gait cross-fades into a committed
 *     forward-lean skate. Spark does the same thing for the same reason: at the
 *     top of the speed range the character reads as a POSE in motion, not as a
 *     cycle.
 *
 *  2. THE POSE IS THE SPEEDOMETER. The player cannot look at the HUD at this
 *     speed. Lean angle, arm carriage and how low the hips ride are the honest
 *     read on how fast they are actually going, so all three are driven off
 *     `groundSpeed` continuously rather than switching at thresholds.
 *
 *  3. NOTHING MAY POP. Every mode change is a cross-fade: pose channels damp
 *     toward their targets with a half-life, and the foot targets get a short
 *     explicit blend window so that switching gait scheme (run → grind → slide)
 *     cannot teleport an ankle. Outside that window the foot targets are
 *     written directly, because damping a planted foot IS drift.
 *
 * Rig space is the skeleton's: +Y up, +Z forward, +X to the LEFT, origin ON THE
 * GROUND between the feet. That origin is why the rig node can sit exactly at
 * `PlayerState.position` with no offset to get wrong.
 */

import { Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three';

import { clamp, clamp01, dampHL, lerp, smoothstep } from '../core/MathX';
import { MoveMode } from '../game/Contracts';
import type { PlayerState } from '../game/Contracts';
import { AttackKind } from '../game/Contracts';
import { RUN, HULL } from './SparkConstants';
import {
  BONE_COUNT,
  BONE_INDEX,
  BONE_NAMES,
  FOOT,
  LIMB,
  REST,
  STANCE,
  CharacterSkeleton,
  type BoneName,
} from './CharacterSkeleton';
import {
  alignFrames,
  makeLimbState,
  makeTwoBoneResult,
  solveTwoBone,
  toLocalRotation,
  type LimbSolverState,
  type TwoBoneResult,
} from './CharacterIK';
import { applyCharacterColors, buildCharacterMeshes, type CharacterMeshSet } from './CharacterMesh';
import { RIDER_COLORS } from '../npr/Palette';

// ─────────────────────────────────────────────────────────────────────────────
// Gait tuning
// ─────────────────────────────────────────────────────────────────────────────

const GAIT = {
  /** Stride at a standstill, and how much every m/s adds to it. */
  strideBase: 1.15,
  stridePerSpeed: 0.085,
  strideMax: 7.4,
  /**
   * Steps per second, capped. Past this the stride absorbs the speed instead.
   * 7.2 is already a fast sprint cadence; beyond it the legs stop reading.
   */
  cadenceMax: 7.2,
  /** Fraction of a foot's cycle spent bearing weight. < 0.5 gives a flight phase. */
  duty: 0.44,
  /** Peak height of the swing foot above the contact plane, metres. */
  swingLift: 0.30,
  /** How far ahead of the hips a foot plants, as a fraction of stride. */
  plantAhead: 0.46,
  /** Hip bob, metres, at full cadence. */
  bob: 0.055,
} as const;

/** Speed range over which the run cross-fades into the high-speed skate. */
const HYPER_LO = 28;
const HYPER_HI = 56;

/** Pose channel damping half-lives, seconds. */
const HL = {
  lean: 0.09,
  roll: 0.11,
  pelvis: 0.07,
  arm: 0.08,
  head: 0.13,
  cloth: 0.10,
} as const;

/** Foot-target cross-fade after a mode change, seconds. */
const FOOT_BLEND = 0.14;

const ARM = {
  /** Two-bone solver parameters shared by both arms. */
  len1: LIMB.upperArm,
  len2: LIMB.forearm,
  maxStretch: 1.06,
  bendHalfLife: 0.035,
  minBend: 0.22,
} as const;

const LEG = {
  len1: LIMB.thigh,
  len2: LIMB.shin,
  /** Legs must not visibly detach from the hips, so they may stretch a little. */
  maxStretch: 1.10,
  bendHalfLife: 0.030,
  minBend: 0.20,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Scratch. Nothing below allocates after construction.
// ─────────────────────────────────────────────────────────────────────────────

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _fwd = new Vector3();
const _side = new Vector3();
const _up = new Vector3();
const _pole = new Vector3();
const _q0 = new Quaternion();
const _q1 = new Quaternion();
const _qStep = new Quaternion();
const _qAcc = new Quaternion();
const _qIdent = new Quaternion();
const _WORLD_UP = new Vector3(0, 1, 0);
const _m = new Matrix4();

/** Rig-space working pose. Index-parallel to the bone table. */
const _rigPos: Vector3[] = [];
const _rigRot: Quaternion[] = [];
for (let i = 0; i < BONE_COUNT; i++) {
  _rigPos.push(new Vector3());
  _rigRot.push(new Quaternion());
}

/** Per-foot gait bookkeeping. Index 0 = left, 1 = right. */
interface FootTrack {
  /** World position the foot is pinned to while bearing weight. */
  plant: Vector3;
  /** World position the foot lifted from, for the swing arc. */
  liftFrom: Vector3;
  /** Where the swing is heading. */
  swingTo: Vector3;
  /** Rig-space target actually fed to the solver, after blending. */
  target: Vector3;
  /** True while bearing weight. */
  planted: boolean;
  /** Ground contact 0..1, for the ankle roll and the dust hooks. */
  contact: number;
}

function makeFootTrack(): FootTrack {
  return {
    plant: new Vector3(),
    liftFrom: new Vector3(),
    swingTo: new Vector3(),
    target: new Vector3(),
    planted: true,
    contact: 1,
  };
}

/** Continuously-damped pose channels. One number per expressive axis. */
interface PoseChannels {
  /** Forward pitch of the torso, radians. */
  lean: number;
  /** Bank into a turn, radians. */
  roll: number;
  /** Shoulder counter-rotation against the hips, radians. */
  twist: number;
  /** Hip height offset from the rest pelvis, metres. Negative = crouched. */
  hipDrop: number;
  /** Hip offset along the character's forward axis. */
  hipPush: number;
  /** Hip lateral offset. */
  hipSlide: number;
  /** How much the arms are held wide (grind balance) vs tucked (dash). */
  armSpread: number;
  /** Arm carriage height — up for running, back for a dash. */
  armDrive: number;
  /** Head pitch relative to the chest. Kept level against the lean. */
  headPitch: number;
  headYaw: number;
  /** Cloth trail, driven by speed and vertical motion. */
  clothBack: number;
  /** 0 = full leg cycle, 1 = high-speed skate. */
  hyper: number;
  /** 0 = legs cycling, 1 = legs held in a fixed mode pose (air, grind, slide). */
  legHold: number;
}

export interface CharacterRigOptions {
  /** Jersey colour. Defaults to the player's identity from the palette. */
  primary?: number;
  /** Helmet / trim colour. */
  accent?: number;
  name?: string;
}

export class CharacterRig {
  readonly object: Object3D;

  private readonly skel: CharacterSkeleton;
  private readonly meshes: CharacterMeshSet;

  private readonly feet: [FootTrack, FootTrack] = [makeFootTrack(), makeFootTrack()];
  private readonly armState: [LimbSolverState, LimbSolverState] = [makeLimbState(), makeLimbState()];
  private readonly legState: [LimbSolverState, LimbSolverState] = [makeLimbState(), makeLimbState()];
  private readonly ikResult: TwoBoneResult = makeTwoBoneResult();

  /** Rig-space hand targets, damped. */
  private readonly handTarget: [Vector3, Vector3] = [new Vector3(), new Vector3()];

  private readonly pose: PoseChannels = {
    lean: 0, roll: 0, twist: 0,
    hipDrop: 0, hipPush: 0, hipSlide: 0,
    armSpread: 0, armDrive: 0,
    headPitch: 0, headYaw: 0,
    clothBack: 0, hyper: 0, legHold: 0,
  };

  /** Gait cycle position, in cycles. One cycle is two steps. */
  private gaitPhase = 0;
  /** Live cadence, cycles per second. */
  private cycleRate = 0;

  private lastMode: MoveMode = MoveMode.Grounded;
  private footBlend = 0;
  private lastFacing = 0;
  /** Damped turn rate, rad/s, for the bank. */
  private turnRate = 0;

  /** World transform of the rig node, kept so world↔rig conversion is allocation-free. */
  private readonly rigPos = new Vector3();
  private readonly rigRot = new Quaternion();
  private readonly rigRotInv = new Quaternion();

  constructor(opts: CharacterRigOptions = {}) {
    this.skel = new CharacterSkeleton();

    const primary = opts.primary ?? RIDER_COLORS[0].jersey.getHex();
    const accent = opts.accent ?? RIDER_COLORS[0].accent.getHex();

    this.meshes = buildCharacterMeshes(this.skel, {
      jersey: primary,
      accent,
      name: opts.name ?? 'player',
    });

    const group = new Group();
    group.name = 'character';
    // The skeleton root must be a child of the same node the meshes are under,
    // or the skinning matrices resolve against a different parent transform.
    group.add(this.skel.root);
    group.add(this.meshes.group);
    this.object = group;

    // Seed both feet planted under the hips so frame one is not a lunge.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      this.feet[i].plant.set(side * STANCE.halfWidth, 0, STANCE.footAhead);
      this.feet[i].liftFrom.copy(this.feet[i].plant);
      this.feet[i].swingTo.copy(this.feet[i].plant);
      this.feet[i].target.set(side * STANCE.halfWidth, LIMB.ankleLift, STANCE.footAhead);
    }
  }

  setColors(primary: number, accent: number): void {
    applyCharacterColors(this.meshes, primary, accent);
  }

  handWorld(side: 'left' | 'right', out: Vector3): Vector3 {
    const bone = this.skel.bone(side === 'left' ? 'handL' : 'handR');
    return out.setFromMatrixPosition(bone.matrixWorld);
  }

  dispose(): void {
    for (const m of this.meshes.owned) m.dispose();
    for (const m of this.meshes.meshes) m.geometry.dispose();
    this.skel.dispose();
    this.object.parent?.remove(this.object);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Update
  // ───────────────────────────────────────────────────────────────────────────

  update(state: PlayerState, dt: number, time: number): void {
    if (dt <= 0) return;

    this.placeRigNode(state, dt);
    this.driveChannels(state, dt);
    this.advanceGait(state, dt);
    this.resolveFeet(state, dt);
    this.resolveHands(state, dt, time);
    this.buildPose(state, dt);
    this.writeBones();

    this.lastMode = state.mode;
    this.lastFacing = state.facing;
  }

  /**
   * Place the rig node at the feet, facing the character's yaw, uprighted onto
   * `alignedUp`.
   *
   * `alignedUp` is ALREADY slerped by the physics — this must not re-derive it
   * from `groundNormal`. Assigning the raw floor normal is the documented cause
   * of the jitter, and doing it here would reintroduce it one layer further out
   * where it looks like a rendering bug instead of a physics one.
   */
  private placeRigNode(state: PlayerState, dt: number): void {
    this.rigPos.copy(state.position);

    // Forward from the facing yaw, then made perpendicular to the aligned up so
    // the character stands on the slope rather than leaning through it.
    _fwd.set(Math.sin(state.facing), 0, Math.cos(state.facing));
    _up.copy(state.alignedUp);
    if (_up.lengthSq() < 1e-8) _up.copy(_WORLD_UP);
    else _up.normalize();

    _fwd.addScaledVector(_up, -_fwd.dot(_up));
    if (_fwd.lengthSq() < 1e-8) {
      // Facing is parallel to up (a vertical wall run). Fall back to any
      // perpendicular so the basis never degenerates.
      _fwd.set(0, 0, 1).addScaledVector(_up, -_up.z);
      if (_fwd.lengthSq() < 1e-8) _fwd.set(1, 0, 0).addScaledVector(_up, -_up.x);
    }
    _fwd.normalize();
    // Rig +X is to the LEFT, so the side axis is up × forward.
    _side.crossVectors(_up, _fwd).normalize();

    _m.makeBasis(_side, _up, _fwd);
    this.rigRot.setFromRotationMatrix(_m);
    this.rigRotInv.copy(this.rigRot).invert();

    this.object.position.copy(this.rigPos);
    this.object.quaternion.copy(this.rigRot);

    // Turn rate, for banking. Damped because a single step's facing delta at
    // 120 Hz is far too noisy to drive a visible lean.
    let d = state.facing - this.lastFacing;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.turnRate = dampHL(this.turnRate, d / dt, 0.10, dt);
  }

  /** Convert a world point into rig space. Allocation-free. */
  private toRig(world: Vector3, out: Vector3): Vector3 {
    out.subVectors(world, this.rigPos);
    return out.applyQuaternion(this.rigRotInv);
  }

  /** Convert a rig-space point into world space. Allocation-free. */
  private toWorld(rig: Vector3, out: Vector3): Vector3 {
    out.copy(rig).applyQuaternion(this.rigRot);
    return out.add(this.rigPos);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pose channels
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Decide what every expressive axis WANTS to be this frame, then damp toward
   * it. Damping here is what makes mode changes cross-fades instead of cuts —
   * there is deliberately no explicit blend tree, because every channel
   * converging at its own rate reads better than one global blend weight.
   */
  private driveChannels(state: PlayerState, dt: number): void {
    const p = this.pose;
    const speed = state.groundSpeed;
    const speed01 = clamp01(speed / RUN.max);
    const hyper = smoothstep(HYPER_LO, HYPER_HI, speed);

    let lean = 0;
    let roll = clamp(-this.turnRate * 0.13, -0.5, 0.5) * (0.35 + 0.65 * speed01);
    let twist = 0;
    let hipDrop = 0;
    let hipPush = 0;
    let hipSlide = 0;
    let armSpread = 0;
    let armDrive = 0;
    let headPitch = 0;
    let legHold = 0;

    switch (state.mode) {
      case MoveMode.Grounded:
        // Lean grows with speed and with how hard the character is accelerating
        // into the hill. This is the pose doing the job of a speedometer.
        lean = 0.14 + 0.62 * speed01 + state.gradient * 0.25;
        hipDrop = -0.02 - 0.10 * speed01;
        armDrive = 1;
        twist = 0.16 * speed01;
        legHold = 0;
        break;

      case MoveMode.Airborne: {
        // Rising reads as a tuck, falling as a reach for the ground.
        const rising = clamp01(state.velocity.y / 12);
        const falling = clamp01(-state.velocity.y / 18);
        lean = 0.10 + 0.30 * speed01 - 0.22 * falling;
        hipDrop = -0.16 * rising;
        armSpread = 0.35 + 0.45 * falling;
        armDrive = 0.2;
        legHold = 1;
        roll *= 0.6;
        break;
      }

      case MoveMode.Dashing:
        // Committed and streamlined: hips forward, arms swept back, head low.
        lean = 0.86;
        hipDrop = -0.13;
        hipPush = 0.10;
        armSpread = -0.55;
        armDrive = -0.9;
        headPitch = -0.16;
        legHold = 1;
        break;

      case MoveMode.Homing:
        // A committed spin toward the target. Curled tight.
        lean = 1.15;
        hipDrop = -0.28;
        armSpread = -0.8;
        armDrive = -0.4;
        legHold = 1;
        break;

      case MoveMode.Diving:
        // Head down, legs trailing straight. The silhouette of an arrow.
        lean = 1.35;
        hipDrop = -0.05;
        armSpread = -0.7;
        armDrive = -1;
        headPitch = 0.30;
        legHold = 1;
        break;

      case MoveMode.WallRun:
        // The rig node is already rolled onto the wall by `alignedUp`, so the
        // pose only has to supply the inward reach and a running carriage.
        lean = 0.30 + 0.35 * speed01;
        armSpread = 0.30;
        armDrive = 0.8;
        legHold = 0;
        roll = 0;
        break;

      case MoveMode.Grinding:
        // Low and wide: knees soft, arms out as a balance pole.
        lean = 0.22 + 0.30 * speed01;
        hipDrop = -0.22;
        armSpread = 1;
        armDrive = 0.1;
        twist = 0.10;
        legHold = 1;
        break;

      case MoveMode.Sliding:
        lean = 0.50;
        hipDrop = -0.52;
        hipPush = -0.10;
        armSpread = 0.55;
        armDrive = -0.2;
        legHold = 1;
        break;

      case MoveMode.Hurt: {
        // Recoil away from the hit. `hurtDirection` is world, so it has to come
        // into rig space before it can mean "backwards" to the pose.
        this.toRigDirection(state.hurtDirection, _v3);
        lean = -0.38 + _v3.z * 0.30;
        hipDrop = -0.14;
        hipSlide = clamp(_v3.x * 0.10, -0.12, 0.12);
        armSpread = 0.85;
        armDrive = -0.3;
        headPitch = -0.25;
        legHold = 1;
        break;
      }

      case MoveMode.Finished:
        lean = 0.10 + 0.35 * speed01;
        armDrive = 0.9;
        legHold = 0;
        break;
    }

    // A hard landing folds the character down for a moment. `landingImpact` is
    // only valid on the step it lands, so it is fed in as an impulse the damping
    // then carries — reading it as a level would flicker.
    if (state.landedThisStep) {
      hipDrop -= 0.30 * state.landingImpact;
      lean += 0.25 * state.landingImpact;
    }

    // At the top of the speed range the run becomes a skate: hips lower, lean
    // deeper, legs mostly held. See the header.
    lean = lerp(lean, lean + 0.30, hyper);
    hipDrop = lerp(hipDrop, hipDrop - 0.10, hyper);

    p.lean = dampHL(p.lean, lean, HL.lean, dt);
    p.roll = dampHL(p.roll, roll, HL.roll, dt);
    p.twist = dampHL(p.twist, twist, HL.arm, dt);
    p.hipDrop = dampHL(p.hipDrop, hipDrop, HL.pelvis, dt);
    p.hipPush = dampHL(p.hipPush, hipPush, HL.pelvis, dt);
    p.hipSlide = dampHL(p.hipSlide, hipSlide, HL.pelvis, dt);
    p.armSpread = dampHL(p.armSpread, armSpread, HL.arm, dt);
    p.armDrive = dampHL(p.armDrive, armDrive, HL.arm, dt);
    // The head stays level against the torso lean — a character that pitches its
    // eyeline into the dirt at speed reads as unconscious, not as fast.
    p.headPitch = dampHL(p.headPitch, headPitch - p.lean * 0.55, HL.head, dt);
    p.headYaw = dampHL(p.headYaw, clamp(-this.turnRate * 0.10, -0.4, 0.4), HL.head, dt);
    p.clothBack = dampHL(p.clothBack, speed01 * 0.9 + clamp01(-state.velocity.y / 30) * 0.4, HL.cloth, dt);
    p.hyper = dampHL(p.hyper, hyper, 0.16, dt);
    p.legHold = dampHL(p.legHold, legHold, 0.10, dt);
  }

  /** Rotate a world DIRECTION into rig space (no translation). */
  private toRigDirection(world: Vector3, out: Vector3): Vector3 {
    return out.copy(world).applyQuaternion(this.rigRotInv);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Gait
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Advance the gait cycle by DISTANCE TRAVELLED, not by elapsed time.
   *
   * This is the whole reason the feet stay planted. If the cycle advanced on a
   * clock, then the moment speed changed, the rate the foot cycles at and the
   * rate the ground passes under it would disagree, and the support foot would
   * skate by exactly that difference. Driving the phase from distance makes the
   * two rates the same quantity by construction.
   */
  private advanceGait(state: PlayerState, dt: number): void {
    const speed = state.groundSpeed;
    const stride = clamp(
      GAIT.strideBase + speed * GAIT.stridePerSpeed,
      GAIT.strideBase,
      GAIT.strideMax,
    );

    // Two steps per cycle, so a cycle covers two strides.
    let rate = speed / (stride * 2);
    const maxRate = GAIT.cadenceMax / 2;
    if (rate > maxRate) rate = maxRate;

    const cycles = state.mode === MoveMode.Grounded || state.mode === MoveMode.WallRun
      || state.mode === MoveMode.Finished ? rate : 0;

    this.cycleRate = dampHL(this.cycleRate, cycles, 0.08, dt);
    this.gaitPhase += this.cycleRate * dt;
    if (this.gaitPhase >= 1) this.gaitPhase -= Math.floor(this.gaitPhase);

    this.stride = stride;

    if (state.mode !== this.lastMode) this.footBlend = FOOT_BLEND;
    else if (this.footBlend > 0) this.footBlend = Math.max(0, this.footBlend - dt);
  }

  private stride: number = GAIT.strideBase;

  /**
   * Resolve both feet to rig-space targets.
   *
   * A foot in stance is pinned to a world point captured at touchdown; a foot in
   * swing arcs from where it lifted to where it will next plant. The plant point
   * is projected onto the plane through the character's feet with the ground
   * normal, which is the only ground information the rig contract gives it — and
   * is exactly right for the slope the physics just resolved against.
   */
  private resolveFeet(state: PlayerState, dt: number): void {
    const holdBlend = clamp01(this.pose.legHold);

    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      const sideSign = i === 0 ? 1 : -1;
      const fp = frac(this.gaitPhase + (i === 0 ? 0 : 0.5));
      const inStance = fp < GAIT.duty;

      if (holdBlend < 0.999) {
        if (inStance) {
          if (!foot.planted) {
            // Touchdown. Pin the foot where the swing was heading.
            foot.plant.copy(foot.swingTo);
            foot.planted = true;
          }
          foot.contact = 1;
          this.toRig(foot.plant, _v0);
          // Keep the pinned foot at ankle height above the contact plane.
          _v0.y = Math.max(_v0.y, 0) + LIMB.ankleLift;
        } else {
          if (foot.planted) {
            // Lift-off. Record where we left and choose the next plant point.
            foot.liftFrom.copy(foot.plant);
            foot.planted = false;
            this.chooseNextPlant(state, sideSign, foot.swingTo);
          }
          const t = clamp01((fp - GAIT.duty) / (1 - GAIT.duty));
          // Swing: lerp the ground track, add a sine arc for the lift.
          this.toRig(foot.liftFrom, _v1);
          this.toRig(foot.swingTo, _v2);
          _v0.lerpVectors(_v1, _v2, smoothstep(0, 1, t));
          const lift = GAIT.swingLift * Math.sin(Math.PI * t) * (1 - this.pose.hyper * 0.55);
          _v0.y = Math.max(_v0.y, 0) + LIMB.ankleLift + lift;
          foot.contact = 0;
        }
      } else {
        _v0.set(sideSign * STANCE.halfWidth, LIMB.ankleLift, STANCE.footAhead);
        foot.contact = 0;
      }

      // Held poses (air, grind, slide, dash) place the feet directly in rig
      // space rather than from the gait.
      if (holdBlend > 0.001) {
        this.heldFootPose(state, i, sideSign, _v1);
        _v0.lerp(_v1, holdBlend);
        if (holdBlend > 0.999) {
          // While fully held the gait is not tracking the world, so re-pin the
          // plant to the live foot position. Without this, dropping back into a
          // run would snap the first stance foot to wherever it was pinned
          // before the character left the ground.
          this.toWorld(_v0, foot.plant);
          foot.swingTo.copy(foot.plant);
          foot.liftFrom.copy(foot.plant);
          foot.planted = inStance;
        }
      }

      if (this.footBlend > 0) {
        const k = 1 - Math.pow(0.001, dt / Math.max(this.footBlend, 1e-4));
        foot.target.lerp(_v0, k);
      } else {
        foot.target.copy(_v0);
      }
    }
  }

  /**
   * Where the next footfall goes, in WORLD space.
   *
   * Ahead of the hips along travel, inboard of the hip line (a runner's feet are
   * not under their hips — that is what makes a run read as a run and not as a
   * waddle), and projected onto the contact plane.
   */
  private chooseNextPlant(state: PlayerState, sideSign: number, out: Vector3): void {
    const ahead = this.stride * GAIT.plantAhead;
    // Narrow the stance as speed rises; sprinters run nearly on a single line.
    const half = STANCE.halfWidth * lerp(1, 0.35, clamp01(state.groundSpeed / RUN.max));

    _v3.set(sideSign * half, 0, ahead);
    this.toWorld(_v3, out);

    // Project onto the plane through the feet with the ground normal.
    _up.copy(state.groundNormal);
    if (_up.lengthSq() < 1e-8) _up.copy(_WORLD_UP);
    else _up.normalize();
    _v3.subVectors(out, state.position);
    const d = _v3.dot(_up);
    out.addScaledVector(_up, -d);
  }

  /** Rig-space foot placement for the modes that hold a pose rather than cycle. */
  private heldFootPose(state: PlayerState, i: number, sideSign: number, out: Vector3): void {
    const half = STANCE.halfWidth;
    switch (state.mode) {
      case MoveMode.Airborne: {
        const rising = clamp01(state.velocity.y / 12);
        const falling = clamp01(-state.velocity.y / 18);
        // Tuck on the way up, reach on the way down, split slightly so the
        // silhouette is not two legs welded together.
        const tuck = lerp(0.34, 0.06, falling) + 0.20 * rising;
        out.set(sideSign * half * 1.1, LIMB.ankleLift + tuck, 0.16 - 0.34 * tuck + (i === 0 ? 0.10 : -0.10));
        break;
      }
      case MoveMode.Dashing:
      case MoveMode.Homing:
        out.set(sideSign * half * 0.8, LIMB.ankleLift + 0.30, -0.30 + (i === 0 ? 0.14 : -0.14));
        break;
      case MoveMode.Diving:
        out.set(sideSign * half * 0.7, LIMB.ankleLift + 0.10, -0.46);
        break;
      case MoveMode.Grinding:
        // Feet along the rail, staggered — the balance stance.
        out.set(sideSign * half * 0.45, LIMB.ankleLift, i === 0 ? 0.30 : -0.24);
        break;
      case MoveMode.Sliding:
        // Lead leg extended, trailing leg folded under.
        out.set(
          sideSign * half * 0.9,
          LIMB.ankleLift + (i === 0 ? 0.02 : 0.22),
          i === 0 ? 0.62 : -0.16,
        );
        break;
      case MoveMode.Hurt:
        out.set(sideSign * half * 1.3, LIMB.ankleLift + 0.16, -0.10 + (i === 0 ? 0.08 : -0.08));
        break;
      default:
        out.set(sideSign * half, LIMB.ankleLift, STANCE.footAhead);
        break;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Arms
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Rig-space hand targets: a running carriage counter-phased against the legs,
   * pulled toward whatever the current mode wants, then overridden by an attack
   * if one is active.
   */
  private resolveHands(state: PlayerState, dt: number, time: number): void {
    const p = this.pose;

    for (let i = 0; i < 2; i++) {
      const sideSign = i === 0 ? 1 : -1;
      const rest = i === 0 ? REST.anchors.handL : REST.anchors.handR;

      // Counter-phase: the left arm drives with the right leg.
      const ph = frac(this.gaitPhase + (i === 0 ? 0.5 : 0)) * Math.PI * 2;
      const swing = Math.sin(ph);

      _v0.copy(rest);
      // Drive: forward/back swing and the matching vertical.
      const drive = p.armDrive * (1 - p.hyper * 0.5);
      _v0.z += swing * 0.26 * drive;
      _v0.y += (Math.cos(ph) * 0.5 + 0.5) * 0.09 * Math.abs(drive) - 0.02;

      // Spread: positive opens the arms out for balance, negative sweeps them
      // back along the body for a dash.
      _v0.x += sideSign * p.armSpread * 0.34;
      _v0.z -= clamp01(-p.armSpread) * 0.42;
      _v0.y += clamp01(p.armSpread) * 0.10;

      // Sweep back and down at extreme speed regardless of mode.
      _v0.z -= p.hyper * 0.30;
      _v0.x += sideSign * p.hyper * 0.10;

      if (state.mode === MoveMode.WallRun) {
        // The inside hand reaches for the wall. `wallNormal` points away from
        // the face, so the reach is along its negation, in rig space.
        this.toRigDirection(state.wallNormal, _v3);
        const inside = _v3.x < 0 ? 0 : 1;
        if (i === inside) {
          _v0.x -= _v3.x * 0.30;
          _v0.z += 0.24;
          _v0.y += 0.16;
        }
      }

      this.applyAttackPose(state, i, _v0, time);

      this.handTarget[i].x = dampHL(this.handTarget[i].x, _v0.x, HL.arm, dt);
      this.handTarget[i].y = dampHL(this.handTarget[i].y, _v0.y, HL.arm, dt);
      this.handTarget[i].z = dampHL(this.handTarget[i].z, _v0.z, HL.arm, dt);
    }
  }

  /**
   * Layer the active attack over the arm carriage.
   *
   * `attack.phase` runs 0..1 across the swing, so the strike is authored as a
   * wind-up into an extension and the phase drives it directly — there is no
   * separate animation clock to fall out of sync with the hitbox the combat
   * system is testing.
   */
  private applyAttackPose(state: PlayerState, i: number, target: Vector3, time: number): void {
    const a = state.attack;
    if (a.kind === AttackKind.None) return;

    // Alternate which arm leads with the combo count, so a chain does not
    // replay the identical swing three times.
    const lead = a.combo % 2;
    const isLead = i === lead;
    const ph = clamp01(a.phase);
    // Wind-up (0..0.3) pulls back, strike (0.3..0.6) extends, recover eases home.
    const windup = smoothstep(0, 0.30, ph) * (1 - smoothstep(0.30, 0.55, ph));
    const strike = smoothstep(0.28, 0.52, ph) * (1 - smoothstep(0.62, 1, ph));

    const sideSign = i === 0 ? 1 : -1;
    const w = isLead ? 1 : 0.35;

    target.z += (-0.30 * windup + 0.62 * strike) * w;
    target.x += sideSign * (0.18 * windup - 0.20 * strike) * w;
    target.y += (0.16 * windup - 0.06 * strike) * w;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pose assembly
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Build every bone's rig-space position, then derive its rotation.
   *
   * Positions first, rotations after, because the skeleton binds with identity
   * local rotations: once a bone and its aim child both have rig-space
   * positions, the bone's orientation is fully determined by `alignFrames`
   * against the rest frame, and there is no accumulated Euler state anywhere to
   * drift.
   */
  private buildPose(state: PlayerState, dt: number): void {
    const p = this.pose;
    const B = BONE_INDEX;

    // ── Pelvis ───────────────────────────────────────────────────────────────
    // Bob is at twice the cycle rate: the hips rise and fall once per STEP, and
    // there are two steps in a cycle.
    const bob = Math.sin(this.gaitPhase * Math.PI * 4) * GAIT.bob
      * (1 - p.legHold) * (1 - p.hyper * 0.7);

    _rigPos[B.pelvis].copy(REST.pos[B.pelvis]);
    _rigPos[B.pelvis].y += p.hipDrop + bob;
    _rigPos[B.pelvis].z += p.hipPush;
    _rigPos[B.pelvis].x += p.hipSlide;

    // Pelvis orientation: the lean is shared with the spine, the hips take a
    // fraction of it plus the counter-twist against the shoulders.
    _q0.setFromAxisAngle(_AXIS_X, p.lean * 0.28);
    _q1.setFromAxisAngle(_AXIS_Z, p.roll * 0.45);
    _q0.multiply(_q1);
    _q1.setFromAxisAngle(_AXIS_Y, -p.twist * 0.6);
    _q0.multiply(_q1);
    _rigRot[B.pelvis].copy(_q0);

    // ── Spine ────────────────────────────────────────────────────────────────
    // The remaining lean/roll/twist is distributed evenly over the three spine
    // segments, so the bend is a curve rather than a hinge at the waist.
    _qStep.setFromAxisAngle(_AXIS_X, p.lean * 0.24);
    _q1.setFromAxisAngle(_AXIS_Z, p.roll * 0.22);
    _qStep.multiply(_q1);
    _q1.setFromAxisAngle(_AXIS_Y, p.twist * 0.55);
    _qStep.multiply(_q1);

    _qAcc.copy(_rigRot[B.pelvis]);
    const spine: BoneName[] = _SPINE_CHAIN;
    for (let k = 0; k < spine.length; k++) {
      const b = BONE_INDEX[spine[k]];
      _qAcc.multiply(_qStep);
      _rigRot[b].copy(_qAcc);
      _rigPos[b].copy(REST.offset[b]).applyQuaternion(_rigRot[REST.parents[b]]);
      _rigPos[b].add(_rigPos[REST.parents[b]]);
    }

    // ── Neck and head ────────────────────────────────────────────────────────
    _q0.setFromAxisAngle(_AXIS_X, p.headPitch * 0.4);
    _q1.setFromAxisAngle(_AXIS_Y, p.headYaw * 0.4);
    _q0.multiply(_q1);
    _rigRot[B.neck].copy(_rigRot[B.chest]).multiply(_q0);
    _rigPos[B.neck].copy(REST.offset[B.neck]).applyQuaternion(_rigRot[B.chest]).add(_rigPos[B.chest]);

    _q0.setFromAxisAngle(_AXIS_X, p.headPitch * 0.6);
    _q1.setFromAxisAngle(_AXIS_Y, p.headYaw * 0.6);
    _q0.multiply(_q1);
    _rigRot[B.head].copy(_rigRot[B.neck]).multiply(_q0);
    _rigPos[B.head].copy(REST.offset[B.head]).applyQuaternion(_rigRot[B.neck]).add(_rigPos[B.neck]);

    _rigRot[B.headEnd].copy(_rigRot[B.head]);
    _rigPos[B.headEnd].copy(REST.offset[B.headEnd]).applyQuaternion(_rigRot[B.head]).add(_rigPos[B.head]);

    // ── Clavicles ────────────────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const clav = i === 0 ? B.clavL : B.clavR;
      _rigRot[clav].copy(_rigRot[B.chest]);
      _rigPos[clav].copy(REST.offset[clav]).applyQuaternion(_rigRot[B.chest]).add(_rigPos[B.chest]);

      const upper = i === 0 ? B.upperArmL : B.upperArmR;
      _rigPos[upper].copy(REST.offset[upper]).applyQuaternion(_rigRot[clav]).add(_rigPos[clav]);
    }

    // ── Arms ─────────────────────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const upper = i === 0 ? B.upperArmL : B.upperArmR;
      const fore = i === 0 ? B.forearmL : B.forearmR;
      const hand = i === 0 ? B.handL : B.handR;
      const handEnd = i === 0 ? B.handEndL : B.handEndR;
      const restBend = i === 0 ? REST.bend.armL : REST.bend.armR;

      // Pole follows the rest bend plane, rotated with the chest so the elbow
      // stays behind the arm as the torso twists.
      _pole.copy(restBend).applyQuaternion(_rigRot[B.chest]);

      solveTwoBone(
        _rigPos[upper], this.handTarget[i], _pole,
        ARM, this.armState[i], dt, this.ikResult,
      );
      _rigPos[fore].copy(this.ikResult.mid);
      _rigPos[hand].copy(this.ikResult.end);

      _v0.subVectors(_rigPos[hand], _rigPos[fore]);
      if (_v0.lengthSq() < 1e-10) _v0.set(0, -1, 0);
      else _v0.normalize();
      _rigPos[handEnd].copy(_rigPos[hand]).addScaledVector(_v0, REST.length[hand]);

      this.orientChain(upper, fore, this.armState[i].bendDir);
      this.orientChain(fore, hand, this.armState[i].bendDir);
      this.orientChain(hand, handEnd, this.armState[i].bendDir);
      _rigRot[handEnd].copy(_rigRot[hand]);
    }

    // ── Legs ─────────────────────────────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const thigh = i === 0 ? B.thighL : B.thighR;
      const shin = i === 0 ? B.shinL : B.shinR;
      const foot = i === 0 ? B.footL : B.footR;
      const toe = i === 0 ? B.toeL : B.toeR;
      const restBend = i === 0 ? REST.bend.legL : REST.bend.legR;

      _rigPos[thigh].copy(REST.offset[thigh]).applyQuaternion(_rigRot[B.pelvis]).add(_rigPos[B.pelvis]);

      _pole.copy(restBend).applyQuaternion(_rigRot[B.pelvis]);

      solveTwoBone(
        _rigPos[thigh], this.feet[i].target, _pole,
        LEG, this.legState[i], dt, this.ikResult,
      );
      _rigPos[shin].copy(this.ikResult.mid);
      _rigPos[foot].copy(this.ikResult.end);

      this.orientChain(thigh, shin, this.legState[i].bendDir);
      this.orientChain(shin, foot, this.legState[i].bendDir);

      // The foot is oriented to the GROUND, not to the shin. The rest foot is
      // level and the ground plane in rig space is level by construction, so a
      // planted foot's rotation is identity plus the ankle flex — which is
      // exactly the property that keeps the sole from shearing into the slope.
      const contact = this.feet[i].contact;
      const flex = lerp(-0.34, 0.06, contact) * (1 - this.pose.legHold)
        + this.heldAnkleFlex(state) * this.pose.legHold;
      _q0.setFromAxisAngle(_AXIS_X, flex);
      _rigRot[foot].copy(_q0);

      _rigPos[toe].copy(REST.offset[toe]).applyQuaternion(_rigRot[foot]).add(_rigPos[foot]);
      _rigRot[toe].copy(_rigRot[foot]);
    }

    // ── Cloth ────────────────────────────────────────────────────────────────
    // Hem and shorts trail behind the motion. This is the cheapest thing in the
    // rig and does more for "this is a character, not a figurine" than anything
    // else in it.
    _q0.setFromAxisAngle(_AXIS_X, -p.clothBack * 0.45);
    _rigRot[B.hem].copy(_rigRot[B.spine1]).multiply(_q0);
    _rigPos[B.hem].copy(REST.offset[B.hem]).applyQuaternion(_rigRot[B.spine1]).add(_rigPos[B.spine1]);

    for (let i = 0; i < 2; i++) {
      const shorts = i === 0 ? B.shortsL : B.shortsR;
      const thigh = i === 0 ? B.thighL : B.thighR;
      _q0.setFromAxisAngle(_AXIS_X, -p.clothBack * 0.22);
      _rigRot[shorts].copy(_rigRot[thigh]).multiply(_q0);
      _rigPos[shorts].copy(REST.offset[shorts]).applyQuaternion(_rigRot[thigh]).add(_rigPos[thigh]);
    }
  }

  /** Ankle flex for the modes that hold a leg pose. */
  private heldAnkleFlex(state: PlayerState): number {
    switch (state.mode) {
      case MoveMode.Diving: return -0.55;
      case MoveMode.Dashing:
      case MoveMode.Homing: return -0.40;
      case MoveMode.Grinding: return 0.05;
      case MoveMode.Sliding: return -0.20;
      default: return -0.18;
    }
  }

  /**
   * Orient `bone` so its rest direction points at `child`'s solved position.
   *
   * `sideRef` is the limb's live bend direction, which keeps the bone's roll in
   * the same plane the IK solved in — without it the upper arm and forearm can
   * satisfy the same positions with different twists and the elbow visibly
   * corkscrews between frames.
   */
  private orientChain(bone: number, child: number, sideRef: Vector3): void {
    _v1.subVectors(_rigPos[child], _rigPos[bone]);
    if (_v1.lengthSq() < 1e-10) {
      _rigRot[bone].copy(_rigRot[REST.parents[bone] >= 0 ? REST.parents[bone] : bone]);
      return;
    }
    _v1.normalize();
    _v2.copy(sideRef);
    // Make the side reference perpendicular to the new direction.
    _v2.addScaledVector(_v1, -_v2.dot(_v1));
    if (_v2.lengthSq() < 1e-10) {
      _v2.set(1, 0, 0).addScaledVector(_v1, -_v1.x);
      if (_v2.lengthSq() < 1e-10) _v2.set(0, 0, 1).addScaledVector(_v1, -_v1.z);
    }
    _v2.normalize();
    alignFrames(REST.dir[bone], REST.side[bone], _v1, _v2, _rigRot[bone]);
  }

  /**
   * Push the rig-space pose onto the Bone objects as LOCAL rotations.
   *
   * Only the pelvis translates; every other bone keeps its rest offset, which is
   * what makes the skeleton rigid-length and stops the character's proportions
   * breathing with the pose.
   */
  private writeBones(): void {
    const B = BONE_INDEX;
    const pelvis = this.skel.bones[B.pelvis];
    pelvis.position.copy(_rigPos[B.pelvis]);
    pelvis.quaternion.copy(_rigRot[B.pelvis]);

    for (let i = 0; i < BONE_COUNT; i++) {
      if (i === B.pelvis) continue;
      const parent = REST.parents[i];
      const bone = this.skel.bones[i];
      if (parent < 0) {
        bone.quaternion.copy(_rigRot[i]);
        continue;
      }
      toLocalRotation(_rigRot[i], _rigRot[parent], bone.quaternion);
    }

    this.skel.root.updateMatrixWorld(true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-scope constants used by the pose builder
// ─────────────────────────────────────────────────────────────────────────────

const _AXIS_X = new Vector3(1, 0, 0);
const _AXIS_Y = new Vector3(0, 1, 0);
const _AXIS_Z = new Vector3(0, 0, 1);
const _SPINE_CHAIN: BoneName[] = ['spine1', 'spine2', 'chest'];

function frac(v: number): number {
  return v - Math.floor(v);
}

/** Factory, matching the project's `createX` convention. */
export function createCharacterRig(opts: CharacterRigOptions = {}): CharacterRig {
  return new CharacterRig(opts);
}
