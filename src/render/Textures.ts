/**
 * Textures — every pixel in this game is generated here at boot.
 * No image files, no fetches. Canvas 2D + a little maths.
 *
 * Everything is cached by key so materials share GPU textures.
 */
import * as THREE from 'three';
import { type RampSpec, type Hex, hexToRgb, rgbToHex, C } from './Palette';
import { hash2, clamp01, lerp, smoothstep } from '../core/MathX';

const cache = new Map<string, THREE.Texture>();

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: false })!;
  return { c, g };
}

function tex(c: HTMLCanvasElement, opts: Partial<THREE.Texture> = {}): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  Object.assign(t, opts);
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// CEL RAMP — the most important texture in the game.
// Width 256, NearestFilter, no mips: sampling it produces genuinely hard steps.
// ---------------------------------------------------------------------------
export function rampTexture(spec: RampSpec, key: string): THREE.Texture {
  const k = 'ramp:' + key;
  const hit = cache.get(k); if (hit) return hit;
  const W = 256;
  const { c, g } = makeCanvas(W, 1);
  const gain = spec.gain ?? 1;
  let prev = 0;
  for (let i = 0; i < spec.stops.length; i++) {
    const x0 = Math.round(prev * W), x1 = Math.round(spec.stops[i] * W);
    const [r, gg, b] = hexToRgb(spec.colors[i]);
    g.fillStyle = rgbToHex(r * gain, gg * gain, b * gain);
    g.fillRect(x0, 0, Math.max(1, x1 - x0), 1);
    prev = spec.stops[i];
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;      // <- no interpolation. bands stay hard.
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  cache.set(k, t);
  return t;
}

// ---------------------------------------------------------------------------
// MATCAP — stylised fake environment reflection. Never a real probe.
// Built as concentric bands: dark bottom (ground bounce), bright top-left
// (sky/sun), and a hard specular blob, all quantised.
// ---------------------------------------------------------------------------
export function matcapTexture(sky: Hex, ground: Hex, hot: Hex, key: string): THREE.Texture {
  const k = 'matcap:' + key;
  const hit = cache.get(k); if (hit) return hit;
  const S = 128;
  const { c, g } = makeCanvas(S, S);
  const img = g.createImageData(S, S);
  const A = hexToRgb(sky), B = hexToRgb(ground), H = hexToRgb(hot);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x / S) * 2 - 1, ny = 1 - (y / S) * 2;
      const r2 = nx * nx + ny * ny;
      const i = (y * S + x) * 4;
      if (r2 > 1.0) { img.data[i + 3] = 0; continue; }
      const nz = Math.sqrt(Math.max(0, 1 - r2));
      // vertical band split, quantised to 4 steps -> reads as a graphic reflection
      const up = clamp01(ny * 0.5 + 0.5);
      const band = Math.floor(up * 4) / 3;
      let r = lerp(B[0], A[0], band), gg = lerp(B[1], A[1], band), b = lerp(B[2], A[2], band);
      // hard horizon line
      const hz = Math.abs(ny) < 0.045 ? 1 : 0;
      r = lerp(r, A[0] * 1.35, hz * 0.8); gg = lerp(gg, A[1] * 1.35, hz * 0.8); b = lerp(b, A[2] * 1.35, hz * 0.8);
      // specular blob, upper-left, hard edged with one soft ring
      const dx = nx + 0.42, dy = ny - 0.46;
      const d = Math.sqrt(dx * dx + dy * dy);
      const blob = d < 0.24 ? 1 : d < 0.32 ? 0.45 : 0;
      r = lerp(r, H[0], blob); gg = lerp(gg, H[1], blob); b = lerp(b, H[2], blob);
      // rim brighten at the sphere edge
      const rim = smoothstep((r2 - 0.72) / 0.28) * 0.55;
      r += rim * A[0]; gg += rim * A[1]; b += rim * A[2];
      // subtle vertical banding so flat surfaces still show structure
      const stripe = ((Math.floor(nz * 9) & 1) ? 1.06 : 0.96);
      img.data[i] = Math.min(255, r * stripe * 255);
      img.data[i + 1] = Math.min(255, gg * stripe * 255);
      img.data[i + 2] = Math.min(255, b * stripe * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = tex(c, { wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  cache.set(k, t);
  return t;
}

// ---------------------------------------------------------------------------
// HATCH — screen-aligned pen hatching mixed into the darkest cel band.
// Three tonal levels packed into R/G/B so one sample gives three densities.
// ---------------------------------------------------------------------------
export function hatchTexture(): THREE.Texture {
  const k = 'hatch'; const hit = cache.get(k); if (hit) return hit;
  const S = 256;
  const { c, g } = makeCanvas(S, S);
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const draw = (chan: number, spacing: number, angle: number, wob: number, wid: number) => {
    const cv = makeCanvas(S, S);
    cv.g.fillStyle = '#000'; cv.g.fillRect(0, 0, S, S);
    cv.g.strokeStyle = '#fff'; cv.g.lineWidth = wid; cv.g.lineCap = 'butt';
    cv.g.save(); cv.g.translate(S / 2, S / 2); cv.g.rotate(angle); cv.g.translate(-S / 2, -S / 2);
    for (let i = -S; i < S * 2; i += spacing) {
      cv.g.beginPath();
      // hand-drawn wobble: the line is not a perfect ruler stroke
      for (let y = -S; y <= S * 2; y += 8) {
        const x = i + Math.sin(y * 0.06 + i * 0.4) * wob + Math.sin(y * 0.21 + i) * wob * 0.4;
        if (y === -S) cv.g.moveTo(x, y); else cv.g.lineTo(x, y);
      }
      cv.g.stroke();
    }
    cv.g.restore();
    const src = cv.g.getImageData(0, 0, S, S);
    const dst = g.getImageData(0, 0, S, S);
    for (let i = 0; i < src.data.length; i += 4) dst.data[i + chan] = src.data[i];
    g.putImageData(dst, 0, 0);
  };
  draw(0, 9, -0.62, 1.1, 1.6);   // R: light hatch
  draw(1, 6, -0.62, 1.0, 1.7);   // G: medium
  draw(2, 4, 0.95, 0.9, 1.8);    // B: dense cross-hatch
  const t = tex(c, { colorSpace: THREE.NoColorSpace, anisotropy: 1 });
  cache.set(k, t); return t;
}

/** HALFTONE — expanding dot grid, used on the boss and in impact frames. */
export function halftoneTexture(): THREE.Texture {
  const k = 'halftone'; const hit = cache.get(k); if (hit) return hit;
  const S = 128, cell = 8;
  const { c, g } = makeCanvas(S, S);
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += cell) for (let x = 0; x < S; x += cell) {
    const r = cell * 0.42;
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(x + cell / 2, y + cell / 2, r, 0, Math.PI * 2); g.fill();
  }
  // second offset grid for a finer level in the green channel
  const d = g.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const fx = (x % 4) - 2, fy = (y % 4) - 2;
    d.data[i + 1] = Math.hypot(fx, fy) < 1.5 ? 255 : 0;
  }
  g.putImageData(d, 0, 0);
  const t = tex(c, { colorSpace: THREE.NoColorSpace, anisotropy: 1 });
  cache.set(k, t); return t;
}

// ---------------------------------------------------------------------------
// SURFACE DETAIL MAPS — these carry the *drawn* look of the architecture.
// They are multiplied into albedo, never used as normal/roughness maps.
// ---------------------------------------------------------------------------

/** Value noise helper on the CPU. */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c2 = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c2, d, u), v);
}
function fbm(x: number, y: number, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f) * a; f *= 2.07; a *= 0.5; }
  return s;
}

