// SCREEN-SPACE POST STAGES
// Three authored passes run after the scene: a Sobel ink pass over a normal+depth
// prepass (the interior lines inverted hulls cannot produce), a speed pass (radial
// lines, radial smear, chroma split, impact flash), and a grading pass that resolves
// the whole frame through a code-generated LUT.

export const FS_QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const INK_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tNormalDepth;
uniform vec2 uTexel;
uniform vec3 uInk;
uniform float uNormalScale;
uniform float uDepthScale;
uniform float uThickness;
uniform float uFadeStart;
uniform float uStrength;
varying vec2 vUv;

vec4 nd(vec2 uv) { return texture2D(tNormalDepth, uv); }

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec2 t = uTexel * uThickness;

  vec4 c  = nd(vUv);
  vec4 l  = nd(vUv - vec2(t.x, 0.0));
  vec4 r  = nd(vUv + vec2(t.x, 0.0));
  vec4 u  = nd(vUv + vec2(0.0, t.y));
  vec4 d  = nd(vUv - vec2(0.0, t.y));
  vec4 lu = nd(vUv + vec2(-t.x,  t.y));
  vec4 ru = nd(vUv + vec2( t.x,  t.y));
  vec4 ld = nd(vUv + vec2(-t.x, -t.y));
  vec4 rd = nd(vUv + vec2( t.x, -t.y));

  // Sobel over depth. The gradient is normalised by depth so a crease reads the same
  // at 5 metres and at 200 metres instead of exploding into noise in the distance.
  float gx = (lu.a + 2.0 * l.a + ld.a) - (ru.a + 2.0 * r.a + rd.a);
  float gy = (lu.a + 2.0 * u.a + ru.a) - (ld.a + 2.0 * d.a + rd.a);
  float depthEdge = length(vec2(gx, gy)) / max(c.a, 0.0025);

  // Normal discontinuity: a straight dot product against the neighbourhood.
  vec3 nc = c.rgb * 2.0 - 1.0;
  float nDiff = 0.0;
  nDiff = max(nDiff, 1.0 - dot(nc, l.rgb * 2.0 - 1.0));
  nDiff = max(nDiff, 1.0 - dot(nc, r.rgb * 2.0 - 1.0));
  nDiff = max(nDiff, 1.0 - dot(nc, u.rgb * 2.0 - 1.0));
  nDiff = max(nDiff, 1.0 - dot(nc, d.rgb * 2.0 - 1.0));

  float edge = clamp(depthEdge * uDepthScale + nDiff * uNormalScale - 0.22, 0.0, 1.0);
  edge = smoothstep(0.18, 0.62, edge);

  // Skip pixels the inverted hull already inked, so the two line systems never
  // stack into a muddy double stroke.
  float lum = dot(base.rgb, vec3(0.299, 0.587, 0.114));
  edge *= smoothstep(0.03, 0.20, lum);
  // Distance falloff keeps far clutter from turning into hatched noise.
  edge *= 1.0 - smoothstep(uFadeStart, 1.0, c.a);
  // Nothing to ink where there is no geometry (sky).
  edge *= step(0.0004, c.a);

  gl_FragColor = vec4(mix(base.rgb, uInk, edge * uStrength), base.a);
}
`;

export const SPEED_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uCenter;
uniform float uSpeed;      // 0..1 normalised velocity
uniform float uBoost;      // 0..1 boost / dash state
uniform float uTime;
uniform float uAspect;
uniform float uFlash;
uniform vec3  uFlashColor;
uniform float uChroma;
uniform float uHitstop;
varying vec2 vUv;

float h11(float x) { return fract(sin(x * 91.3458) * 47453.5453); }

void main() {
  vec2 d = vUv - uCenter;
  d.x *= uAspect;
  float r = length(d);
  float a = atan(d.y, d.x);

  float intensity = clamp(uSpeed * 0.85 + uBoost * 0.6, 0.0, 1.4);

  // RADIAL SMEAR: a handful of taps back toward the focus point. Only ever strong
  // at the frame edges, so the middle of the screen stays readable at full speed.
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  float smear = intensity * smoothstep(0.12, 0.62, r) * 0.5;
  if (smear > 0.002) {
    vec2 dir = normalize(vUv - uCenter) * smear * 0.045;
    col += texture2D(tDiffuse, vUv - dir * 0.35).rgb;
    col += texture2D(tDiffuse, vUv - dir * 0.7).rgb;
    col += texture2D(tDiffuse, vUv - dir).rgb;
    col *= 0.25;
  }

  // CHROMA SPLIT at the edges, scaled by speed. Subtle, never a gimmick.
  if (uChroma > 0.001) {
    vec2 off = normalize(d + 1e-5) * uChroma * r * 0.006;
    col.r = texture2D(tDiffuse, vUv + off).r;
    col.b = texture2D(tDiffuse, vUv - off).b;
  }

  // RADIAL SPEED LINES: hard-edged strokes keyed off the angle, scrolling outward.
  float lines = 0.0;
  if (intensity > 0.04) {
    float id = floor(a * 26.0);
    float rnd = h11(id);
    float w = 0.34 + rnd * 0.4;
    float band = step(w, fract(a * 26.0));
    float travel = fract(r * (1.1 + rnd * 1.4) - uTime * (1.4 + intensity * 2.6) - rnd);
    float stroke = step(0.62, travel) * band;
    lines = stroke * smoothstep(0.2, 0.78, r) * intensity;
  }
  vec3 lineCol = mix(vec3(1.0), uFlashColor, 0.35);
  col = mix(col, lineCol, clamp(lines * 0.55, 0.0, 0.8));

  // Hit-stop drains colour for a couple of frames: reads as a held impact frame.
  float g = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(g) * 1.06, uHitstop * 0.7);

  col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

export const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler3D uLut;
uniform float uLutSize;
uniform float uLutMix;
uniform float uVignette;
uniform float uUrgency;    // stage timer pressure 0..1
uniform vec3  uUrgencyColor;
uniform float uTime;
uniform float uFade;       // screen transition wipe 0..1
varying vec2 vUv;

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  col = clamp(col, 0.0, 1.0);

  // Code-authored LUT: one grade unifies characters, world, effects and UI.
  vec3 scaled = col * (uLutSize - 1.0) + 0.5;
  vec3 graded = texture(uLut, scaled / uLutSize).rgb;
  col = mix(col, graded, uLutMix);

  // Graphic vignette, stepped rather than smooth so it belongs with the line work.
  float r = length((vUv - 0.5) * vec2(1.1, 1.0));
  float vig = 1.0 - uVignette * smoothstep(0.42, 0.92, r);
  col *= vig;

  // Timer pressure: a pulsing edge tint that escalates as the clock runs out.
  float pulse = 0.5 + 0.5 * sin(uTime * (5.0 + uUrgency * 9.0));
  col = mix(col, uUrgencyColor, uUrgency * smoothstep(0.3, 0.95, r) * (0.22 + 0.26 * pulse));

  // Hard-edged transition wipe used between screens.
  float wipe = step(vUv.x * 0.6 + vUv.y * 0.4, uFade);
  col = mix(col, vec3(0.02, 0.01, 0.06), wipe);

  gl_FragColor = vec4(col, 1.0);
}
`;
