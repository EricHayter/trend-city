/**
 * Pipeline — owns the renderer, the single MRT geometry pass, the cel shadow
 * map, the post chain and the adaptive-resolution controller.
 *
 * Frame shape (one geometry pass, four full-screen passes):
 *
 *   [shadow depth pass]  ortho camera, layer 2 only, MeshDepthMaterial override
 *   [MRT scene pass]     attachment0 = colour, attachment1 = viewNormal + linear depth
 *   [EdgePass]           interior ink from normals/depth
 *   [BloomPass]          stylised neon halation
 *   [SpeedPass]          radial smear + drawn speed lines (no-ops when slow)
 *   [GradePass]          FXAA, chroma, LUT, impact frame, vignette → screen
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { EdgePass } from './passes/EdgePass';
import { BloomPass } from './passes/BloomPass';
import { SpeedPass } from './passes/SpeedPass';
import { GradePass } from './passes/GradePass';
import { gradeLUT, halftoneTexture } from './Textures';
import { Shared, updateSharedResolution } from './Shared';
import { clamp, damp } from '../core/MathX';

/** Layers: 0 = surfaces, 1 = ink hulls, 2 = shadow casters, 3 = fx. */
export const LAYER_SURFACE = 0;
export const LAYER_INK = 1;
export const LAYER_SHADOW = 2;
export const LAYER_FX = 3;

class MrtPass extends Pass {
  constructor(private target: THREE.WebGLRenderTarget, private scene: THREE.Scene, private cam: THREE.Camera) {
    super();
    this.needsSwap = false;
  }
  setCamera(c: THREE.Camera) { this.cam = c; }
  override render(renderer: THREE.WebGLRenderer) {
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.cam);
  }
}

