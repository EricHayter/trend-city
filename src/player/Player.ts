import { Vector3, Quaternion, Group } from 'three';
import { MOVE, COMBAT } from './Tuning';
import { Rig } from './Rig';
import { Animator, AnimState } from './Anim';
import { PhysicsWorld, HitResult, newHitResult } from '../world/Physics';
import { Rail, Solid } from '../world/Types';
import { Input } from '../core/Input';
import { clamp, clamp01, damp, angleDamp, lerp, wrapAngle, smoothstep } from '../core/MathX';

export interface HomingTarget { pos: Vector3; id: number; }

export interface PlayerHooks {
  findHoming(from: Vector3, dir: Vector3, range: number, cone: number): HomingTarget | null;
  onHomingHit(id: number, pos: Vector3): void;
  onMelee(combo: number, pos: Vector3, dir: Vector3, aerial: boolean): void;
  onCharged(pos: Vector3, dir: Vector3): void;
  onSlam(pos: Vector3, power: number): void;
  onLand(hard: boolean, impactSpeed: number, pos: Vector3, normal: Vector3): void;
  onJump(kind: 'single' | 'double' | 'wall' | 'bounce' | 'launch', pos: Vector3): void;
  onDash(air: boolean, pos: Vector3, dir: Vector3): void;
  onBoostChange(active: boolean): void;
  onWallRun(active: boolean, pos: Vector3, normal: Vector3): void;
  onGrind(active: boolean, pos: Vector3): void;
  onBreak(solid: Solid, pos: Vector3): void;
  onHurt(amount: number, pos: Vector3): void;
  onFootstep(pos: Vector3, speed: number): void;
  onSurfaceFx(pos: Vector3, dir: Vector3, speed: number, kind: string): void;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _low = new Vector3();
const _high = new Vector3();
const _tang = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * THE PLAYER
 * One controller owns position, velocity and state. Every mechanic is written to feed
 * the next one: slopes write into speed, speed writes into jump arcs, rails write into
 * launch height, homing writes into air momentum. Nothing resets velocity to zero
 * unless the player asked for it.
 */
export class Player {
  pos = new Vector3();
  vel = new Vector3();
  facing = 0;
  turnRate = 0;
  grounded = false;
  groundNormal = new Vector3(0, 1, 0);
  groundSolid: Solid | null = null;
  state: AnimState = 'idle';
  anim: Animator;
  hit: HitResult = newHitResult();

  health = MOVE.maxHealth;
  boost = MOVE.boostMax;
  boosting = false;
  invuln = 0;
  dead = false;

  // timers
  private coyote = 0;
  private jumpBuf = 0;
  private airJumps = 1;
  private airDashes = MOVE.airDashCharges;
  private dashTimer = 0;
  private dashCd = 0;
  private slideTimer = 0;
  private wallTimer = 0;
  private wallCd = 0;
  private landTimer = 0;
  private attackTimer = 0;
  private comboTimer = 0;
  private chargeTime = 0;
  private hurtTimer = 0;
  private poundTimer = 0;
  private homingTarget: HomingTarget | null = null;
  private grindRail: Rail | null = null;
  private grindT = 0;
  private grindDir = 1;
  private grindCd = 0;
  private wallNormal = new Vector3();
  private wallSide = 1;
  private footPhase = 0;
  combo = 0;
  style = 0;
  styleRank = 0;
  airTime = 0;
  lastImpactSpeed = 0;
  peakSpeed = 0;
  distanceTravelled = 0;
  chainCount = 0;
  private chainTimer = 0;

  constructor(public rig: Rig, public phys: PhysicsWorld, public hooks: PlayerHooks) {
    this.anim = new Animator(rig);
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get group(): Group { return this.rig.group; }
  get isGrinding() { return !!this.grindRail; }
  get isWallRunning() { return this.wallTimer > 0; }
  get isAttacking() { return this.attackTimer > 0; }

  spawn(pos: Vector3, heading: number) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.facing = heading;
    this.health = MOVE.maxHealth;
    this.boost = MOVE.boostMax;
    this.dead = false;
    this.combo = 0; this.style = 0; this.styleRank = 0;
    this.grindRail = null;
    this.wallTimer = 0;
    this.airJumps = 1;
    this.airDashes = MOVE.airDashCharges;
    this.state = 'idle';
    this.anim.set('idle');
    this.peakSpeed = 0;
    this.distanceTravelled = 0;
  }

