import { WebGLRenderer, WebGLRenderTarget, Scene, PerspectiveCamera, ShaderMaterial, Vector2, Color,
  HalfFloatType, NearestFilter, LinearSRGBColorSpace, NoToneMapping, ColorManagement } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { NORMAL_DEPTH_VERTEX, NORMAL_DEPTH_FRAGMENT } from './CelVertex';
import { INK_FRAG, SPEED_FRAG, GRADE_FRAG, FS_QUAD_VERT } from './PostShaders';
import { makeGradingLUT } from './Textures';
import { MaterialLibrary } from './CelMaterial';
import { DistrictStyle } from './Palette';

export const LAYER_WORLD = 0;   // everything that contributes to the ink prepass
export const LAYER_OUTLINE = 1; // inverted hulls
export const LAYER_SKY = 2;
export const LAYER_FX = 3;      // particles, trails, additive effects

// Colour management is deliberately off. The whole game is authored in display space
// so a hex in the palette file is exactly the hex that reaches the screen, which is
// what makes hard-edged NPR banding predictable.
ColorManagement.enabled = false;

export class Pipeline {
  readonly renderer: WebGLRenderer;
  readonly composer: EffectComposer;
  readonly ndTarget: WebGLRenderTarget;
  readonly inkPass: ShaderPass;
  readonly speedPass: ShaderPass;
  readonly gradePass: ShaderPass;
  readonly bloomPass: UnrealBloomPass;
  private ndMaterial: ShaderMaterial;
  private renderPass: RenderPass;
  private width = 1;
  private height = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  pixelRatio = 1;
  maxPixelRatio = 2;
  private frameEma = 16;
  private ratioCooldown = 0;
  adaptive = true;
  outlineMaterials: ShaderMaterial[] = [];

  constructor(canvas: HTMLCanvasElement, private lib: MaterialLibrary) {
    this.renderer = new WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.autoClear = true;
    this.renderer.setClearColor(new Color(0x07060f), 1);

    this.ndTarget = new WebGLRenderTarget(2, 2, {
      type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, generateMipmaps: false,
    });

    this.ndMaterial = new ShaderMaterial({
      vertexShader: NORMAL_DEPTH_VERTEX,
      fragmentShader: NORMAL_DEPTH_FRAGMENT,
      uniforms: { uFar: { value: 2200 } },
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.renderTarget1.texture.type = HalfFloatType;
    this.renderPass = new RenderPass(new Scene(), new PerspectiveCamera());
    this.composer.addPass(this.renderPass);

    this.inkPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tNormalDepth: { value: this.ndTarget.texture },
        uTexel: { value: new Vector2(1 / 1920, 1 / 1080) },
        uInk: { value: new Color(0x140b28) },
        uNormalScale: { value: 0.9 },
        uDepthScale: { value: 0.34 },
        uThickness: { value: 1.15 },
        uFadeStart: { value: 0.42 },
        uStrength: { value: 0.92 },
      },
      vertexShader: FS_QUAD_VERT,
      fragmentShader: INK_FRAG,
    });
    this.composer.addPass(this.inkPass);

    this.bloomPass = new UnrealBloomPass(new Vector2(1920, 1080), 0.62, 0.72, 0.82);
    this.composer.addPass(this.bloomPass);

