import { Scene, Group, Vector3, Color, InstancedMesh, OctahedronGeometry, Matrix4, Quaternion } from 'three';
import { Input } from './core/Input';
import { Rng, randomSeedString } from './core/Rng';
import { clamp, clamp01, damp, lerp } from './core/MathX';
import { MaterialLibrary } from './render/CelMaterial';
import { Pipeline, LAYER_SKY, LAYER_FX, LAYER_OUTLINE, LAYER_WORLD } from './render/Pipeline';
import { Sky } from './render/Sky';
import { DISTRICTS } from './render/Palette';
import { generateStage, Stage } from './world/Generator';
import { Rig } from './player/Rig';
import { Player } from './player/Player';
import { CameraRig } from './player/CameraRig';
import { MOVE, COMBAT } from './player/Tuning';
import { EnemyManager } from './combat/Enemies';
import { Boss } from './combat/Boss';
import { CombatFx } from './combat/Combat';
import { Particles } from './fx/Particles';
import { Trail } from './fx/Trails';
import { AudioEngine } from './audio/Audio';
import { Music } from './audio/Music';
import { Hud, HudState } from './ui/Hud';

const TRANSMISSIONS: [number, string, string][] = [
  [0.06, 'HALCYON', 'You are moving again. I did not authorise that. I am glad of it.'],
  [0.2, 'HALCYON', 'I built this borough. I am no longer certain what for.'],
  [0.34, 'HALCYON', 'There is a gap in my archive shaped exactly like you.'],
  [0.5, 'HALCYON', 'Courier build seven. There were others. I cannot find their records.'],
  [0.66, 'HALCYON', 'You keep taking the fast lines. So did the last one.'],
  [0.8, 'HALCYON', 'The lattice is awake. Something is coming to stop you reaching it.'],
  [0.94, 'HALCYON', 'If you reach the core I will have to remember why I made you.'],
];

/** The whole game: screens, stage lifecycle, and one allocation-free update loop. */
export class Game {
  scene = new Scene();
  lib = new MaterialLibrary();
  pipeline: Pipeline;
  sky = new Sky();
  cam = new CameraRig();
  input: Input;
  hud: Hud;
  audio = new AudioEngine();
  music: Music;
  particles = new Particles(1100);
  trail = new Trail(28, 0.7, 0x9ef0ff, 0x7b3bff);
  handTrail = new Trail(14, 0.3, 0xffffff, 0xff3d9a);
  enemies: EnemyManager;
  boss: Boss;
  combatFx: CombatFx;
  player: Player;
  stage: Stage | null = null;
  worldRoot = new Group();
  screen: HudState['screen'] = 'title';
  private time = 0;
  private timeLeft = 0;
  private elapsed = 0;
  private hudState: HudState;
  private seeds: string[] = [];
  private selectIndex = 0;
  private best: Record<string, number> = {};
  private stats = { fragments: 0, shards: 0, orbs: 0, kills: 0, damage: 0, shortcuts: 0, chain: 0 };
  private hitstop = 0;
  private slowmo = 0;
  private msg = { text: '', from: '', t: 0 };
  private msgIndex = 0;
  private pickupMesh: InstancedMesh | null = null;
  private pickupIdx: number[] = [];
  private districtBlend = 0;
  private currentDistrict = 0;
  private bossTargets: { pos: Vector3; id: number }[] = [];
  private goalReached = false;
  private bossStarted = false;
  private results: any = {};
  private flashRank = 0;
  private tmpM = new Matrix4();
  private tmpQ = new Quaternion();
  private tmpS = new Vector3(1, 1, 1);
  private v = new Vector3();
  private v2 = new Vector3();

