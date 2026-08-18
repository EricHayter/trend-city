import { Group, Mesh, Object3D, Vector3, Quaternion, ShaderMaterial, IcosahedronGeometry,
  CylinderGeometry, BoxGeometry, TorusGeometry, BufferGeometry } from 'three';
import { MaterialLibrary } from '../render/CelMaterial';
import { makeOutlineMaterial, prepareOutlineGeometry, attachOutline } from '../render/Outline';
import { LAYER_OUTLINE } from '../render/Pipeline';
import { taperBox, shard } from '../player/Rig';
import { EnemyKind, EnemySpawn } from '../world/Types';
import { PhysicsWorld } from '../world/Physics';
import { clamp, clamp01, damp, angleDamp, lerp, TAU } from '../core/MathX';
import { Rng } from '../core/Rng';

export interface EnemyStats { hp: number; radius: number; height: number; speed: number; damage: number; score: number; }

const STATS: Record<EnemyKind, EnemyStats> = {
  grunt:    { hp: 2, radius: 1.0, height: 2.0, speed: 9,  damage: 1, score: 100 },
  flyer:    { hp: 1, radius: 0.9, height: 1.6, speed: 7,  damage: 1, score: 120 },
  ranger:   { hp: 2, radius: 1.0, height: 1.8, speed: 5,  damage: 1, score: 150 },
  armored:  { hp: 5, radius: 1.3, height: 2.4, speed: 5,  damage: 1, score: 260 },
  pursuer:  { hp: 2, radius: 1.0, height: 1.8, speed: 22, damage: 1, score: 200 },
  turret:   { hp: 3, radius: 1.2, height: 2.2, speed: 0,  damage: 1, score: 180 },
  miniboss: { hp: 14, radius: 2.4, height: 4.4, speed: 8, damage: 2, score: 900 },
};

type Phase = 'idle' | 'alert' | 'telegraph' | 'attack' | 'recover' | 'hurt' | 'dead';

export class Enemy {
  kind: EnemyKind = 'grunt';
  group = new Group();
  pos = new Vector3();
  vel = new Vector3();
  home = new Vector3();
  hp = 1;
  maxHp = 1;
  alive = false;
  active = false;
  phase: Phase = 'idle';
  phaseTime = 0;
  facing = 0;
  flash = 0;
  hitStun = 0;
  bob = 0;
  traversal = false;
  patrol = 6;
  grounded = false;
  stats: EnemyStats = STATS.grunt;
  parts: { core?: Object3D; head?: Object3D; armL?: Object3D; armR?: Object3D; legL?: Object3D; legR?: Object3D; ring?: Object3D; shieldPlate?: Object3D } = {};
  materials: ShaderMaterial[] = [];
  deathTimer = 0;
}

/**
 * ENEMIES
 * Seven archetypes, all procedural, all animated, and all built to be traversal
 * furniture as much as obstacles: the flyers and pursuers on fast lines are placed so a
 * homing chain through them is faster than going around.
 */
export class EnemyManager {
  enemies: Enemy[] = [];
  root = new Group();
  private outlineMat: ShaderMaterial;
  private geoCache = new Map<string, BufferGeometry>();
  private rng = new Rng('enemies');
  onDeath: ((e: Enemy) => void) | null = null;
  onAttack: ((e: Enemy, dir: Vector3) => void) | null = null;
  onHit: ((e: Enemy, pos: Vector3) => void) | null = null;

  constructor(private lib: MaterialLibrary, private phys: PhysicsWorld) {
    this.outlineMat = makeOutlineMaterial(0x0a0618, 0x33205e, 2.4, 1.1);
    lib.all.push(this.outlineMat);
  }

  private geo(key: string, make: () => BufferGeometry): BufferGeometry {
    let g = this.geoCache.get(key);
    if (!g) { g = prepareOutlineGeometry(make()); this.geoCache.set(key, g); }
    return g;
  }

