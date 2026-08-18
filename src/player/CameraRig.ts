import { PerspectiveCamera, Vector3, Quaternion, MathUtils } from 'three';
import { Player } from './Player';
import { PhysicsWorld } from '../world/Physics';
import { MOVE } from './Tuning';
import { clamp, clamp01, damp, angleDamp, lerp, spring, wrapAngle, smoothstep } from '../core/MathX';

const _v = new Vector3();
const _v2 = new Vector3();
const _target = new Vector3();
const _desired = new Vector3();
const UP = new Vector3(0, 1, 0);

export type CamMode = 'chase' | 'orbit' | 'setpiece' | 'boss' | 'results';

/**
 * THIRD PERSON CAMERA
 * Spring-damped chase with a deliberate cinematic vocabulary: it lengthens and lowers
 * with speed, banks into turns, leads the player by velocity, kicks FOV on acceleration,
 * takes a hard punch on impacts, swings wide during set pieces, and recovers smoothly
 * rather than snapping back.
 */
export class CameraRig {
  camera = new PerspectiveCamera(62, 16 / 9, 0.4, 2400);
  mode: CamMode = 'chase';
  yaw = 0;
  private pitch = 0.18;
  private dist = 9.5;
  private distSpring = { v: 0 };
  private heightSpring = { v: 0 };
  private height = 3.4;
  private posSmooth = new Vector3();
  private lookSmooth = new Vector3();
  private bank = 0;
  private fov = 62;
  private shakeAmp = 0;
  private shakeTime = 0;
  private manualYaw = 0;
  private cineTimer = 0;
  private cineYaw = 0;
  private cineDist = 0;
  private cineHeight = 0;
  private initialised = false;
  fovKick = 0;

  constructor() {
    this.camera.position.set(0, 5, -12);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  shake(amount: number) {
    this.shakeAmp = Math.min(2.4, this.shakeAmp + amount);
  }

  /** Set-piece framing: swing to an offset angle and hold it, then blend back. */
  cinematic(seconds: number, yawOffset: number, distance: number, height: number) {
    this.cineTimer = seconds;
    this.cineYaw = yawOffset;
    this.cineDist = distance;
    this.cineHeight = height;
  }

  nudgeYaw(delta: number) { this.manualYaw += delta; }

  snapTo(player: Player) {
    this.yaw = player.facing;
    this.posSmooth.copy(player.pos).addScaledVector(_v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), -this.dist).setY(player.pos.y + this.height);
    this.camera.position.copy(this.posSmooth);
    this.lookSmooth.copy(player.pos).setY(player.pos.y + 1.5);
    this.initialised = true;
  }