  constructor(private glCanvas: HTMLCanvasElement, hudCanvas: HTMLCanvasElement) {
    this.pipeline = new Pipeline(glCanvas, this.lib);
    this.input = new Input(document.body);
    this.hud = new Hud(hudCanvas);
    this.music = new Music(this.audio);
    this.scene.add(this.sky.mesh);
    this.sky.mesh.layers.set(LAYER_SKY);
    this.scene.add(this.worldRoot);
    this.scene.add(this.particles.mesh, this.trail.mesh, this.handTrail.mesh);

    const rig = new Rig(this.lib);
    this.scene.add(rig.group);
    for (const m of rig.outlineMaterials) this.pipeline.outlineMaterials.push(m);

    this.enemies = new EnemyManager(this.lib, null as any);
    this.scene.add(this.enemies.root);
    this.combatFx = new CombatFx(this.lib);
    this.scene.add(this.combatFx.root);
    this.boss = new Boss(this.lib, this.bossHooks());
    this.scene.add(this.boss.group);

    this.player = new Player(rig, null as any, this.playerHooks());
    this.combatFx.onPlayerHit = (amount, from) => this.player.hurt(amount, from);
    this.combatFx.onWaveVisual = (pos, radius) => {
      this.particles.emit('shock', pos, this.v.set(0, 1, 0), 1, 0xff3d9a, 0xffffff, radius / 14);
      this.cam.shake(0.5);
    };
    this.enemies.onDeath = (e) => {
      this.stats.kills++;
      this.player.addStyle(24);
      this.player.addBoost(9);
      this.particles.emit('debris', e.pos, this.v.set(0, 1, 0), 12, 0xff3d9a, 0x4de8ff, 1.3);
      this.particles.emit('ring', e.pos, this.v, 1, 0xffffff, 0x4de8ff, 1);
      this.audio.destroy();
      this.hitstop = COMBAT.hitstopHeavy;
      this.cam.shake(0.45);
    };
    this.enemies.onHit = (e, pos) => {
      this.particles.emit('spark', pos, this.v.set(0, 1, 0), 8, 0xffffff, 0xffd27a, 1);
      this.audio.hitEnemy(false);
      this.hitstop = COMBAT.hitstopLight;
      this.cam.shake(0.24);
    };
    this.enemies.onAttack = (e, dir) => {
      if (e.kind === 'ranger' || e.kind === 'turret') {
        this.combatFx.fireOrb(this.v.copy(e.pos).setY(e.pos.y + 1.4), dir, 42, 0.9);
        this.audio.tone(720, 240, 0.16, 'square', 0.14, 3000, 0.12);
      } else {
        const d = e.pos.distanceTo(this.player.pos);
        if (d < 5.4 && this.player.invuln <= 0) this.player.hurt(e.stats.damage, e.pos);
        this.audio.burst(0.12, 700, 1.2, 0.2, 'bandpass', 0.14);
      }
    };

    this.hudState = {
      screen: 'title', time: 0, timeLimit: 0, elapsed: 0, speed: 0, maxSpeed: MOVE.hardCap,
      health: MOVE.maxHealth, maxHealth: MOVE.maxHealth, boost: 100, boostMax: MOVE.boostMax,
      fragments: 0, shards: 0, orbs: 0, pickupTotal: 0, combo: 0, style: 0, rank: 0,
      objective: 'REACH THE LATTICE', district: '', seed: '', bossHp: 1, bossPhase: 1,
      bossName: 'HALCYON WARDEN', bossActive: false, message: '', messageFrom: '', messageT: 0,
      paceDelta: 0, progress: 0, results: {}, selectIndex: 0, selectCards: [], best: null, flashRank: 0,
    };

    this.newSeeds();
    this.buildStage(this.seeds[0], true);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    (window as any).__game = this;
  }

  private newSeeds() {
    this.seeds = [randomSeedString(), randomSeedString(), randomSeedString()];
  }

