/**
 * Skeleton — the character's bone hierarchy, built in code.
 *
 * Three decisions here decide whether the rest of the rig is easy or impossible:
 *
 *  1. THE REST POSE IS THE RUNNING STANCE, NOT A T-POSE. Every bone is authored
 *     in an athletic ready position: a 12 degree forward lean, knees carrying a
 *     little bend, elbows already folded into the running carriage. A T-pose
 *     bind would mean the very first frame asks the IK for a 90 degree
 *     correction on every limb, which is exactly where procedural rigs pop, and
 *     it would mean the skin weights are solved for a shape the character is
 *     never in. This character spends essentially all of its life running, so
 *     binding in a run-ready stance keeps every runtime correction small, the
 *     solver stays in its well-behaved region, and the deltoids and knees
 *     deform through the range they were weighted for.
 *
 *     (This file began life binding a BMX rider with its hands on the grips and
 *     its feet on the pedals, for exactly the same reason. The principle
 *     survived the pivot; the pose did not.)
 *
 *  2. EVERY BONE'S REST LOCAL ROTATION IS IDENTITY. Bone k's local offset from
 *     its parent is therefore the same vector in rig space and in the parent's
 *     local frame. That single property removes an entire class of bugs: the rig
 *     can compute everything in rig space, then convert to local rotations with
 *     one quaternion multiply per bone, with no baked rest rotations to smear
 *     into the result and no Euler order to get wrong.
 *
 *  3. ELBOWS AND KNEES ARE SOLVED, NOT TYPED IN. The rest mid-joints come out of
 *     the same `solveTwoBone` the runtime uses, from the same segment lengths and
 *     pole directions. Hand-authored coordinates would be a few millimetres off
 *     the segment lengths, and the rig would snap by that amount on frame one.
 *     Solving them guarantees |shoulder→elbow| is exactly `upperArm` forever.
 *
 * Rig space: +Y up, +Z forward, +X to the LEFT, origin ON THE GROUND between
 * the feet. y = 0 is the ground plane, which means the rig node can be placed
 * at `PlayerState.position` (which is the feet) with no offset — every offset
 * that is not zero is an offset something eventually gets wrong.
 */

import { Bone, Skeleton, Vector3 } from 'three';

import { makeLimbState, makeTwoBoneResult, solveTwoBone } from './IK';

// ─────────────────────────────────────────────────────────────────────────────
// Bone table
// ─────────────────────────────────────────────────────────────────────────────

