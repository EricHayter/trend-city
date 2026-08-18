// HUD TOOLKIT
// Every interface element is drawn with the same vocabulary as the world: hard ink
// strokes, sheared plates, flat saturated fills and stepped bars. No HTML widgets, no
// rounded corners, no soft shadows.

export const INK = '#0b0718';
export const PAPER = '#fff3e0';

export interface Ctx2 extends CanvasRenderingContext2D {}

export function plate(g: Ctx2, x: number, y: number, w: number, h: number, skew: number, fill: string, stroke = INK, lw = 4) {
  g.save();
  g.beginPath();
  g.moveTo(x + skew, y);
  g.lineTo(x + w + skew, y);
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (lw > 0) {
    g.lineWidth = lw;
    g.strokeStyle = stroke;
    g.lineJoin = 'miter';
    g.stroke();
  }
  g.restore();
}

export function chevron(g: Ctx2, x: number, y: number, w: number, h: number, fill: string, stroke = INK, lw = 3) {
  g.save();
  g.beginPath();
  g.moveTo(x, y + h);
  g.lineTo(x + w * 0.42, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w * 0.58, y + h);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = stroke;
  g.stroke();
  g.restore();
}

/** Text with a hard ink outline: legible over any part of the frame. */
export function inkText(g: Ctx2, text: string, x: number, y: number, size: number, color: string,
  align: CanvasTextAlign = 'left', weight = 900, outline = 5, skew = 0, font = 'Arial Black, Impact, Haettenschweiler, sans-serif') {
  g.save();
  g.font = weight + ' ' + size + 'px ' + font;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  if (skew !== 0) {
    g.translate(x, y);
    g.transform(1, 0, skew, 1, 0, 0);
    x = 0; y = 0;
  }
  if (outline > 0) {
    g.lineWidth = outline;
    g.strokeStyle = INK;
    g.lineJoin = 'round';
    g.strokeText(text, x, y);
  }
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.restore();
}

/** Stepped bar: fills in discrete blocks so it belongs with the banded shading. */
export function steppedBar(g: Ctx2, x: number, y: number, w: number, h: number, t: number, steps: number,
  fill: string, back = 'rgba(11,7,24,0.55)', skew = 10) {
  plate(g, x, y, w, h, skew, back, INK, 3);
  const filled = Math.round(t * steps);
  const cw = (w - 6) / steps;
  for (let i = 0; i < filled; i++) {
    plate(g, x + 3 + i * cw, y + 3, cw - 2, h - 6, skew * 0.7, fill, 'rgba(0,0,0,0)', 0);
  }
}

export function diagonalStripes(g: Ctx2, x: number, y: number, w: number, h: number, color: string, spacing = 18, alpha = 0.18, offset = 0) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.globalAlpha = alpha;
  g.strokeStyle = color;
  g.lineWidth = spacing * 0.45;
  for (let i = -h; i < w + h; i += spacing) {
    g.beginPath();
    g.moveTo(x + i + offset, y + h);
    g.lineTo(x + i + h + offset, y);
    g.stroke();
  }
  g.restore();
}

export function ring(g: Ctx2, cx: number, cy: number, r: number, from: number, to: number, width: number, color: string) {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, from, to);
  g.lineWidth = width;
  g.strokeStyle = color;
  g.lineCap = 'butt';
  g.stroke();
  g.restore();
}

/** Stepped arc gauge used by the speedometer: notched, never a smooth sweep. */
export function gauge(g: Ctx2, cx: number, cy: number, r: number, t: number, notches: number, color: string, back: string) {
  const start = Math.PI * 0.78;
  const end = Math.PI * 2.22;
  const span = end - start;
  for (let i = 0; i < notches; i++) {
    const a0 = start + (i / notches) * span + 0.014;
    const a1 = start + ((i + 1) / notches) * span - 0.014;
    const on = i / notches < t;
    ring(g, cx, cy, r, a0, a1, on ? 13 : 9, on ? color : back);
  }
}

export function shake(t: number, amp: number): [number, number] {
  return [Math.sin(t * 61) * amp, Math.sin(t * 47 + 1.1) * amp];
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return m + ':' + String(sec).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

export const RANK_COLORS: Record<string, string> = {
  S: '#ffd27a', A: '#ff3d9a', B: '#4de8ff', C: '#b6ff3d', D: '#8fa2c8',
};