  private playerHooks() {
    const g = this;
    return {
      findHoming(from: Vector3, dir: Vector3, range: number, cone: number) {
        const n = g.boss.targets(g.bossTargets);
        let best: any = null, bestScore = -Infinity;
        for (let i = 0; i < n; i++) {
          const t = g.bossTargets[i];
          g.v.subVectors(t.pos, from);
          const d = g.v.length();
          if (d > range * 1.6) continue;
          g.v.divideScalar(d);
          const f = g.v.dot(dir);
          if (f < cone - 0.25) continue;
          const score = f * 2 - d / range;
          if (score > bestScore) { bestScore = score; best = t; }
        }
        const e = g.enemies.findTarget(from, dir, range, cone);
        if (e && (!best || bestScore < 1.2)) return e;
        return best;
      },
      onHomingHit(id: number, pos: Vector3) {
        g.audio.homing();
        g.particles.emit('ring', pos, g.v.set(0, 1, 0), 1, 0xffffff, 0x4de8ff, 1.2);
        g.particles.emit('spark', pos, g.v.set(0, 1, 0), 14, 0xffffff, 0xff3d9a, 1.4);
        g.hitstop = COMBAT.hitstopHeavy;
        g.cam.shake(0.6);
        g.pipeline.speedPass.uniforms.uFlash.value = 0.5;
        if (id >= 999) g.boss.hit(id, 1);
        else g.enemies.damage(id, 2, g.player.pos, 12);
      },
      onMelee(combo: number, pos: Vector3, dir: Vector3, aerial: boolean) {
        g.audio.attack(combo);
        const reach = COMBAT.meleeRange + combo * 0.4;
        g.v.copy(pos).addScaledVector(dir, reach * 0.6).setY(pos.y + 1.1);
        g.particles.emit('shard', g.v, dir, 5, 0xffffff, 0x9ef0ff, 0.8);
        let anyHit = false;
        for (let i = 0; i < g.enemies.enemies.length; i++) {
          const e = g.enemies.enemies[i];
          if (!e.alive || !e.active) continue;
          if (e.pos.distanceTo(g.v) > reach + e.stats.radius) continue;
          g.enemies.damage(i, combo === 3 ? 3 : 1, pos, 8 + combo * 4);
          anyHit = true;
        }
        const bn = g.boss.targets(g.bossTargets);
        for (let i = 0; i < bn; i++) {
          if (g.bossTargets[i].pos.distanceTo(g.v) < reach + 3) { g.boss.hit(g.bossTargets[i].id, 1); anyHit = true; }
        }
        if (anyHit) { g.hitstop = combo === 3 ? COMBAT.hitstopHeavy : COMBAT.hitstopLight; g.cam.shake(0.3 + combo * 0.1); }
      },
      onCharged(pos: Vector3, dir: Vector3) {
        g.audio.destroy();
        g.particles.emit('shock', g.v.copy(pos).setY(pos.y + 1), dir, 1, 0x4de8ff, 0xffffff, 1.6);
        g.pipeline.speedPass.uniforms.uFlash.value = 0.7;
        g.cam.shake(0.9);
        g.hitstop = COMBAT.hitstopBoss;
        for (let i = 0; i < g.enemies.enemies.length; i++) {
          const e = g.enemies.enemies[i];
          if (!e.alive || !e.active) continue;
          if (e.pos.distanceTo(pos) > 12) continue;
          g.enemies.damage(i, 5, pos, 26);
        }
        const bn = g.boss.targets(g.bossTargets);
        for (let i = 0; i < bn; i++) if (g.bossTargets[i].pos.distanceTo(pos) < 16) g.boss.hit(g.bossTargets[i].id, 2);
      },
      onSlam(pos: Vector3, power: number) {
        g.audio.land(true, 60);
        g.particles.emit('shock', pos, g.v.set(0, 1, 0), 1, 0xffd27a, 0xffffff, 1.4);
        g.particles.emit('dust', pos, g.v.set(0, 1, 0), 16, 0xd8d3e8, 0xffffff, 1.6);
        g.cam.shake(1.2);
        g.hitstop = COMBAT.hitstopHeavy;
        g.pipeline.speedPass.uniforms.uFlash.value = 0.45;
        for (let i = 0; i < g.enemies.enemies.length; i++) {
          const e = g.enemies.enemies[i];
          if (!e.alive || !e.active) continue;
          if (e.pos.distanceTo(pos) > COMBAT.slamRadius) continue;
          g.enemies.damage(i, 3, pos, 20);
        }
      },
      onLand(hard: boolean, impact: number, pos: Vector3, normal: Vector3) {
        g.audio.land(hard, impact);
        g.particles.emit('dust', pos, normal, hard ? 14 : 6, 0xe8dcf2, 0xffffff, hard ? 1.5 : 0.8);
        if (hard) {
          g.particles.emit('ring', pos, normal, 1, 0xffffff, 0xffd27a, 1);
          g.cam.shake(0.85);
          g.cam.fovKick = -4;
          g.pipeline.speedPass.uniforms.uFlash.value = 0.22;
        } else g.cam.shake(0.18);
      },
      onJump(kind: string, pos: Vector3) {
        if (kind === 'double') g.audio.doubleJump();
        else if (kind === 'wall') g.audio.wallJump();
        else if (kind === 'bounce') { g.audio.bounce(); g.particles.emit('ring', pos, g.v.set(0, 1, 0), 1, 0x4de8ff, 0xffffff, 0.8); }
        else if (kind === 'launch') { g.audio.booster(); g.cam.fovKick = 6; }
        else g.audio.jump();
        g.particles.emit('dust', pos, g.v.set(0, 1, 0), 4, 0xcfc4f2, 0xffffff, 0.7);
      },
      onDash(air: boolean, pos: Vector3, dir: Vector3) {
        g.audio.dash(air);
        g.particles.emit('flame', g.v.copy(pos).setY(pos.y + 0.9), dir, 8, 0x4de8ff, 0xffffff, 1);
        g.cam.fovKick = air ? 7 : 5;
        g.cam.shake(0.2);
      },
      onBoostChange(active: boolean) {
        g.audio.boost(active);
        if (active) g.cam.fovKick = 9;
      },
      onWallRun(active: boolean, pos: Vector3, normal: Vector3) {
        if (active) g.audio.burst(0.2, 1800, 2, 0.16, 'bandpass', 0.2, 0, 700);
      },
      onGrind(active: boolean, pos: Vector3) {
        g.audio.setGrind(active, clamp01(g.player.speed / MOVE.grindMax));
        if (active) g.particles.emit('spark', pos, g.v.set(0, 1, 0), 6, 0xffd27a, 0xffffff, 1);
      },
      onBreak(solid: any, pos: Vector3) {
        g.audio.destroy();
        g.particles.emit('debris', pos, g.v.set(0, 1, 0), 10, 0xcfc4f2, 0xffd27a, 1.2);
        g.cam.shake(0.3);
        g.hitstop = COMBAT.hitstopLight;
      },
      onHurt(amount: number, pos: Vector3) {
        g.stats.damage += amount;
        g.audio.hurt();
        g.cam.shake(1.0);
        g.particles.emit('spark', pos, g.v.set(0, 1, 0), 12, 0xff3d5a, 0xffffff, 1.2);
        g.pipeline.speedPass.uniforms.uFlash.value = 0.4;
        (g.pipeline.speedPass.uniforms.uFlashColor.value as Color).setHex(0xff3d5a);
        g.hitstop = 0.09;
      },
      onFootstep(pos: Vector3, speed: number) {
        g.audio.footstep(speed);
        if (speed > 18) g.particles.emit('dust', pos, g.v.set(0, 1, 0), 2, 0xe8dcf2, 0xcfc4f2, 0.5);
      },
      onSurfaceFx(pos: Vector3, dir: Vector3, speed: number, kind: string) {
        if (kind === 'booster') { if (Math.random() < 0.4) { g.particles.emit('flame', pos, dir, 3, 0x4de8ff, 0xffffff, 1); g.cam.fovKick = 8; g.audio.booster(); } }
        else if (kind === 'grind') { if (Math.random() < 0.5) g.particles.emit('spark', pos, dir, 2, 0xffd27a, 0xffffff, 0.8); }
        else if (kind === 'slide') { if (Math.random() < 0.6) g.particles.emit('dust', pos, dir, 2, 0xe8dcf2, 0xffffff, 0.9); }
        else if (kind === 'wallrun') { if (Math.random() < 0.4) g.particles.emit('spark', pos, dir, 1, 0x9ef0ff, 0xffffff, 0.6); }
        else if (kind === 'homing' || kind === 'airdash') g.particles.emit('flame', pos, dir, 2, 0x4de8ff, 0xff3d9a, 0.9);
      },
    };
  }

