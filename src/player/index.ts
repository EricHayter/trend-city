/**
 * The player — physics and rig, behind the one `IPlayer` handle the rest of the
 * game is allowed to hold.
 *
 * The split is deliberate. `PlayerPhysics` runs on the fixed 120 Hz step and
 * knows nothing about meshes; `CharacterRig` runs once per rendered frame on an
 * INTERPOLATED transform and knows nothing about collision. This file is the
 * only place that knows both exist.
 *
 * Interpolation is not cosmetic here. At 74 m/s a 120 Hz step covers 0.62 m, so
 * a rig drawn on the raw physics state judders by up to two thirds of a metre
 * whenever the display rate and the step rate beat against each other. `alpha`
 * blends the last two steps and removes exactly that.
 */

import { Group, Object3D, Vector3 } from 'three';

import { PlayerPhysics, type PlayerPhysicsOptions } from './PlayerPhysics';
import { CharacterRig, type CharacterRigOptions } from './CharacterRig';
import type {
  IPlayer, PlayerInput, PlayerState,
  ITraversal, IEnemyDirector, IAudio, IEffects,
} from '../game/Contracts';

export { PlayerPhysics } from './PlayerPhysics';
export { CharacterRig, createCharacterRig } from './CharacterRig';
export { CharacterSkeleton, REST, LIMB, FOOT, STANCE, BONE_INDEX } from './CharacterSkeleton';
export * from './SparkConstants';

export interface PlayerOptions extends PlayerPhysicsOptions {
  rig?: CharacterRigOptions;
}

const _lerpPos = new Vector3();

export class Player implements IPlayer {
  readonly object: Object3D;
  readonly physics: PlayerPhysics;
  readonly rig: CharacterRig;

  /**
   * The state the RIG sees: the live state with its transform replaced by the
   * interpolated one. Built once by shallow copy, so every vector the rig only
   * reads (velocity, normals, the attack block) stays aliased to the live state
   * and costs nothing per frame; only the three interpolated channels are owned.
   */
  private readonly visual: PlayerState;

  constructor(opts: PlayerOptions) {
    this.physics = new PlayerPhysics(opts);
    this.rig = new CharacterRig(opts.rig);

    const group = new Group();
    group.name = 'player';
    group.add(this.rig.object);
    this.object = group;

    this.visual = { ...this.physics.state };
    this.visual.position = new Vector3().copy(this.physics.state.position);
    this.visual.alignedUp = new Vector3().copy(this.physics.state.alignedUp);
  }

  get state(): PlayerState {
    return this.physics.state;
  }

  // ── Wiring. The physics reaches these subsystems; the rig never does. ──────
  setTraversal(t: ITraversal | null): void { this.physics.setTraversal(t); }
  setEnemies(d: IEnemyDirector | null): void { this.physics.setEnemies(d); }
  setAudio(a: IAudio | null): void { this.physics.setAudio(a); }
  setEffects(e: IEffects | null): void { this.physics.setEffects(e); }

  step(input: PlayerInput, dt: number): void {
    this.physics.step(input, dt);
  }

  updateVisual(alpha: number, dt: number, time: number): void {
    const s = this.physics.state;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

    _lerpPos.lerpVectors(this.physics.prevPosition, s.position, a);
    this.visual.position.copy(_lerpPos);
    this.visual.alignedUp.copy(this.physics.prevAlignedUp).lerp(s.alignedUp, a).normalize();

    // Facing is an angle, so it interpolates the short way round or the
    // character spins through 350 degrees every time it crosses the seam.
    let d = s.facing - this.physics.prevFacing;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.visual.facing = this.physics.prevFacing + d * a;

    // Scalars the rig reads. Copied rather than aliased because the shallow
    // clone froze them at construction.
    this.visual.mode = s.mode;
    this.visual.previousMode = s.previousMode;
    this.visual.modeTime = s.modeTime;
    this.visual.groundSpeed = s.groundSpeed;
    this.visual.speed = s.speed;
    this.visual.forwardSpeed = s.forwardSpeed;
    this.visual.gradient = s.gradient;
    this.visual.airHeight = s.airHeight;
    this.visual.airTime = s.airTime;
    this.visual.landedThisStep = s.landedThisStep;
    this.visual.landingImpact = s.landingImpact;
    this.visual.hardLanding = s.hardLanding;
    this.visual.boost = s.boost;
    this.visual.boosting = s.boosting;
    this.visual.health = s.health;
    this.visual.invulnTime = s.invulnTime;

    this.rig.update(this.visual, dt, time);
  }

  damage(amount: number, from: Vector3): boolean {
    return this.physics.damage(amount, from);
  }

  refreshAirCharges(): void {
    this.physics.refreshAirCharges();
  }

  reset(position: Vector3, facing: number): void {
    this.physics.reset(position, facing);
    this.visual.position.copy(this.physics.state.position);
    this.visual.alignedUp.copy(this.physics.state.alignedUp);
    this.visual.facing = facing;
  }

  finish(): void { this.physics.finish(); }
  addBoost(fraction: number): void { this.physics.addBoost(fraction); }
  heal(amount: number): void { this.physics.heal(amount); }

  dispose(): void {
    this.rig.dispose();
    this.object.parent?.remove(this.object);
  }
}

export function createPlayer(opts: PlayerOptions): Player {
  return new Player(opts);
}