export interface Quality {
  shadows: boolean;
  shadowSize: number;
  bloom: boolean;
  edge: boolean;
  maxPixelRatio: number;
  adaptive: boolean;
}

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly mrt: THREE.WebGLRenderTarget;
  readonly edge: EdgePass;
  readonly bloom: BloomPass;
  readonly speed: SpeedPass;
  readonly grade: GradePass;
  private mrtPass: MrtPass;

  // shadow
  readonly shadowRT: THREE.WebGLRenderTarget;
  readonly shadowCam: THREE.OrthographicCamera;
  private depthMat = new THREE.MeshDepthMaterial();
  private shadowExtent = 96;

  quality: Quality = {
    shadows: true, shadowSize: 2048, bloom: true, edge: true,
    maxPixelRatio: 2, adaptive: true,
  };

  /** current render scale multiplier chosen by the adaptive controller */
  scale = 1;
  private scaleTarget = 1;
  private cooldown = 0;
  private w = 1280;
  private h = 720;

  constructor(canvas: HTMLCanvasElement, private scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x0a0713, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // stylised: we grade by hand
    this.renderer.info.autoReset = false;

    this.mrt = new THREE.WebGLRenderTarget(1280, 720, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.mrt.textures[0].name = 'gColor';
    this.mrt.textures[1].name = 'gNormalDepth';
    // normal/depth must never be filtered across a silhouette
    this.mrt.textures[1].minFilter = THREE.NearestFilter;
    this.mrt.textures[1].magFilter = THREE.NearestFilter;

    this.shadowRT = new THREE.WebGLRenderTarget(2048, 2048, {
      depthBuffer: true, stencilBuffer: false,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    });
    this.shadowRT.depthTexture = new THREE.DepthTexture(2048, 2048);
    this.shadowRT.depthTexture.type = THREE.UnsignedIntType;
    this.shadowRT.depthTexture.minFilter = THREE.NearestFilter;
    this.shadowRT.depthTexture.magFilter = THREE.NearestFilter;
    Shared.shadowMap.value = this.shadowRT.depthTexture;
    Shared.shadowTexel.value = 1 / 2048;

    this.shadowCam = new THREE.OrthographicCamera(-96, 96, 96, -96, -260, 420);
    this.shadowCam.layers.set(LAYER_SHADOW);

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1280, 720, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    }));
    this.composer.renderToScreen = true;

    this.mrtPass = new MrtPass(this.mrt, scene, camera);
    this.edge = new EdgePass(this.mrt);
    this.bloom = new BloomPass(0.78, 0.80);
    this.speed = new SpeedPass();
    this.grade = new GradePass(gradeLUT(), halftoneTexture());
    this.grade.renderToScreen = true;

    this.composer.addPass(this.mrtPass);
    this.composer.addPass(this.edge);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.speed);
    this.composer.addPass(this.grade);
  }

  setCamera(c: THREE.PerspectiveCamera) { this.mrtPass.setCamera(c); }

  resize(cssW: number, cssH: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio) * this.scale;
    const w = Math.max(320, Math.round(cssW * dpr));
    const h = Math.max(180, Math.round(cssH * dpr));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(cssW, cssH, true);
    // drive the *drawing buffer* directly so adaptive scale is a real resolution change
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.getContext().canvas.width = w;
    this.renderer.getContext().canvas.height = h;
    this.mrt.setSize(w, h);
    this.composer.setSize(w, h);
    this.edge.setSize(w, h);
    this.bloom.setSize(w, h);
    this.speed.setSize(w, h);
    this.grade.setSize(w, h);
    updateSharedResolution(w, h);
  }

  /** Called once per frame with the smoothed frame time; nudges render scale. */
  adapt(avgMs: number, dt: number, cssW: number, cssH: number) {
    if (!this.quality.adaptive) return;
    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      if (avgMs > 19.0 && this.scaleTarget > 0.62) { this.scaleTarget -= 0.09; this.cooldown = 0.7; }
      else if (avgMs < 13.4 && this.scaleTarget < 1.0) { this.scaleTarget += 0.05; this.cooldown = 1.1; }
    }
    const s = damp(this.scale, this.scaleTarget, 6, dt);
    if (Math.abs(s - this.scale) > 0.004) {
      this.scale = clamp(s, 0.6, 1);
      this.resize(cssW, cssH);
    }
  }

  /**
   * Render the shadow cascade. `focus` should lead the player slightly so the
   * texels are spent in front of them rather than behind.
   */
  renderShadow(focus: THREE.Vector3) {
    if (!this.quality.shadows) { Shared.shadowStrength.value = 0; return; }
    Shared.shadowStrength.value = 1;
    const d = Shared.sunDir.value;
    const e = this.shadowExtent;
    // snap the focus to a shadow texel so the map doesn't shimmer while running
    const texel = (e * 2) / this.quality.shadowSize;
    const fx = Math.round(focus.x / texel) * texel;
    const fy = Math.round(focus.y / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.shadowCam.left = -e; this.shadowCam.right = e;
    this.shadowCam.top = e; this.shadowCam.bottom = -e;
    this.shadowCam.near = -320; this.shadowCam.far = 420;
    this.shadowCam.position.set(fx + d.x * 150, fy + d.y * 150, fz + d.z * 150);
    this.shadowCam.up.set(0, 1, 0);
    this.shadowCam.lookAt(fx, fy, fz);
    this.shadowCam.updateProjectionMatrix();
    this.shadowCam.updateMatrixWorld(true);

    Shared.shadowMatrix.value.set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    ).multiply(this.shadowCam.projectionMatrix).multiply(this.shadowCam.matrixWorldInverse);

    const prevOverride = this.scene.overrideMaterial;
    this.scene.overrideMaterial = this.depthMat;
    this.renderer.setRenderTarget(this.shadowRT);
    this.renderer.setViewport(0, 0, this.quality.shadowSize, this.quality.shadowSize);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.shadowCam);
    this.scene.overrideMaterial = prevOverride;
    this.renderer.setViewport(0, 0, this.w, this.h);
  }

  render() {
    this.renderer.info.reset();
    this.renderer.setRenderTarget(null);
    this.composer.render();
  }

  setShadowSize(n: number) {
    this.quality.shadowSize = n;
    this.shadowRT.setSize(n, n);
    Shared.shadowTexel.value = 1 / n;
  }
  setShadowExtent(e: number) { this.shadowExtent = e; }

  get stats() {
    const i = this.renderer.info;
    return { calls: i.render.calls, tris: i.render.triangles, programs: i.programs?.length ?? 0, w: this.w, h: this.h };
  }

  dispose() {
    this.mrt.dispose(); this.shadowRT.dispose();
    this.edge.dispose(); this.bloom.dispose(); this.speed.dispose(); this.grade.dispose();
    this.composer.dispose(); this.renderer.dispose();
  }
}