  private bossHooks() {
    const g = this;
    return {
      fireOrb: (pos: Vector3, dir: Vector3, speed: number, size: number) => g.combatFx.fireOrb(pos, dir, speed, size),
      shockwave: (pos: Vector3, radius: number, power: number) => g.combatFx.shockwave(pos, radius, power),
      beamDanger: (from: Vector3, dir: Vector3, length: number, width: number) => g.combatFx.setBeam(from, dir, length, width),
      onTelegraph: (kind: string, pos: Vector3) => { g.audio.bossTelegraph(kind); g.cam.shake(0.3); },
      onImpact: (pos: Vector3, power: number) => {
        g.audio.bossImpact(power);
        g.cam.shake(power);
        g.particles.emit('debris', pos, g.v.set(0, 1, 0), 14, 0xff3d9a, 0xffd27a, 1.6);
        g.pipeline.speedPass.uniforms.uFlash.value = 0.4;
        g.hitstop = COMBAT.hitstopBoss;
      },
      onPhase: (phase: number) => {
        g.audio.stinger();
        g.cam.cinematic(1.6, 2.2, 26, 8);
        g.slowmo = 0.6;
        g.showMessage('HALCYON', phase === 2 ? 'It is protecting the core. It is protecting me from you.' : phase === 3 ? 'It is not following my instructions any more.' : 'The Warden is awake. Do not stop moving.');
      },
      onDefeated: () => {
        g.audio.bossDefeat();
        g.slowmo = 1.6;
        g.cam.cinematic(3.2, 3.0, 30, 10);
        g.showMessage('HALCYON', 'I remember now. I made you to leave. Go.');
        setTimeout(() => g.finish(true), 3600);
      },
      onHit: (pos: Vector3, weak: boolean) => {
        g.audio.hitEnemy(true);
        g.particles.emit('spark', pos, g.v.set(0, 1, 0), 12, 0xffffff, 0xff3d9a, 1.3);
        g.cam.shake(0.5);
        g.hitstop = COMBAT.hitstopBoss;
      },
    };
  }

