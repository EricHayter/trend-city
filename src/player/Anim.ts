import { Object3D, Vector3, Quaternion, Euler, MathUtils } from 'three';
import { Rig, Bones } from './Rig';
import { angleDamp, damp, clamp, clamp01, lerp, TAU, smoothstep } from '../core/MathX';

export type AnimState =
  | 'idle' | 'run' | 'sprint' | 'brake' | 'jump' | 'double' | 'fall' | 'airDash' | 'dash'
  | 'homing' | 'melee1' | 'melee2' | 'melee3' | 'aerial' | 'wallRun' | 'wallJump' | 'grind'
  | 'slide' | 'boost' | 'land' | 'hardLand' | 'damage' | 'knock' | 'victory' | 'pound';

const THIGH = 0.54;
const SHIN = 0.5;

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();

interface LegTarget { z: number; y: number; x: number; }

/**
 * PROCEDURAL ANIMATION
 * There are no keyframes and no imported clips. Every pose is solved each frame from
 * movement state, and the two rules that keep it from looking like a puppet are:
 *  1. contact preservation: while a foot is planted its local position moves backward
 *     at exactly the body's ground speed, so feet never slide;
 *  2. inertia: nothing snaps. Bones are damped toward targets at per-state rates, so
 *     transitions blend and heavy states resolve more slowly than light ones.
 */
export class Animator {
  state: AnimState = 'idle';
  prevState: AnimState = 'idle';
  stateTime = 0;
  private phase = 0;
  private breath = 0;
  private legL: LegTarget = { z: 0.1, y: -0.98, x: -0.2 };
  private legR: LegTarget = { z: -0.1, y: -0.98, x: 0.2 };
  private plantL = new Vector3();
  private plantR = new Vector3();
  private squash = 1;
  private squashVel = 0;
  private tailAngles: number[] = [];
  private scarfAngles: number[] = [];
  private tailLateral: number[] = [];
  private lean = 0;
  private leanZ = 0;
  private twist = 0;
  private bones: Bones;
  /** Set by the controller: where a hand should be pinned (wall, rail, enemy). */
  handTarget: Vector3 | null = null;
  handSide = 1;

  constructor(private rig: Rig) {
    this.bones = rig.bones;
    for (let i = 0; i < rig.bones.tail.length; i++) { this.tailAngles.push(0); this.tailLateral.push(0); }
    for (let i = 0; i < rig.bones.scarf.length; i++) this.scarfAngles.push(0);
  }

  set(state: AnimState) {
    if (this.state === state) return;
    this.prevState = this.state;
    this.state = state;
    this.stateTime = 0;
  }

  /** Impact impulse: squash the body, which then springs back over ~0.3s. */
  impact(strength: number) {
    this.squashVel -= strength;
  }

  private ik(thigh: Object3D, shin: Object3D, foot: Object3D, target: LegTarget, side: number, rate: number, dt: number) {
    // Solve the two-bone chain in the sagittal plane, then apply a little lateral swing.
    const dz = target.z;
    const dy = target.y;
    let dist = Math.hypot(dz, dy);
    dist = clamp(dist, 0.25, THIGH + SHIN - 0.02);
    const cosKnee = clamp((THIGH * THIGH + SHIN * SHIN - dist * dist) / (2 * THIGH * SHIN), -1, 1);
    const knee = Math.PI - Math.acos(cosKnee);
    const cosHip = clamp((THIGH * THIGH + dist * dist - SHIN * SHIN) / (2 * THIGH * dist), -1, 1);
    const hipToTarget = Math.atan2(dz, -dy);
    const hipPitch = hipToTarget - Math.acos(cosHip);
    thigh.rotation.x = angleDamp(thigh.rotation.x, hipPitch, rate, dt);
    thigh.rotation.z = angleDamp(thigh.rotation.z, -side * target.x * 0.9, rate, dt);
    shin.rotation.x = angleDamp(shin.rotation.x, knee, rate, dt);
    // Ankle keeps the boot roughly flat to the ground plane.
    foot.rotation.x = angleDamp(foot.rotation.x, -(hipPitch + knee) * 0.72, rate * 0.9, dt);
  }

