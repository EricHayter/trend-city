import { DataTexture, Data3DTexture, RGBAFormat, UnsignedByteType, NearestFilter, LinearFilter,
  ClampToEdgeWrapping, RepeatWrapping, Color, Texture, CanvasTexture, SRGBColorSpace } from 'three';

// EVERY texture in the game is generated here, in code. No files, no downloads.

const c = new Color();
const c2 = new Color();

/**
 * RAMP / STEP LIGHTING TEXTURE
 * A 1D lookup with N hard bands, sampled with NearestFilter so there is zero
 * interpolation. Thresholds and per-band tints are authored per material class,
 * which is what lets concrete, skin, metal and glass each own their cel response.
 */
export function makeRampTexture(bands: { at: number; color: number }[], width = 64): DataTexture {
  const data = new Uint8Array(width * 4);
  const sorted = bands.slice().sort((a, b) => a.at - b.at);
  for (let i = 0; i < width; i++) {
    const t = (i + 0.5) / width;
    let chosen = sorted[0];
    for (const b of sorted) if (t >= b.at) chosen = b;
    c.setHex(chosen.color);
    data[i * 4 + 0] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * STYLISED FAKE ENVIRONMENT REFLECTION
 * A matcap authored as banded graphic shapes, never a real cubemap probe: a bright
 * upper sweep, a hard mid band, a warm bounce from below and a clipped hot spot.
 */
export function makeMatcap(top: number, mid: number, bottom: number, hot: number, size = 128): Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
  // Sphere body split into three hard bands along a tilted axis.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const ax = 0.44, ay = 0.82;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * 2 - 1;
      const ny = 1 - (y / size) * 2;
      const r2 = nx * nx + ny * ny;
      const i = (y * size + x) * 4;
      if (r2 > 1) { d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = 255; continue; }
      const nz = Math.sqrt(Math.max(0, 1 - r2));
      const k = nx * ax + ny * ay + nz * 0.36;
      let col = bottom;
      if (k > 0.78) col = hot; else if (k > 0.42) col = top; else if (k > 0.02) col = mid;
      c.setHex(col);
      d[i] = c.r * 255; d[i + 1] = c.g * 255; d[i + 2] = c.b * 255; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // A single clipped graphic highlight streak, drawn hard-edged on purpose.
  g.globalAlpha = 0.9;
  g.fillStyle = hex(hot);
  g.beginPath();
  g.ellipse(size * 0.34, size * 0.26, size * 0.14, size * 0.06, -0.7, 0, Math.PI * 2);
  g.fill();
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * SHADOW-BAND HATCHING
 * Screen-aligned diagonal ink hatch, blended at low opacity inside the darkest
 * band only. Reads as stylised shading texture, never as a screen filter.
 */
export function makeHatchTexture(size = 64): Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = '#000';
  g.lineWidth = 2.0;
  g.lineCap = 'butt';
  for (let i = -size; i < size * 2; i += 8) {
    g.beginPath();
    g.moveTo(i, -4);
    g.lineTo(i + size + 4, size + 4);
    g.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * COLOUR GRADING LUT
 * Authored in code as a 3D lookup: shadows pushed to violet ink, midtones pulled
 * toward the palette accent, highlights warmed, saturation lifted, then a gentle
 * filmic-free contrast S-curve. Applied once as the final post pass so characters,
 * world, effects and UI all resolve under the same palette.
 */
export function makeGradingLUT(size = 32, accent = 0x7b3bff, shadowTint = 0x1a1040, highlight = 0xfff0d8): Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  const ac = new Color(accent);
  const sc = new Color(shadowTint);
  const hc = new Color(highlight);
  let p = 0;
  for (let bz = 0; bz < size; bz++) {
    for (let gy = 0; gy < size; gy++) {
      for (let rx = 0; rx < size; rx++) {
        let r = rx / (size - 1), gg = gy / (size - 1), b = bz / (size - 1);
        const lum = r * 0.299 + gg * 0.587 + b * 0.114;
        // Contrast S-curve around a slightly raised pivot.
        const curve = (v: number) => {
          const t = Math.min(1, Math.max(0, v));
          return t * t * (3 - 2 * t) * 0.82 + t * 0.18;
        };
        r = curve(r); gg = curve(gg); b = curve(b);
        // Split tone.
        const sw = Math.pow(1 - lum, 2.2) * 0.34;
        const hw = Math.pow(lum, 2.4) * 0.22;
        r = r * (1 - sw) + sc.r * sw; gg = gg * (1 - sw) + sc.g * sw; b = b * (1 - sw) + sc.b * sw;
        r = r * (1 - hw) + hc.r * hw; gg = gg * (1 - hw) + hc.g * hw; b = b * (1 - hw) + hc.b * hw;
        // Midtone pull toward the accent hue, strongest at mid luminance.
        const mw = Math.max(0, 1 - Math.abs(lum - 0.45) * 2.6) * 0.1;
        r = r * (1 - mw) + ac.r * mw; gg = gg * (1 - mw) + ac.g * mw; b = b * (1 - mw) + ac.b * mw;
        // Saturation lift.
        const l2 = r * 0.299 + gg * 0.587 + b * 0.114;
        const sat = 1.22;
        r = l2 + (r - l2) * sat; gg = l2 + (gg - l2) * sat; b = l2 + (b - l2) * sat;
        data[p++] = Math.round(Math.min(1, Math.max(0, r)) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, gg)) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, b)) * 255);
        data[p++] = 255;
      }
    }
  }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Hard-edged particle sprite sheet: shards, chevrons, rings, sparks. No soft blobs. */
export function makeParticleAtlas(size = 256): Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  const q = size / 2;
  const poly = (cx: number, cy: number, pts: number[][]) => {
    g.beginPath();
    g.moveTo(cx + pts[0][0], cy + pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(cx + pts[i][0], cy + pts[i][1]);
    g.closePath();
    g.fill();
  };
  g.fillStyle = '#fff';
  // 0: four-point star shard
  poly(q * 0.5, q * 0.5, [[0, -46], [12, -12], [46, 0], [12, 12], [0, 46], [-12, 12], [-46, 0], [-12, -12]]);
  // 1: angular chevron
  poly(q * 1.5, q * 0.5, [[-34, 26], [0, -30], [34, 26], [10, 26], [0, 2], [-10, 26]]);
  // 2: hard ring
  g.beginPath(); g.arc(q * 0.5, q * 1.5, 44, 0, Math.PI * 2); g.arc(q * 0.5, q * 1.5, 30, 0, Math.PI * 2, true); g.fill();
  // 3: debris triangle cluster
  poly(q * 1.5, q * 1.5, [[-30, 24], [-6, -28], [22, -6], [30, 28]]);
  const tex = new CanvasTexture(cv);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