  hurt(amount: number, fromPos: Vector3) {
    if (this.invuln > 0 || this.dead) return;
    this.health -= amount;
    this.invuln = MOVE.hitInvuln;
    this.combo = 0;
    this.style = Math.max(0, this.style - 40);
    _v.subVectors(this.pos, fromPos).setY(0);
    if (_v.lengthSq() < 0.01) _v.set(-Math.sin(this.facing), 0, -Math.cos(this.facing));
    _v.normalize().multiplyScalar(MOVE.knockback);
    this.vel.x = _v.x; this.vel.z = _v.z;
    this.vel.y = 12;
    this.grindRail = null;
    this.wallTimer = 0;
    this.hurtTimer = 0.5;
    this.anim.set(amount > 1 ? 'knock' : 'damage');
    this.anim.impact(0.35);
    this.rig.setFlash(1, 0xff3d5a);
    this.hooks.onHurt(amount, this.pos);
    if (this.health <= 0) this.dead = true;
  }

  /** Boost meter is also the reward currency: pickups and style feed it. */
  addBoost(v: number) { this.boost = clamp(this.boost + v, 0, MOVE.boostMax); }
  addStyle(v: number) {
    this.style += v;
    this.chainCount++;
    this.chainTimer = 2.2;
    this.styleRank = this.style > 900 ? 5 : this.style > 600 ? 4 : this.style > 380 ? 3 : this.style > 200 ? 2 : this.style > 80 ? 1 : 0;
  }

  update(dt: number, input: Input, camYaw: number) {
    if (this.dead) { this.updateVisual(dt); return; }
    const M = MOVE;
    const prevY = this.vel.y;
    const wasGrounded = this.grounded;

    this.invuln = Math.max(0, this.invuln - dt);
    this.rig.setFlash(Math.max(0, (this.invuln - MOVE.hitInvuln + 0.18) * 5), 0xff3d5a);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.wallCd = Math.max(0, this.wallCd - dt);
    this.grindCd = Math.max(0, this.grindCd - dt);
    this.landTimer = Math.max(0, this.landTimer - dt);
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    this.chainTimer = Math.max(0, this.chainTimer - dt);
    if (this.chainTimer <= 0) this.chainCount = 0;
    if (this.comboTimer <= 0) this.combo = 0;
    this.style = Math.max(0, this.style - COMBAT.styleDecay * dt);

    // ---- desired direction in camera space -------------------------------
    const wantX = input.moveX, wantZ = input.moveY;
    const hasInput = Math.abs(wantX) + Math.abs(wantZ) > 0.1;
    _v.set(0, 0, 0);
    if (hasInput) {
      const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
      _v.set(wantX * cos + wantZ * sin, 0, -wantX * sin + wantZ * cos).normalize();
    }
    const wantYaw = hasInput ? Math.atan2(_v.x, _v.z) : this.facing;

    // ---- input buffering --------------------------------------------------
    if (input.pressed('jump')) this.jumpBuf = M.jumpBuffer;
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);

    // ---- state routing -----------------------------------------------------
    if (this.hurtTimer > 0) {
      this.integrate(dt, M.gravity);
    } else if (this.grindRail) {
      this.updateGrind(dt, input);
    } else if (this.wallTimer > 0) {
      this.updateWallRun(dt, input, _v, hasInput);
    } else if (this.homingTarget) {
      this.updateHoming(dt);
    } else if (this.dashTimer > 0) {
      this.updateDash(dt, input);
    } else if (this.poundTimer > 0) {
      this.updatePound(dt);
    } else {
      this.updateNormal(dt, input, _v, hasInput, wantYaw, camYaw);
    }

    // ---- collision ---------------------------------------------------------
    this.collide(dt);