/**
 * CONCRETE — quantised blotches + panel seams + a few hand-placed stains.
 * Deliberately *not* uniform noise: the blotches are posterised to 4 levels so
 * they read as painted patches rather than photographic grain.
 */
export function concreteTexture(tint: Hex = '#ffffff'): THREE.Texture {
  const k = 'concrete:' + tint; const hit = cache.get(k); if (hit) return hit;
  const S = 512;
  const { c, g } = makeCanvas(S, S);
  const img = g.createImageData(S, S);
  const T = hexToRgb(tint);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbm(x / 64, y / 64, 4);
    const q = Math.floor(clamp01(n) * 4) / 3;          // posterise
    let v = lerp(0.80, 1.06, q);
    // fine speckle, also posterised
    v *= (hash2(x * 3.1, y * 2.7) > 0.86 ? 0.90 : 1.0);
    const i = (y * S + x) * 4;
    img.data[i] = v * T[0] * 255; img.data[i + 1] = v * T[1] * 255; img.data[i + 2] = v * T[2] * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // panel seams — hard dark lines on an irregular grid
  g.strokeStyle = 'rgba(0,0,0,0.30)'; g.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const y = Math.round((i / 5) * S + hash2(i, 7) * 40);
    g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
  }
  for (let i = 0; i < 4; i++) {
    const x = Math.round((i / 4) * S + hash2(i, 13) * 60);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke();
  }
  // streak stains under the seams — one of the strongest "hand-made" cues
  for (let i = 0; i < 22; i++) {
    const x = hash2(i, 3) * S, y = hash2(i, 9) * S;
    const h = 30 + hash2(i, 21) * 120, w = 3 + hash2(i, 31) * 12;
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, 'rgba(0,0,0,0.22)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(x, y, w, h);
  }
  const t = tex(c); cache.set(k, t); return t;
}

