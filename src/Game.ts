/**
 * Game — top level owner. Holds the scene graph, the render pipeline, the clock,
 * input, the collision world and (soon) the player, enemies and stage.
 *
 * Right now it builds a hand-written district through the Kit. That district is
 * the render-pipeline test bed: once the cel look is verified against captured
 * frames it gets replaced by the procedural assembler output, which uses the
 * exact same Kit calls.
 */
import * as THREE from 'three';
import { Pipeline } from './render/Pipeline';
import { SkyDome } from './render/Sky';
import { Shared } from './render/Shared';
import { hatchTexture, blueNoise } from './render/Textures';
import { BIOME_BOROUGH, type Biome, C } from './render/Palette';
import { Clock } from './core/Time';
import { Input } from './core/Input';
import { Bus } from './core/Events';
import { Rng } from './core/Rng';
import { CollisionWorld } from './world/Collision';
import { Kit } from './world/Kit';
import { SF } from './world/Types';
import { buildTestDistrict } from './world/TestDistrict';

export interface GameOptions {
  gl: HTMLCanvasElement;
  ui: HTMLCanvasElement;
  seed?: string;
  deterministic?: boolean;
}

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly pipeline: Pipeline;
  readonly sky = new SkyDome();
  readonly clock = new Clock();
  readonly input: Input;
  readonly bus = new Bus();
  readonly collision = new CollisionWorld();
  readonly world = new THREE.Group();
  readonly ui: HTMLCanvasElement;
  readonly uiCtx: CanvasRenderingContext2D;

  biome: Biome = BIOME_BOROUGH;
  seed: string;
  running = false;
  paused = false;

  /** free camera state, used until the player exists */
  camPos = new THREE.Vector3(0, 14, -34);
  camYaw = 0;
  camPitch = -0.06;
  camSpeed = 34;
  private lookTarget = new THREE.Vector3();
  private _fwd = new THREE.Vector3();

  private cssW = 1280;
  private cssH = 720;
  private raf = 0;

  constructor(o: GameOptions) {
    this.seed = o.seed ?? 'TREND-CITY';
    this.ui = o.ui;
    this.uiCtx = o.ui.getContext('2d')!;

    this.camera = new THREE.PerspectiveCamera(64, 16 / 9, 0.2, 2600);
    this.camera.layers.enableAll();

    this.scene.add(this.world);
    this.scene.add(this.sky.mesh);

    this.pipeline = new Pipeline(o.gl, this.scene, this.camera);
    this.input = new Input(window);
    this.input.deterministic = !!o.deterministic;

    Shared.hatchMap.value = hatchTexture();
    Shared.noiseMap.value = blueNoise();
    Shared.cameraNear.value = this.camera.near;
    Shared.cameraFar.value = this.camera.far;

    this.sky.apply(this.biome);
    this.build(this.seed);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // ─────────────────────────────────────────────── world build

  build(seed: string) {
    this.seed = seed;
    this.collision.clear();
    // dispose the previous district
    while (this.world.children.length) {
      const c = this.world.children.pop()!;
      c.traverse((n) => {
        const m = n as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    const rng = new Rng(seed);
    const kit = new Kit(this.collision, this.biome, rng);
    buildTestDistrict(kit, this.world, rng);
    kit.finalizeProps(this.world);
    this.collision.build();
    this.stats = {
      tris: kit.stats.tris, colliderTris: kit.stats.colliderTris,
      drawCalls: kit.stats.drawCalls, props: kit.stats.props,
    };
    // start the camera on the deck looking down the road
    this.camPos.set(0, 18, -46);
    this.camYaw = 0; this.camPitch = -0.02;
  }

  stats = { tris: 0, colliderTris: 0, drawCalls: 0, props: 0 };

  // ─────────────────────────────────────────────── loop

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.reset(performance.now());
    const frame = (t: number) => {
      this.raf = requestAnimationFrame(frame);
      this.step(t);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  /** one full frame; the harness calls this directly for deterministic capture */
  step(nowMs: number) {
    this.clock.tick(nowMs);
    const dt = this.clock.dt;
    this.input.update(this.clock.rawDt);
    if (!this.paused) this.update(dt);
    this.render();
  }

  update(dt: number) {
    Shared.time.value = this.clock.time;
    Shared.gtime.value += dt;

    // --- free camera (placeholder until the player lands) ---
    const i = this.input;
    const it = i.intent;
    const spd = this.camSpeed * (i.held('dash') ? 3.4 : 1) * (i.held('boost') ? 6 : 1);
    if (i.held('camLeft')) this.camYaw += dt * 1.6;
    if (i.held('camRight')) this.camYaw -= dt * 1.6;
    if (i.held('jump')) this.camPos.y += spd * dt;
    if (i.held('pound')) this.camPos.y -= spd * dt;
    const sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
    this.camPos.x += (it.moveX * cy + it.moveY * sy) * spd * dt;
    this.camPos.z += (-it.moveX * sy + it.moveY * cy) * spd * dt;

    this.camera.position.copy(this.camPos);
    this._fwd.set(Math.sin(this.camYaw) * Math.cos(this.camPitch), Math.sin(this.camPitch), Math.cos(this.camYaw) * Math.cos(this.camPitch));
    this.lookTarget.copy(this.camPos).add(this._fwd);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();

    this.sky.follow(this.camera, this.camera.far);
  }

  render() {
    this.pipeline.renderShadow(this.camPos);
    this.pipeline.render();
    if (this.pipeline.quality.adaptive) {
      this.pipeline.adapt(this.clock.avgMs, this.clock.rawDt, this.cssW, this.cssH);
    }
    this.drawUi();
  }

  // ─────────────────────────────────────────────── temporary readout

  /** temporary dev readout; the harness turns it off so captures stay clean */
  debugHud = true;

  private drawUi() {
    const g = this.uiCtx;
    const w = this.ui.width, h = this.ui.height;
    g.clearRect(0, 0, w, h);
    if (!this.debugHud) return;
    const dpr = w / this.cssW;
    g.save();
    g.scale(dpr, dpr);
    g.font = '600 13px ui-monospace, Menlo, monospace';
    g.fillStyle = C.volt;
    const p = this.pipeline.stats;
    const lines = [
      `SEED ${this.seed}`,
      `${this.clock.avgMs.toFixed(1)}ms  worst ${this.clock.worstMs.toFixed(1)}ms  scale ${this.pipeline.scale.toFixed(2)}`,
      `calls ${p.calls}  tris ${(p.tris / 1000).toFixed(1)}k  kit ${(this.stats.tris / 1000).toFixed(1)}k`,
      `collider ${this.stats.colliderTris} tris  props ${this.stats.props}`,
      `cam ${this.camPos.x.toFixed(1)} ${this.camPos.y.toFixed(1)} ${this.camPos.z.toFixed(1)}  yaw ${this.camYaw.toFixed(2)}`,
    ];
    g.globalAlpha = 0.9;
    for (let k = 0; k < lines.length; k++) g.fillText(lines[k], 14, 22 + k * 16);
    g.restore();
  }

  // ─────────────────────────────────────────────── plumbing

  resize() {
    this.cssW = Math.max(320, window.innerWidth);
    this.cssH = Math.max(240, window.innerHeight);
    this.camera.aspect = this.cssW / this.cssH;
    this.camera.updateProjectionMatrix();
    this.pipeline.resize(this.cssW, this.cssH);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.ui.width = Math.round(this.cssW * dpr);
    this.ui.height = Math.round(this.cssH * dpr);
    this.ui.style.width = this.cssW + 'px';
    this.ui.style.height = this.cssH + 'px';
  }

  /** harness hook: place the camera exactly, for reproducible inspection */
  setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov?: number) {
    this.camPos.set(px, py, pz);
    if (fov !== undefined) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(tx, ty, tz);
    this.camera.updateMatrixWorld();
    const d = new THREE.Vector3(tx - px, ty - py, tz - pz).normalize();
    this.camYaw = Math.atan2(d.x, d.z);
    this.camPitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
  }
}

export { SF };
