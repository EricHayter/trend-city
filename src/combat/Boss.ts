import { Group, Mesh, Object3D, Vector3, Quaternion, ShaderMaterial, IcosahedronGeometry,
  TorusGeometry, CylinderGeometry, BufferGeometry } from 'three';
import { MaterialLibrary } from '../render/CelMaterial';
import { makeOutlineMaterial, prepareOutlineGeometry, attachOutline } from '../render/Outline';
import { LAYER_OUTLINE } from '../render/Pipeline';
import { taperBox, shard } from '../player/Rig';
import { clamp, clamp01, damp, angleDamp, lerp, TAU, smoothstep } from '../core/MathX';

export type BossPhase = 0 | 1 | 2 | 3 | 4;   // 0 = dormant, 4 = defeated
export type BossAttack = 'none' | 'volley' | 'beam' | 'slam' | 'charge' | 'rain' | 'stagger';

export interface BossHooks {
  fireOrb(pos: Vector3, dir: Vector3, speed: number, size: number): void;
  shockwave(pos: Vector3, radius: number, power: number): void;
  beamDanger(from: Vector3, dir: Vector3, length: number, width: number): void;
  onTelegraph(kind: BossAttack, pos: Vector3): void;
  onImpact(pos: Vector3, power: number): void;
  onPhase(phase: BossPhase): void;
  onDefeated(): void;
  onHit(pos: Vector3, weak: boolean): void;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();

/**
 * THE HALCYON WARDEN
 * A three phase construct that fights by controlling space, so the player has to keep
 * moving through the arena instead of standing and trading hits. Phase one exposes
 * orbiting nodes that can only be reached with a homing chain off the arena rail; phase
 * two grounds it into charges and slams that must be wall-run and jumped; phase three
 * opens the core but rains fire across the plate.
 */
export class Boss {
  group = new Group();
  pos = new Vector3();
  center = new Vector3();
  hp = 100;
  maxHp = 100;
  phase: BossPhase = 0;
  attack: BossAttack = 'none';
  attackTime = 0;
  cooldown = 2;
  coreExposed = false;
  coreTimer = 0;
  active = false;
  defeatTimer = 0;
  flash = 0;
  private hover = 16;
  private angle = 0;
  private bob = 0;
  private mats: ShaderMaterial[] = [];
  private coreMat: ShaderMaterial;
  private core: Object3D;
  private crown: Object3D;
  private armL: Object3D;
  private armR: Object3D;
  private shell: Object3D;
  private nodes: { obj: Object3D; alive: boolean; angle: number; hp: number }[] = [];
  private telegraphed = false;
  private chargeDir = new Vector3();
  private outlineMat: ShaderMaterial;

  constructor(private lib: MaterialLibrary, private hooks: BossHooks) {
    this.outlineMat = makeOutlineMaterial(0x08040f, 0x2a1050, 3.1, 1.3);
    lib.all.push(this.outlineMat);
    const shellMat = lib.get('boss', { base: 0xcfc4f2 }, 'bossShell');
    const dark = lib.get('boss', { base: 0x3a2a6e }, 'bossDark');
    const trim = lib.get('bossCore', { emissiveColor: 0x4de8ff, emissive: 1.3 }, 'bossTrim');
    this.coreMat = lib.get('bossCore', { emissiveColor: 0xff3d9a, emissive: 1.9 }, 'bossCore');
    this.mats = [shellMat, dark, trim, this.coreMat];

    const mk = (geo: BufferGeometry, mat: ShaderMaterial, parent: Object3D, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
      prepareOutlineGeometry(geo);
      const m = new Mesh(geo, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      parent.add(m);
      const twin = attachOutline(m, this.outlineMat);
      twin.layers.set(LAYER_OUTLINE);
      m.add(twin);
      return m;
    };

    // Silhouette: a broad inverted keystone body, a floating crown, and long claw arms.
    this.shell = new Object3D();
    this.group.add(this.shell);
    mk(taperBox(11, 7, 6.4, 4.2, 7.4), shellMat, this.shell, 0, 0, 0);
    mk(taperBox(7.4, 5, 9.6, 6.2, 2.2), dark, this.shell, 0, 4.2, 0);
    mk(shard(4.2, 3.4, 6.4), shellMat, this.shell, 0, -3.4, 0.4);
    mk(shard(2.2, 1.8, 3.6), trim, this.shell, -4.4, -1.8, 0);
    mk(shard(2.2, 1.8, 3.6), trim, this.shell, 4.4, -1.8, 0);

    this.core = new Object3D();
    this.core.position.set(0, 0.4, 2.6);
    this.shell.add(this.core);
    mk(new IcosahedronGeometry(2.1, 1), this.coreMat, this.core);
    mk(new TorusGeometry(2.9, 0.34, 6, 18), trim, this.core, 0, 0, 0);

    this.crown = new Object3D();
    this.crown.position.y = 7.4;
    this.group.add(this.crown);
    mk(new TorusGeometry(7.4, 0.6, 6, 26), trim, this.crown);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      mk(shard(1.4, 1.4, 3.4), dark, this.crown, Math.sin(a) * 7.4, 0, Math.cos(a) * 7.4);
    }

    const arm = (side: number) => {
      const root = new Object3D();
      root.position.set(side * 6.2, 2.2, 0);
      this.shell.add(root);
      mk(taperBox(2.4, 2.4, 1.6, 1.6, 7.4), shellMat, root, 0, -3.4, 0);
      const fore = new Object3D();
      fore.position.y = -7.2;
      root.add(fore);
      mk(taperBox(1.8, 1.8, 2.6, 2.6, 6.4), dark, fore, 0, -3.2, 0);
      mk(shard(2.6, 2.6, 4.4), trim, fore, 0, -6.6, 0);
      return root;
    };
    this.armL = arm(-1);
    this.armR = arm(1);

    // Phase one weak points: three nodes on a wide orbit, reachable only by chaining.
    for (let i = 0; i < 3; i++) {
      const obj = new Object3D();
      this.group.add(obj);
      const holder = new Object3D();
      holder.position.set(0, 0, 15);
      obj.add(holder);
      mk(new IcosahedronGeometry(1.9, 1), this.coreMat, holder);
      mk(new TorusGeometry(2.6, 0.28, 6, 14), trim, holder, 0, 0, 0);
      this.nodes.push({ obj, alive: true, angle: (i / 3) * TAU, hp: 3 });
    }

    this.group.visible = false;
  }