    // ---- landing resolution (sequenced, not simultaneous) -----------------
    if (!wasGrounded && this.grounded) {
      const impact = Math.abs(prevY);
      this.lastImpactSpeed = impact;
      const hard = impact > M.hardLandingSpeed;
      this.airJumps = 1;
      this.airDashes = M.airDashCharges;
      this.landTimer = hard ? M.hardLandRecover : M.landRecover;
      this.anim.set(hard ? 'hardLand' : 'land');
      this.anim.impact(hard ? 0.42 : 0.16 + clamp01(impact / 60) * 0.15);
      this.hooks.onLand(hard, impact, this.pos, this.groundNormal);
      if (this.airTime > 0.7) this.addStyle(12);
      this.airTime = 0;
    }
    if (!this.grounded) this.airTime += dt;

    // Bounce surfaces read as part of the movement system, not as a script.
    if (this.grounded && this.groundSolid && this.groundSolid.bounce > 0) {
      this.vel.y = this.groundSolid.bounce;
      this.grounded = false;
      this.airJumps = 1;
      this.anim.set('jump');
      this.anim.impact(0.3);
      this.hooks.onJump('bounce', this.pos);
      this.addStyle(8);
    }

    if (this.hit.hazard && this.invuln <= 0) this.hurt(1, _v2.copy(this.pos).addScaledVector(this.vel, -0.1));

    // ---- boost meter -------------------------------------------------------
    const wantBoost = input.held('boost') && this.boost > 1 && !this.dead;
    if (wantBoost !== this.boosting) {
      this.boosting = wantBoost;
      this.hooks.onBoostChange(wantBoost);
    }
    if (this.boosting) this.boost = Math.max(0, this.boost - M.boostDrain * dt);
    else this.boost = Math.min(M.boostMax, this.boost + M.boostRegen * dt * (this.grounded ? 1 : 0.55));

    // ---- attacks -----------------------------------------------------------
    this.updateAttacks(dt, input);

    this.peakSpeed = Math.max(this.peakSpeed, this.speed);
    this.distanceTravelled += this.speed * dt;
    this.updateVisual(dt);
  }