  showMessage(from: string, text: string) {
    this.msg.from = from;
    this.msg.text = text;
    this.msg.t = 2.6 + text.length * 0.02;
    this.audio.transmission();
  }

  buildStage(seed: string, silent = false) {
    if (this.stage) {
      this.worldRoot.remove(this.stage.root);
    }
    const stage = generateStage(seed, this.lib);
    this.stage = stage;
    this.worldRoot.add(stage.root);
    for (const m of stage.data.builder.outlineMaterials) this.pipeline.outlineMaterials.push(m);
    (this.player as any).phys = stage.data.physics;
    (this.enemies as any).phys = stage.data.physics;
    this.enemies.spawnAll(stage.data.enemies);

    // Pickups: one instanced batch, matrices refreshed only for what is nearby.
    if (this.pickupMesh) { this.scene.remove(this.pickupMesh); }
    const mat = this.lib.get('neon', { emissiveColor: 0xffd27a, emissive: 1.6 }, 'pickupMat');
    this.pickupMesh = new InstancedMesh(new OctahedronGeometry(0.62, 0), mat, Math.max(1, Math.min(300, stage.data.pickups.length)));
    this.pickupMesh.frustumCulled = false;
    (this.pickupMesh as any).noOutline = true;
    this.scene.add(this.pickupMesh);

    this.timeLeft = stage.timeLimit;
    this.elapsed = 0;
    this.goalReached = false;
    this.bossStarted = false;
    this.msgIndex = 0;
    this.stats = { fragments: 0, shards: 0, orbs: 0, kills: 0, damage: 0, shortcuts: 0, chain: 0 };
    for (const p of stage.data.pickups) p.taken = false;
    this.player.spawn(stage.spawn, stage.spawnHeading);
    this.cam.snapTo(this.player);
    this.applyDistrict(0, 1);
    if (!silent) console.log('[VOLTBOROUGH] seed', seed, stage.plan.map((p) => p.label).join(' -> '), stage.report);
  }

  private applyDistrict(index: number, blend: number) {
    const style = DISTRICTS[clamp(index, 0, DISTRICTS.length - 1)];
    this.lib.applyDistrict(style, blend);
    this.sky.applyDistrict(style, blend);
    if (blend >= 1) this.pipeline.applyDistrict(style);
    this.hudState.district = style.name;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.pipeline.resize(w, h);
    this.cam.resize(w / h);
    this.hud.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
  }