  private arm(upper: Object3D, fore: Object3D, hand: Object3D, ux: number, uz: number, fx: number, hx: number, rate: number, dt: number, uy = 0) {
    upper.rotation.x = angleDamp(upper.rotation.x, ux, rate, dt);
    upper.rotation.z = angleDamp(upper.rotation.z, uz, rate, dt);
    upper.rotation.y = angleDamp(upper.rotation.y, uy, rate, dt);
    fore.rotation.x = angleDamp(fore.rotation.x, fx, rate, dt);
    hand.rotation.x = angleDamp(hand.rotation.x, hx, rate, dt);
  }

  /**
   * @param speed horizontal ground speed
   * @param vertical vertical velocity
   * @param turn signed turn rate, drives banking and scarf whip
   * @param groundNormal used to keep the body upright relative to the surface
   */
  update(dt: number, speed: number, vertical: number, turn: number, grounded: boolean, groundNormal: Vector3, forwardLean: number) {
    this.stateTime += dt;
    this.breath += dt;
    const b = this.bones;
    const st = this.state;

    // Body squash spring: one shared impact channel for landings, attacks and hits.
    const k = 150, d = 15;
    this.squashVel += ((1 - this.squash) * k - this.squashVel * d) * dt;
    this.squash = clamp(this.squash + this.squashVel * dt, 0.62, 1.25);

    const fast = clamp01(speed / 40);
    const rate = st === 'idle' ? 9 : 18 + fast * 10;

    // Torso attitude: lean into speed, bank into turns, twist counter to the legs.
    let leanTarget = forwardLean;
    let leanZTarget = -turn * 0.16;
    let twistTarget = 0;
    let hipY = 0;
    let hipZ = 0;

    const stridePhaseSpeed = speed > 0.6 ? speed / Math.max(1.4, 1.25 + speed * 0.052) : 0;

    switch (st) {
      case 'idle': {
        this.phase += dt * 1.1;
        const bob = Math.sin(this.breath * 1.9) * 0.018;
        hipY = bob;
        leanTarget = 0.04 + Math.sin(this.breath * 1.9) * 0.02;
        twistTarget = Math.sin(this.breath * 0.7) * 0.08;
        this.legL = { z: 0.1, y: -0.94 + bob, x: -0.14 };
        this.legR = { z: -0.08, y: -0.94 + bob, x: 0.16 };
        this.arm(b.armL, b.foreL, b.handL, 0.12, 0.2 + Math.sin(this.breath * 1.9) * 0.03, -0.34, 0.1, 8, dt);
        this.arm(b.armR, b.foreR, b.handR, 0.1, -0.22 - Math.sin(this.breath * 1.9 + 1) * 0.03, -0.3, 0.1, 8, dt);
        b.head.rotation.y = angleDamp(b.head.rotation.y, Math.sin(this.breath * 0.55) * 0.3, 4, dt);
        break;
      }
      case 'run':
      case 'sprint':
      case 'boost': {
        this.phase += dt * stridePhaseSpeed;
        const stride = clamp(1.2 + speed * 0.055, 1.3, 3.1);
        const lift = clamp(0.16 + speed * 0.012, 0.2, 0.46);
        const cycle = this.phase % 1;
        const legPose = (offset: number): LegTarget => {
          const t = (cycle + offset) % 1;
          if (t < 0.5) {
            // Contact: slide the foot backward at exactly body speed. No skating.
            const u = t / 0.5;
            return { z: stride * 0.5 - stride * u, y: -0.99, x: 0 };
          }
          const u = (t - 0.5) / 0.5;
          return { z: -stride * 0.5 + stride * u, y: -0.99 + Math.sin(u * Math.PI) * lift, x: 0 };
        };
        this.legL = legPose(0);
        this.legR = legPose(0.5);
        const swing = Math.sin(cycle * TAU);
        const armAmp = st === 'boost' ? 0.35 : lerp(0.7, 1.25, fast);
        this.arm(b.armL, b.foreL, b.handL, -swing * armAmp, 0.16, -0.5 - Math.abs(swing) * 0.5, 0.1, rate, dt);
        this.arm(b.armR, b.foreR, b.handR, swing * armAmp, -0.16, -0.5 - Math.abs(swing) * 0.5, 0.1, rate, dt);
        hipY = Math.abs(Math.sin(cycle * TAU)) * 0.045 - 0.02;
        twistTarget = -swing * 0.22;
        leanTarget = forwardLean + fast * 0.3 + (st === 'boost' ? 0.22 : 0);
        if (st === 'boost') {
          // Boost: arms swept back, body flattened forward into an arrow.
          this.arm(b.armL, b.foreL, b.handL, 1.5, 0.5, -0.4, 0, 22, dt, -0.3);
          this.arm(b.armR, b.foreR, b.handR, 1.5, -0.5, -0.4, 0, 22, dt, 0.3);
        }
        b.head.rotation.x = angleDamp(b.head.rotation.x, -leanTarget * 0.5, 10, dt);
        b.head.rotation.y = angleDamp(b.head.rotation.y, turn * 0.2, 8, dt);
        break;
      }
      case 'brake': {
        leanTarget = -0.42;
        leanZTarget = -turn * 0.3;
        this.legL = { z: 0.44, y: -0.82, x: -0.2 };
        this.legR = { z: -0.34, y: -0.9, x: 0.24 };
        this.arm(b.armL, b.foreL, b.handL, -1.5, 0.7, -0.7, 0.2, 20, dt);
        this.arm(b.armR, b.foreR, b.handR, -1.3, -0.8, -0.6, 0.2, 20, dt);
        break;
      }
      case 'jump': {
        const t = clamp01(this.stateTime / 0.34);
        leanTarget = 0.16 - t * 0.1;
        this.legL = { z: 0.3 - t * 0.1, y: -0.7 - t * 0.15, x: -0.1 };
        this.legR = { z: -0.18, y: -0.86, x: 0.14 };
        this.arm(b.armL, b.foreL, b.handL, -2.0 + t * 0.9, 0.4, -0.5, 0.1, 24, dt);
        this.arm(b.armR, b.foreR, b.handR, -2.1 + t * 0.9, -0.4, -0.5, 0.1, 24, dt);
        break;
      }
      case 'double': {
        // Full forward roll: the flip is the read, so it drives the whole body.
        const t = clamp01(this.stateTime / 0.42);
        b.hips.rotation.x = angleDamp(b.hips.rotation.x, -TAU * t, 26, dt);
        this.legL = { z: 0.34, y: -0.62, x: -0.12 };
        this.legR = { z: 0.2, y: -0.7, x: 0.14 };
        this.arm(b.armL, b.foreL, b.handL, -2.6, 0.9, -1.3, 0.2, 26, dt);
        this.arm(b.armR, b.foreR, b.handR, -2.6, -0.9, -1.3, 0.2, 26, dt);
        leanTarget = 0;
        break;
      }
      case 'fall': {
        leanTarget = 0.1 + clamp01(-vertical / 60) * 0.24;
        this.legL = { z: 0.22, y: -0.86, x: -0.16 };
        this.legR = { z: -0.2, y: -0.9, x: 0.18 };
        this.arm(b.armL, b.foreL, b.handL, -0.9, 0.6, -0.7, 0.1, 12, dt);
        this.arm(b.armR, b.foreR, b.handR, -0.8, -0.62, -0.66, 0.1, 12, dt);
        break;
      }
      case 'airDash':
      case 'dash': {
        // Stretched arrow pose: one arm forward, trailing leg extended.
        leanTarget = 0.62;
        this.legL = { z: 0.52, y: -0.72, x: -0.1 };
        this.legR = { z: -0.5, y: -0.78, x: 0.1 };
        this.arm(b.armR, b.foreR, b.handR, -2.5, -0.1, -0.1, -0.2, 30, dt, 0.2);
        this.arm(b.armL, b.foreL, b.handL, 1.7, 0.35, -0.3, 0.1, 30, dt);
        twistTarget = 0.2;
        break;
      }
      case 'homing': {
        // Tucked spin. Legs in, arms in, everything reads as a projectile.
        b.hips.rotation.x = angleDamp(b.hips.rotation.x, -TAU * (this.stateTime * 7), 30, dt);
        this.legL = { z: 0.36, y: -0.5, x: -0.1 };
        this.legR = { z: 0.3, y: -0.52, x: 0.1 };
        this.arm(b.armL, b.foreL, b.handL, -2.8, 1.0, -1.7, 0.3, 30, dt);
        this.arm(b.armR, b.foreR, b.handR, -2.8, -1.0, -1.7, 0.3, 30, dt);
        break;
      }
      case 'melee1':
      case 'melee2':
      case 'melee3':
      case 'aerial': {
        const t = clamp01(this.stateTime / 0.26);
        const wind = smoothstep(0, 0.28, t);
        const strike = smoothstep(0.2, 0.58, t);
        const settle = smoothstep(0.6, 1, t);
        const side = st === 'melee2' ? -1 : 1;
        twistTarget = side * (0.5 - strike * 1.2 + settle * 0.3);
        leanTarget = 0.2 + strike * 0.24 - settle * 0.16;
        if (st === 'melee3' || st === 'aerial') {
          // Finisher: spinning kick, the leg leads and the arms counterweight.
          this.legL = { z: 0.2 - strike * 0.1, y: -0.9, x: -0.1 };
          this.legR = { z: -0.3 + strike * 1.1, y: -0.86 + strike * 0.5, x: 0.1 };
          b.hips.rotation.y = angleDamp(b.hips.rotation.y, side * strike * 1.5, 30, dt);
          this.arm(b.armL, b.foreL, b.handL, -1.6, 1.0, -1.0, 0.2, 30, dt);
          this.arm(b.armR, b.foreR, b.handR, -1.2, -1.1, -0.9, 0.2, 30, dt);
        } else {
          const lead = side > 0 ? b : b;
          const upper = side > 0 ? -2.6 * strike + 1.0 * wind : -2.4 * strike + 0.9 * wind;
          if (side > 0) {
            this.arm(b.armR, b.foreR, b.handR, upper, -0.2 + strike * 0.5, -1.4 + strike * 1.3, -0.3 + strike * 0.4, 34, dt, -0.4 + strike * 0.8);
            this.arm(b.armL, b.foreL, b.handL, 0.9 - strike * 0.4, 0.5, -1.1, 0.1, 26, dt);
          } else {
            this.arm(b.armL, b.foreL, b.handL, upper, 0.2 - strike * 0.5, -1.4 + strike * 1.3, -0.3 + strike * 0.4, 34, dt, 0.4 - strike * 0.8);
            this.arm(b.armR, b.foreR, b.handR, 0.9 - strike * 0.4, -0.5, -1.1, 0.1, 26, dt);
          }
          this.legL = { z: 0.34 - strike * 0.1, y: -0.9, x: -0.14 };
          this.legR = { z: -0.28, y: -0.94, x: 0.16 };
        }
        break;
      }
      case 'wallRun': {
        // Body angled off the wall with the inside hand tracking the surface.
        const s = this.handSide;
        leanZTarget = s * 0.44;
        leanTarget = 0.24;
        this.phase += dt * Math.max(2.6, stridePhaseSpeed);
        const cyc = Math.sin(this.phase * TAU);
        this.legL = { z: cyc * 0.5, y: -0.9, x: -0.1 };
        this.legR = { z: -cyc * 0.5, y: -0.9, x: 0.1 };
        if (s > 0) {
          this.arm(b.armR, b.foreR, b.handR, -1.1, -1.2, -0.35, 0.0, 22, dt, -0.3);
          this.arm(b.armL, b.foreL, b.handL, -cyc * 1.1, 0.3, -0.7, 0.1, 20, dt);
        } else {
          this.arm(b.armL, b.foreL, b.handL, -1.1, 1.2, -0.35, 0.0, 22, dt, 0.3);
          this.arm(b.armR, b.foreR, b.handR, cyc * 1.1, -0.3, -0.7, 0.1, 20, dt);
        }
        break;
      }
      case 'wallJump': {
        const t = clamp01(this.stateTime / 0.3);
        leanZTarget = -this.handSide * 0.5 * (1 - t);
        twistTarget = -this.handSide * 0.7 * (1 - t);
        this.legL = { z: 0.36, y: -0.66, x: -0.1 };
        this.legR = { z: -0.2, y: -0.84, x: 0.12 };
        this.arm(b.armL, b.foreL, b.handL, -2.2, 0.8, -0.8, 0.2, 26, dt);
        this.arm(b.armR, b.foreR, b.handR, -2.2, -0.8, -0.8, 0.2, 26, dt);
        break;
      }
      case 'grind': {
        // Surf stance: feet split along the rail, knees loaded, arms wide for balance.
        leanTarget = 0.3;
        leanZTarget = -turn * 0.4;
        this.legL = { z: 0.44, y: -0.74, x: -0.22 };
        this.legR = { z: -0.4, y: -0.78, x: 0.24 };
        this.arm(b.armL, b.foreL, b.handL, -0.5, 1.15, -0.5, 0.1, 16, dt);
        this.arm(b.armR, b.foreR, b.handR, -0.4, -1.2, -0.45, 0.1, 16, dt);
        hipY = -0.16;
        break;
      }
      case 'slide': {
        leanTarget = 0.9;
        this.legL = { z: 0.62, y: -0.5, x: -0.18 };
        this.legR = { z: 0.1, y: -0.42, x: 0.22 };
        this.arm(b.armL, b.foreL, b.handL, 1.2, 0.5, -0.4, 0.3, 22, dt);
        this.arm(b.armR, b.foreR, b.handR, -1.9, -0.4, -0.5, 0.2, 22, dt);
        hipY = -0.42;
        break;
      }
      case 'pound': {
        leanTarget = -0.2;
        this.legL = { z: 0.1, y: -0.55, x: -0.18 };
        this.legR = { z: -0.08, y: -0.55, x: 0.18 };
        this.arm(b.armL, b.foreL, b.handL, -2.9, 0.5, -0.3, 0.2, 30, dt);
        this.arm(b.armR, b.foreR, b.handR, -2.9, -0.5, -0.3, 0.2, 30, dt);
        break;
      }
      case 'land':
      case 'hardLand': {
        const dur = st === 'hardLand' ? 0.42 : 0.2;
        const t = clamp01(this.stateTime / dur);
        const comp = Math.sin(Math.PI * Math.pow(t, 0.7));
        const deep = st === 'hardLand' ? 0.4 : 0.22;
        hipY = -comp * deep;
        leanTarget = comp * (st === 'hardLand' ? 0.55 : 0.3);
        this.legL = { z: 0.16, y: -0.99 + comp * deep, x: -0.2 - comp * 0.1 };
        this.legR = { z: -0.14, y: -0.99 + comp * deep, x: 0.2 + comp * 0.1 };
        this.arm(b.armL, b.foreL, b.handL, 0.6 - comp * 1.8, 0.5 + comp * 0.3, -0.9 - comp * 0.6, 0.2, 24, dt);
        this.arm(b.armR, b.foreR, b.handR, 0.5 - comp * 1.7, -0.5 - comp * 0.3, -0.9 - comp * 0.6, 0.2, 24, dt);
        break;
      }
      case 'damage':
      case 'knock': {
        const t = clamp01(this.stateTime / 0.4);
        leanTarget = -0.6 * (1 - t);
        twistTarget = 0.5 * (1 - t);
        if (st === 'knock') b.hips.rotation.x = angleDamp(b.hips.rotation.x, TAU * t, 18, dt);
        this.legL = { z: -0.3, y: -0.8, x: -0.24 };
        this.legR = { z: 0.34, y: -0.76, x: 0.26 };
        this.arm(b.armL, b.foreL, b.handL, -1.9, 1.1, -1.2, 0.4, 24, dt);
        this.arm(b.armR, b.foreR, b.handR, -1.7, -1.2, -1.1, 0.4, 24, dt);
        break;
      }
      case 'victory': {
        const t = this.stateTime;
        leanTarget = -0.16 + Math.sin(t * 3) * 0.05;
        twistTarget = Math.sin(t * 2.2) * 0.2;
        this.legL = { z: 0.24, y: -0.9, x: -0.3 };
        this.legR = { z: -0.26, y: -0.92, x: 0.3 };
        this.arm(b.armR, b.foreR, b.handR, -2.9, -0.3, -0.3, -0.2, 12, dt, 0.2);
        this.arm(b.armL, b.foreL, b.handL, 0.5, 0.9, -1.4, 0.3, 12, dt);
        b.head.rotation.x = angleDamp(b.head.rotation.x, -0.2, 8, dt);
        break;
      }
    }

    // Reset the roll driven by flips once those states end.
    if (st !== 'double' && st !== 'homing' && st !== 'knock') {
      b.hips.rotation.x = angleDamp(b.hips.rotation.x, 0, 14, dt);
    }
    if (st !== 'melee3' && st !== 'aerial') b.hips.rotation.y = angleDamp(b.hips.rotation.y, 0, 16, dt);

    // Legs
    const legRate = st === 'run' || st === 'sprint' || st === 'boost' ? 26 + fast * 14 : 18;
    this.ik(b.thighL, b.shinL, b.footL, this.legL, -1, legRate, dt);
    this.ik(b.thighR, b.shinR, b.footR, this.legR, 1, legRate, dt);

    // Torso and hips
    this.lean = damp(this.lean, leanTarget, 12, dt);
    this.leanZ = damp(this.leanZ, leanZTarget, 10, dt);
    this.twist = damp(this.twist, twistTarget, 14, dt);
    b.chest.rotation.x = this.lean * 0.55;
    b.chest.rotation.z = this.leanZ * 0.6;
    b.chest.rotation.y = this.twist;
    b.hips.rotation.z = this.leanZ * 0.4;
    b.hips.position.y = 0.98 + hipY;
    b.neck.rotation.x = -this.lean * 0.3;

    // Squash and stretch on the whole rig, volume preserving.
    const sq = this.squash;
    b.root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    // Surface alignment: the body tips with the ground plane so feet stay flush.
    if (grounded) {
      const pitch = Math.asin(clamp(-groundNormal.z, -0.6, 0.6));
      const roll = Math.asin(clamp(groundNormal.x, -0.6, 0.6));
      b.root.rotation.x = angleDamp(b.root.rotation.x, pitch * 0.6, 10, dt);
      b.root.rotation.z = angleDamp(b.root.rotation.z, -roll * 0.6, 10, dt);
    } else {
      b.root.rotation.x = angleDamp(b.root.rotation.x, 0, 6, dt);
      b.root.rotation.z = angleDamp(b.root.rotation.z, 0, 6, dt);
    }

    // Hand pinning: when the controller supplies a contact point (wall, rail, target),
    // the arm aims at it in local space so the contact never looks detached.
    if (this.handTarget) {
      const arm = this.handSide > 0 ? b.armR : b.armL;
      const fore = this.handSide > 0 ? b.foreR : b.foreL;
      arm.updateWorldMatrix(true, false);
      _v.setFromMatrixPosition(arm.matrixWorld);
      _v2.copy(this.handTarget).sub(_v);
      const reach = clamp(_v2.length(), 0.3, 0.9);
      arm.parent!.updateWorldMatrix(true, false);
      _v2.normalize();
      // Convert the world direction into the arm's parent space, then aim -Y down it.
      const inv = _q.copy(arm.parent!.getWorldQuaternion(new Quaternion())).invert();
      _v2.applyQuaternion(inv);
      const targetX = Math.atan2(_v2.z, -_v2.y);
      const targetZ = Math.atan2(-_v2.x, -_v2.y);
      arm.rotation.x = angleDamp(arm.rotation.x, targetX, 24, dt);
      arm.rotation.z = angleDamp(arm.rotation.z, targetZ, 24, dt);
      fore.rotation.x = angleDamp(fore.rotation.x, -(0.9 - reach) * 1.6, 24, dt);
    }

    // CLOTH: a lagging angular chain. Each segment chases the one above it with a delay,
    // so speed streams the coat backward and hard turns crack it sideways.
    const tailDrive = clamp(speed / 34, 0, 1.9);
    const vertDrive = clamp(-vertical / 40, -1, 1.4);
    for (let i = 0; i < b.tail.length; i++) {
      const seg = b.tail[i];
      const target = 0.24 + tailDrive * (0.7 + i * 0.16) + vertDrive * 0.3 * (1 + i * 0.2);
      const lateral = -turn * (0.3 + i * 0.14);
      this.tailAngles[i] = damp(this.tailAngles[i], target, 9 - i * 1.1, dt);
      this.tailLateral[i] = damp(this.tailLateral[i], lateral, 8 - i * 0.8, dt);
      seg.rotation.x = this.tailAngles[i] + Math.sin(this.breath * 6 + i) * 0.05 * tailDrive;
      seg.rotation.z = this.tailLateral[i];
    }
    for (let i = 0; i < b.scarf.length; i++) {
      const seg = b.scarf[i];
      const target = 0.4 + tailDrive * (0.9 + i * 0.3) + vertDrive * 0.24;
      this.scarfAngles[i] = damp(this.scarfAngles[i], target, 11 - i * 1.4, dt);
      seg.rotation.x = this.scarfAngles[i] + Math.sin(this.breath * 8 + i * 1.7) * 0.09 * tailDrive;
      seg.rotation.z = -turn * (0.4 + i * 0.2);
    }
  }
}