  // -------------------------------------------------------------------------
  private updateNormal(dt: number, input: Input, dir: Vector3, hasInput: boolean, wantYaw: number, camYaw: number) {
    const M = MOVE;
    const sp = this.speed;

    // Turning: fast movement turns slower. This is what makes speed feel committed.
    const turnSpeed = lerp(M.turnRate, M.turnRateFast, clamp01(sp / M.hardCap));
    const prevFacing = this.facing;
    if (hasInput) this.facing = angleDamp(this.facing, wantYaw, turnSpeed * (this.grounded ? 1 : M.airControl), dt);
    this.turnRate = wrapAngle(this.facing - prevFacing) / Math.max(dt, 1e-4);

    const target = this.boosting ? M.boostSpeed : input.held('dash') || sp > M.runSpeed + 2 ? M.sprintSpeed : M.runSpeed;
    const accel = (this.grounded ? M.accel : M.accelAir) * (this.boosting ? 1.7 : 1);

    _v.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    if (hasInput) {
      // Accelerate along facing, and steer existing velocity toward it.
      const cur = _v2.set(this.vel.x, 0, this.vel.z);
      const along = cur.dot(_v);
      const newAlong = Math.min(Math.max(along + accel * dt, -M.hardCap), Math.max(target, along + accel * dt));
      const lateral = _v3.copy(cur).addScaledVector(_v, -along);
      const lateralKeep = this.grounded ? Math.exp(-9 * dt) : Math.exp(-2.4 * dt);
      this.vel.x = _v.x * newAlong + lateral.x * lateralKeep;
      this.vel.z = _v.z * newAlong + lateral.z * lateralKeep;
    } else if (this.grounded) {
      const dec = (input.held('slide') ? M.brakeDecel : M.frictionDecel) * dt;
      const cur = Math.hypot(this.vel.x, this.vel.z);
      const next = Math.max(0, cur - dec);
      if (cur > 1e-4) { this.vel.x *= next / cur; this.vel.z *= next / cur; }
    }

    // Braking read: holding back at speed.
    const backwards = hasInput && this.speed > M.runSpeed && _v2.set(this.vel.x, 0, this.vel.z).normalize().dot(dir) < -0.25;

    // ---- SLOPES ------------------------------------------------------------
    // Gravity is projected onto the contact plane. Downhill gives real acceleration,
    // uphill costs real speed, and both feed straight into jump arcs.
    if (this.grounded) {
      const n = this.groundNormal;
      const slope = 1 - n.y;
      if (slope > 0.02) {
        _tang.set(n.x, 0, n.z).normalize();
        const downhill = _tang.dot(_v2.set(this.vel.x, 0, this.vel.z).normalize()) > 0;
        const gain = M.slopeAccel * slope * dt;
        if (downhill) {
          this.vel.x += _tang.x * gain;
          this.vel.z += _tang.z * gain;
        } else {
          const cur = Math.hypot(this.vel.x, this.vel.z);
          const next = Math.max(0, cur - M.slopeBrake * slope * dt);
          if (cur > 1e-4) { this.vel.x *= next / cur; this.vel.z *= next / cur; }
        }
      }
      // Momentum surfaces: panels, ducts, boost strips.
      const s = this.groundSolid;
      if (s && s.boost !== 1) {
        const cur = Math.hypot(this.vel.x, this.vel.z);
        if (s.boost > 1 && cur > 2) {
          const goal = Math.min(M.hardCap, cur * s.boost);
          const nv = Math.min(goal, cur + 60 * dt * (s.boost - 1) * 4);
          this.vel.x *= nv / cur; this.vel.z *= nv / cur;
          if (s.boost > 2) { this.hooks.onSurfaceFx(this.pos, _v, nv, 'booster'); this.addStyle(2 * dt * 60); }
        }
      }
    }

    // Speed cap, applied last so slopes and boosters can exceed sprint but not the cap.
    const cur = Math.hypot(this.vel.x, this.vel.z);
    if (cur > M.hardCap) { this.vel.x *= M.hardCap / cur; this.vel.z *= M.hardCap / cur; }

    // ---- jump --------------------------------------------------------------
    if (this.grounded) this.coyote = M.coyoteTime; else this.coyote = Math.max(0, this.coyote - dt);
    if (this.jumpBuf > 0 && (this.grounded || this.coyote > 0)) {
      this.jumpBuf = 0; this.coyote = 0;
      // Leaving a downslope converts the surface angle into a taller arc.
      const slopeBonus = this.grounded ? clamp01((1 - this.groundNormal.y) * 2.4) : 0;
      this.vel.y = M.jumpSpeed * (1 + slopeBonus * (M.slopeLaunchBoost - 1) * 3);
      this.grounded = false;
      this.anim.set('jump');
      this.anim.impact(0.12);
      this.hooks.onJump('single', this.pos);
    } else if (this.jumpBuf > 0 && this.airJumps > 0) {
      this.jumpBuf = 0;
      this.airJumps--;
      this.vel.y = M.doubleJumpSpeed;
      this.anim.set('double');
      this.hooks.onJump('double', this.pos);
      this.addStyle(4);
    }
    if (input.released('jump') && this.vel.y > 0 && !this.grounded) this.vel.y *= M.jumpCutMul;

    // ---- dashes ------------------------------------------------------------
    if (input.pressed('dash') && this.dashCd <= 0) {
      if (this.grounded) {
        this.dashTimer = M.groundDashTime;
        this.dashCd = M.dashCooldown;
        this.anim.set('dash');
        this.hooks.onDash(false, this.pos, _v);
        this.addStyle(6);
      } else if (this.airDashes > 0) {
        // Homing takes priority when a target is in front: traversal, not just combat.
        const t = this.hooks.findHoming(this.pos, _v, M.homingRange, M.homingCone);
        if (t) {
          this.homingTarget = t;
          this.anim.set('homing');
          this.hooks.onDash(true, this.pos, _v);
        } else {
          this.airDashes--;
          this.dashTimer = M.airDashTime;
          this.dashCd = M.dashCooldown;
          this.vel.y = Math.max(this.vel.y, 2);
          this.anim.set('airDash');
          this.hooks.onDash(true, this.pos, _v);
          this.addStyle(5);
        }
      }
    }

    // ---- slide and ground pound -------------------------------------------
    if (input.pressed('slide')) {
      if (this.grounded && this.speed > M.slideSpeedMin) {
        this.slideTimer = M.slideTime;
        const c = Math.hypot(this.vel.x, this.vel.z);
        const nv = Math.min(M.hardCap, c + M.slideBoost);
        this.vel.x *= nv / c; this.vel.z *= nv / c;
        this.anim.set('slide');
        this.hooks.onSurfaceFx(this.pos, _v, nv, 'slide');
        this.addStyle(5);
      } else if (!this.grounded) {
        this.poundTimer = 0.6;
        this.vel.set(this.vel.x * 0.2, -M.groundPoundSpeed, this.vel.z * 0.2);
        this.anim.set('pound');
      }
    }
    if (this.slideTimer > 0) {
      this.slideTimer -= dt;
      const c = Math.hypot(this.vel.x, this.vel.z);
      const next = Math.max(0, c - M.slideFriction * dt);
      if (c > 1e-4) { this.vel.x *= next / c; this.vel.z *= next / c; }
      if (this.grounded) this.hooks.onSurfaceFx(this.pos, _v, c, 'slide');
      if (this.slideTimer <= 0 || !this.grounded || c < 8) this.slideTimer = 0;
    }

    // ---- rail snap ---------------------------------------------------------
    if (this.grindCd <= 0) this.trySnapRail();

    // ---- wall run ----------------------------------------------------------
    if (!this.grounded && this.wallCd <= 0 && this.speed > M.wallRunMinSpeed && this.hit.wall && this.hit.wallSolid && this.hit.wallSolid.wallrun) {
      this.wallNormal.copy(this.hit.wallNormal);
      _v2.set(-this.wallNormal.z, 0, this.wallNormal.x);
      if (_v2.dot(_v3.set(this.vel.x, 0, this.vel.z)) < 0) _v2.negate();
      this.wallSide = _v2.cross(this.wallNormal).y > 0 ? 1 : -1;
      this.wallTimer = M.wallRunTime;
      this.anim.set('wallRun');
      this.anim.handSide = this.wallNormal.x * Math.cos(this.facing) - this.wallNormal.z * Math.sin(this.facing) > 0 ? -1 : 1;
      this.hooks.onWallRun(true, this.pos, this.wallNormal);
      this.addStyle(8);
    }

    this.integrate(dt, this.vel.y < 0 ? M.gravity * M.fallGravityMul : M.gravity);

    // ---- animation state selection ----------------------------------------
    if (this.attackTimer > 0) {
      // Attack animation owns the body while it is active.
    } else if (this.landTimer > 0) {
      // Landing recovery holds its pose.
    } else if (this.slideTimer > 0) {
      this.anim.set('slide');
    } else if (!this.grounded) {
      if (this.vel.y < -4 && this.anim.state !== 'double') this.anim.set('fall');
    } else if (backwards) {
      this.anim.set('brake');
    } else if (this.boosting && this.speed > M.sprintSpeed * 0.8) {
      this.anim.set('boost');
    } else if (this.speed > M.runSpeed + 4) {
      this.anim.set('sprint');
    } else if (this.speed > 1.4) {
      this.anim.set('run');
    } else {
      this.anim.set('idle');
    }
  }

