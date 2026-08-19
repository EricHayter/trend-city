/**
 * Sky — a fully procedural graphic sky: banded gradient, flat two-tone cel
 * clouds with hard edges, a hard-edged sun disc with a stylised spoke flare,
 * and a horizon haze that the atmospheric-perspective fog mixes toward.
 *
 * Nothing here is physical. Everything is chosen to look like screen-printed
 * poster art, and every value is a uniform so the whole sky can be crossfaded
 * between biomes.
 */
import * as THREE from 'three';
import { Shared } from './Shared';
import { type Biome, hexToRgb } from './Palette';

const col = (h: string) => new THREE.Color().setRGB(...hexToRgb(h), THREE.SRGBColorSpace);

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
out vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - vec3(modelMatrix[3]);
  gl_Position = projectionMatrix * viewMatrix * wp;
  // pin to the far plane so nothing can ever poke through the sky
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

const FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormalDepth;

in vec3 vDir;
uniform float time;
uniform vec2 resolution;
uniform vec3 sunDir;
uniform vec3 uSky0, uSky1, uSky2, uSky3, uSky4, uHorizon, uSun;
uniform vec3 uCloud, uCloudShade;
uniform float uBands, uCover, uSpeed, uScale, uStars, uSunSize, uFlare, uCloudAmt;
uniform float flash;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x),
             mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += vn(p) * a; p *= 2.07; p += 13.1; a *= 0.5; }
  return s;
}

/** 5-stop vertical gradient, then hard-quantised into uBands steps. */
vec3 gradient(float y) {
  float t = clamp(y * 0.5 + 0.5, 0.0, 1.0);
  // quantise with a small ordered dither so a 1080-tall sky shows no seams
  float d = (h21(gl_FragCoord.xy * 0.5) - 0.5) * (0.55 / uBands);
  t = floor(clamp(t + d, 0.0, 1.0) * uBands + 0.5) / uBands;
  float k = t * 4.0;
  if (k < 1.0) return mix(uSky0, uSky1, k);
  if (k < 2.0) return mix(uSky1, uSky2, k - 1.0);
  if (k < 3.0) return mix(uSky2, uSky3, k - 2.0);
  return mix(uSky3, uSky4, clamp(k - 3.0, 0.0, 1.0));
}

