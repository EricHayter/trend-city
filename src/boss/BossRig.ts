/**
 * BossRig — the boss's scene graph and all of its procedural animation.
 *
 * ── NO SKELETON, NO VERTEX ANIMATION ────────────────────────────────────────
 *
 * The boss is a hard-surface machine, so every joint is an `Object3D` and every
 * pose is a transform. That is not a shortcut, it is the only safe option here:
 * `CelMaterial` builds its prepass, shadow and outline-hull companions from the
 * same options as the main material but does NOT inject `vertexBody` into any
 * of them. Any geometry deformation written in the vertex shader would
 * therefore appear in the main pass and in none of the other three, and a
 * prepass/main mismatch is documented in `CelMaterial`'s own header as the
 * usual cause of an outline hull detaching from its mesh. Transform animation
 * is applied to all four passes by the scene graph itself and cannot desync.
 *
 * ── THE POSE MODEL ──────────────────────────────────────────────────────────
 *
 * `PoseTarget` is a flat block of scalars. The fight's state machine writes a
 * target; `updateVisual` critically damps the live pose toward it with a
 * half-life, never assigns it. That is the same discipline `SLOPE.alignRate`
 * enforces on the player's alignment and for the same reason — a 20 m arm
 * whose angle is assigned steps visibly at 120 Hz, and the step is 20 m long.
 *
 * ── HIERARCHY ───────────────────────────────────────────────────────────────
 *
 *   root            world position, yaw
 *    └ sink         vertical offset for emerging from / sinking into the mountain
 *       └ body      whole-body pitch and roll (crouch, all-fours, lunge lean)
 *          ├ pelvis
 *          │  ├ hipL/R → thighL/R → kneeL/R → shinL/R → ankleL/R → footL/R
 *          │  └ waist  → torso
 *          │             ├ neck → head → visor
 *          │             ├ ventHinge[0..n] → vent plate
 *          │             ├ dorsalCore
 *          │             └ shoulderL/R → upper arm → elbow → forearm → wrist → fist
 *          │                                                              └ fistCore
 */

import { Group, Mesh, Object3D, Vector3 } from 'three';

import { dampHL } from '../core/MathX';
import { Rng } from '../core/RNG';
import { CelMaterial, disposeCelMaterial, makeCelMesh } from '../npr/CelMaterial';
import type { CelOptions } from '../npr/CelMaterial';
import { RAMPS } from '../npr/Palette';
import { BODY, LOOK, MOTION } from './BossConstants';
import {
  coreGeometry,
  finishHardSurface,
  fistGeometry,
  footGeometry,
  forearmGeometry,
  headGeometry,
  pauldronGeometry,
  pelvisGeometry,
  shinGeometry,
  thighGeometry,
  torsoGeometry,
  torsoTrimGeometry,
  upperArmGeometry,
  ventPlateGeometry,
  visorGeometry,
} from './BossGeometry';

// ─────────────────────────────────────────────────────────────────────────────
// Pose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every scalar the fight is allowed to drive. Arrays are [left, right].
 *
 * Kept as a flat mutable block rather than a class with setters so that
 * writing a pose is a sequence of field assignments and allocates nothing —
 * this is written every physics step.
 */
export interface PoseTarget {
  /** Whole-body lean, radians. Positive pitches the chest toward +Z (forward). */
  bodyPitch: number;
  bodyRoll: number;
  /** Metres the hips drop. Crouch, kneel, all fours. */
  hipDrop: number;
  waistPitch: number;
  waistTwist: number;
  headPitch: number;
  headYaw: number;

  /** Shoulder. `armPitch` swings the arm forward, `armSpread` outward. */
  armPitch: [number, number];
  armSpread: [number, number];
  armTwist: [number, number];
  elbow: [number, number];
  wrist: [number, number];

  legPitch: [number, number];
  knee: [number, number];
  ankle: [number, number];

  /** 0 closed, 1 fully open. */
  ventOpen: number;
  /** Emissive drive on the cores and the visor. */
  coreGlow: number;
  visorGlow: number;
  /** Metres the whole rig sits below the ground. Intro and death. */
  sink: number;
  /** 0..1 scale on the pulse the vulnerable core does. */
  corePulse: number;
}