  private integrate(dt: number, gravity: number) {
    if (!this.grounded) {
      this.vel.y = Math.max(-MOVE.terminalFall, this.vel.y - gravity * dt);
    } else if (this.vel.y < 0) {
      this.vel.y = 0;
    }
    this.pos.addScaledVector(this.vel, dt);
  }

  private updateDash(dt: number, input: Input) {
    const M = MOVE;
    this.dashTimer -= dt;
    const air = this.anim.state === 'airDash';
    const speed = air ? M.airDashSpeed : M.groundDashSpeed;
    _v.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    this.vel.x = _v.x * speed;
    this.vel.z = _v.z * speed;
    if (air) this.vel.y = damp(this.vel.y, 0, 12, dt);
    this.integrate(dt, air ? 0 : M.gravity);
    this.hooks.onSurfaceFx(this.pos, _v, speed, air ? 'airdash' : 'dash');
    if (this.dashTimer <= 0) {
      // Dash exits into whatever the player is already doing: no dead stop.
      const keep = air ? 0.72 : 0.9;
      this.vel.x *= keep; this.vel.z *= keep;
    }
  }

  private updateHoming(dt: number) {
    const M = MOVE;
    const t = this.homingTarget!;
    _v.subVectors(t.pos, this.pos);
    const dist = _v.length();
    if (dist < 2.2 || dist > M.homingRange * 1.8) {
      if (dist < 2.2) {
        this.hooks.onHomingHit(t.id, t.pos);
        // Bounce keeps vertical momentum and preserves horizontal speed: chains work.
        this.vel.y = M.homingBounce;
        this.airJumps = 1;
        this.airDashes = M.airDashCharges;
        this.anim.impact(0.28);
        this.addStyle(20);
        this.anim.set('aerial');
        this.attackTimer = 0.18;
      }
      this.homingTarget = null;
      return;
    }
    _v.divideScalar(dist);
    this.facing = Math.atan2(_v.x, _v.z);
    this.vel.copy(_v).multiplyScalar(M.homingSpeed);
    this.pos.addScaledVector(this.vel, dt);
    this.hooks.onSurfaceFx(this.pos, _v, M.homingSpeed, 'homing');
  }