  start() {
    this.screen = 'title';
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const frameMs = now - last;
      let dt = Math.min(0.05, frameMs / 1000);
      last = now;
      try { this.update(dt, frameMs); } catch (e) { console.error('[loop]', e); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private update(dtRaw: number, frameMs: number) {
    this.input.poll();
    if (this.input.anyInputSeen && !this.audio.ready) { this.audio.init(); this.music.setMode('title'); }

    // Time dilation: hit-stop freezes, slow motion stretches. Both feed one scale.
    let scale = 1;
    if (this.hitstop > 0) { this.hitstop -= dtRaw; scale = 0.02; }
    else if (this.slowmo > 0) { this.slowmo -= dtRaw; scale = 0.34; }
    const dt = dtRaw * scale;
    this.time += dtRaw;

    if (this.screen === 'title') this.updateTitle(dtRaw);
    else if (this.screen === 'intro') this.updateIntro(dtRaw);
    else if (this.screen === 'select') this.updateSelect(dtRaw);
    else if (this.screen === 'results') this.updateResults(dtRaw);
    else this.updatePlay(dt, dtRaw);

    this.lib.update(dtRaw);
    this.sky.update(dtRaw, this.cam.camera);
    this.particles.update(dtRaw);
    this.music.update(dtRaw);

    const sp = clamp01(this.player.speed / MOVE.boostSpeed);
    const u = this.pipeline.speedPass.uniforms;
    u.uSpeed.value = this.screen === 'play' || this.screen === 'boss' ? sp : 0;
    u.uBoost.value = this.player.boosting ? 1 : 0;
    u.uChroma.value = sp * 1.6;
    u.uHitstop.value = this.hitstop > 0 ? 1 : 0;
    u.uFlash.value = damp(u.uFlash.value, 0, 14, dtRaw);
    this.pipeline.gradePass.uniforms.uUrgency.value = this.screen === 'play' ? this.hud.urgency : 0;

    this.drawHud(dtRaw);
    this.pipeline.render(this.scene, this.cam.camera, dtRaw, frameMs);
  }

  private updateTitle(dt: number) {
    const s = this.stage!;
    this.cam.orbit(dt, this.v.copy(s.spawn).setY(s.spawn.y + 26), 78, 34, 0.12);
    this.player.anim.set('idle');
    this.player.update(0.0001, this.input, 0);
    if (this.input.pressed('start')) { this.audio.ui('confirm'); this.screen = 'intro'; }
  }

  private updateIntro(dt: number) {
    const s = this.stage!;
    this.cam.orbit(dt, this.v.copy(this.player.pos).setY(this.player.pos.y + 1.4), 7.5, 2.4, 0.5);
    this.player.anim.set('victory');
    this.player.update(0.0001, this.input, 0);
    if (this.input.pressed('start')) { this.audio.ui('confirm'); this.screen = 'select'; this.prepareCards(); }
  }

  private cards: any[] = [];
  private prepareCards() {
    this.cards = this.seeds.map((seed, i) => {
      const preview = i === 0 && this.stage ? this.stage : null;
      const st = preview && preview.seed === seed ? preview : generateStage(seed, this.lib, { bodyCount: 13 });
      if (st !== this.stage) { st.root.visible = false; }
      return {
        seed, name: DISTRICTS[Math.min(5, i * 2)].name, distance: st.totalDistance, timer: st.timeLimit,
        modules: st.plan.length, enemies: st.enemyTotal, pickups: st.pickupTotal, best: this.best[seed] || null,
        stage: st,
      };
    });
  }

  private updateSelect(dt: number) {
    const s = this.stage!;
    this.cam.orbit(dt, this.v.copy(s.spawn).setY(s.spawn.y + 30), 96, 40, 0.08);
    if (this.input.pressed('camLeft') || this.input.moveX < -0.5) { }
    if (this.input.pressed('restart')) { this.newSeeds(); this.prepareCards(); this.audio.ui('back'); }
    const move = this.input.moveX;
    if (Math.abs(move) > 0.6 && this.selectCooldown <= 0) {
      this.selectIndex = (this.selectIndex + (move > 0 ? 1 : -1) + this.cards.length) % this.cards.length;
      this.selectCooldown = 0.24;
      this.audio.ui('move');
    }
    this.selectCooldown -= dt;
    if (this.input.pressed('start')) {
      this.audio.ui('confirm');
      const card = this.cards[this.selectIndex];
      this.buildStage(card.seed);
      this.screen = 'play';
      this.music.setMode('explore');
      this.cam.snapTo(this.player);
      this.showMessage(TRANSMISSIONS[0][1], TRANSMISSIONS[0][2]);
      this.msgIndex = 1;
    }
  }
  private selectCooldown = 0;

  private updateResults(dt: number) {
    this.flashRank = Math.max(0, this.flashRank - dt * 1.4);
    this.cam.orbit(dt, this.v.copy(this.player.pos).setY(this.player.pos.y + 2), 9, 3, 0.3);
    this.player.anim.set('victory');
    this.player.update(0.0001, this.input, 0);
    if (this.input.pressed('start')) { this.audio.ui('confirm'); this.buildStage(this.stage!.seed); this.screen = 'play'; this.music.setMode('explore'); this.cam.snapTo(this.player); }
    else if (this.input.pressed('back')) { this.audio.ui('back'); this.newSeeds(); this.prepareCards(); this.screen = 'select'; }
  }

  private updatePlay(dt: number, dtRaw: number) {
    const stage = this.stage!;
    const phys = stage.data.physics;
    phys.update(dt);
    this.player.update(dt, this.input, this.cam.yaw);
    this.enemies.update(dt, this.player.pos, this.player.vel, 150);
    this.combatFx.update(dt, this.player.pos, MOVE.radius + 0.4, this.player.invuln > 0);
    if (this.boss.active) this.boss.update(dt, this.player.pos);
    this.cam.update(dtRaw, this.player, phys, this.boss.active ? this.boss.pos : undefined);

    // Trails
    this.v.set(-Math.cos(this.player.facing), 0.2, Math.sin(this.player.facing)).normalize();
    const speedN = clamp01(this.player.speed / MOVE.boostSpeed);
    this.trail.update(this.v2.copy(this.player.pos).setY(this.player.pos.y + 1.0), this.v,
      Math.max(0, speedN - 0.35) * 1.6 + (this.player.boosting ? 0.5 : 0));
    this.player.rig.bones.handR.getWorldPosition(this.v2);
    this.handTrail.update(this.v2, this.v, this.player.isAttacking ? 0.9 : Math.max(0, speedN - 0.6));

    // District blending along the run.
    const progress = clamp01(this.player.distanceTravelled / Math.max(1, stage.totalDistance * 0.92));
    const districtIndex = Math.min(DISTRICTS.length - 1, Math.floor(progress * DISTRICTS.length));
    if (districtIndex !== this.currentDistrict) { this.currentDistrict = districtIndex; this.pipeline.applyDistrict(DISTRICTS[districtIndex]); }
    this.applyDistrict(districtIndex, Math.min(1, dtRaw * 0.7));

    stage.streamer.update(this.player.pos, this.v.set(Math.sin(this.player.facing), 0, Math.cos(this.player.facing)));

    // Pickups
    this.updatePickups(dt);

    // Collapse triggers: the floor gives out behind the player, on approach.
    phys.triggerCollapse(this.currentChunk(), this.player.pos, 40);

    // Timer
    if (!this.goalReached) {
      this.timeLeft -= dtRaw;
      this.elapsed += dtRaw;
      if (Math.floor(this.timeLeft) !== Math.floor(this.timeLeft + dtRaw) && this.timeLeft < 11) this.audio.countdown(this.timeLeft < 6);
      if (this.timeLeft <= 0) this.finish(false);
    }
    if (this.player.dead) this.finish(false);

    // Goal and boss handoff
    if (!this.goalReached && this.player.pos.distanceTo(stage.goal) < 16) {
      this.goalReached = true;
      this.audio.goal();
      this.player.addStyle(150);
      this.cam.cinematic(1.8, 1.4, 18, 6);
      this.slowmo = 0.8;
      this.showMessage('HALCYON', 'You made it to the lattice. Something else made it here first.');
      this.particles.emit('ring', stage.goal, this.v.set(0, 1, 0), 1, 0xffffff, 0x4de8ff, 2);
    }
    if (this.goalReached && !this.bossStarted && this.player.pos.distanceTo(stage.bossCenter) < 90) {
      this.bossStarted = true;
      this.boss.begin(stage.bossCenter);
      this.cam.mode = 'boss';
      this.screen = 'boss';
      this.music.setMode('boss');
      this.cam.cinematic(2.4, 2.6, 30, 10);
    }

    // Narrative beats
    if (this.msgIndex < TRANSMISSIONS.length && progress > TRANSMISSIONS[this.msgIndex][0]) {
      this.showMessage(TRANSMISSIONS[this.msgIndex][1], TRANSMISSIONS[this.msgIndex][2]);
      this.msgIndex++;
    }
    if (this.msg.t > 0) this.msg.t -= dtRaw;

    // Audio mix follows play state.
    this.audio.setSpeed(speedN, this.player.boosting);
    this.audio.setGrind(this.player.isGrinding, clamp01(this.player.speed / MOVE.grindMax));
    const intensity = clamp01(speedN * 0.7 + (this.enemies.aliveCount > 0 ? 0.1 : 0) + (this.player.style > 200 ? 0.2 : 0));
    this.music.intensity = intensity;
    if (!this.boss.active) this.music.setMode(this.timeLeft < 25 ? 'critical' : speedN > 0.55 ? 'chase' : 'explore');

    this.stats.chain = Math.max(this.stats.chain, (this.player as any).chainCount || 0);
    if (this.player.pos.y < -420) this.player.hurt(1, this.v.copy(this.player.pos).setY(this.player.pos.y + 20)),
      this.player.spawn(this.nearestNode(), this.player.facing);
  }

  private currentChunk(): number {
    const stage = this.stage!;
    const frac = clamp01(this.player.distanceTravelled / Math.max(1, stage.totalDistance));
    return Math.min(stage.plan.length - 1, Math.floor(frac * stage.plan.length));
  }

  private nearestNode(): Vector3 {
    const nodes = this.stage!.data.nodes;
    let best = this.stage!.spawn, bd = Infinity;
    for (const n of nodes) {
      const d = n.pos.distanceToSquared(this.player.pos);
      if (d < bd) { bd = d; best = n.pos; }
    }
    return this.v2.copy(best).setY(best.y + 2);
  }

  private updatePickups(dt: number) {
    const stage = this.stage!;
    const mesh = this.pickupMesh!;
    let n = 0;
    const cap = mesh.count;
    for (const p of stage.data.pickups) {
      if (p.taken) continue;
      const d = p.pos.distanceTo(this.player.pos);
      if (d < 2.6) {
        p.taken = true;
        this.audio.pickup(p.kind);
        this.particles.emit('spark', p.pos, this.v.set(0, 1, 0), 6, 0xffd27a, 0xffffff, 0.8);
        this.player.addStyle(p.risky ? 12 : 5);
        if (p.kind === 'time') { this.timeLeft += 4 + p.value; this.stats.shortcuts += p.risky ? 1 : 0; }
        else if (p.kind === 'health') this.player.health = Math.min(MOVE.maxHealth, this.player.health + 1);
        else if (p.kind === 'boost') this.player.addBoost(45);
        else if (p.kind === 'shard') { this.stats.shards++; this.player.addBoost(12); if (p.risky) this.stats.shortcuts++; }
        else if (p.kind === 'orb') { this.stats.orbs++; this.player.addBoost(8); }
        else this.stats.fragments++;
        continue;
      }
      if (d > 130 || n >= cap) continue;
      p.bob += dt * 3;
      this.tmpQ.setFromAxisAngle(UPV, p.bob);
      this.v2.copy(p.pos).setY(p.pos.y + Math.sin(p.bob * 0.7) * 0.3);
      const scale = p.kind === 'time' ? 1.5 : p.kind === 'health' ? 1.3 : p.kind === 'boost' ? 1.4 : 1;
      this.tmpS.set(scale, scale, scale);
      this.tmpM.compose(this.v2, this.tmpQ, this.tmpS);
      mesh.setMatrixAt(n++, this.tmpM);
    }
    for (let i = n; i < cap; i++) { this.tmpM.makeScale(0, 0, 0); mesh.setMatrixAt(i, this.tmpM); }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private finish(cleared: boolean) {
    if (this.screen === 'results') return;
    const collected = this.stats.fragments + this.stats.shards + this.stats.orbs;
    const total = this.stage!.pickupTotal;
    const score = (cleared ? 1000 : 0) + this.player.style + collected * 30 + this.stats.kills * 40
      + Math.max(0, this.timeLeft) * 20 - this.stats.damage * 120;
    const rank = !cleared ? 'D' : score > 3200 ? 'S' : score > 2400 ? 'A' : score > 1700 ? 'B' : 'C';
    this.results = {
      cleared, rank, time: this.elapsed, remaining: Math.max(0, this.timeLeft), collected, pickupTotal: total,
      kills: this.stats.kills, damage: this.stats.damage, style: this.player.style, chain: this.stats.chain,
      topSpeed: this.player.peakSpeed, shortcuts: this.stats.shortcuts, boss: cleared,
    };
    if (cleared) {
      const seed = this.stage!.seed;
      if (!this.best[seed] || this.elapsed < this.best[seed]) this.best[seed] = this.elapsed;
    }
    this.flashRank = 1;
    this.screen = 'results';
    this.music.setMode(cleared ? 'victory' : 'explore');
    this.music.intensity = cleared ? 1 : 0.2;
    this.audio.ui('rank');
    this.player.anim.set(cleared ? 'victory' : 'damage');
    this.audio.setSpeed(0, false);
    this.audio.setGrind(false, 0);
  }

  private drawHud(dt: number) {
    const s = this.hudState;
    const stage = this.stage;
    s.screen = this.screen === 'boss' ? 'play' : this.screen;
    s.time = this.timeLeft;
    s.timeLimit = stage ? stage.timeLimit : 0;
    s.elapsed = this.elapsed;
    s.speed = this.player.speed;
    s.health = this.player.health;
    s.boost = this.player.boost;
    s.fragments = this.stats.fragments;
    s.shards = this.stats.shards;
    s.orbs = this.stats.orbs;
    s.pickupTotal = stage ? stage.pickupTotal : 0;
    s.combo = (this.player as any).chainCount || 0;
    s.style = this.player.style;
    s.rank = this.player.styleRank;
    s.seed = stage ? stage.seed : '';
    s.objective = this.boss.active ? 'DESTROY THE WARDEN' : this.goalReached ? 'ENTER THE LATTICE' : 'REACH THE LATTICE';
    s.bossActive = this.boss.active;
    s.bossHp = this.boss.healthFraction;
    s.bossPhase = this.boss.phase;
    s.message = this.msg.text;
    s.messageFrom = this.msg.from;
    s.messageT = this.msg.t;
    s.progress = stage ? clamp01(this.player.distanceTravelled / Math.max(1, stage.totalDistance * 0.92)) : 0;
    const expected = stage ? stage.timeLimit * (1 - s.progress) : 0;
    s.paceDelta = this.timeLeft - expected;
    s.results = this.results;
    s.selectIndex = this.selectIndex;
    s.selectCards = this.cards;
    s.best = stage ? (this.best[stage.seed] || null) : null;
    s.flashRank = this.flashRank;
    this.hud.draw(dt, s);
  }
}

const UPV = new Vector3(0, 1, 0);