/** METAL PANEL — riveted plates with a strong directional brush. */
export function metalTexture(tint: Hex = '#ffffff'): THREE.Texture {
  const k = 'metal:' + tint; const hit = cache.get(k); if (hit) return hit;
  const S = 512;
  const { c, g } = makeCanvas(S, S);
  const T = hexToRgb(tint);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // anisotropic brush: high frequency across, low along
    const n = fbm(x / 3, y / 90, 3);
    const q = Math.floor(clamp01(n) * 5) / 4;
    const v = lerp(0.86, 1.10, q);
    const i = (y * S + x) * 4;
    img.data[i] = v * T[0] * 255; img.data[i + 1] = v * T[1] * 255; img.data[i + 2] = v * T[2] * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const P = 128;
  g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.38)';
  for (let i = 0; i <= S; i += P) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 2;
  for (let i = 0; i <= S; i += P) {
    g.beginPath(); g.moveTo(i + 3, 0); g.lineTo(i + 3, S); g.stroke();
  }
  // rivets
  for (let py = 0; py < S; py += P) for (let px = 0; px < S; px += P) {
    for (let k2 = 0; k2 < 4; k2++) {
      const rx = px + 12 + (k2 % 2) * (P - 24), ry = py + 12 + Math.floor(k2 / 2) * (P - 24);
      g.fillStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); g.arc(rx, ry, 3.4, 0, 6.3); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.arc(rx - 1, ry - 1, 1.9, 0, 6.3); g.fill();
    }
  }
  const t = tex(c); cache.set(k, t); return t;
}

/**
 * FACADE — the workhorse for city buildings. Window lattice with lit / dark
 * windows chosen from a *structured* pattern (floor bands, vertical cores)
 * rather than pure noise, so towers read as buildings with floors and lifts.
 * RGB = albedo, and the emissive mask lives in a companion texture.
 */
export function facadeTextures(
  body: Hex, frame: Hex, lit: Hex, seed: number,
  cols = 8, rows = 12, litChance = 0.4,
): { albedo: THREE.Texture; emissive: THREE.Texture } {
  const k = `facade:${body}${frame}${lit}${seed}${cols}${rows}${litChance}`;
  const a = cache.get(k + ':a'), e = cache.get(k + ':e');
  if (a && e) return { albedo: a, emissive: e };
  const S = 512;
  const A = makeCanvas(S, S), E = makeCanvas(S, S);
  A.g.fillStyle = body; A.g.fillRect(0, 0, S, S);
  E.g.fillStyle = '#000'; E.g.fillRect(0, 0, S, S);
  // base grime so the flat body colour is not dead flat
  const img = A.g.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const v = lerp(0.90, 1.06, Math.floor(fbm(x / 90 + seed, y / 90) * 4) / 3);
    img.data[i] *= v; img.data[i + 1] *= v; img.data[i + 2] *= v;
  }
  A.g.putImageData(img, 0, 0);

  const cw = S / cols, ch = S / rows;
  const pad = Math.max(2, cw * 0.16), padY = Math.max(2, ch * 0.20);
  // structured lighting: some whole floors are lit, some vertical cores are dark
  const floorLit: number[] = [], coreDark: boolean[] = [];
  for (let r = 0; r < rows; r++) floorLit[r] = hash2(seed * 7 + r, 3) < 0.30 ? 1 : 0;
  for (let cx = 0; cx < cols; cx++) coreDark[cx] = hash2(seed * 11 + cx, 5) < 0.22;
  for (let r = 0; r < rows; r++) for (let cx = 0; cx < cols; cx++) {
    const x = cx * cw + pad, y = r * ch + padY;
    const w = cw - pad * 2, h = ch - padY * 2;
    A.g.fillStyle = frame; A.g.fillRect(cx * cw, r * ch, cw, ch);
    let on = false;
    if (!coreDark[cx]) {
      const rr = hash2(seed * 3 + cx * 17, r * 13 + 1);
      on = floorLit[r] ? rr < 0.85 : rr < litChance;
    }
    if (on) {
      A.g.fillStyle = lit; A.g.fillRect(x, y, w, h);
      E.g.fillStyle = '#fff'; E.g.fillRect(x, y, w, h);
      // occasional silhouette bar inside the window (blinds / partition)
      if (hash2(cx * 5 + seed, r * 9) < 0.35) {
        const bh = h * (0.2 + hash2(r, cx) * 0.35);
        A.g.fillStyle = 'rgba(0,0,0,0.55)'; A.g.fillRect(x, y, w, bh);
        E.g.fillStyle = 'rgba(0,0,0,0.75)'; E.g.fillRect(x, y, w, bh);
      }
    } else {
      A.g.fillStyle = 'rgba(0,0,0,0.55)'; A.g.fillRect(x, y, w, h);
    }
  }
  // hard structural bands every few floors (mechanical levels)
  for (let r = 0; r < rows; r += 4) {
    A.g.fillStyle = 'rgba(0,0,0,0.5)'; A.g.fillRect(0, r * ch - 3, S, 6);
    E.g.fillStyle = '#000'; E.g.fillRect(0, r * ch - 3, S, 6);
  }
  const at = tex(A.c), et = tex(E.c, { colorSpace: THREE.NoColorSpace });
  cache.set(k + ':a', at); cache.set(k + ':e', et);
  return { albedo: at, emissive: et };
}