  private updatePound(dt: number) {
    this.poundTimer -= dt;
    this.vel.y = -MOVE.groundPoundSpeed;
    this.integrate(dt, 0);
    if (this.grounded || this.poundTimer <= 0) {
      if (this.grounded) {
        this.hooks.onSlam(this.pos, 1);
        this.anim.set('hardLand');
        this.anim.impact(0.5);
        this.addStyle(14);
      }
      this.poundTimer = 0;
    }
  }

  private updateWallRun(dt: number, input: Input, dir: Vector3, hasInput: boolean) {
    const M = MOVE;
    this.wallTimer -= dt;
    // Stick to the wall, run along its tangent, and bleed vertical slowly.
    _v2.set(-this.wallNormal.z, 0, this.wallNormal.x);
    if (_v2.dot(_v3.set(Math.sin(this.facing), 0, Math.cos(this.facing))) < 0) _v2.negate();
    const along = Math.max(M.wallRunMinSpeed, Math.hypot(this.vel.x, this.vel.z));
    this.vel.x = _v2.x * along - this.wallNormal.x * M.wallRunStick;
    this.vel.z = _v2.z * along - this.wallNormal.z * M.wallRunStick;
    this.vel.y = Math.max(this.vel.y - M.wallRunGravity * dt, -14);
    this.facing = angleDamp(this.facing, Math.atan2(_v2.x, _v2.z), 14, dt);
    this.pos.addScaledVector(this.vel, dt);
    // Pin the inside hand to the wall so the contact never looks fake.
    _v3.copy(this.pos).addScaledVector(this.wallNormal, -0.5).setY(this.pos.y + 1.3);
    this.anim.handTarget = _v3.clone();
    this.hooks.onSurfaceFx(this.pos, _v2, along, 'wallrun');

    const bail = this.jumpBuf > 0;
    if (bail || this.wallTimer <= 0 || this.grounded) {
      if (bail) {
        this.jumpBuf = 0;
        this.vel.x = _v2.x * along * 0.85 + this.wallNormal.x * M.wallJumpOut;
        this.vel.z = _v2.z * along * 0.85 + this.wallNormal.z * M.wallJumpOut;
        this.vel.y = M.wallJumpUp;
        this.facing = Math.atan2(this.vel.x, this.vel.z);
        this.anim.set('wallJump');
        this.anim.impact(0.18);
        this.hooks.onJump('wall', this.pos);
        this.airJumps = 1;
        this.airDashes = M.airDashCharges;
        this.addStyle(12);
      }
      this.wallTimer = 0;
      this.wallCd = 0.22;
      this.anim.handTarget = null;
      this.hooks.onWallRun(false, this.pos, this.wallNormal);
    }
  }

  private railQuery = { rail: null as Rail | null, t: 0, point: new Vector3(), dist: Infinity };