/** One flat cloud sheet. Returns coverage in .x and the lit/shade split in .y. */
vec2 sheet(vec3 d, float h, float scale, float speed, float cover, vec2 drift) {
  if (d.y < 0.012) return vec2(0.0);
  vec2 p = d.xz / max(d.y, 0.012) * h;
  p = p * scale + drift * time * speed;
  float n = fbm(p);
  // hard threshold -> flat shape with a crisp edge
  float body = step(cover, n);
  // sample again shifted toward the sun for the internal lit/shade split
  float n2 = fbm(p + normalize(sunDir.xz + vec2(0.01)) * 0.34);
  float lit = step(cover + 0.055, n2);
  return vec2(body, lit);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 c = gradient(d.y);

  // --- horizon haze band: a hard-ish bright strip, brightest toward the sun --
  float hz = 1.0 - clamp(abs(d.y) / 0.30, 0.0, 1.0);
  float toSun = clamp(dot(normalize(vec3(sunDir.x, 0.0, sunDir.z)), normalize(vec3(d.x, 0.0, d.z))), 0.0, 1.0);
  c = mix(c, uHorizon, pow(hz, 2.0) * (0.30 + 0.55 * pow(toSun, 2.2)));

  // --- stars (deep grid biome) --------------------------------------------
  if (uStars > 0.001) {
    vec2 sp = floor(d.xz / max(abs(d.y) + 0.14, 0.14) * 210.0);
    float st = step(0.9955, h21(sp)) * clamp(d.y * 2.2, 0.0, 1.0);
    float tw = 0.55 + 0.45 * sin(time * 2.4 + h21(sp + 3.0) * 40.0);
    c += vec3(0.75, 0.85, 1.0) * st * tw * uStars;
  }

  // --- clouds: three parallax sheets, back to front ------------------------
  if (uCloudAmt > 0.001) {
    vec2 a = sheet(d, 1.00, 0.34 * uScale, 1.0, uCover + 0.10, vec2(1.0, 0.22));
    vec2 b = sheet(d, 1.60, 0.62 * uScale, 1.7, uCover + 0.02, vec2(0.86, -0.35));
    vec2 e = sheet(d, 2.60, 1.15 * uScale, 2.9, uCover - 0.05, vec2(1.15, 0.12));
    // far sheets sit closer to the sky colour (aerial perspective for clouds)
    vec3 farC = mix(uCloudShade, uCloud, 0.35);
    c = mix(c, mix(mix(farC, uCloud, a.y), c, 0.30), a.x * uCloudAmt * 0.85);
    c = mix(c, mix(uCloudShade, uCloud, b.y), b.x * uCloudAmt * 0.92);
    c = mix(c, mix(uCloudShade, uCloud, e.y), e.x * uCloudAmt);
  }

  // --- sun ----------------------------------------------------------------
  vec3 sd = normalize(sunDir);
  float cs = dot(d, sd);
  float ang = acos(clamp(cs, -1.0, 1.0));
  float R = uSunSize;

  // graphic spoke flare: hard-quantised rays in the sun's tangent basis
  vec3 t1 = normalize(cross(sd, vec3(0.0, 1.0, 0.0001)));
  vec3 t2 = cross(sd, t1);
  float pa = atan(dot(d, t2), dot(d, t1));
  float spokes = 0.5 + 0.5 * cos(pa * 12.0);
  spokes = step(0.55, spokes) * 0.6 + step(0.86, spokes) * 0.4;
  float halo = pow(clamp(1.0 - ang / (R * 16.0), 0.0, 1.0), 2.4);
  c += uSun * halo * (0.25 + spokes * 0.55) * uFlare;

  // two hard concentric rings — the "printed" part of the flare
  float r1 = smoothstep(R * 3.1, R * 3.0, ang) * step(R * 2.6, ang);
  float r2 = smoothstep(R * 5.4, R * 5.2, ang) * step(R * 4.8, ang);
  c += uSun * (r1 * 0.30 + r2 * 0.16) * uFlare;

  // the disc itself: hard edge, one bright core, one rim step
  float disc = step(ang, R);
  float core = step(ang, R * 0.62);
  c = mix(c, uSun * 1.25, disc * 0.92);
  c = mix(c, min(uSun * 1.8 + 0.35, vec3(1.6)), core * 0.85);

  c = mix(c, vec3(1.0), flash * 0.6);
  gColor = vec4(c, 1.0);
  // depth 1.0 = far plane, so the edge pass never inks the sky
  gNormalDepth = vec4(0.5, 0.5, 1.0, 1.0);
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.RawShaderMaterial;

  constructor() {
    const geo = new THREE.SphereGeometry(1, 40, 24);
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        time: Shared.time, resolution: Shared.resolution, sunDir: Shared.sunDir,
        flash: Shared.flash,
        uSky0: { value: col('#ffb06b') }, uSky1: { value: col('#ff4d8d') },
        uSky2: { value: col('#a02fb0') }, uSky3: { value: col('#4b1d8f') },
        uSky4: { value: col('#241a5c') },
        uHorizon: { value: col('#ffd0a0') }, uSun: { value: col('#fff0c0') },
        uCloud: { value: col('#ffd9b0') }, uCloudShade: { value: col('#c05a92') },
        uBands: { value: 11 }, uCover: { value: 0.52 }, uSpeed: { value: 0.006 },
        uScale: { value: 1.0 }, uStars: { value: 0.0 }, uSunSize: { value: 0.036 },
        uFlare: { value: 1.0 }, uCloudAmt: { value: 1.0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(1);
    (this.mesh as any).noInk = true;
  }

  /** Push a (possibly blended) biome into the sky + the shared scene uniforms. */
  apply(b: Biome) {
    const u = this.mat.uniforms;
    u.uSky0.value.setRGB(...hexToRgb(b.sky[0]), THREE.SRGBColorSpace);
    u.uSky1.value.setRGB(...hexToRgb(b.sky[1]), THREE.SRGBColorSpace);
    u.uSky2.value.setRGB(...hexToRgb(b.sky[2]), THREE.SRGBColorSpace);
    u.uSky3.value.setRGB(...hexToRgb(b.sky[3]), THREE.SRGBColorSpace);
    u.uSky4.value.setRGB(...hexToRgb(b.sky[4]), THREE.SRGBColorSpace);
    u.uHorizon.value.setRGB(...hexToRgb(b.horizon), THREE.SRGBColorSpace);
    u.uSun.value.setRGB(...hexToRgb(b.sun), THREE.SRGBColorSpace);
    u.uCloud.value.setRGB(...hexToRgb(b.cloud.color), THREE.SRGBColorSpace);
    u.uCloudShade.value.setRGB(...hexToRgb(b.cloud.shade), THREE.SRGBColorSpace);
    u.uCover.value = 1 - b.cloud.cover;
    u.uSpeed.value = b.cloud.speed * 100;
    u.uScale.value = b.cloud.scale;
    u.uStars.value = b.id === 'grid' ? 1 : 0;
    u.uCloudAmt.value = b.id === 'grid' ? 0.55 : 1;

    Shared.sunDir.value.set(b.sunDir[0], b.sunDir[1], b.sunDir[2]).normalize();
    Shared.sunColor.value.setRGB(...hexToRgb(b.sun), THREE.SRGBColorSpace);
    Shared.ambSky.value.setRGB(...hexToRgb(b.ambSky), THREE.SRGBColorSpace);
    Shared.ambGround.value.setRGB(...hexToRgb(b.ambGround), THREE.SRGBColorSpace);
    Shared.fogColor.value.setRGB(...hexToRgb(b.fog), THREE.SRGBColorSpace);
    Shared.fogColorHi.value.setRGB(...hexToRgb(b.sky[2]), THREE.SRGBColorSpace);
    Shared.fogNear.value = b.fogNear;
    Shared.fogFar.value = b.fogFar;
    Shared.fogBands.value = b.fogBands;
    Shared.fogStrength.value = b.fogStrength;
  }

  /** Keep the dome centred on the camera and sized just inside the far plane. */
  follow(cam: THREE.Camera, far: number) {
    this.mesh.position.setFromMatrixPosition(cam.matrixWorld);
    this.mesh.scale.setScalar(far * 0.5);
  }
}
