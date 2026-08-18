import { Mesh, SphereGeometry, ShaderMaterial, BackSide, Color, Vector3, Camera } from 'three';
import { DistrictStyle } from './Palette';

// SKY AND ATMOSPHERE
// Banded gradient dome, flat hard-edged drifting cel clouds, a graphic sun disc with a
// stylised spoke flare, and a quantised horizon plate. Everything is stepped: there is
// no smooth gradient anywhere in the sky, which is what keeps it reading as artwork.
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uCloudCover;
uniform float uBands;
uniform float uFlare;
varying vec3 vDir;

float h21(vec2 p) {
  p = fract(p * vec2(127.34, 311.21));
  p += dot(p, p + 42.17);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += vnoise(p) * a; p *= 2.04; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);

  // Stepped vertical gradient: three authored plates, hard transitions.
  float q = floor(h * uBands) / uBands;
  vec3 sky = mix(uHorizon, uMid, clamp(q * 2.0 - 0.35, 0.0, 1.0));
  sky = mix(sky, uTop, clamp(q * 1.7 - 0.72, 0.0, 1.0));

  // Flat cloud shapes on a dome projection, thresholded twice for a two-tone shape
  // with a hard rim. Two layers drift at different speeds for parallax.
  vec2 cuv = d.xz / max(0.12, abs(d.y) + 0.22);
  float n1 = fbm(cuv * 1.4 + vec2(uTime * 0.014, uTime * 0.006));
  float n2 = fbm(cuv * 2.9 - vec2(uTime * 0.026, 0.0));
  float shape = n1 * 0.72 + n2 * 0.28;
  float cover = 1.0 - uCloudCover;
  float body = step(cover, shape);
  float core = step(cover + 0.085, shape);
  float horizonFade = smoothstep(-0.02, 0.16, d.y);
  vec3 cloud = mix(uCloudShade, uCloud, core);
  sky = mix(sky, cloud, body * horizonFade * 0.94);

  // Graphic sun: hard disc, hard halo ring, and stylised spokes. No lens photography.
  float sd = dot(d, normalize(uSunDir));
  float disc = step(0.9986, sd);
  float halo = step(0.995, sd) * 0.55;
  float ring = step(0.9925, sd) * (1.0 - step(0.9945, sd)) * 0.7;
  float ang = atan(d.x - uSunDir.x, d.y - uSunDir.y);
  float spokes = step(0.72, abs(sin(ang * 6.0))) * step(0.972, sd) * uFlare;
  sky += uSun * (disc * 1.5 + halo + ring + spokes * 0.6);

  gl_FragColor = vec4(sky, 1.0);
}
`;

export class Sky {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;
  readonly sunDir = new Vector3(0.42, 0.5, 0.46).normalize();

  constructor() {
    this.mat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTop: { value: new Color(0x2b1b5e) },
        uMid: { value: new Color(0x8c3a9e) },
        uHorizon: { value: new Color(0xff8ac4) },
        uSun: { value: new Color(0xffd27a) },
        uCloud: { value: new Color(0xffc4e4) },
        uCloudShade: { value: new Color(0xb85fa8) },
        uSunDir: { value: this.sunDir },
        uTime: { value: 0 },
        uCloudCover: { value: 0.46 },
        uBands: { value: 7 },
        uFlare: { value: 1 },
      },
    });
    // Low-poly dome: the shader does the work, the geometry costs nothing.
    this.mesh = new Mesh(new SphereGeometry(1, 24, 16), this.mat);
    this.mesh.scale.setScalar(3000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    (this.mesh as any).noOutline = true;
    (this.mesh as any).isSky = true;
  }

  applyDistrict(s: DistrictStyle, blend = 1) {
    const u = this.mat.uniforms;
    (u.uTop.value as Color).lerp(new Color(s.skyTop), blend);
    (u.uMid.value as Color).lerp(new Color(s.skyMid), blend);
    (u.uHorizon.value as Color).lerp(new Color(s.skyHorizon), blend);
    (u.uSun.value as Color).lerp(new Color(s.sun), blend);
    (u.uCloud.value as Color).lerp(new Color(s.cloud), blend);
    (u.uCloudShade.value as Color).lerp(new Color(s.cloudShade), blend);
    const cover = s.atmosphere === 'storm' ? 0.62 : s.atmosphere === 'void' ? 0.2 : s.atmosphere === 'smog' ? 0.54 : 0.44;
    u.uCloudCover.value += (cover - u.uCloudCover.value) * blend;
    const target = new Vector3(s.lightDir[0], s.lightDir[1], s.lightDir[2]).normalize();
    this.sunDir.lerp(target, blend * 0.5).normalize();
  }

  update(dt: number, camera: Camera) {
    this.mat.uniforms.uTime.value += dt;
    this.mesh.position.copy(camera.position);
  }
}