  private trySnapRail() {
    const q = this.phys.nearestRail(this.pos, 2.6, this.railQuery);
    if (!q.rail) return;
    // Only snap when arriving from above or at speed: rails should feel earned.
    if (this.vel.y > 6) return;
    const rail = q.rail;
    this.grindRail = rail;
    this.grindT = q.t;
    _v.copy(this.vel).setY(0);
    this.grindDir = this.railTangent(rail, q.t, _v2).dot(_v) >= 0 ? 1 : -1;
    this.grindSpeed = Math.max(MOVE.grindMin, Math.hypot(this.vel.x, this.vel.z));
    this.anim.set('grind');
    this.anim.impact(0.14);
    this.airJumps = 1;
    this.airDashes = MOVE.airDashCharges;
    this.hooks.onGrind(true, q.point);
    this.addStyle(10);
  }

  private grindSpeed = 20;

  private railTangent(rail: Rail, t: number, out: Vector3): Vector3 {
    for (let i = 1; i < rail.points.length; i++) {
      if (t <= rail.lengths[i] || i === rail.points.length - 1) {
        out.subVectors(rail.points[i], rail.points[i - 1]).normalize();
        return out;
      }
    }
    return out.set(0, 0, 1);
  }

  private railPoint(rail: Rail, t: number, out: Vector3): Vector3 {
    const clamped = clamp(t, 0, rail.total);
    for (let i = 1; i < rail.points.length; i++) {
      if (clamped <= rail.lengths[i]) {
        const seg = rail.lengths[i] - rail.lengths[i - 1];
        const u = seg > 0 ? (clamped - rail.lengths[i - 1]) / seg : 0;
        return out.copy(rail.points[i - 1]).lerp(rail.points[i], u);
      }
    }
    return out.copy(rail.points[rail.points.length - 1]);
  }

  private updateGrind(dt: number, input: Input) {
    const M = MOVE;
    const rail = this.grindRail!;
    this.railTangent(rail, this.grindT, _tang);
    // Rails obey gravity along their slope: downhill rails are the fast line.
    const slope = -_tang.y * this.grindDir;
    this.grindSpeed = clamp(this.grindSpeed + (slope * 34 + (rail.boost - 1) * 60 + (this.boosting ? M.boostAccel * 0.4 : 0)) * dt, M.grindMin, M.grindMax);
    this.grindT += this.grindSpeed * this.grindDir * dt;
    const end = this.grindT <= 0 || this.grindT >= rail.total;
    this.railPoint(rail, this.grindT, _v);
    this.pos.copy(_v).setY(_v.y + 0.1);
    this.vel.copy(_tang).multiplyScalar(this.grindSpeed * this.grindDir);
    this.facing = angleDamp(this.facing, Math.atan2(this.vel.x, this.vel.z), 16, dt);
    this.turnRate = 0;
    this.grounded = false;
    // Feet pinned to the rail line.
    this.anim.handTarget = null;
    this.hooks.onSurfaceFx(this.pos, _tang, this.grindSpeed, 'grind');

    if (this.jumpBuf > 0) {
      this.jumpBuf = 0;
      this.vel.y = M.jumpSpeed * 1.05;
      this.exitGrind(true);
      this.anim.set('jump');
      this.hooks.onJump('single', this.pos);
      this.addStyle(8);
      return;
    }
    if (end) {
      // Launch at the end of a rail: momentum becomes altitude.
      this.vel.y = Math.max(this.vel.y, rail.launchAtEnd);
      this.exitGrind(rail.launchAtEnd > 4);
      if (rail.launchAtEnd > 4) { this.hooks.onJump('launch', this.pos); this.addStyle(10); }
    }
  }

  private exitGrind(launch: boolean) {
    this.hooks.onGrind(false, this.pos);
    this.grindRail = null;
    this.grindCd = 0.28;
    this.anim.set(launch ? 'jump' : 'fall');
  }