  update(dt: number, player: Player, phys: PhysicsWorld, bossPos?: Vector3) {
    const speedN = clamp01(player.speed / MOVE.boostSpeed);
    const boostN = player.boosting ? 1 : 0;

    // ---- orientation -------------------------------------------------------
    // The camera follows the direction of travel, not the input, so hard turns read as
    // the world swinging past rather than the stick yanking the view.
    let targetYaw = player.facing;
    if (player.speed > 6) {
      _v.set(player.vel.x, 0, player.vel.z).normalize();
      targetYaw = Math.atan2(_v.x, _v.z);
    }
    targetYaw += this.manualYaw;
    this.manualYaw = damp(this.manualYaw, 0, 1.6, dt);

    if (this.cineTimer > 0) {
      this.cineTimer -= dt;
      targetYaw += this.cineYaw;
    }

    const yawRate = lerp(4.6, 8.2, speedN);
    this.yaw = angleDamp(this.yaw, targetYaw, yawRate, dt);

    // ---- distance and height ----------------------------------------------
    let wantDist = lerp(8.6, 13.4, speedN) + boostN * 1.6;
    let wantHeight = lerp(3.5, 2.5, speedN);
    if (player.state === 'slide') { wantHeight -= 0.8; wantDist -= 1.2; }
    if (player.isGrinding) { wantDist += 1.4; wantHeight += 0.5; }
    if (!player.grounded && player.vel.y < -30) { wantHeight += 1.6; wantDist += 1.0; }
    if (this.cineTimer > 0) { wantDist = this.cineDist; wantHeight = this.cineHeight; }
    if (this.mode === 'boss' && bossPos) {
      // Frame the boss and the player together: distance grows with their separation.
      const sep = player.pos.distanceTo(bossPos);
      wantDist = clamp(sep * 0.55 + 9, 12, 34);
      wantHeight = 5.5;
    }
    this.dist = spring(this.dist, this.distSpring, wantDist, 90, 15, dt);
    this.height = spring(this.height, this.heightSpring, wantHeight, 110, 17, dt);

    // ---- banking -----------------------------------------------------------
    const bankTarget = clamp(-player.turnRate * 0.055 * (0.35 + speedN), -0.34, 0.34);
    this.bank = damp(this.bank, bankTarget, 6, dt);

    // ---- look target with velocity lead ------------------------------------
    _target.copy(player.pos);
    _target.y += 1.55 + speedN * 0.5;
    _v.set(player.vel.x, player.vel.y * 0.35, player.vel.z).multiplyScalar(0.14 * (0.5 + speedN));
    _target.add(_v);
    if (this.mode === 'boss' && bossPos) _target.lerp(bossPos, 0.34);
    this.lookSmooth.lerp(_target, 1 - Math.exp(-14 * dt));

    // ---- desired camera position -------------------------------------------
    const pitch = this.pitch + (player.vel.y < -20 ? 0.1 : 0) + (this.mode === 'boss' ? 0.05 : 0);
    _desired.set(
      player.pos.x - Math.sin(this.yaw) * this.dist,
      player.pos.y + this.height + this.dist * pitch,
      player.pos.z - Math.cos(this.yaw) * this.dist,
    );

    // ---- collision avoidance ------------------------------------------------
    _v.copy(_desired).sub(this.lookSmooth);
    const wantLen = _v.length();
    _v.divideScalar(wantLen || 1);
    const clear = phys.raycastFirst(this.lookSmooth, _v, wantLen);
    if (clear < wantLen) _desired.copy(this.lookSmooth).addScaledVector(_v, Math.max(2.6, clear - 0.4));

    // Positional spring: tight at speed so the camera never lags behind the player.
    const follow = lerp(9, 17, speedN);
    this.posSmooth.lerp(_desired, 1 - Math.exp(-follow * dt));

    // ---- shake -------------------------------------------------------------
    this.shakeTime += dt;
    this.shakeAmp = damp(this.shakeAmp, 0, 7, dt);
    const s = this.shakeAmp;
    const sx = Math.sin(this.shakeTime * 61.3) * s * 0.34;
    const sy = Math.sin(this.shakeTime * 47.7 + 1.3) * s * 0.3;

    this.camera.position.copy(this.posSmooth);
    this.camera.position.x += sx;
    this.camera.position.y += sy;
    this.camera.up.set(Math.sin(this.bank), Math.cos(this.bank), 0).applyAxisAngle(UP, this.yaw);
    this.camera.lookAt(this.lookSmooth);

    // ---- FOV ---------------------------------------------------------------
    // FOV leads acceleration, not raw speed, so it punches on the change and settles.
    const wantFov = 60 + speedN * 16 + boostN * 6 + this.fovKick;
    this.fov = damp(this.fov, wantFov, 7, dt);
    this.fovKick = damp(this.fovKick, 0, 5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Orbiting showcase camera used by the title screen and the results screen. */
  orbit(dt: number, center: Vector3, radius: number, height: number, speed = 0.14) {
    this.yaw += dt * speed;
    this.camera.position.set(center.x + Math.sin(this.yaw) * radius, center.y + height, center.z + Math.cos(this.yaw) * radius);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
    if (this.camera.fov !== 54) { this.camera.fov = 54; this.camera.updateProjectionMatrix(); }
  }
}