    this.speedPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uCenter: { value: new Vector2(0.5, 0.5) },
        uSpeed: { value: 0 },
        uBoost: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 1.77 },
        uFlash: { value: 0 },
        uFlashColor: { value: new Color(0xffffff) },
        uChroma: { value: 0 },
        uHitstop: { value: 0 },
      },
      vertexShader: FS_QUAD_VERT,
      fragmentShader: SPEED_FRAG,
    });
    this.composer.addPass(this.speedPass);

    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uLut: { value: makeGradingLUT(32) },
        uLutSize: { value: 32 },
        uLutMix: { value: 0.88 },
        uVignette: { value: 0.38 },
        uUrgency: { value: 0 },
        uUrgencyColor: { value: new Color(0xff3d5a) },
        uTime: { value: 0 },
        uFade: { value: 0 },
      },
      vertexShader: FS_QUAD_VERT,
      fragmentShader: GRADE_FRAG,
    });
    this.gradePass.renderToScreen = true;
    this.composer.addPass(this.gradePass);
  }

  setScene(scene: Scene, camera: PerspectiveCamera) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  resize(cssWidth: number, cssHeight: number) {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.applyResolution();
  }

  private applyResolution() {
    const dpr = Math.min(this.maxPixelRatio, window.devicePixelRatio || 1) * this.pixelRatio;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.width = Math.max(2, Math.floor(this.cssWidth * dpr));
    this.height = Math.max(2, Math.floor(this.cssHeight * dpr));
    this.composer.setSize(this.cssWidth, this.cssHeight);
    this.composer.setPixelRatio(dpr);
    this.ndTarget.setSize(this.width, this.height);
    (this.inkPass.uniforms.uTexel.value as Vector2).set(1 / this.width, 1 / this.height);
    this.speedPass.uniforms.uAspect.value = this.cssWidth / Math.max(1, this.cssHeight);
    this.bloomPass.resolution.set(this.width, this.height);
    this.lib.setResolution(this.width, this.height);
  }

  /**
   * ADAPTIVE PIXEL RATIO
   * Frame time is smoothed, then internal resolution walks up or down between 0.7x and
   * full retina. Movement is slow and hysteretic so it never visibly pumps.
   */
  private adapt(frameMs: number, dt: number) {
    this.frameEma += (frameMs - this.frameEma) * 0.08;
    this.ratioCooldown -= dt;
    if (!this.adaptive || this.ratioCooldown > 0) return;
    if (this.frameEma > 19.5 && this.pixelRatio > 0.7) {
      this.pixelRatio = Math.max(0.7, this.pixelRatio - 0.1);
      this.ratioCooldown = 1.2;
      this.applyResolution();
    } else if (this.frameEma < 13.0 && this.pixelRatio < 1) {
      this.pixelRatio = Math.min(1, this.pixelRatio + 0.05);
      this.ratioCooldown = 2.0;
      this.applyResolution();
    }
  }

  applyDistrict(style: DistrictStyle) {
    (this.gradePass.uniforms.uLut.value as any).dispose?.();
    this.gradePass.uniforms.uLut.value = makeGradingLUT(32, style.accent, style.skyTop, style.sun);
    (this.inkPass.uniforms.uInk.value as Color).setHex(style.atmosphere === 'void' ? 0x1c0f3c : 0x140b28);
  }

  /** Normal+depth prepass, then the composer chain. */
  render(scene: Scene, camera: PerspectiveCamera, dt: number, frameMs: number) {
    this.adapt(frameMs, dt);

    const upp = (2 * Math.tan((camera.fov * Math.PI) / 360)) / this.height;
    for (const m of this.outlineMaterials) m.uniforms.uUnitsPerPixel.value = upp;
    this.ndMaterial.uniforms.uFar.value = camera.far;

    // Prepass: world layer only. Hulls, sky and additive FX would only pollute the
    // normal buffer and cause the ink pass to double-stroke.
    const mask = camera.layers.mask;
    camera.layers.set(LAYER_WORLD);
    scene.overrideMaterial = this.ndMaterial;
    this.renderer.setRenderTarget(this.ndTarget);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);
    scene.overrideMaterial = null;
    this.renderer.setRenderTarget(null);
    camera.layers.mask = mask;

    this.speedPass.uniforms.uTime.value += dt;
    this.gradePass.uniforms.uTime.value += dt;
    this.setScene(scene, camera);
    this.composer.render(dt);
  }

  get info() { return this.renderer.info; }
  get internalWidth() { return this.width; }
  get internalHeight() { return this.height; }
}