  private updateAttacks(dt: number, input: Input) {
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    if (input.held('attack')) this.chargeTime += dt; 
    if (input.released('attack') && this.chargeTime > COMBAT.chargeTime) {
      _v.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.hooks.onCharged(this.pos, _v);
      this.anim.set('melee3');
      this.attackTimer = 0.34;
      this.anim.impact(0.24);
      this.chargeTime = 0;
      this.addStyle(18);
      return;
    }
    if (input.released('attack')) this.chargeTime = 0;
    if (!input.pressed('attack')) return;
    if (this.attackTimer > 0.12) return;

    _v.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    const aerial = !this.grounded;
    if (this.dashTimer > 0) {
      // Dash attack: the dash carries through the hit.
      this.hooks.onMelee(3, this.pos, _v, aerial);
      this.anim.set('melee3');
      this.attackTimer = 0.24;
      this.addStyle(10);
      return;
    }
    this.combo = this.comboTimer > 0 ? Math.min(3, this.combo + 1) : 1;
    this.comboTimer = COMBAT.comboWindow;
    this.attackTimer = this.combo === 3 ? 0.32 : 0.22;
    this.anim.set(aerial ? 'aerial' : (this.combo === 1 ? 'melee1' : this.combo === 2 ? 'melee2' : 'melee3'));
    this.anim.impact(0.1 + this.combo * 0.04);
    // Attacks nudge the player forward: combat never kills momentum outright.
    const push = aerial ? 6 : 8 + this.combo * 2;
    this.vel.x += _v.x * push * 0.5;
    this.vel.z += _v.z * push * 0.5;
    this.hooks.onMelee(this.combo, this.pos, _v, aerial);
    this.addStyle(6 + this.combo * 3);
  }

  private collide(dt: number) {
    const r = MOVE.radius;
    _low.copy(this.pos).setY(this.pos.y + r);
    this.phys.resolveSphere(_low, r, this.hit, 3);
    this.pos.y = _low.y - r;
    this.pos.x = _low.x;
    this.pos.z = _low.z;
    this.grounded = this.hit.grounded;
    if (this.grounded) {
      this.groundNormal.copy(this.hit.groundNormal);
      this.groundSolid = this.hit.groundSolid;
      // Moving platforms carry the player.
      const s = this.groundSolid;
      if (s && s.moving) {
        this.pos.x += s.moving.velocity.x * dt;
        this.pos.z += s.moving.velocity.z * dt;
        this.pos.y += Math.max(0, s.moving.velocity.y * dt);
      }
    } else {
      this.groundNormal.lerp(UP, 0.2);
      this.groundSolid = null;
    }
    // Upper body sphere: keeps the character from clipping into overhangs.
    _high.copy(this.pos).setY(this.pos.y + MOVE.height - r * 0.9);
    const upperHit = newHitResultCache;
    this.phys.resolveSphere(_high, r * 0.92, upperHit, 2);
    this.pos.x = _high.x;
    this.pos.z = _high.z;
    if (upperHit.ceiling && this.vel.y > 0) this.vel.y = 0;
    if (upperHit.wall) { this.hit.wall = true; this.hit.wallNormal.copy(upperHit.wallNormal); this.hit.wallSolid = upperHit.wallSolid; }
    if (upperHit.hazard) this.hit.hazard = true;

    // Breakables: run through them, keep the speed, get the style.
    const solid = this.hit.wallSolid || this.hit.groundSolid;
    if (solid && solid.breakable && !solid.broken && this.speed > 14) {
      solid.broken = true;
      this.hooks.onBreak(solid, solid.center);
      this.addStyle(6);
    }
  }

  private updateVisual(dt: number) {
    const g = this.rig.group;
    g.position.copy(this.pos);
    g.rotation.y = this.facing;
    // Footstep events drive dust and audio, phase-locked to the actual stride.
    if (this.grounded && this.speed > 3) {
      const stride = clamp(1.2 + this.speed * 0.055, 1.3, 3.1);
      this.footPhase += (this.speed / stride) * dt;
      if (this.footPhase > 0.5) {
        this.footPhase -= 0.5;
        this.hooks.onFootstep(this.pos, this.speed);
      }
    }
    this.anim.update(dt, this.speed, this.vel.y, this.turnRate, this.grounded, this.groundNormal,
      clamp(this.speed / MOVE.hardCap, 0, 1) * 0.34);
    this.state = this.anim.state;
  }
}

const newHitResultCache = newHitResult();