/** GRID — the digital biome's signature surface: glowing wire cells. */
export function gridTexture(line: Hex, bg: Hex, div = 8): { albedo: THREE.Texture; emissive: THREE.Texture } {
  const k = `grid:${line}${bg}${div}`;
  const a = cache.get(k + ':a'), e = cache.get(k + ':e');
  if (a && e) return { albedo: a, emissive: e };
  const S = 512, cw = S / div;
  const A = makeCanvas(S, S), E = makeCanvas(S, S);
  A.g.fillStyle = bg; A.g.fillRect(0, 0, S, S);
  E.g.fillStyle = '#000'; E.g.fillRect(0, 0, S, S);
  for (const [ctx, col, w] of [[A.g, line, 3], [E.g, '#ffffff', 3]] as const) {
    ctx.strokeStyle = col as string; ctx.lineWidth = w as number;
    for (let i = 0; i <= S; i += cw) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
    for (let i = 0; i <= S; i += cw / 4) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // a few brighter "active" cells
  for (let i = 0; i < 10; i++) {
    const gx = Math.floor(hash2(i, 2) * div) * cw, gy = Math.floor(hash2(i, 8) * div) * cw;
    A.g.fillStyle = line; A.g.globalAlpha = 0.22; A.g.fillRect(gx, gy, cw, cw); A.g.globalAlpha = 1;
    E.g.fillStyle = '#fff'; E.g.globalAlpha = 0.30; E.g.fillRect(gx, gy, cw, cw); E.g.globalAlpha = 1;
  }
  const at = tex(A.c), et = tex(E.c, { colorSpace: THREE.NoColorSpace });
  cache.set(k + ':a', at); cache.set(k + ':e', et);
  return { albedo: at, emissive: et };
}

/** HAZARD stripes for industrial edges and launch ramps. */
export function hazardTexture(a: Hex = C.gold, b: Hex = '#1a1208'): THREE.Texture {
  const k = 'hazard:' + a + b; const hit = cache.get(k); if (hit) return hit;
  const S = 128;
  const { c, g } = makeCanvas(S, S);
  g.fillStyle = b; g.fillRect(0, 0, S, S);
  g.save(); g.translate(S / 2, S / 2); g.rotate(-Math.PI / 4); g.translate(-S, -S);
  g.fillStyle = a;
  for (let i = 0; i < S * 2; i += 32) g.fillRect(i, 0, 16, S * 2);
  g.restore();
  // scuffs
  g.globalAlpha = 0.25; g.fillStyle = '#000';
  for (let i = 0; i < 40; i++) g.fillRect(hash2(i, 1) * S, hash2(i, 2) * S, 2 + hash2(i, 3) * 9, 2);
  g.globalAlpha = 1;
  const t = tex(c); cache.set(k, t); return t;
}

/** Vertical scan/energy gradient for rails, beams and grind lines. */
export function energyTexture(a: Hex, b: Hex): THREE.Texture {
  const k = 'energy:' + a + b; const hit = cache.get(k); if (hit) return hit;
  const S = 64;
  const { c, g } = makeCanvas(S, S);
  g.fillStyle = b; g.fillRect(0, 0, S, S);
  g.fillStyle = a;
  for (let i = 0; i < S; i += 8) g.fillRect(0, i, S, 4);
  g.fillStyle = '#fff'; g.globalAlpha = 0.7; g.fillRect(0, 0, S, 2);
  g.globalAlpha = 1;
  const t = tex(c, { anisotropy: 1 }); cache.set(k, t); return t;
}

// ---------------------------------------------------------------------------
// COLOUR GRADING LUT
// 32³ cube unwrapped into a 1024×32 strip. Hand-authored curves, not a preset:
//  * shadows are pulled toward violet and never reach black
//  * midtones gain saturation with a hue push toward magenta/cyan poles
//  * highlights roll off to warm cream so hot geometry doesn't clip to white
//  * greens are desaturated slightly (keeps the acid accent special)
// ---------------------------------------------------------------------------
export function gradeLUT(): THREE.Texture {
  const k = 'lut'; const hit = cache.get(k); if (hit) return hit;
  const N = 32, W = N * N, H = N;
  const { c, g } = makeCanvas(W, H);
  const img = g.createImageData(W, H);
  const shadowTint = hexToRgb('#2a1550');
  const highTint = hexToRgb('#fff0d6');
  for (let b = 0; b < N; b++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let r = x / (N - 1), gg = y / (N - 1), bb = b / (N - 1);

    // 1. contrast S-curve around 0.46 pivot
    const scurve = (v: number) => {
      const t = clamp01(v);
      return clamp01(t < 0.46 ? 0.46 * Math.pow(t / 0.46, 1.28) : 1 - (1 - 0.46) * Math.pow((1 - t) / 0.54, 1.16));
    };
    r = scurve(r); gg = scurve(gg); bb = scurve(bb);

    // 2. luma + saturation boost with a soft knee so neons don't clip
    const l = r * 0.299 + gg * 0.587 + bb * 0.114;
    const sat = 1.30 - 0.35 * l;
    r = l + (r - l) * sat; gg = l + (gg - l) * sat; bb = l + (bb - l) * sat;

    // 3. green desaturation (keeps acid green as a rare accent)
    const greenness = clamp01(gg - Math.max(r, bb));
    gg -= greenness * 0.18; r += greenness * 0.05;

    // 4. shadow / highlight tinting
    const shw = Math.pow(1 - clamp01(l), 2.4);
    const hiw = Math.pow(clamp01(l), 2.8);
    r = lerp(r, shadowTint[0] + r * 0.55, shw * 0.55);
    gg = lerp(gg, shadowTint[1] + gg * 0.55, shw * 0.55);
    bb = lerp(bb, shadowTint[2] + bb * 0.55, shw * 0.55);
    r = lerp(r, highTint[0], hiw * 0.30);
    gg = lerp(gg, highTint[1], hiw * 0.30);
    bb = lerp(bb, highTint[2], hiw * 0.30);

    // 5. lift floor — pure black is banned, it kills the ink lines' readability
    r = 0.028 + r * 0.972; gg = 0.020 + gg * 0.980; bb = 0.052 + bb * 0.948;

    const px = (y * W + b * N + x) * 4;
    img.data[px] = clamp01(r) * 255;
    img.data[px + 1] = clamp01(gg) * 255;
    img.data[px + 2] = clamp01(bb) * 255;
    img.data[px + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  // A LUT is data, not a picture: the shader indexes rows by the green channel,
  // so the default canvas flip would read row (31 - g) and invert every green.
  t.flipY = false;
  t.generateMipmaps = false; t.needsUpdate = true;
  cache.set(k, t); return t;
}

/** Blue-noise-ish 64² tile for dither and particle jitter. */
export function blueNoise(): THREE.Texture {
  const k = 'bn'; const hit = cache.get(k); if (hit) return hit;
  const S = 64;
  const { c, g } = makeCanvas(S, S);
  const img = g.createImageData(S, S);
  // void-and-cluster is overkill; a jittered bayer beats white noise for banding
  const bayer = (x: number, y: number, n = 8) => {
    let v = 0, m = 0;
    for (let i = n; i > 0; i >>= 1) {
      v = (v << 2) | (((x & i) ? 1 : 0) << 1 | ((x & i) !== (y & i) ? 1 : 0));
      m = (m << 2) | 3;
    }
    return v / (m + 1);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const v = clamp01(bayer(x, y) * 0.75 + hash2(x, y) * 0.25) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = tex(c, { colorSpace: THREE.NoColorSpace, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, generateMipmaps: false, anisotropy: 1 });
  cache.set(k, t); return t;
}

export function disposeTextures() { for (const t of cache.values()) t.dispose(); cache.clear(); }