  private mk(geo: BufferGeometry, mat: ShaderMaterial, parent: Object3D, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    const twin = attachOutline(m, this.outlineMat);
    twin.layers.set(LAYER_OUTLINE);
    m.add(twin);
    return m;
  }

  /** Builds the body for an archetype. Shapes are chosen for silhouette legibility. */
  private build(e: Enemy) {
    const kind = e.kind;
    const g = e.group;
    while (g.children.length) g.remove(g.children[0]);
    const accent = kind === 'armored' ? 0xffb03a : kind === 'pursuer' ? 0xff3d9a : kind === 'ranger' ? 0xb6ff3d : 0x4de8ff;
    const shell = this.lib.get('enemy', { base: kind === 'armored' ? 0x6a5a8c : 0x4a3a72 }, 'enemyShell' + kind);
    const trim = this.lib.get('enemyTrim', { emissiveColor: accent, emissive: 0.8 }, 'enemyTrim' + kind);
    const dark = this.lib.get('enemy', { base: 0x281c4a }, 'enemyDark');
    e.materials = [shell, trim, dark];

    const box = (bw: number, bd: number, tw: number, td: number, h: number) =>
      this.geo('t' + [bw, bd, tw, td, h].join('_'), () => taperBox(bw, bd, tw, td, h));
    const sph = () => this.geo('sph', () => new IcosahedronGeometry(0.5, 1));
    const cyl = () => this.geo('cyl8', () => new CylinderGeometry(0.5, 0.5, 1, 8));
    const ring = () => this.geo('ring', () => new TorusGeometry(0.7, 0.16, 6, 14));
    const spike = () => this.geo('spike', () => shard(0.3, 0.3, 0.9));

    switch (kind) {
      case 'grunt': {
        const core = new Object3D(); core.position.y = 1.1; g.add(core); e.parts.core = core;
        this.mk(box(1.0, 0.8, 0.7, 0.6, 1.1), shell, core);
        this.mk(box(0.7, 0.6, 0.5, 0.4, 0.4), trim, core, 0, 0.66, 0.06);
        this.mk(spike(), trim, core, 0, 0.8, -0.1, 0.8, 0.8, 0.8);
        const legL = new Object3D(); legL.position.set(-0.3, -0.5, 0); core.add(legL); e.parts.legL = legL;
        const legR = new Object3D(); legR.position.set(0.3, -0.5, 0); core.add(legR); e.parts.legR = legR;
        this.mk(box(0.3, 0.3, 0.22, 0.22, 0.9), dark, legL, 0, -0.45, 0);
        this.mk(box(0.3, 0.3, 0.22, 0.22, 0.9), dark, legR, 0, -0.45, 0);
        const armL = new Object3D(); armL.position.set(-0.56, 0.36, 0); core.add(armL); e.parts.armL = armL;
        const armR = new Object3D(); armR.position.set(0.56, 0.36, 0); core.add(armR); e.parts.armR = armR;
        this.mk(box(0.28, 0.28, 0.36, 0.36, 0.8), shell, armL, 0, -0.4, 0);
        this.mk(box(0.28, 0.28, 0.36, 0.36, 0.8), shell, armR, 0, -0.4, 0);
        break;
      }
      case 'flyer': {
        const core = new Object3D(); core.position.y = 0.9; g.add(core); e.parts.core = core;
        this.mk(sph(), shell, core, 0, 0, 0, 1.5, 1.1, 1.5);
        this.mk(ring(), trim, core, 0, 0, 0, 1.3, 1.3, 1.3);
        this.mk(sph(), trim, core, 0, 0, 0.45, 0.5, 0.5, 0.5);
        const armL = new Object3D(); armL.position.set(-0.8, 0.1, 0); core.add(armL); e.parts.armL = armL;
        const armR = new Object3D(); armR.position.set(0.8, 0.1, 0); core.add(armR); e.parts.armR = armR;
        this.mk(spike(), trim, armL, 0, 0, 0, 0.9, 1.1, 0.9);
        this.mk(spike(), trim, armR, 0, 0, 0, 0.9, 1.1, 0.9);
        break;
      }
      case 'ranger': {
        const core = new Object3D(); core.position.y = 1.2; g.add(core); e.parts.core = core;
        this.mk(box(0.9, 0.7, 1.1, 0.8, 1.2), shell, core);
        this.mk(sph(), trim, core, 0, 0.4, 0.4, 0.6, 0.6, 0.6);
        const armR = new Object3D(); armR.position.set(0.62, 0.2, 0.1); core.add(armR); e.parts.armR = armR;
        this.mk(cyl(), dark, armR, 0, 0, 0.5, 0.34, 1.3, 0.34);
        this.mk(ring(), trim, armR, 0, 0, 1.0, 0.6, 0.6, 0.6);
        const legL = new Object3D(); legL.position.set(-0.3, -0.6, 0); core.add(legL); e.parts.legL = legL;
        const legR = new Object3D(); legR.position.set(0.3, -0.6, 0); core.add(legR); e.parts.legR = legR;
        this.mk(box(0.26, 0.26, 0.2, 0.2, 1.0), dark, legL, 0, -0.5, 0);
        this.mk(box(0.26, 0.26, 0.2, 0.2, 1.0), dark, legR, 0, -0.5, 0);
        break;
      }
      case 'armored': {
        const core = new Object3D(); core.position.y = 1.5; g.add(core); e.parts.core = core;
        this.mk(box(1.6, 1.2, 1.2, 1.0, 1.8), shell, core);
        const plate = this.mk(box(1.9, 0.5, 1.7, 0.4, 2.0), trim, core, 0, 0, 0.7);
        e.parts.shieldPlate = plate;
        this.mk(box(0.9, 0.7, 0.6, 0.5, 0.5), dark, core, 0, 1.05, 0);
        const legL = new Object3D(); legL.position.set(-0.5, -0.9, 0); core.add(legL); e.parts.legL = legL;
        const legR = new Object3D(); legR.position.set(0.5, -0.9, 0); core.add(legR); e.parts.legR = legR;
        this.mk(box(0.44, 0.44, 0.34, 0.34, 1.1), dark, legL, 0, -0.55, 0);
        this.mk(box(0.44, 0.44, 0.34, 0.34, 1.1), dark, legR, 0, -0.55, 0);
        break;
      }
      case 'pursuer': {
        const core = new Object3D(); core.position.y = 1.1; g.add(core); e.parts.core = core;
        this.mk(box(0.7, 1.4, 0.5, 1.0, 1.0), shell, core);
        this.mk(spike(), trim, core, 0, 0.1, 0.9, 1.1, 1.4, 1.1);
        this.mk(spike(), trim, core, -0.4, 0.5, -0.3, 0.7, 1.0, 0.7);
        this.mk(spike(), trim, core, 0.4, 0.5, -0.3, 0.7, 1.0, 0.7);
        const legL = new Object3D(); legL.position.set(-0.34, -0.5, 0); core.add(legL); e.parts.legL = legL;
        const legR = new Object3D(); legR.position.set(0.34, -0.5, 0); core.add(legR); e.parts.legR = legR;
        this.mk(box(0.24, 0.3, 0.18, 0.24, 1.0), dark, legL, 0, -0.5, 0);
        this.mk(box(0.24, 0.3, 0.18, 0.24, 1.0), dark, legR, 0, -0.5, 0);
        break;
      }
      case 'turret': {
        const core = new Object3D(); core.position.y = 0.9; g.add(core); e.parts.core = core;
        this.mk(cyl(), dark, g, 0, 0.4, 0, 1.6, 0.8, 1.6);
        const head = new Object3D(); head.position.y = 0.6; core.add(head); e.parts.head = head;
        this.mk(box(1.2, 1.0, 0.9, 0.8, 0.9), shell, head);
        this.mk(cyl(), trim, head, 0, 0.1, 0.8, 0.3, 1.2, 0.3);
        this.mk(ring(), trim, head, 0, 0.5, 0, 1.0, 1.0, 1.0);
        break;
      }
      case 'miniboss': {
        const core = new Object3D(); core.position.y = 2.6; g.add(core); e.parts.core = core;
        this.mk(box(2.6, 2.0, 1.8, 1.6, 2.6), shell, core);
        this.mk(box(1.4, 1.2, 1.0, 0.9, 0.9), trim, core, 0, 1.6, 0.1);
        this.mk(spike(), trim, core, -0.8, 1.5, -0.4, 1.4, 1.8, 1.4);
        this.mk(spike(), trim, core, 0.8, 1.5, -0.4, 1.4, 1.8, 1.4);
        const armL = new Object3D(); armL.position.set(-1.5, 0.9, 0); core.add(armL); e.parts.armL = armL;
        const armR = new Object3D(); armR.position.set(1.5, 0.9, 0); core.add(armR); e.parts.armR = armR;
        this.mk(box(0.7, 0.7, 1.1, 1.1, 1.9), shell, armL, 0, -0.9, 0);
        this.mk(box(0.7, 0.7, 1.1, 1.1, 1.9), shell, armR, 0, -0.9, 0);
        const legL = new Object3D(); legL.position.set(-0.8, -1.4, 0); core.add(legL); e.parts.legL = legL;
        const legR = new Object3D(); legR.position.set(0.8, -1.4, 0); core.add(legR); e.parts.legR = legR;
        this.mk(box(0.7, 0.7, 0.5, 0.5, 1.6), dark, legL, 0, -0.8, 0);
        this.mk(box(0.7, 0.7, 0.5, 0.5, 1.6), dark, legR, 0, -0.8, 0);
        this.mk(ring(), trim, core, 0, 0, 0, 2.6, 2.6, 2.6);
        break;
      }
    }
  }