  begin(center: Vector3) {
    this.center.copy(center);
    this.pos.copy(center).setY(center.y + this.hover);
    this.group.position.copy(this.pos);
    this.group.visible = true;
    this.active = true;
    this.phase = 1;
    this.hp = this.maxHp = 100;
    this.attack = 'none';
    this.cooldown = 2.4;
    for (const n of this.nodes) { n.alive = true; n.hp = 3; n.obj.visible = true; }
    this.hooks.onPhase(1);
  }

  /** Homing targets: nodes in phase one, the core when it is open, otherwise nothing. */
  targets(out: { pos: Vector3; id: number }[]): number {
    let n = 0;
    if (!this.active || this.phase >= 4) return 0;
    if (this.phase === 1) {
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i];
        if (!node.alive) continue;
        node.obj.children[0].getWorldPosition(_v);
        out[n] = { pos: _v.clone(), id: 1000 + i };
        n++;
      }
    } else if (this.coreExposed) {
      this.core.getWorldPosition(_v);
      out[n] = { pos: _v.clone(), id: 999 };
      n++;
    }
    return n;
  }

  hit(id: number, amount: number): boolean {
    if (!this.active || this.phase >= 4) return false;
    if (id >= 1000) {
      const node = this.nodes[id - 1000];
      if (!node || !node.alive) return false;
      node.hp -= amount;
      this.flash = 1;
      node.obj.children[0].getWorldPosition(_v);
      this.hooks.onHit(_v, true);
      if (node.hp <= 0) {
        node.alive = false;
        node.obj.visible = false;
        this.hp -= 12;
        this.hooks.onImpact(_v, 1.4);
        if (!this.nodes.some((x) => x.alive)) this.enterPhase(2);
      }
      return true;
    }
    if (!this.coreExposed) return false;
    this.hp -= amount * 4;
    this.flash = 1;
    this.core.getWorldPosition(_v);
    this.hooks.onHit(_v, true);
    this.coreTimer = Math.min(this.coreTimer, 0.4);
    if (this.hp <= 0) this.defeat();
    else if (this.hp < 34 && this.phase === 2) this.enterPhase(3);
    return true;
  }

  private enterPhase(p: BossPhase) {
    this.phase = p;
    this.attack = 'stagger';
    this.attackTime = 0;
    this.cooldown = 1.6;
    this.telegraphed = false;
    if (p === 2) this.hp = Math.min(this.hp, 72);
    this.hooks.onPhase(p);
  }

  private defeat() {
    this.phase = 4;
    this.attack = 'none';
    this.defeatTimer = 3.4;
    this.hooks.onDefeated();
  }

  update(dt: number, playerPos: Vector3) {
    if (!this.active) return;
    this.bob += dt;
    this.flash = Math.max(0, this.flash - dt * 4);
    for (const m of this.mats) m.uniforms.uFlash.value = this.flash * 0.8;

    if (this.phase === 4) {
      // DEFEAT: the construct sags, spins down, and comes apart in stages.
      this.defeatTimer -= dt;
      const t = clamp01(1 - this.defeatTimer / 3.4);
      this.group.rotation.z = Math.sin(t * 9) * 0.2 * (1 - t);
      this.group.rotation.y += dt * (1.4 + t * 8);
      this.pos.y = damp(this.pos.y, this.center.y + 2, 1.2, dt);
      this.group.position.copy(this.pos);
      this.shell.scale.setScalar(1 + Math.sin(t * 30) * 0.03 * (1 - t));
      this.crown.position.y = damp(this.crown.position.y, 18, 0.8, dt);
      this.coreMat.uniforms.uEmissive.value = 1.9 + Math.sin(t * 40) * 1.4;
      if (this.defeatTimer <= 0) { this.group.visible = false; this.active = false; }
      return;
    }

    // Node orbit: wide, tilted, and fast enough that they must be chained, not walked to.
    for (const n of this.nodes) {
      if (!n.alive) continue;
      n.angle += dt * (0.7 + this.phase * 0.16);
      n.obj.rotation.y = n.angle;
      n.obj.rotation.x = Math.sin(n.angle * 0.7) * 0.34;
      n.obj.children[0].rotation.y += dt * 3;
    }

    this.crown.rotation.y += dt * 0.5;
    this.core.rotation.y += dt * 1.4;
    this.coreMat.uniforms.uEmissive.value = this.coreExposed ? 2.6 + Math.sin(this.bob * 14) * 0.7 : 1.1;

    if (this.coreTimer > 0) {
      this.coreTimer -= dt;
      if (this.coreTimer <= 0) this.coreExposed = false;
    }

    // ---- movement ----------------------------------------------------------
    const wantHover = this.phase === 1 ? 18 : this.phase === 2 ? 11 : 13;
    this.hover = damp(this.hover, wantHover, 1.4, dt);
    if (this.attack !== 'charge') {
      this.angle += dt * (this.phase === 3 ? 0.42 : 0.24);
      const orbit = this.phase === 1 ? 26 : 18;
      _v.set(this.center.x + Math.sin(this.angle) * orbit, this.center.y + this.hover + Math.sin(this.bob * 0.9) * 1.6, this.center.z + Math.cos(this.angle) * orbit);
      this.pos.lerp(_v, 1 - Math.exp(-1.6 * dt));
    }
    const faceTarget = Math.atan2(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
    this.group.rotation.y = angleDamp(this.group.rotation.y, faceTarget, 2.4, dt);
    this.group.position.copy(this.pos);
    this.shell.position.y = Math.sin(this.bob * 1.1) * 0.6;

    // ---- attack scheduling --------------------------------------------------
    this.attackTime += dt;
    if (this.attack === 'none' || this.attack === 'stagger') {
      this.armL.rotation.x = damp(this.armL.rotation.x, 0.1, 5, dt);
      this.armR.rotation.x = damp(this.armR.rotation.x, 0.1, 5, dt);
      this.cooldown -= dt;
      if (this.attack === 'stagger' && this.attackTime > 1.4) this.attack = 'none';
      if (this.cooldown <= 0 && this.attack === 'none') this.pickAttack(playerPos);
      return;
    }

    switch (this.attack) {
      case 'volley': {
        // Telegraph: arms rise and the core charges. Then a spread of tracking orbs.
        this.armL.rotation.x = damp(this.armL.rotation.x, -1.1, 8, dt);
        this.armR.rotation.x = damp(this.armR.rotation.x, -1.1, 8, dt);
        if (!this.telegraphed && this.attackTime > 0.05) { this.telegraphed = true; this.hooks.onTelegraph('volley', this.pos); }
        if (this.attackTime > 0.9) {
          const shots = this.phase === 3 ? 7 : 5;
          for (let i = 0; i < shots; i++) {
            _v.subVectors(playerPos, this.pos).normalize();
            const spread = (i - (shots - 1) / 2) * 0.13;
            _v2.set(_v.x * Math.cos(spread) - _v.z * Math.sin(spread), _v.y, _v.x * Math.sin(spread) + _v.z * Math.cos(spread));
            this.hooks.fireOrb(_v.copy(this.pos).setY(this.pos.y - 2), _v2, 34 + this.phase * 4, 1.1);
          }
          this.endAttack(1.5);
        }
        break;
      }
      case 'beam': {
        // A sweeping beam across the plate: the arena rail and pylons are the answer.
        if (!this.telegraphed) { this.telegraphed = true; this.hooks.onTelegraph('beam', this.pos); }
        const t = this.attackTime;
        if (t > 1.1) {
          const sweep = (t - 1.1) / 1.6;
          const a = this.group.rotation.y - 0.9 + sweep * 1.8;
          _v2.set(Math.sin(a), -0.34, Math.cos(a)).normalize();
          this.hooks.beamDanger(_v.copy(this.pos), _v2, 110, 3.4);
          this.armL.rotation.x = damp(this.armL.rotation.x, -1.5, 10, dt);
          this.armR.rotation.x = damp(this.armR.rotation.x, -1.5, 10, dt);
          if (sweep >= 1) { this.expose(2.2); this.endAttack(1.8); }
        }
        break;
      }
      case 'slam': {
        // Rise, hold, then drive both arms down. Shockwave rings must be jumped.
        if (!this.telegraphed) { this.telegraphed = true; this.hooks.onTelegraph('slam', this.pos); }
        if (this.attackTime < 0.8) {
          this.pos.y = damp(this.pos.y, this.center.y + this.hover + 9, 6, dt);
          this.armL.rotation.x = damp(this.armL.rotation.x, -1.9, 9, dt);
          this.armR.rotation.x = damp(this.armR.rotation.x, -1.9, 9, dt);
        } else if (this.attackTime < 1.05) {
          this.pos.y = damp(this.pos.y, this.center.y + 3.4, 26, dt);
          this.armL.rotation.x = damp(this.armL.rotation.x, 0.7, 26, dt);
          this.armR.rotation.x = damp(this.armR.rotation.x, 0.7, 26, dt);
        } else {
          if (this.attackTime < 1.12) {
            this.hooks.shockwave(_v.copy(this.center).setY(this.center.y), 16, 1);
            this.hooks.onImpact(_v, 2.2);
          }
          this.expose(2.6);
          this.endAttack(2.0);
        }
        break;
      }
      case 'charge': {
        if (!this.telegraphed) {
          this.telegraphed = true;
          this.chargeDir.subVectors(playerPos, this.pos).setY(0).normalize();
          this.hooks.onTelegraph('charge', this.pos);
        }
        if (this.attackTime > 0.7) {
          this.pos.addScaledVector(this.chargeDir, 62 * dt);
          this.pos.y = damp(this.pos.y, this.center.y + 5.4, 8, dt);
          this.hooks.shockwave(_v.copy(this.pos).setY(this.center.y), 7, 0.6);
          if (this.pos.distanceTo(this.center) > 62) {
            this.hooks.onImpact(this.pos, 1.8);
            this.expose(2.4);
            this.endAttack(1.6);
          }
        } else {
          this.pos.addScaledVector(this.chargeDir, -8 * dt);
        }
        break;
      }
      case 'rain': {
        if (!this.telegraphed) { this.telegraphed = true; this.hooks.onTelegraph('rain', this.pos); }
        if (this.attackTime > 0.7 && this.attackTime < 2.4) {
          if (Math.random() < dt * 14) {
            const a = Math.random() * TAU, r = Math.random() * 48;
            _v.set(this.center.x + Math.sin(a) * r, this.pos.y + 6, this.center.z + Math.cos(a) * r);
            this.hooks.fireOrb(_v, _v2.set(0, -1, 0), 44, 1.4);
          }
        }
        if (this.attackTime > 2.6) { this.expose(1.8); this.endAttack(1.4); }
        break;
      }
    }
  }

  private expose(seconds: number) {
    if (this.phase === 1) return;
    this.coreExposed = true;
    this.coreTimer = seconds;
  }

  private endAttack(cooldown: number) {
    this.attack = 'none';
    this.attackTime = 0;
    this.telegraphed = false;
    this.cooldown = Math.max(0.5, cooldown - this.phase * 0.22);
  }

  private pickAttack(playerPos: Vector3) {
    const r = Math.random();
    if (this.phase === 1) {
      this.attack = r < 0.55 ? 'volley' : 'beam';
    } else if (this.phase === 2) {
      this.attack = r < 0.34 ? 'slam' : r < 0.68 ? 'charge' : 'volley';
    } else {
      this.attack = r < 0.28 ? 'rain' : r < 0.52 ? 'beam' : r < 0.78 ? 'charge' : 'slam';
    }
    this.attackTime = 0;
    this.telegraphed = false;
  }

  get healthFraction() { return clamp01(this.hp / this.maxHp); }
  get nodesAlive() { return this.nodes.filter((n) => n.alive).length; }
}