export const BONE_NAMES = [
  'pelvis',
  'spine1',
  'spine2',
  'chest',
  'neck',
  'head',
  'headEnd',
  'clavL',
  'upperArmL',
  'forearmL',
  'handL',
  'handEndL',
  'clavR',
  'upperArmR',
  'forearmR',
  'handR',
  'handEndR',
  'thighL',
  'shinL',
  'footL',
  'toeL',
  'thighR',
  'shinR',
  'footR',
  'toeR',
  'hem',
  'shortsL',
  'shortsR',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

export const BONE_COUNT = BONE_NAMES.length;

export const BONE_INDEX: Record<BoneName, number> = (() => {
  const m = {} as Record<BoneName, number>;
  for (let i = 0; i < BONE_NAMES.length; i++) m[BONE_NAMES[i]] = i;
  return m;
})();

/** Parent of every bone. `null` only for the pelvis. */
const PARENT_NAME: Record<BoneName, BoneName | null> = {
  pelvis: null,
  spine1: 'pelvis',
  spine2: 'spine1',
  chest: 'spine2',
  neck: 'chest',
  head: 'neck',
  headEnd: 'head',
  clavL: 'chest',
  upperArmL: 'clavL',
  forearmL: 'upperArmL',
  handL: 'forearmL',
  handEndL: 'handL',
  clavR: 'chest',
  upperArmR: 'clavR',
  forearmR: 'upperArmR',
  handR: 'forearmR',
  handEndR: 'handR',
  thighL: 'pelvis',
  shinL: 'thighL',
  footL: 'shinL',
  toeL: 'footL',
  thighR: 'pelvis',
  shinR: 'thighR',
  footR: 'shinR',
  toeR: 'footR',
  hem: 'spine1',
  shortsL: 'thighL',
  shortsR: 'thighR',
};

/**
 * The child each bone points AT. A bone's rest direction is the unit vector
 * toward this child; leaves inherit their parent's direction.
 */
const AIM_NAME: Partial<Record<BoneName, BoneName>> = {
  pelvis: 'spine1',
  spine1: 'spine2',
  spine2: 'chest',
  chest: 'neck',
  neck: 'head',
  head: 'headEnd',
  clavL: 'upperArmL',
  upperArmL: 'forearmL',
  forearmL: 'handL',
  handL: 'handEndL',
  clavR: 'upperArmR',
  upperArmR: 'forearmR',
  forearmR: 'handR',
  handR: 'handEndR',
  thighL: 'shinL',
  shinL: 'footL',
  footL: 'toeL',
  thighR: 'shinR',
  shinR: 'footR',
  footR: 'toeR',
};

// ─────────────────────────────────────────────────────────────────────────────
// Proportions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The foot, in its own rest frame: origin at the ankle joint, +Z toward the toe,
 * sole flat and horizontal.
 *
 * These numbers are shared by the three places that MUST agree or the foot
 * sinks into the ground: the rest skeleton (which puts the ankle `soleDrop`
 * above the floor), the shoe mesh (which is lofted from them), and the rig's
 * foot planting (which solves the ankle onto a contact point). They live here
 * rather than in RiderMesh so there is exactly one definition of where the
 * bottom of the shoe is.
 *
 * The rest foot is LEVEL. `poseLegs` writes the foot bone's rig rotation as the
 * GROUND's own rotation times the ankle-flex channel, so with flex at zero the
 * shoe renders exactly as authored — which means "as authored" has to be the
 * sole flat on the surface.
 */
export const FOOT = {
  /** Underside of the sole below the ankle joint. */
  soleDrop: 0.090,
  /** Back of the heel, behind the ankle. */
  heelBack: 0.078,
  /** Tip of the toe, ahead of the ankle. `heelBack + toeAhead` = shoe length. */
  toeAhead: 0.177,
  /** Ball of the foot — where the spindle sits — ahead of the ankle. */
  ballAhead: 0.078,
  /** The toe BONE (metatarsal joint) relative to the ankle. */
  toeJointAhead: 0.092,
  toeJointDrop: 0.052,
};

export const LIMB = {
  upperArm: 0.285,
  forearm: 0.265,
  thigh: 0.425,
  shin: 0.405,
  /**
   * How far the ankle JOINT sits above the ground when the foot is planted.
   *
   * This is not a free parameter: the sole of the shoe is `FOOT.soleDrop` below
   * the ankle, so for the sole to sit ON the ground the ankle must be exactly
   * that far above it. Getting this wrong by a couple of centimetres is the
   * classic "character skates with its feet inside the terrain" bug, and it is
   * invisible in a still taken from anywhere but ground level.
   */
  ankleLift: FOOT.soleDrop,
};

/** Radii and shape parameters the mesh builder needs. Metres. */
export const RIDER_DIMS = {
  headRadius: 0.096,
  helmetRadius: 0.118,
  neckRadius: 0.050,

  chestHalfWidth: 0.183,
  chestDepth: 0.112,
  waistHalfWidth: 0.138,
  waistDepth: 0.098,
  hipHalfWidth: 0.156,
  hipDepth: 0.116,

  upperArmTop: 0.055,
  upperArmBottom: 0.044,
  forearmTop: 0.044,
  forearmBottom: 0.032,
  handRadius: 0.044,

  thighTop: 0.089,
  thighBottom: 0.064,
  shinTop: 0.060,
  shinBottom: 0.040,

  shoeLength: 0.255,
  shoeWidth: 0.052,
  shoeHeight: 0.078,

  /** Clothing is offset outward from the body by this much. */
  clothGap: 0.016,
};

/**
 * The stance. Half the distance between the feet, and how far the planted foot
 * sits ahead of the hip line.
 *
 * A runner's feet are not under their hips — they are inboard of them, which is
 * why a run cycle reads as a run and not as a waddle. 0.098 matches the hip
 * bone's own X so the rest legs are vertical in the frontal plane; the run
 * cycle narrows it from there.
 */
export const STANCE = {
  halfWidth: 0.098,
  /** Rest ankle Z. Slightly ahead of the hips, matching the forward lean. */
  footAhead: 0.010,
} as const;

/** Rest ground contact for a foot in rig space. `side` is +1 for the LEFT. */
export function footRest(side: number, out: Vector3): Vector3 {
  return out.set(side * STANCE.halfWidth, LIMB.ankleLift, STANCE.footAhead);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rest pose
// ─────────────────────────────────────────────────────────────────────────────

/** Pole directions, rig space. Elbows out and back; knees forward and out. */
const ELBOW_POLE_L = new Vector3(0.42, -0.16, -0.89).normalize();
const KNEE_POLE_L = new Vector3(0.26, 0.10, 0.96).normalize();

const _restState = makeLimbState();
const _restRes = makeTwoBoneResult();
const _pole = new Vector3();

/** Rest mid-joint + rest bend direction for a two-bone limb. */
function solveRestLimb(
  root: Vector3,
  end: Vector3,
  pole: Vector3,
  len1: number,
  len2: number,
  outMid: Vector3,
  outBend: Vector3,
): void {
  _restState.seeded = false;
  _restState.stretch = 1;
  _restState.overreach = 0;
  _restState.bendDir.set(0, 0, 1);
  solveTwoBone(
    root,
    end,
    pole,
    { len1, len2, maxStretch: 1.0, bendHalfLife: 0, minBend: 0.20 },
    _restState,
    0,
    _restRes,
  );
  outMid.copy(_restRes.mid);
  outBend.copy(_restState.bendDir);
}

function v(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

/**
 * The rest table. Built once at module load; every RiderSkeleton instance and
 * the mesh builder read from it, and nothing ever mutates it.
 */
export interface RestTable {
  /** Parent index per bone, -1 for the root. */
  parents: Int16Array;
  /** Rig-space rest position per bone. */
  pos: Vector3[];
  /** Rest offset from the parent, in rig space (= in parent local space). */
  offset: Vector3[];
  /** Unit rest direction toward the aim child. */
  dir: Vector3[];
  /** Unit rest side reference, perpendicular-ish to `dir`. */
  side: Vector3[];
  /** Distance to the aim child. */
  length: Float32Array;
  /** Rest bend directions for the four IK limbs. */
  bend: { armL: Vector3; armR: Vector3; legL: Vector3; legR: Vector3 };
  /**
   * Rest end-effector positions, so the rig has something to blend FROM and the
   * mesh builder has the hand/foot centres without re-deriving them.
   */
  anchors: { handL: Vector3; handR: Vector3; footL: Vector3; footR: Vector3 };
}

export const REST: RestTable = buildRest();

function buildRest(): RestTable {
  const pos = new Array<Vector3>(BONE_COUNT);
  const set = (name: BoneName, p: Vector3): void => {
    pos[BONE_INDEX[name]] = p;
  };

  // ── Spine: hips up through a torso leaning ~12 degrees into the run ───────
  //
  // Every Y here is measured from the GROUND, not from the hips, because the
  // ground is what the physics hands us. `headEnd` lands at 1.722, which is
  // `HULL.height` (1.72) to within a millimetre — the capsule the collision
  // uses and the body the camera sees are the same height on purpose.
  set('pelvis', v(0, 0.930, -0.030));
  set('spine1', v(0, 1.065, -0.002));
  set('spine2', v(0, 1.202, 0.027));
  set('chest', v(0, 1.355, 0.060));
  set('neck', v(0, 1.460, 0.077));
  set('head', v(0, 1.577, 0.088));
  set('headEnd', v(0, 1.722, 0.088));

  // ── Arms: the running carriage ────────────────────────────────────────────
  //
  // Hands in front of the hips, inboard, at roughly navel height. Shoulder to
  // hand is 0.328 m against a 0.550 m arm, a chord ratio of 0.60 — a firm 90ish
  // degree elbow, which is where a sprinter's arms live and, conveniently, the
  // middle of the two-bone solver's range. Bind here and no runtime arm pose is
  // ever asking the solver for something near full extension or full fold.
  set('clavL', v(0.050, 1.370, 0.052));
  set('clavR', v(-0.050, 1.370, 0.052));
  set('upperArmL', v(0.186, 1.342, 0.062));
  set('upperArmR', v(-0.186, 1.342, 0.062));

  const handL = v(0.152, 1.040, 0.185);
  const handR = v(-0.152, 1.040, 0.185);
  set('handL', handL.clone());
  set('handR', handR.clone());
  // The hand tip continues along the forearm, so the glove has a direction to be
  // swept along and the wrist has a twist reference.
  const forearmAxisL = handL.clone().sub(pos[BONE_INDEX.upperArmL]).normalize();
  set('handEndL', handL.clone().addScaledVector(forearmAxisL, 0.058));
  set(
    'handEndR',
    handR
      .clone()
      .addScaledVector(_pole.set(-forearmAxisL.x, forearmAxisL.y, forearmAxisL.z), 0.058),
  );

  const bendArmL = new Vector3();
  const bendArmR = new Vector3();
  const elbowL = new Vector3();
  const elbowR = new Vector3();
  solveRestLimb(pos[BONE_INDEX.upperArmL], handL, ELBOW_POLE_L, LIMB.upperArm, LIMB.forearm, elbowL, bendArmL);
  _pole.set(-ELBOW_POLE_L.x, ELBOW_POLE_L.y, ELBOW_POLE_L.z);
  solveRestLimb(pos[BONE_INDEX.upperArmR], handR, _pole, LIMB.upperArm, LIMB.forearm, elbowR, bendArmR);
  set('forearmL', elbowL.clone());
  set('forearmR', elbowR.clone());

  // ── Legs: hips down to two planted feet ───────────────────────────────────
  //
  // Hip to ankle is 0.796 m against a 0.830 m leg: 96% extended, so the rest
  // knee carries a few degrees of bend. Straight legs (100%) are the one place
  // a two-bone solver genuinely degenerates — the bend plane becomes undefined
  // and the knee snaps to whatever the pole vector says the instant weight
  // shifts. Keeping 4% in reserve at bind time costs nothing visually and means
  // the solver is never asked for the singular case.
  const ankleL = new Vector3();
  const ankleR = new Vector3();
  footRest(1, ankleL);
  footRest(-1, ankleR);

  set('thighL', v(0.098, 0.885, -0.024));
  set('thighR', v(-0.098, 0.885, -0.024));
  set('footL', ankleL.clone());
  set('footR', ankleR.clone());
  // The toe bone is the metatarsal joint, not the tip of the shoe: it is the
  // hinge the front of the foot flexes about, so it belongs over the ball.
  set('toeL', ankleL.clone().add(v(0, -FOOT.toeJointDrop, FOOT.toeJointAhead)));
  set('toeR', ankleR.clone().add(v(0, -FOOT.toeJointDrop, FOOT.toeJointAhead)));

  const bendLegL = new Vector3();
  const bendLegR = new Vector3();
  const kneeL = new Vector3();
  const kneeR = new Vector3();
  solveRestLimb(pos[BONE_INDEX.thighL], ankleL, KNEE_POLE_L, LIMB.thigh, LIMB.shin, kneeL, bendLegL);
  _pole.set(-KNEE_POLE_L.x, KNEE_POLE_L.y, KNEE_POLE_L.z);
  solveRestLimb(pos[BONE_INDEX.thighR], ankleR, _pole, LIMB.thigh, LIMB.shin, kneeR, bendLegR);
  set('shinL', kneeL.clone());
  set('shinR', kneeR.clone());

  // ── Cloth ─────────────────────────────────────────────────────────────────
  // One hem bone at the small of the back, one per short leg. These carry the
  // follow-through; without them cloth is welded to the body and the character
  // reads as a plastic figurine.
  set('hem', v(0, 1.000, -0.075));
  set('shortsL', pos[BONE_INDEX.thighL].clone().lerp(kneeL, 0.62));
  set('shortsR', pos[BONE_INDEX.thighR].clone().lerp(kneeR, 0.62));

  // ── Derived tables ────────────────────────────────────────────────────────
  const parents = new Int16Array(BONE_COUNT);
  const offset = new Array<Vector3>(BONE_COUNT);
  const dir = new Array<Vector3>(BONE_COUNT);
  const side = new Array<Vector3>(BONE_COUNT);
  const length = new Float32Array(BONE_COUNT);

  for (let i = 0; i < BONE_COUNT; i++) {
    const name = BONE_NAMES[i];
    const parentName = PARENT_NAME[name];
    parents[i] = parentName === null ? -1 : BONE_INDEX[parentName];
    // The root bone's "offset from its parent" is its rig-space position: its
    // parent is the rig node itself. Leaving it at the origin would bind the
    // skeleton a metre below the mesh, and the whole character would then sink
    // by exactly the pelvis height the moment the rig posed itself — which is
    // precisely what it did the first time this ran.
    offset[i] =
      parentName === null ? pos[i].clone() : pos[i].clone().sub(pos[BONE_INDEX[parentName]]);
  }

  for (let i = 0; i < BONE_COUNT; i++) {
    const name = BONE_NAMES[i];
    const aim = AIM_NAME[name];
    if (aim) {
      const d = pos[BONE_INDEX[aim]].clone().sub(pos[i]);
      length[i] = d.length();
      dir[i] = length[i] > 1e-6 ? d.divideScalar(length[i]) : new Vector3(0, 1, 0);
    } else {
      length[i] = 0;
      dir[i] = new Vector3(0, 1, 0); // patched below from the parent
    }
  }
  // Leaves inherit their parent's direction so a rotation applied to them is
  // still meaningful (the toe, the hand tip, the hem).
  for (let i = 0; i < BONE_COUNT; i++) {
    if (!AIM_NAME[BONE_NAMES[i]] && parents[i] >= 0) dir[i].copy(dir[parents[i]]);
  }
  // The hem hangs down and back regardless of the spine's aim.
  dir[BONE_INDEX.hem].set(0, -0.92, -0.39).normalize();
  dir[BONE_INDEX.shortsL].copy(dir[BONE_INDEX.thighL]);
  dir[BONE_INDEX.shortsR].copy(dir[BONE_INDEX.thighR]);

  // Side references. The arms and legs use their own rest bend plane so the
  // runtime solve, which orients bones against the live bend direction, agrees
  // with the bind pose exactly. Everything else uses rig +X.
  for (let i = 0; i < BONE_COUNT; i++) side[i] = new Vector3(1, 0, 0);
  side[BONE_INDEX.upperArmL].copy(bendArmL);
  side[BONE_INDEX.forearmL].copy(bendArmL);
  side[BONE_INDEX.upperArmR].copy(bendArmR);
  side[BONE_INDEX.forearmR].copy(bendArmR);
  side[BONE_INDEX.thighL].copy(bendLegL);
  side[BONE_INDEX.shinL].copy(bendLegL);
  side[BONE_INDEX.thighR].copy(bendLegR);
  side[BONE_INDEX.shinR].copy(bendLegR);
  side[BONE_INDEX.handL].set(0, 0, 1);
  side[BONE_INDEX.handR].set(0, 0, 1);
  side[BONE_INDEX.footL].set(1, 0, 0);
  side[BONE_INDEX.footR].set(1, 0, 0);

  return {
    parents,
    pos,
    offset,
    dir,
    side,
    length,
    bend: { armL: bendArmL, armR: bendArmR, legL: bendLegL, legR: bendLegR },
    anchors: { handL: handL.clone(), handR: handR.clone(), footL: ankleL.clone(), footR: ankleR.clone() },
  };
}

/** Convenience for the mesh builder: rest position of a named bone. */
export function restPos(name: BoneName): Vector3 {
  return REST.pos[BONE_INDEX[name]];
}

// ─────────────────────────────────────────────────────────────────────────────
// The instance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One character's bones. Geometry and the rest table are shared across every
 * instance; only the Bone objects and the Skeleton are per-instance, because
 * those are what animate.
 */
export class RiderSkeleton {
  readonly bones: Bone[] = [];
  readonly skeleton: Skeleton;
  readonly root: Bone;

  constructor() {
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new Bone();
      b.name = BONE_NAMES[i];
      b.position.copy(REST.offset[i]);
      // Rest local rotation is identity by construction. See the header.
      this.bones.push(b);
    }
    for (let i = 0; i < BONE_COUNT; i++) {
      const p = REST.parents[i];
      if (p >= 0) this.bones[p].add(this.bones[i]);
    }
    this.root = this.bones[BONE_INDEX.pelvis];
    this.root.updateMatrixWorld(true);
    // Skeleton captures the inverse bind matrices from the bones' current world
    // matrices, which is why the root must be at the origin right now.
    this.skeleton = new Skeleton(this.bones);
  }

  bone(name: BoneName): Bone {
    return this.bones[BONE_INDEX[name]];
  }

  dispose(): void {
    this.skeleton.dispose();
  }
}