  spawnAll(spawns: EnemySpawn[]) {
    this.enemies.length = 0;
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    for (const s of spawns) {
      const e = new Enemy();
      e.kind = s.kind;
      e.stats = STATS[s.kind];
      e.hp = e.maxHp = e.stats.hp;
      e.pos.copy(s.pos);
      e.home.copy(s.pos);
      e.traversal = s.traversal;
      e.patrol = s.patrol;
      e.alive = true;
      this.build(e);
      e.group.position.copy(e.pos);
      e.group.visible = false;
      this.root.add(e.group);
      this.enemies.push(e);
    }
  }

  /** Homing target search: the cone test is generous, because chaining should feel kind. */
  findTarget(from: Vector3, dir: Vector3, range: number, cone: number): { pos: Vector3; id: number } | null {
    let best: Enemy | null = null;
    let bestScore = -Infinity;
    let bestIndex = -1;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive || !e.active) continue;
      _v.subVectors(e.pos, from);
      const d = _v.length();
      if (d > range || d < 1.2) continue;
      _v.divideScalar(d);
      const facing = _v.dot(dir);
      if (facing < cone) continue;
      const score = facing * 2 - d / range;
      if (score > bestScore) { bestScore = score; best = e; bestIndex = i; }
    }
    if (!best) return null;
    return { pos: _target.copy(best.pos).setY(best.pos.y + best.stats.height * 0.5), id: bestIndex };
  }

  damage(index: number, amount: number, fromPos: Vector3, knock = 10): boolean {
    const e = this.enemies[index];
    if (!e || !e.alive) return false;
    // The armoured archetype ignores frontal light hits: attack from behind or above.
    if (e.kind === 'armored') {
      _v.subVectors(fromPos, e.pos).setY(0).normalize();
      _v2.set(Math.sin(e.facing), 0, Math.cos(e.facing));
      if (_v.dot(_v2) > 0.35 && amount < 3) {
        e.flash = 0.3;
        if (this.onHit) this.onHit(e, e.pos);
        return false;
      }
    }
    e.hp -= amount;
    e.flash = 1;
    e.hitStun = 0.16;
    e.phase = 'hurt';
    e.phaseTime = 0;
    _v.subVectors(e.pos, fromPos).setY(0.3).normalize().multiplyScalar(knock);
    e.vel.add(_v);
    if (this.onHit) this.onHit(e, e.pos);
    if (e.hp <= 0) {
      e.alive = false;
      e.phase = 'dead';
      e.deathTimer = 0.34;
      if (this.onDeath) this.onDeath(e);
      return true;
    }
    return false;
  }

  /** Enemies only think when they are near the player: 40 archetypes, 18 brains. */
  update(dt: number, playerPos: Vector3, playerVel: Vector3, activateRadius = 150) {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const dist = e.pos.distanceTo(playerPos);
      const shouldActive = dist < activateRadius && (e.alive || e.deathTimer > 0);
      if (shouldActive !== e.active) {
        e.active = shouldActive;
        e.group.visible = shouldActive;
      }
      if (!e.active) continue;
      if (!e.alive) {
        e.deathTimer -= dt;
        const t = clamp01(e.deathTimer / 0.34);
        e.group.scale.setScalar(Math.max(0.001, t * (1 + (1 - t) * 1.6)));
        e.group.rotation.y += dt * 14;
        if (e.deathTimer <= 0) { e.group.visible = false; e.active = false; }
        continue;
      }
      this.think(e, dt, dist, playerPos, playerVel);
      this.animate(e, dt);
      for (const m of e.materials) m.uniforms.uFlash.value = e.flash;
      e.flash = Math.max(0, e.flash - dt * 5);
    }
  }

  private think(e: Enemy, dt: number, dist: number, playerPos: Vector3, playerVel: Vector3) {
    e.phaseTime += dt;
    e.hitStun = Math.max(0, e.hitStun - dt);
    const s = e.stats;
    const flying = e.kind === 'flyer';
    const wantFace = Math.atan2(playerPos.x - e.pos.x, playerPos.z - e.pos.z);

    if (e.hitStun > 0) {
      e.pos.addScaledVector(e.vel, dt);
      e.vel.multiplyScalar(Math.exp(-4 * dt));
      if (!flying) e.vel.y -= 40 * dt;
      this.ground(e, dt);
      return;
    }

    switch (e.kind) {
      case 'turret': {
        e.facing = angleDamp(e.facing, wantFace, 3.2, dt);
        if (dist < 60) {
          if (e.phase === 'idle' || e.phase === 'alert') { e.phase = 'telegraph'; e.phaseTime = 0; }
          if (e.phase === 'telegraph' && e.phaseTime > 0.7) {
            e.phase = 'attack'; e.phaseTime = 0;
            _v.subVectors(playerPos, e.pos).normalize();
            if (this.onAttack) this.onAttack(e, _v);
          }
          if (e.phase === 'attack' && e.phaseTime > 0.5) { e.phase = 'alert'; e.phaseTime = 0; }
        } else e.phase = 'idle';
        break;
      }
      case 'ranger': {
        e.facing = angleDamp(e.facing, wantFace, 4, dt);
        // Keeps distance: backs off when the player closes in.
        const want = 22;
        _v.subVectors(e.pos, playerPos).setY(0);
        const d = _v.length() || 1;
        _v.divideScalar(d);
        const move = clamp((want - d) * 0.4, -1, 1);
        e.vel.x = _v.x * move * s.speed;
        e.vel.z = _v.z * move * s.speed;
        if (dist < 70) {
          if (e.phase !== 'telegraph' && e.phase !== 'attack') { e.phase = 'telegraph'; e.phaseTime = 0; }
          if (e.phase === 'telegraph' && e.phaseTime > 0.85) {
            e.phase = 'attack'; e.phaseTime = 0;
            _v2.subVectors(playerPos, e.pos).addScaledVector(playerVel, 0.22).normalize();
            if (this.onAttack) this.onAttack(e, _v2);
          }
          if (e.phase === 'attack' && e.phaseTime > 0.6) { e.phase = 'alert'; e.phaseTime = 0; }
        }
        e.vel.y -= 40 * dt;
        e.pos.addScaledVector(e.vel, dt);
        this.ground(e, dt);
        break;
      }
      case 'flyer': {
        e.facing = angleDamp(e.facing, wantFace, 3, dt);
        e.bob += dt;
        // Hovers near its post, dives when the player is close and below.
        _v.copy(e.home);
        _v.y += Math.sin(e.bob * 1.7) * 1.4;
        if (dist < 26 && e.phase !== 'attack') { e.phase = 'telegraph'; }
        if (e.phase === 'telegraph' && e.phaseTime > 0.5) {
          e.phase = 'attack'; e.phaseTime = 0;
          _v2.subVectors(playerPos, e.pos).normalize();
          e.vel.copy(_v2).multiplyScalar(26);
        }
        if (e.phase === 'attack') {
          e.pos.addScaledVector(e.vel, dt);
          e.vel.multiplyScalar(Math.exp(-1.6 * dt));
          if (e.phaseTime > 0.9) { e.phase = 'recover'; e.phaseTime = 0; }
        } else if (e.phase === 'recover') {
          e.pos.lerp(_v, 1 - Math.exp(-2.4 * dt));
          if (e.phaseTime > 1.1) { e.phase = 'idle'; e.phaseTime = 0; }
        } else {
          e.pos.lerp(_v, 1 - Math.exp(-3.4 * dt));
        }
        break;
      }
      case 'pursuer': {
        e.facing = angleDamp(e.facing, wantFace, 6, dt);
        if (dist < 70) {
          _v.subVectors(playerPos, e.pos).setY(0).normalize();
          const charge = e.phase === 'attack' ? 2.2 : 1;
          e.vel.x = damp(e.vel.x, _v.x * s.speed * charge, 6, dt);
          e.vel.z = damp(e.vel.z, _v.z * s.speed * charge, 6, dt);
          if (dist < 16 && e.phase === 'idle') { e.phase = 'telegraph'; e.phaseTime = 0; }
          if (e.phase === 'telegraph' && e.phaseTime > 0.34) { e.phase = 'attack'; e.phaseTime = 0; }
          if (e.phase === 'attack' && e.phaseTime > 0.7) { e.phase = 'idle'; e.phaseTime = 0; }
        } else {
          e.vel.x = damp(e.vel.x, 0, 4, dt);
          e.vel.z = damp(e.vel.z, 0, 4, dt);
        }
        e.vel.y -= 46 * dt;
        e.pos.addScaledVector(e.vel, dt);
        this.ground(e, dt);
        break;
      }
      default: {
        // grunt, armored, miniboss: patrol, then advance and swing.
        e.facing = angleDamp(e.facing, wantFace, e.kind === 'miniboss' ? 2.6 : 4, dt);
        if (dist < 44) {
          _v.subVectors(playerPos, e.pos).setY(0).normalize();
          const stop = e.kind === 'miniboss' ? 5 : 3.2;
          const move = dist > stop ? 1 : -0.2;
          e.vel.x = damp(e.vel.x, _v.x * s.speed * move, 5, dt);
          e.vel.z = damp(e.vel.z, _v.z * s.speed * move, 5, dt);
          if (dist < stop + 2.4) {
            if (e.phase === 'idle' || e.phase === 'alert') { e.phase = 'telegraph'; e.phaseTime = 0; }
            if (e.phase === 'telegraph' && e.phaseTime > (e.kind === 'miniboss' ? 0.7 : 0.5)) {
              e.phase = 'attack'; e.phaseTime = 0;
              _v2.set(Math.sin(e.facing), 0, Math.cos(e.facing));
              if (this.onAttack) this.onAttack(e, _v2);
            }
            if (e.phase === 'attack' && e.phaseTime > 0.45) { e.phase = 'recover'; e.phaseTime = 0; }
            if (e.phase === 'recover' && e.phaseTime > 0.4) { e.phase = 'alert'; e.phaseTime = 0; }
          }
        } else {
          // Patrol around the post so idle enemies still have life.
          const t = performance.now() * 0.0004 + e.home.x;
          _v.set(e.home.x + Math.sin(t) * e.patrol, e.pos.y, e.home.z + Math.cos(t * 0.8) * e.patrol);
          _v.sub(e.pos).setY(0);
          if (_v.length() > 0.6) {
            _v.normalize();
            e.vel.x = damp(e.vel.x, _v.x * s.speed * 0.4, 3, dt);
            e.vel.z = damp(e.vel.z, _v.z * s.speed * 0.4, 3, dt);
            e.facing = angleDamp(e.facing, Math.atan2(_v.x, _v.z), 2.4, dt);
          }
          e.phase = 'idle';
        }
        e.vel.y -= 46 * dt;
        e.pos.addScaledVector(e.vel, dt);
        this.ground(e, dt);
        break;
      }
    }
    e.group.position.copy(e.pos);
    e.group.rotation.y = e.facing;
  }

  private ground(e: Enemy, dt: number) {
    const probe = this.phys.groundHeight(e.pos.x, e.pos.z, e.pos.y + 2.5, 14);
    if (probe.y !== -Infinity && e.pos.y <= probe.y + 0.1) {
      e.pos.y = probe.y;
      e.vel.y = 0;
      e.grounded = true;
    } else e.grounded = false;
    if (e.pos.y < -400) { e.alive = false; e.active = false; e.group.visible = false; }
  }

  /** Procedural animation per archetype: telegraphs are readable at a glance. */
  private animate(e: Enemy, dt: number) {
    const p = e.parts;
    const t = performance.now() * 0.001;
    const tel = e.phase === 'telegraph' ? clamp01(e.phaseTime / 0.55) : 0;
    const atk = e.phase === 'attack' ? clamp01(e.phaseTime / 0.4) : 0;
    const speed = Math.hypot(e.vel.x, e.vel.z);
    const stride = Math.sin(t * (4 + speed * 0.5)) * clamp01(speed / 8);

    if (p.core) {
      p.core.rotation.x = damp(p.core.rotation.x, -tel * 0.34 + atk * 0.5, 16, dt);
      p.core.position.y = (e.kind === 'flyer' ? 0.9 : e.kind === 'miniboss' ? 2.6 : e.kind === 'armored' ? 1.5 : e.kind === 'ranger' ? 1.2 : 1.1)
        + (e.kind === 'flyer' ? Math.sin(t * 2.6) * 0.18 : Math.abs(stride) * 0.08 - tel * 0.16);
      p.core.scale.set(1 + tel * 0.12 - atk * 0.1, 1 - tel * 0.14 + atk * 0.12, 1 + tel * 0.12 - atk * 0.1);
    }
    if (p.legL && p.legR) {
      p.legL.rotation.x = stride * 0.7;
      p.legR.rotation.x = -stride * 0.7;
    }
    if (p.armL && p.armR) {
      const swing = e.kind === 'flyer' ? Math.sin(t * 9) * 0.4 + tel * 0.6 : -stride * 0.5 - tel * 1.4 + atk * 2.2;
      p.armL.rotation.x = damp(p.armL.rotation.x, swing, 18, dt);
      p.armR.rotation.x = damp(p.armR.rotation.x, swing, 18, dt);
      p.armL.rotation.z = damp(p.armL.rotation.z, tel * 0.5, 12, dt);
      p.armR.rotation.z = damp(p.armR.rotation.z, -tel * 0.5, 12, dt);
    }
    if (p.head) p.head.rotation.y = Math.sin(t * 1.6) * 0.2 - tel * 0.1;
    if (p.shieldPlate) p.shieldPlate.position.z = 0.7 + tel * 0.2;
    if (e.kind === 'flyer' && p.core) p.core.rotation.y += dt * (2 + tel * 8);
  }

  get aliveCount() { let n = 0; for (const e of this.enemies) if (e.alive) n++; return n; }
}

const _v = new Vector3();
const _v2 = new Vector3();
const _target = new Vector3();