export function createPose(): PoseTarget {
  return {
    bodyPitch: 0,
    bodyRoll: 0,
    hipDrop: 0,
    waistPitch: 0,
    waistTwist: 0,
    headPitch: 0,
    headYaw: 0,
    armPitch: [0, 0],
    armSpread: [0, 0],
    armTwist: [0, 0],
    elbow: [0, 0],
    wrist: [0, 0],
    legPitch: [0, 0],
    knee: [0, 0],
    ankle: [0, 0],
    ventOpen: 0,
    coreGlow: LOOK.coreGlowIdle,
    visorGlow: LOOK.coreGlowIdle,
    sink: 0,
    corePulse: 0,
  };
}

/** Reset a pose block to the neutral standing pose, in place. */
export function neutralPose(p: PoseTarget): void {
  p.bodyPitch = 0;
  p.bodyRoll = 0;
  p.hipDrop = 0;
  p.waistPitch = 0;
  p.waistTwist = 0;
  p.headPitch = 0;
  p.headYaw = 0;
  p.armPitch[0] = 0.12;
  p.armPitch[1] = 0.12;
  p.armSpread[0] = 0.16;
  p.armSpread[1] = 0.16;
  p.armTwist[0] = 0;
  p.armTwist[1] = 0;
  p.elbow[0] = -0.34;
  p.elbow[1] = -0.34;
  p.wrist[0] = 0;
  p.wrist[1] = 0;
  p.legPitch[0] = 0;
  p.legPitch[1] = 0;
  p.knee[0] = -0.10;
  p.knee[1] = -0.10;
  p.ankle[0] = 0.10;
  p.ankle[1] = 0.10;
  p.ventOpen = 0;
  p.coreGlow = LOOK.coreGlowIdle;
  p.visorGlow = LOOK.coreGlowIdle;
  p.sink = 0;
  p.corePulse = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The emissive injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The glow written into the core, the visor and the vent throats.
 *
 * NO LITERAL COLOUR. `uGlowColor` is seeded from `RAMPS.marker`'s hottest band,
 * which is the palette's committed "reads at distance" chroma, and the pulse is
 * driven by a uniform this subsystem advances itself rather than by the shared
 * `uTime`. That second point is deliberate: the predecessor project shipped for
 * weeks with the frame clock being fed a dimensionless multiplier instead of a
 * delta, so `uTime` advanced a second per rendered frame and every effect keyed
 * to it was wrong in a way nobody could see in a still.
 *
 * NEVER put a backtick inside this template literal's comments — `check:glsl`
 * enforces it and it has cost this project three cycles.
 */
const GLOW_PREAMBLE = /* glsl */ `
  uniform vec3  uGlowColor;
  uniform float uGlowStrength;
  uniform float uGlowPulse;
`;

const GLOW_BODY = /* glsl */ `
  {
    // Fresnel-weighted so the glow sits in the depth of the shape rather than
    // washing the whole panel flat. Squared, so it stays a drawn core.
    vec3 gv = normalize(uCameraPos - vWorldPos);
    float facing = 1.0 - abs(dot(normalize(vNormal), gv));
    float k = uGlowStrength * (0.45 + 0.55 * facing * facing) * uGlowPulse;
    celCol = mix(celCol, uGlowColor, clamp(k, 0.0, 0.94));
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Rig
// ─────────────────────────────────────────────────────────────────────────────

interface Limb {
  joint: Object3D;
  child: Object3D | null;
}

export class BossRig {
  readonly object = new Group();

  private readonly sink = new Group();
  private readonly body = new Group();
  private readonly pelvis = new Group();
  private readonly waist = new Group();
  private readonly torso = new Group();
  private readonly neck = new Group();
  private readonly head = new Group();

  private readonly shoulder: Object3D[] = [];
  private readonly elbow: Object3D[] = [];
  private readonly wristJoint: Object3D[] = [];
  private readonly hip: Object3D[] = [];
  private readonly knee: Object3D[] = [];
  private readonly ankle: Object3D[] = [];
  private readonly ventHinge: Object3D[] = [];

  /** Weak-point anchors, kept so the fight can read their world positions. */
  private readonly fistAnchor: Object3D[] = [];
  private readonly dorsalAnchor = new Group();
  private readonly chestAnchor = new Group();

  private readonly materials: CelMaterial[] = [];
  private readonly glowMaterials: CelMaterial[] = [];

  /** Live pose, damped toward the target every visual update. */
  readonly pose: PoseTarget = createPose();
  private pulseClock = 0;

  constructor() {
    this.object.name = 'boss-rig';
    this.object.add(this.sink);
    this.sink.add(this.body);
    this.body.add(this.pelvis);
    this.pelvis.position.y = BODY.hipHeight;
    this.pelvis.add(this.waist);
    this.waist.add(this.torso);
    this.torso.add(this.neck);
    this.neck.position.y = BODY.shoulderHeight - BODY.hipHeight + 1.2;
    this.neck.add(this.head);

    neutralPose(this.pose);
    this.build();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Construction
  // ───────────────────────────────────────────────────────────────────────────

  private add(
    parent: Object3D,
    geo: ReturnType<typeof pelvisGeometry>,
    preset: keyof typeof RAMPS,
    name: string,
    outlineWidth: number,
    glow = false,
  ): Mesh {
    finishHardSurface(geo);
    const opts: CelOptions = {
      vertexAo: true,
      outlineWidth,
      name,
      idName: name,
      valueSteps: 5,
    };
    if (glow) {
      opts.fragmentPreamble = GLOW_PREAMBLE;
      opts.fragmentBody = GLOW_BODY;
      opts.uniforms = {
        uGlowColor: { value: RAMPS.marker.colors[RAMPS.marker.colors.length - 1].clone() },
        uGlowStrength: { value: LOOK.coreGlowIdle },
        uGlowPulse: { value: 1 },
      };
    }
    const built = makeCelMesh(geo, preset, opts);
    built.mesh.castShadow = true;
    built.mesh.receiveShadow = true;
    // A 20 m body whose parts are individually frustum-culled pops limbs in and
    // out at the screen edge, because each part's bounding sphere is metres
    // across while the whole subject is tens of metres across.
    built.mesh.frustumCulled = false;
    if (built.hull) built.hull.frustumCulled = false;
    parent.add(built.group);
    this.materials.push(built.material);
    if (glow) this.glowMaterials.push(built.material);
    return built.mesh;
  }

  private build(): void {
    const rng = new Rng('boss-rig');

    this.add(this.pelvis, pelvisGeometry(), 'rock', 'boss-pelvis', LOOK.outlineArmour);
    this.add(this.torso, torsoGeometry(), 'rock', 'boss-torso', LOOK.outlineArmour);
    this.add(this.torso, torsoTrimGeometry(), 'frame', 'boss-trim', LOOK.outlineFrame);
    this.add(this.head, headGeometry(), 'rock', 'boss-head', LOOK.outlineArmour);
    this.add(this.head, visorGeometry(), 'lens', 'boss-visor', LOOK.outlineFrame, true);

    // ── Dorsal vents and the core they hide ────────────────────────────────
    const bank = new Group();
    bank.position.set(0, BODY.torsoHeight * 0.45, -BODY.torsoHalfDepth * 0.9);
    this.torso.add(bank);
    for (let i = 0; i < BODY.ventCount; i++) {
      const hinge = new Group();
      hinge.position.set(0, (i - (BODY.ventCount - 1) * 0.5) * BODY.ventSpacing, 0);
      bank.add(hinge);
      this.add(hinge, ventPlateGeometry(), 'metal', `boss-vent-${i}`, LOOK.outlineFrame);
      this.ventHinge.push(hinge);
    }
    this.dorsalAnchor.position.copy(bank.position);
    this.dorsalAnchor.position.z -= 0.6;
    this.torso.add(this.dorsalAnchor);
    this.add(this.dorsalAnchor, coreGeometry(), 'marker', 'boss-core-dorsal', LOOK.outlineCore, true);

    // ── Chest core ─────────────────────────────────────────────────────────
    this.chestAnchor.position.set(0, BODY.torsoHeight * 0.34, BODY.torsoHalfDepth * 0.72);
    this.torso.add(this.chestAnchor);
    this.add(this.chestAnchor, coreGeometry(), 'marker', 'boss-core-chest', LOOK.outlineCore, true);

    // ── Arms ───────────────────────────────────────────────────────────────
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const shoulder = new Group();
      shoulder.position.set(side * BODY.shoulderOffset, BODY.shoulderHeight - BODY.hipHeight - 1.0, 0);
      this.torso.add(shoulder);
      this.shoulder.push(shoulder);
      this.add(shoulder, pauldronGeometry(side), 'rock', `boss-pauldron-${s}`, LOOK.outlineArmour);
      this.add(shoulder, upperArmGeometry(), 'metal', `boss-upperarm-${s}`, LOOK.outlineFrame);

      const elbow = new Group();
      elbow.position.y = -BODY.upperArmLength;
      shoulder.add(elbow);
      this.elbow.push(elbow);
      this.add(elbow, forearmGeometry(), 'metal', `boss-forearm-${s}`, LOOK.outlineFrame);

      const wrist = new Group();
      wrist.position.y = -BODY.forearmLength;
      elbow.add(wrist);
      this.wristJoint.push(wrist);
      this.add(wrist, fistGeometry(), 'rock', `boss-fist-${s}`, LOOK.outlineArmour);

      const fistCore = new Group();
      fistCore.position.y = -BODY.fistRadius * 1.1;
      wrist.add(fistCore);
      this.fistAnchor.push(fistCore);
      this.add(fistCore, coreGeometry(), 'marker', `boss-core-fist-${s}`, LOOK.outlineCore, true);
    }

    // ── Legs ───────────────────────────────────────────────────────────────
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const hip = new Group();
      hip.position.set(side * BODY.legSpread, -2.2, 0);
      this.pelvis.add(hip);
      this.hip.push(hip);
      this.add(hip, thighGeometry(), 'metal', `boss-thigh-${s}`, LOOK.outlineFrame);

      const knee = new Group();
      knee.position.y = -BODY.thighLength;
      hip.add(knee);
      this.knee.push(knee);
      this.add(knee, shinGeometry(), 'rock', `boss-shin-${s}`, LOOK.outlineArmour);

      const ankle = new Group();
      ankle.position.y = -BODY.shinLength;
      knee.add(ankle);
      this.ankle.push(ankle);
      this.add(ankle, footGeometry(), 'rock', `boss-foot-${s}`, LOOK.outlineArmour);
    }

    // Consume the rng so the seed is used deterministically even though the
    // current part set does not jitter — keeps future additions reproducible.
    rng.next();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Animation
  // ───────────────────────────────────────────────────────────────────────────

  /** Place the root. Called from the fight's interpolated visual update. */
  setRoot(x: number, y: number, z: number, yaw: number): void {
    this.object.position.set(x, y, z);
    this.object.rotation.y = yaw;
  }

  /**
   * Damp the live pose toward `target` and write the transforms.
   *
   * `dt` here is a FRAME delta, which is correct: this is the visual half. No
   * value computed in this method is ever read back by the fight's fixed step.
   */
  apply(target: PoseTarget, dt: number, halfLife = MOTION.poseHalfLife): void {
    const p = this.pose;
    const hl = halfLife;

    p.bodyPitch = dampHL(p.bodyPitch, target.bodyPitch, hl, dt);
    p.bodyRoll = dampHL(p.bodyRoll, target.bodyRoll, hl, dt);
    p.hipDrop = dampHL(p.hipDrop, target.hipDrop, hl, dt);
    p.waistPitch = dampHL(p.waistPitch, target.waistPitch, hl, dt);
    p.waistTwist = dampHL(p.waistTwist, target.waistTwist, hl, dt);
    p.headPitch = dampHL(p.headPitch, target.headPitch, hl, dt);
    p.headYaw = dampHL(p.headYaw, target.headYaw, hl, dt);
    p.ventOpen = dampHL(p.ventOpen, target.ventOpen, hl, dt);
    p.coreGlow = dampHL(p.coreGlow, target.coreGlow, hl * 1.6, dt);
    p.visorGlow = dampHL(p.visorGlow, target.visorGlow, hl * 1.6, dt);
    p.sink = dampHL(p.sink, target.sink, hl * 3.0, dt);
    p.corePulse = dampHL(p.corePulse, target.corePulse, hl * 2.0, dt);

    for (let s = 0; s < 2; s++) {
      p.armPitch[s] = dampHL(p.armPitch[s], target.armPitch[s], hl, dt);
      p.armSpread[s] = dampHL(p.armSpread[s], target.armSpread[s], hl, dt);
      p.armTwist[s] = dampHL(p.armTwist[s], target.armTwist[s], hl, dt);
      p.elbow[s] = dampHL(p.elbow[s], target.elbow[s], hl, dt);
      p.wrist[s] = dampHL(p.wrist[s], target.wrist[s], hl, dt);
      p.legPitch[s] = dampHL(p.legPitch[s], target.legPitch[s], hl, dt);
      p.knee[s] = dampHL(p.knee[s], target.knee[s], hl, dt);
      p.ankle[s] = dampHL(p.ankle[s], target.ankle[s], hl, dt);
    }

    this.sink.position.y = -p.sink;
    this.body.rotation.x = p.bodyPitch;
    this.body.rotation.z = p.bodyRoll;
    this.pelvis.position.y = BODY.hipHeight - p.hipDrop;
    this.waist.rotation.x = p.waistPitch;
    this.waist.rotation.y = p.waistTwist;
    this.neck.rotation.x = p.headPitch;
    this.neck.rotation.y = p.headYaw;

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const sh = this.shoulder[s];
      sh.rotation.x = p.armPitch[s];
      sh.rotation.z = side * p.armSpread[s];
      sh.rotation.y = p.armTwist[s];
      this.elbow[s].rotation.x = p.elbow[s];
      this.wristJoint[s].rotation.x = p.wrist[s];

      this.hip[s].rotation.x = p.legPitch[s];
      this.knee[s].rotation.x = p.knee[s];
      this.ankle[s].rotation.x = p.ankle[s];
    }

    for (let i = 0; i < this.ventHinge.length; i++) {
      // Alternating hinge sign so the bank opens like a set of gills rather
      // than like a single flap.
      const sign = i % 2 === 0 ? 1 : -1;
      this.ventHinge[i].rotation.x = sign * p.ventOpen * LOOK.ventOpenAngle;
    }

    this.pulseClock += dt * LOOK.corePulseHz * Math.PI * 2;
    if (this.pulseClock > Math.PI * 2000) this.pulseClock -= Math.PI * 2000;
    const pulse = 1 + Math.sin(this.pulseClock) * 0.28 * p.corePulse;
    for (const m of this.glowMaterials) {
      const isVisor = m.name.indexOf('visor') >= 0;
      m.uniforms.uGlowStrength.value = isVisor ? p.visorGlow : p.coreGlow;
      m.uniforms.uGlowPulse.value = pulse;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Weak point anchors
  // ───────────────────────────────────────────────────────────────────────────

  /** World position of a fist core. `side` 0 = left, 1 = right. */
  fistWorld(side: number, out: Vector3): Vector3 {
    return this.fistAnchor[side].getWorldPosition(out);
  }

  /** World position of the dorsal core, exposed while the vents are open. */
  dorsalWorld(out: Vector3): Vector3 {
    return this.dorsalAnchor.getWorldPosition(out);
  }

  /** World position of the chest core. */
  chestWorld(out: Vector3): Vector3 {
    return this.chestAnchor.getWorldPosition(out);
  }

  /** World position of the visor, for the beam origin. */
  visorWorld(out: Vector3): Vector3 {
    return this.head.getWorldPosition(out);
  }

  /** World position and direction of a shoulder, for the arc sweep pivot. */
  shoulderWorld(side: number, out: Vector3): Vector3 {
    return this.shoulder[side].getWorldPosition(out);
  }

  /** Force the scene graph up to date without waiting for the renderer. */
  refresh(): void {
    this.object.updateMatrixWorld(true);
  }

  dispose(): void {
    for (const m of this.materials) disposeCelMaterial(m);
    this.materials.length = 0;
    this.glowMaterials.length = 0;
    this.object.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    this.object.clear();
  }
}
