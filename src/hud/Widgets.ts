/**
 * Widgets — the stage HUD elements.
 *
 * Every widget owns exactly one layer, decides for itself whether its content
 * changed this frame, and draws only when it did. The `sig()` pattern below is
 * the whole dirty-tracking scheme: a widget builds a short string describing
 * everything it would draw, and if that string is unchanged the layer is skipped
 * entirely — no clear, no strokes, no texture upload. It is crude and it is
 * exactly right: it is impossible to forget to invalidate something, because the
 * signature *is* the content.
 *
 * Enter/exit animation lives on the quad (slide + scale + alpha), not on the
 * canvas, so a panel flying in costs nothing to draw. See HudLayer.slideX.
 *
 * ── WHAT THIS FILE IS NOT, ANY MORE ─────────────────────────────────────────
 * The race is gone. There is no standings board, no position block, no gap
 * readouts, no trick score and no km/h. What replaced them is a stage HUD: a
 * clock counting DOWN, health, boost, a combo with a draining window, the
 * collection counts, a descent profile, a contextual traversal prompt and a
 * boss bar. See docs/PIVOT.md.
 *
 * ── THE SPEED READOUT IS A CONTRACT ─────────────────────────────────────────
 * `HudModel.speedDisplay` is already in Spark display units (m/s × 2.5). It is
 * rendered exactly as given. The conversion lives in
 * `src/player/SparkConstants.ts` and is not repeated, re-derived or inverted
 * anywhere in this directory, and no unit string appears next to the number
 * — Spark 3 shows a bare figure and so does this.
 *
 * ── ONE SOURCE OF TRUTH PER DISPLAYED FACT ──────────────────────────────────
 * RESUME.md bug #10: rider names came from one list and their colour chips from
 * another, so the leaderboard drew every racer in the wrong colour in every
 * frame. Nothing here reads a fact from two places. The checkpoint marks on the
 * descent profile are the surviving case where it could happen — the positions
 * come from `CHECKPOINT_TS` and the times from `HudModel.splits` — so the SET
 * of checkpoints is taken from `splits` alone and `CHECKPOINT_TS` is only ever
 * indexed by a split's own `index`, with a bounds guard. A checkpoint the model
 * does not report is not drawn.
 */

import type { HudModel, HudPopup } from '../game/Contracts';
import { MoveMode, StagePhase, TraversalPrompt } from '../game/Contracts';
import { HUD_PALETTE } from '../npr/Palette';
import { CHECKPOINT_TS } from '../game/WorldConstants';
import {
  clamp,
  clamp01,
  dampHL,
  ease,
  formatGap,
  makeSpring,
  springStep,
  type SpringState,
} from '../core/MathX';
import {
  HudLayer,
  bar,
  chevron,
  cornerTicks,
  css,
  cssA,
  cssMix,
  hazard,
  slab,
  slabPath,
  tick,
  tri,
  INK_W,
  SHEAR,
} from './HudCanvas';
import { drawText, measureText, type TextStyle } from './Typeface';

// ── Shared palette strings, resolved once ────────────────────────────────────
export const P = {
  ink: css(HUD_PALETTE.ink),
  inkSoft: css(HUD_PALETTE.inkSoft),
  paper: css(HUD_PALETTE.paper),
  paperDim: css(HUD_PALETTE.paperDim),
  gold: css(HUD_PALETTE.gold),
  goldHot: css(HUD_PALETTE.goldHot),
  red: css(HUD_PALETTE.red),
  teal: css(HUD_PALETTE.teal),
  violet: css(HUD_PALETTE.violet),
  boost: css(HUD_PALETTE.boost),
  boostFull: css(HUD_PALETTE.boostFull),
  shadow: css(HUD_PALETTE.shadow),
  // ── PANEL OPACITY ──────────────────────────────────────────────────────────
  // These were 0.66 / 0.82 / 0.50 and that is not a stylistic difference, it is
  // a bug. At 0.66 a high-contrast subject behind a panel is still fully
  // legible THROUGH it: conifers and terrain read inside the descent profile,
  // a whole character reads on top of the speedometer. The HUD is composited
  // after the graded frame precisely so that nothing in the scene can sit in
  // front of it — a translucent fill throws that away and lets the scene sit in
  // front of it anyway.
  //
  // 0.93 was tried first and it is NOT enough, which is worth recording: the
  // panels are near-black, and 7% of a bright highlight over a value of 29 is
  // a 14-unit step — on a dark flat field that is not a hint of the scene, it
  // is the scene. Weber's law does not care that the number is small.
  //
  // So they are opaque, and the two levels are now two INKS rather than two
  // alphas: a lifted violet-black for the general panel, the true ink for the
  // ones that carry the primary readouts.
  panel: css(HUD_PALETTE.inkSoft),
  panelDeep: css(HUD_PALETTE.ink),
  panelLight: cssA(HUD_PALETTE.inkSoft, 0.85),
};

// Body text style. Tables and small labels do NOT get the house shear — a
// sheared column of numbers is unreadable, and legibility beats consistency.
export const LABEL: TextStyle = { size: 18, weight: 0.16, fill: P.paperDim, ink: P.ink, tracking: 0.13, skew: 0 };
export const VALUE: TextStyle = { size: 26, weight: 0.15, fill: P.paper, ink: P.ink, tracking: 0.06, skew: 0 };

/**
 * The phases in which the stage furniture is on screen.
 *
 * One predicate, used by every widget, because "is the run happening" was
 * previously written out longhand in nine places and two of them disagreed
 * about whether the finish counts. It does: the run-out after the goal is the
 * frame where the player reads their final clock.
 */
export function stageLive(p: StagePhase): boolean {
  return (
    p === StagePhase.Running ||
    p === StagePhase.Boss ||
    p === StagePhase.Countdown ||
    p === StagePhase.Cleared
  );
}

/** True while the player still has control — excludes the countdown and the run-out. */
export function stagePlaying(p: StagePhase): boolean {
  return p === StagePhase.Running || p === StagePhase.Boss;
}

// ── The profile panel's header row, hoisted ──────────────────────────────────
//
// These three sit on ONE baseline and are laid out left to right against each
// other: title, then the live objective, then the percentage hard right.
// That is the fix for the collisions. Previously the middle string was anchored
// to the moving player marker and clamped only to the PLOT, so any time the
// marker sat left of centre — which is the whole first half of every run, and
// therefore most of the capture set — it printed straight through the title.
// A label that moves cannot be laid out. This one does not move.
const PROFILE_TITLE = 'DESCENT';
/**
 * The one baseline the whole header row sits on.
 *
 * The title's caps are 11.5 tall, so at 26 they still sit 14.5 units clear of
 * the slab's top edge — more air than the accent stripe gets at the bottom —
 * and the header row reads as tight to the panel's top rather than floating
 * in it.
 */
const PROFILE_HEAD_BASE = 26;
const PROFILE_TITLE_ST: TextStyle = {
  size: 16, weight: 0.17, fill: P.gold, ink: P.ink, tracking: 0.22, skew: SHEAR,
};
const PROFILE_OBJ_ST: TextStyle = {
  size: 13, weight: 0.17, fill: P.paper, ink: P.ink, tracking: 0.13, skew: SHEAR,
};
const PROFILE_PCT_ST: TextStyle = {
  size: 16, weight: 0.18, fill: P.goldHot, ink: P.ink, tracking: 0.06, align: 'right', skew: SHEAR,
};
/**
 * The two label rows under the baseline rule.
 *
 * These used to share a 34-unit band: the checkpoint digits on baseline
 * rule+17 and SUMMIT/GOAL on rule+30. Thirteen units apart, for a 12-unit
 * digit over a 13-unit cap — which means the digit's stroke ENDED where the end
 * label's cap line BEGAN, and the two collided the moment they shared an x.
 * They always do at both ends.
 *
 * A stack of two type sizes needs (cap + stroke/2 + gap) between baselines, not
 * a number that looked about right. These are derived from the sizes below:
 * 19 units of baseline pitch for a 10 over an 11, which puts 7 clear units
 * between the digit's ink and the end label's caps.
 */
const PROFILE_CP_ST: TextStyle = {
  size: 10, weight: 0.20, fill: P.paperDim, ink: null, align: 'center', tracking: 0.02, skew: 0,
};
const PROFILE_END_ST: TextStyle = {
  size: 11, weight: 0.18, fill: P.paperDim, ink: null, tracking: 0.16, skew: 0,
};
const PROFILE_ACCENT_H = 5;
const PROFILE_CUT = 20;

/**
 * ── THE MARKER IS PART OF THE LAYOUT, NOT DECORATION ON TOP OF IT ────────────
 *
 * The two label rows were separated from each other and from the title, and the
 * plot was fitted to what was left. That solves the STATIC collisions. It does
 * not solve the moving ones, and a still cannot show them: the player marker
 * rides on the skyline, the skyline's height is the terrain's, and the marker
 * is fifteen units tall in a plot that is seventy-two units deep. Swept over
 * the whole route the old chevron's ink:
 *
 *     t = 0.938   overlapped the `7` checkpoint digit's cap box by 2.9 units
 *     t = 0.976   hung 8.9 units BELOW the baseline rule
 *     t = 0       hung off the plot's left edge onto the slab's chamfered
 *                 top-left corner, where it read as a black scribble
 *
 * So the marker is a first-class term in the layout. The SKYLINE gets its own
 * band — `skyTop`/`skyBot` — inset from the type above and below it by exactly
 * the marker's ink reach, and the plot's left inset is the slab's leaning wall
 * plus the marker's sideways reach. Changing the marker's size re-solves the
 * panel instead of silently re-breaking it.
 *
 * The marker is a SOLID triangle, not a stroked chevron. `chevron()` is an
 * outline shape, so its coloured core is the gap between two strokes; at the
 * size this panel can afford that gap is 4.2 units wide and the ink halo either
 * side of it is 2.6. A filled triangle has no such failure mode: it is gold all
 * the way through at any size, and pointing it along the local downhill keeps
 * the "travelling, not parked" read.
 *
 * `tri` puts its tip a full radius along `dir` and its base corners at
 * 1.048 R, so that factor — not R — is its true reach.
 */
const PROFILE_MARK_R = 11;
const PROFILE_MARK_REACH = 1.048;
const PROFILE_MARK_INK = 2.2;
/** Drawn this far above / right of the skyline point it marks. */
const PROFILE_MARK_LIFT = 2;
const PROFILE_MARK_DX = 2;
/** Clear air between a marker's ink and the type it is passing. */
const PROFILE_MARK_GAP = 3;

/**
 * The marker metrics, exported so a layout probe asserts against the numbers
 * the widget actually draws with instead of a copy of them that can rot.
 */
export const PROFILE_METRICS = {
  markR: PROFILE_MARK_R,
  markReach: PROFILE_MARK_REACH,
  markInk: PROFILE_MARK_INK,
  markLift: PROFILE_MARK_LIFT,
  markDx: PROFILE_MARK_DX,
  gap: PROFILE_MARK_GAP,
  headBase: PROFILE_HEAD_BASE,
  titleSize: PROFILE_TITLE_ST.size,
  titleWeight: PROFILE_TITLE_ST.weight ?? 0.17,
  cpSize: PROFILE_CP_ST.size,
  shear: SHEAR,
} as const;

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

/** M:SS.hh. Hundredths, not thousandths — the last digit of a millisecond
 *  field is unreadable in motion and it doubles the clock's redraw rate. */
export function clockString(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00.00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${m}:${pad2(sec)}.${pad2(cs)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base
// ─────────────────────────────────────────────────────────────────────────────

export abstract class Widget {
  readonly layer: HudLayer;
  /** 0 = fully out, 1 = fully in. Drives alpha and the entrance slide. */
  protected vis = 0;
  protected want = 0;
  /** Direction the panel flies in from, design units. */
  protected enterX = 0;
  protected enterY = 0;
  private sigStr = '\0';

  constructor(layer: HudLayer) {
    this.layer = layer;
    this.layer.alpha = 0;
  }

  /** Static geometry. Called once per resize. */
  abstract furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  /** Per-frame state update. Must call `sig()` with everything it will draw. */
  abstract update(m: HudModel, dt: number, time: number): void;
  /** Dynamic content, over the pre-blitted furniture. */
  abstract draw(ctx: CanvasRenderingContext2D, w: number, h: number): void;

  protected sig(s: string): void {
    if (s !== this.sigStr) {
      this.sigStr = s;
      this.layer.dirty = true;
    }
  }

  /** Force the next frame to redraw regardless of signature. */
  protected invalidate(): void {
    this.sigStr = '\0';
    this.layer.dirty = true;
  }

  /**
   * Advance the presence animation. The alpha ramps faster than the slide so a
   * panel is fully opaque before it finishes settling — a panel that fades in
   * over its whole travel reads as a dissolve, which is the one transition that
   * has no place in a cel HUD.
   */
  protected present(on: boolean, dt: number, halfLife = 0.07): void {
    this.want = on ? 1 : 0;
    this.vis = dampHL(this.vis, this.want, halfLife, dt);
    if (Math.abs(this.vis - this.want) < 0.002) this.vis = this.want;
    const t = ease.outQuart(clamp01(this.vis));
    this.layer.alpha = clamp01(this.vis * 1.35);
    this.layer.slideX = this.enterX * (1 - t);
    this.layer.slideY = this.enterY * (1 - t);
  }

  /**
   * Presence for elements that must never be readable at a partial alpha.
   *
   * `present()` is a symmetric damp, and for a panel that is fine: it fades out
   * over ~0.2 s showing its own last frame, which is what a panel leaving should
   * look like. It is exactly wrong for anything whose canvas holds STALE
   * content while it leaves, because the viewer does not see a fade — they see
   * the old reading at 13% alpha and read it as a draw that failed. That was
   * the old corner call's whole defect, and the traversal prompt below inherits
   * both the defect's shape (a source that flickers across a threshold) and the
   * fix.
   *
   * This ramps in fast and then CUTS: once the fade-out passes below `floor`
   * the alpha goes straight to zero. Nothing is ever on screen between 0 and
   * `floor`, so a half-drawn element is not a state this HUD can be in.
   */
  protected presentCut(on: boolean, dt: number, halfLife = 0.035, floor = 0.6): void {
    this.want = on ? 1 : 0;
    this.vis = dampHL(this.vis, this.want, halfLife, dt);
    if (on) {
      if (this.vis > 0.94) this.vis = 1;
    } else if (this.vis < floor) {
      this.vis = 0;
    }
    const t = ease.outQuart(clamp01(this.vis));
    this.layer.alpha = this.vis <= 0 ? 0 : clamp01(this.vis * 1.6);
    this.layer.slideX = this.enterX * (1 - t);
    this.layer.slideY = this.enterY * (1 - t);
  }

  get shown(): boolean {
    return this.vis > 0.002;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route profile — the signature element
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole descent, as an elevation cross-section.
 *
 * This is the one HUD element that tells you something the 3D cannot: where you
 * are in a four-minute stage, how much vertical is left, and whether the next
 * section is the steep bit. Drawn as a filled silhouette with a hard ink skyline
 * so it reads as the mountain itself rather than as a chart — the ridden portion
 * is flooded gold behind the player marker, which turns "progress" into a
 * physical thing filling up rather than a percentage.
 *
 * The rival rail is gone with the race. Its band is given back to the mountain's
 * relief, which is what the panel wanted in the first place.
 */
export class RouteProfileWidget extends Widget {
  private profilePath: Path2D | null = null;
  private skylinePath: Path2D | null = null;
  private samples: Float32Array | null = null;
  private plotX = 0;
  private plotY = 0;
  private plotW = 0;
  private plotH = 0;
  private curveY: number[] = [];

  /** Slab width at its BOTTOM edge. The shear pushes the top edge right by
   *  SHEAR*h, so this is `layer width − margin − SHEAR*h`; sizing the slab to
   *  the layer instead (as it was) throws the sheared top-right corner outside
   *  the backing store and the panel is delivered with its corner cut off. */
  private bodyW = 0;
  /** Baseline rule y, and the two label rows below it. */
  private ruleY = 0;
  private cpBaseY = 0;
  private endBaseY = 0;
  /** The band the SKYLINE may occupy. Insets the plot by the marker's reach. */
  private skyTop = 0;
  private skyBot = 0;

  private progress = 0;
  private markerT = 0;
  private objective = '';
  /** Header baseline x for the objective, measured off the title. */
  private objX = 250;

  /**
   * Checkpoint slots. POOLED — `update()` runs every frame whether or not
   * anything is redrawn, and building this list per frame would allocate for a
   * list whose length never changes inside a run. `cpCount` is how many are
   * live, and a slot only exists because `HudModel.splits` reported it.
   */
  private cpT: number[] = [];
  private cpLabel: number[] = [];
  private cpDone: boolean[] = [];
  private cpCount = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterX = -140;
  }

  /**
   * Rebuild the silhouette. Costs a couple of hundred path segments and runs on
   * resize or when the game hands over a different profile array — never per
   * frame.
   */
  private buildPaths(w: number, h: number): void {
    const s = this.samples;

    // ── PANEL METRICS ────────────────────────────────────────────────────────
    // Every y below is derived, not chosen, so the two label rows cannot drift
    // back into each other if the panel is ever resized again.
    this.bodyW = w - 12 - SHEAR * h;      // slab bottom-edge width; top fits too
    const endInk = PROFILE_END_ST.size * (PROFILE_END_ST.weight ?? 0.18) * 0.5;
    const cpInk = PROFILE_CP_ST.size * (PROFILE_CP_ST.weight ?? 0.2) * 0.5;
    // Work up from the bottom: accent stripe, then the end-label row, then the
    // checkpoint digits, and give the plot whatever is left.
    this.endBaseY = h - PROFILE_ACCENT_H - 7 - endInk;
    this.cpBaseY = this.endBaseY - PROFILE_END_ST.size - 7 - cpInk;
    this.ruleY = this.cpBaseY - PROFILE_CP_ST.size - 6;

    // ── THE SKYLINE'S BAND ───────────────────────────────────────────────────
    // Top down: the header row's ink, then the band the ridge may occupy, then
    // the checkpoint digits. Every boundary is one term clear of the next, and
    // every term is the ink extent of the thing it belongs to.
    const markSide = PROFILE_MARK_R * PROFILE_MARK_REACH + PROFILE_MARK_INK * 0.5;
    const markUp = markSide + PROFILE_MARK_LIFT;
    const markDown = markSide - PROFILE_MARK_LIFT;

    // The header row is three styles on one baseline, so its ink bottom is the
    // HEAVIEST of them — the percentage, hard right, is a hair fatter than the
    // title.
    const headWeight = Math.max(PROFILE_TITLE_ST.weight ?? 0.17, PROFILE_PCT_ST.weight ?? 0.18);
    const titleInk = PROFILE_HEAD_BASE
      + Math.max(PROFILE_TITLE_ST.size, PROFILE_PCT_ST.size) * (headWeight * 0.5 + 0.052);
    const digitCapTop = this.cpBaseY - PROFILE_CP_ST.size - cpInk;

    this.skyTop = titleInk + PROFILE_MARK_GAP + markUp;
    // The rule is furniture too: a marker that hangs across it reads as a
    // chart that has broken its own axis, so the band clears that as well as
    // the digits, and with the rows as they are it is the rule that binds.
    this.skyBot = Math.min(
      digitCapTop - PROFILE_MARK_GAP - markDown,
      this.ruleY - 1 - markDown,
    );

    // The slab leans: its left wall at height y is SHEAR*h*(1 − y/h) in from
    // the layer edge, widest at the top. The plot starts clear of that wall
    // PLUS the widest sideways reach of anything drawn in it, so the marker at
    // t = 0 is a whole shape inside the panel instead of half a one on the
    // chamfer. The wall is measured at the top of the skyline band, the
    // topmost thing in the plot and therefore where it leans furthest in.
    const wallL = SHEAR * h * (1 - (this.skyTop - markUp) / h);
    const reachLeft = markSide - PROFILE_MARK_DX;
    this.plotX = Math.ceil(wallL + 4 + reachLeft);
    this.plotY = this.skyTop - 6;
    // The right inset clears the slab's bottom-right chamfer: GOAL is
    // right-aligned to the plot, and at the end-label baseline the chamfer has
    // already eaten 8 units off the slab edge.
    this.plotW = this.bodyW - this.plotX - 14;
    this.plotH = this.ruleY - this.plotY;
    this.curveY.length = 0;
    this.profilePath = null;
    this.skylinePath = null;
    if (!s || s.length < 2) return;

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < s.length; i++) {
      if (s[i] < lo) lo = s[i];
      if (s[i] > hi) hi = s[i];
    }
    const span = Math.max(hi - lo, 1e-3);

    const fill = new Path2D();
    const line = new Path2D();
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const x = this.plotX + (i / (n - 1)) * this.plotW;
      // Into the reserved band, not into the plot box: the box is where the
      // mountain BODY is drawn, the band is where its ridge is allowed to go.
      const y = this.skyBot - ((s[i] - lo) / span) * (this.skyBot - this.skyTop);
      this.curveY.push(y);
      if (i === 0) {
        fill.moveTo(x, y);
        line.moveTo(x, y);
      } else {
        fill.lineTo(x, y);
        line.lineTo(x, y);
      }
    }
    fill.lineTo(this.plotX + this.plotW, this.plotY + this.plotH);
    fill.lineTo(this.plotX, this.plotY + this.plotH);
    fill.closePath();
    this.profilePath = fill;
    this.skylinePath = line;
  }

  private yAt(t: number): number {
    if (this.curveY.length === 0) return (this.skyTop + this.skyBot) * 0.5;
    const f = clamp01(t) * (this.curveY.length - 1);
    const i = Math.floor(f);
    const j = Math.min(this.curveY.length - 1, i + 1);
    return this.curveY[i] + (this.curveY[j] - this.curveY[i]) * (f - i);
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.buildPaths(w, h);

    slab(ctx, 0, 0, this.bodyW, h, {
      fill: P.panel,
      ink: P.ink,
      inkWidth: INK_W,
      cuts: 0b0101,
      cut: PROFILE_CUT,
      accent: P.gold,
      accentHeight: PROFILE_ACCENT_H,
    });

    // The header row starts on the plot's left edge and the percentage ends on
    // its right, so the type and the chart share one measure instead of being
    // two independently-inset things that happen to be in the same panel.
    drawText(ctx, PROFILE_TITLE, this.plotX, PROFILE_HEAD_BASE, PROFILE_TITLE_ST);
    // Where the live objective starts. Measured off the title so the two can
    // never touch, whatever the title says.
    this.objX = this.plotX + measureText(PROFILE_TITLE, PROFILE_TITLE_ST) + 16;

    if (!this.profilePath || !this.skylinePath) return;

    const plotR = this.plotX + this.plotW;

    // The mountain body, flat and unlit — this is a silhouette, not a chart fill.
    ctx.fillStyle = cssA(HUD_PALETTE.violet, 0.30);
    ctx.fill(this.profilePath);

    // Skyline: a fat ink stroke with a thin paper highlight riding on top of it.
    // Two strokes, not one — the highlight is what stops the profile reading as
    // a black smear when it sits over a dark tree line.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 5.0;
    ctx.stroke(this.skylinePath);
    ctx.strokeStyle = P.paperDim;
    ctx.lineWidth = 2.0;
    ctx.stroke(this.skylinePath);
    ctx.lineJoin = 'miter';

    // Baseline rule.
    tick(ctx, this.plotX, this.ruleY, plotR, this.ruleY, 2.2, P.ink);

    // The two end labels, on their own baseline. The checkpoint hairlines and
    // digits are DYNAMIC now — a checkpoint that has been taken lights up — so
    // they are drawn in `draw()`, not baked here.
    drawText(ctx, 'SUMMIT', this.plotX, this.endBaseY, PROFILE_END_ST);
    drawText(ctx, 'GOAL', plotR, this.endBaseY, { ...PROFILE_END_ST, align: 'right' });
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.present(stageLive(m.phase), dt, 0.09);

    if (m.routeProfile && m.routeProfile !== this.samples) {
      this.samples = m.routeProfile;
      this.layer.markFurniture();
      this.invalidate();
    }

    const target = clamp01(m.routeProgress);
    // Snap on a teleport, ease within a run. The easing is there because
    // progress arrives quantised by the physics step and a marker that steps
    // reads as a dropped frame — but easing a JUMP is a different thing
    // entirely: after a restart or a capture-harness reposition the marker
    // spends a fifth of a second somewhere the header's percentage says it is
    // not, and a still caught in that window shows the panel disagreeing with
    // itself. One frame at 74 m/s moves well under 0.01 of any real stage, so
    // that threshold cannot fire in play.
    if (Math.abs(target - this.progress) > 0.01) this.markerT = target;
    this.progress = target;
    this.markerT = dampHL(this.markerT, this.progress, 0.05, dt);

    this.objective = m.objective ? m.objective.toUpperCase() : '';

    // Refill the pooled checkpoint slots in place. The SET comes from the
    // model's splits and nowhere else; `CHECKPOINT_TS` only supplies the
    // position for an index the model already claims exists.
    this.cpCount = 0;
    for (let i = 0; i < m.splits.length; i++) {
      const sp = m.splits[i];
      if (sp.index <= 0 || sp.index >= CHECKPOINT_TS.length - 1) continue;
      const k = this.cpCount++;
      this.cpT[k] = CHECKPOINT_TS[sp.index];
      this.cpLabel[k] = sp.index;
      this.cpDone[k] = sp.time !== null;
    }

    // Quantise the marker to a tenth of a design pixel: below that nothing on
    // screen changes and a redraw would be pure cost.
    const q = Math.round(this.markerT * this.plotW * 2);
    let s = `${q}|${this.objective}|${this.cpCount}`;
    for (let i = 0; i < this.cpCount; i++) s += this.cpDone[i] ? '1' : '0';
    this.sig(s);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.profilePath) return;
    const px = this.plotX + this.markerT * this.plotW;
    const py = this.yAt(this.markerT);

    // Checkpoint hairlines and their digits. Under the flood so the flood
    // washes the ones already taken, over the silhouette so they read.
    for (let i = 0; i < this.cpCount; i++) {
      const t = this.cpT[i];
      const x = this.plotX + t * this.plotW;
      const done = this.cpDone[i];
      tick(ctx, x, this.yAt(t), x, this.ruleY, done ? 2.0 : 1.6,
        done ? cssA(HUD_PALETTE.goldHot, 0.7) : cssA(HUD_PALETTE.paperDim, 0.45));
      tick(ctx, x, this.ruleY, x, this.ruleY + 5, 1.6, cssA(HUD_PALETTE.paperDim, 0.55));
      drawText(ctx, String(this.cpLabel[i]), x, this.cpBaseY, done
        ? { ...PROFILE_CP_ST, fill: P.goldHot }
        : PROFILE_CP_ST);
    }

    // Ridden ground, flooded gold behind the marker.
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotX - 4, this.plotY - 10, px - this.plotX + 4, this.plotH + 20);
    ctx.clip();
    ctx.fillStyle = cssA(HUD_PALETTE.gold, 0.42);
    ctx.fill(this.profilePath);
    ctx.strokeStyle = P.goldHot;
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    if (this.skylinePath) ctx.stroke(this.skylinePath);
    ctx.lineJoin = 'miter';
    ctx.restore();

    // The player: a drop line to the baseline, then the marker on the skyline.
    tick(ctx, px, py, px, this.ruleY, 2.4, cssA(HUD_PALETTE.goldHot, 0.75));
    // Point it along the local downhill so it reads as travelling, not parked.
    const y2 = this.yAt(Math.min(1, this.markerT + 0.02));
    const dir = Math.atan2(y2 - py, this.plotW * 0.02);
    tri(
      ctx, px + PROFILE_MARK_DX, py - PROFILE_MARK_LIFT,
      PROFILE_MARK_R, dir, P.goldHot, P.ink, PROFILE_MARK_INK,
    );

    // Header row: objective after the title, percentage hard right. Both on
    // the title's baseline, both at fixed anchors. See PROFILE_TITLE_ST.
    const pct = `${Math.round(this.progress * 100)}%`;
    const pctR = this.plotX + this.plotW;
    drawText(ctx, pct, pctR, PROFILE_HEAD_BASE, PROFILE_PCT_ST);
    // The objective is clipped to the space between the title and the
    // percentage rather than allowed to run under either. The clip is here so a
    // long objective degrades by being cut off instead of by overprinting.
    const pctW = measureText(pct, PROFILE_PCT_ST);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.objX - 4, PROFILE_HEAD_BASE - 20, (pctR - pctW - 18) - this.objX + 4, 26);
    ctx.clip();
    drawText(ctx, this.objective, this.objX, PROFILE_HEAD_BASE, PROFILE_OBJ_ST);
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage clock + splits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The clock counts DOWN, and that is the whole difference between a race HUD
 * and a stage HUD.
 *
 * In the race the clock was a scoreboard: interesting afterwards, ignorable
 * during. Here it is the failure condition, so it is the loudest single element
 * on screen and it is allowed to be — the brief permits exactly three loud
 * things at 74 m/s and this is the first of them.
 *
 * Elapsed time is kept, small, under the countdown. It is what the results
 * screen is scored on and what a player chasing a personal best is actually
 * watching, and it costs one extra redraw of a 470-unit-wide layer to show.
 */
export class ClockWidget extends Widget {
  private left = 0;
  private elapsed = 0;
  private critical = false;
  private phase = 0;
  /** The most recent split, held on screen then cut. */
  private splitIdx = -1;
  private splitDelta: number | null = null;
  private splitTime = 0;
  private splitAge = 99;
  private seen = new Set<number>();

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = -90;
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    slab(ctx, 0, 0, w - 20, 96, {
      fill: P.panelDeep,
      ink: P.ink,
      inkWidth: INK_W,
      cuts: 0b0110,
      cut: 18,
      accent: P.gold,
      accentHeight: 4,
    });
    drawText(ctx, 'TIME', 30, 30, {
      size: 15, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.26, skew: SHEAR,
    });
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.present(stageLive(m.phase), dt, 0.08);

    this.left = Math.max(0, m.timeLeft);
    this.elapsed = Math.max(0, m.time);
    this.critical = m.timeCritical && stagePlaying(m.phase);
    this.phase = time;

    // Latch the newest checkpoint split we have not shown yet.
    for (const sp of m.splits) {
      if (sp.time !== null && !this.seen.has(sp.index)) {
        this.seen.add(sp.index);
        this.splitIdx = sp.index;
        this.splitDelta = sp.delta;
        this.splitTime = sp.time;
        this.splitAge = 0;
      }
    }
    this.splitAge += dt;

    // The alarm blinks at 5 Hz; that rate is in the signature so the layer
    // redraws on the blink and on nothing else.
    const alarm = this.critical ? Math.floor(time * 5) & 1 : 0;
    const sp = this.splitAge < 3.0 ? `${this.splitIdx}:${Math.round(this.splitAge * 30)}` : 'n';
    this.sig(`${clockString(this.left)}|${Math.round(this.elapsed * 10)}|${alarm}|${sp}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // ── THE ALARM ────────────────────────────────────────────────────────────
    // It is not a colour change. A colour change on a dark panel is a 20% shift
    // in one hue and it is invisible in peripheral vision, which is where the
    // clock lives when it matters. The whole plate strobes to red and back, so
    // the thing that changes is VALUE across a 470 x 96 area.
    const blink = this.critical ? (Math.floor(this.phase * 5) & 1) === 0 : false;
    if (this.critical) {
      slabPath(ctx, 0, 0, w - 20, 96, 0b0110, 18, SHEAR);
      ctx.fillStyle = blink ? cssA(HUD_PALETTE.red, 0.92) : cssA(HUD_PALETTE.ink, 0.92);
      ctx.fill();
      ctx.strokeStyle = blink ? P.goldHot : P.red;
      ctx.lineWidth = 3.4;
      ctx.stroke();
      drawText(ctx, 'TIME', 30, 30, {
        size: 15, weight: 0.18, fill: blink ? P.paper : P.red, ink: P.ink, tracking: 0.26, skew: SHEAR,
      });
    }

    drawText(ctx, clockString(this.left), w - 34, 78, {
      size: 46,
      weight: 0.155,
      fill: this.critical ? (blink ? P.paper : P.red) : P.paper,
      ink: P.ink,
      tracking: 0.04,
      align: 'right',
      tabular: true,
      skew: SHEAR * 0.7,
    });

    // Elapsed, permanently under the countdown. Small, dim, and never allowed
    // to be mistaken for the number that matters.
    const el = clockString(this.elapsed);
    const st: TextStyle = {
      size: 22, weight: 0.16, fill: P.paperDim, ink: P.ink, tracking: 0.05,
      align: 'right', tabular: true, skew: 0,
    };
    const tw = measureText(el, st) + 84;
    const ex = w - 20 - tw;
    bar(ctx, ex, 104, tw, 34, P.panelDeep, cssA(HUD_PALETTE.paperDim, 0.5), 2.0);
    drawText(ctx, 'RUN', ex + 18, 130, {
      size: 14, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.2, skew: SHEAR,
    });
    drawText(ctx, el, w - 34, 130, st);

    // Split flash: snaps in, holds, cuts out at 2.6s. No fade — a split that
    // dissolves is a split you did not read in time.
    if (this.splitAge < 2.6 && this.splitIdx >= 0) {
      const k = ease.snap(clamp01(this.splitAge / 0.22));
      const d = this.splitDelta;
      const col = d === null ? P.paper : d < 0 ? P.teal : P.red;
      const label = `CP ${this.splitIdx}`;
      const val = d === null ? clockString(this.splitTime) : formatGap(d);
      const bw = 210 * k;
      const y = 152;
      ctx.save();
      ctx.globalAlpha = clamp01(k);
      bar(ctx, 8, y, bw, 38, P.panelDeep, col, 2.4);
      if (k > 0.55) {
        drawText(ctx, label, 26, y + 27, { size: 17, weight: 0.17, fill: P.paperDim, ink: P.ink, tracking: 0.1, skew: 0 });
        drawText(ctx, val, 8 + bw - 14, y + 27, {
          size: 21, weight: 0.16, fill: col, ink: P.ink, tracking: 0.04, align: 'right', tabular: true, skew: 0,
        });
      }
      ctx.restore();
    }
  }

  reset(): void {
    this.seen.clear();
    this.splitIdx = -1;
    this.splitAge = 99;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Speed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Speed sits in the bottom-right corner because that is where the eye is not,
 * and it is read by the needle rather than by the number — the digits are for
 * the two frames a stage where you actually look at them. It is the second of
 * the three things allowed to be loud.
 *
 * ── THE NUMBER IS `speedDisplay`, VERBATIM ───────────────────────────────────
 * `HudModel.speedDisplay` is already in Spark display units. It is printed as
 * it arrives. There is no km/h anywhere in this widget, no unit suffix beside
 * the figure (Spark 3 shows a bare number and so does this), and — importantly
 * — no top-speed constant. The dial is driven by `speedFraction`, which is the
 * model's own 0..1 of the run's top speed, so this file never needs to know
 * what 185 is or where 2.5 came from. That knowledge stays in
 * `src/player/SparkConstants.ts`, which is the whole point.
 *
 * The arc hugs the corner: 90° from due-left to straight-up, centred on the
 * corner itself, so it wraps the number instead of floating beside it.
 */

// ── SPEED BLOCK METRICS ──────────────────────────────────────────────────────
//
// Every number in this widget used to be a literal tuned against one screenshot
// at one speed, and three separate things fell off the edge of the layer as a
// result: the dial band's polygon ran 76 units past the right edge of its
// backing store, the readout numeral's sheared top-right corner reached the
// layer edge at two digits, and the unit row overlapped the numeral's
// descender by four units at every speed.
//
// So the geometry is solved instead of guessed. The dial radius is the largest
// that keeps the WHOLE band polygon inside the layer with a margin
// (`fitRadius`), the gauge marks moved OUTSIDE the tick ring where there is
// unlimited room instead of inside it where they were fighting the readout, and
// the readout plate and its two type rows are stacked from measured ink
// extents.
const SPEED_A0 = Math.PI * 0.975; // band start, a hair below due-left
const SPEED_A1 = Math.PI * 1.525; // band end, a hair past straight-up
/** Margin between the band polygon and the layer edge, design units. */
const SPEED_MARGIN = 6;
/** Big readout. 86 rather than 96: three digits at 96 do not fit the plate. */
const SPEED_NUM: TextStyle = {
  size: 86, weight: 0.16, ink: P.ink, inkWidth: 0.055,
  tracking: 0.02, align: 'right', tabular: true, skew: SHEAR,
};
/** The row under the numeral. It carries the MOVE MODE, not a unit. */
const SPEED_MODE: TextStyle = {
  size: 17, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.22, align: 'right', skew: SHEAR,
};
const SPEED_GAUGE: TextStyle = {
  size: 14, weight: 0.18, fill: P.paperDim, ink: P.ink, align: 'center', tracking: 0.12, skew: 0,
};
const SPEED_TICKS = 40;
/** Above this fraction of top speed the dial reads red — the "committed" band. */
const SPEED_HOT = 0.8;

/**
 * The mode tag. Named states only: `Grounded` and `Airborne` are what the
 * picture already says, so printing them is noise, and a tag that is on in
 * every frame stops being a tag.
 */
function modeTag(mode: MoveMode): string {
  switch (mode) {
    case MoveMode.WallRun: return 'WALL';
    case MoveMode.Grinding: return 'GRIND';
    case MoveMode.Sliding: return 'SLIDE';
    case MoveMode.Dashing: return 'DASH';
    case MoveMode.Homing: return 'HOMING';
    case MoveMode.Diving: return 'DIVE';
    case MoveMode.Hurt: return 'HURT';
    default: return '';
  }
}

function modeColor(mode: MoveMode): string {
  switch (mode) {
    case MoveMode.WallRun: return P.violet;
    case MoveMode.Grinding: return P.teal;
    case MoveMode.Dashing:
    case MoveMode.Homing: return P.boostFull;
    case MoveMode.Hurt: return P.red;
    default: return P.gold;
  }
}

export class SpeedWidget extends Widget {
  private needle: SpringState = makeSpring(0, 0);
  /** 0..1 of top speed. The dial's only input. */
  private frac = 0;
  /** Spark display units, straight off the model. */
  private display = 0;
  private boosting = false;
  private mode: MoveMode = MoveMode.Grounded;
  private cx = 0;
  private cy = 0;
  /** Outer radius of the tick ring. Everything else is measured off it. */
  private rTick = 0;
  /** Band annulus. */
  private rBand0 = 0;
  private rBand1 = 0;
  /** Radius the gauge marks are centred on — OUTSIDE the ticks. */
  private rLabel = 0;
  /** Readout plate box, and the two baselines inside it. */
  private plate = { x: 0, y: 0, w: 0, h: 0 };
  private numRight = 0;
  private numBase = 0;
  private modeRight = 0;
  private modeBase = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterX = 150;
  }

  /**
   * Largest band radius that keeps the whole sweep inside (0,0,w,h) with
   * `SPEED_MARGIN` to spare. The band's bounding box is centre + R·[cos,sin]
   * extremes over the sweep, so each of the four edges gives a linear bound on
   * R and the answer is the smallest of them.
   */
  private fitRadius(w: number, h: number): number {
    // The sweep contains π (cos = -1) and 1.5π (sin = -1); the other two
    // extremes are at the ends.
    const cMin = -1;
    const cMax = Math.max(Math.cos(SPEED_A0), Math.cos(SPEED_A1));
    const sMin = -1;
    const sMax = Math.max(Math.sin(SPEED_A0), Math.sin(SPEED_A1));
    const m = SPEED_MARGIN;
    let r = Infinity;
    if (cMin < 0) r = Math.min(r, (this.cx - m) / -cMin);
    if (cMax > 0) r = Math.min(r, (w - m - this.cx) / cMax);
    if (sMin < 0) r = Math.min(r, (this.cy - m) / -sMin);
    if (sMax > 0) r = Math.min(r, (h - m - this.cy) / sMax);
    return r;
  }

  private geom(w: number, h: number): void {
    this.cx = w - 34;
    this.cy = h - 34;
    this.rBand1 = this.fitRadius(w, h);
    this.rTick = this.rBand1 - 48;
    this.rBand0 = this.rTick - 62;
    this.rLabel = this.rTick + 18;

    // Readout plate. Its top-left corner is chamfered so the low end of the
    // tick ring passes OUTSIDE it — see the cut in `furniture()`.
    const pb = h - 8;
    const pt = 194;
    this.plate = { x: 300, y: pt, w: (w - 44) - 300, h: pb - pt };

    // Type stack, worked up from the plate's bottom edge.
    const numInk = SPEED_NUM.size * (SPEED_NUM.inkWidth ?? 0.055);
    const modeInk = SPEED_MODE.size * 0.052 + SPEED_MODE.size * (SPEED_MODE.weight ?? 0.18) * 0.5;
    this.modeBase = pb - 16;
    this.modeRight = w - 60;
    this.numBase = this.modeBase - SPEED_MODE.size - modeInk - 8
      - (SPEED_NUM.size * (SPEED_NUM.weight ?? 0.16) * 0.5 + numInk);
    this.numRight = w - 56;
  }

  /** `f` is 0..1 of top speed. 180° (due left) → 270° (straight up). */
  private angleFor(f: number): number {
    return Math.PI + clamp01(f) * Math.PI * 0.5;
  }

  /**
   * The faceted annular face the ticks sit on. Runs a little wide of the tick
   * band at both ends so the marks and the needle's tip are on it too — a
   * gauge whose extreme reading falls off the edge of its own dial is worse
   * than no dial at all.
   */
  private dialBand(ctx: CanvasRenderingContext2D): void {
    const seg = 12;
    ctx.beginPath();
    for (let i = 0; i <= seg; i++) {
      const a = SPEED_A0 + ((SPEED_A1 - SPEED_A0) * i) / seg;
      const x = this.cx + Math.cos(a) * this.rBand1;
      const y = this.cy + Math.sin(a) * this.rBand1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = seg; i >= 0; i--) {
      const a = SPEED_A0 + ((SPEED_A1 - SPEED_A0) * i) / seg;
      ctx.lineTo(this.cx + Math.cos(a) * this.rBand0, this.cy + Math.sin(a) * this.rBand0);
    }
    ctx.closePath();
    ctx.fillStyle = P.panel;
    ctx.fill();
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = INK_W;
    ctx.stroke();
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.geom(w, h);

    // ── THE DIAL BODY ────────────────────────────────────────────────────────
    // The arc used to be ticks and numbers floating on the raw frame with no
    // panel anywhere near them, and that is the whole of the old defect: an
    // entire subject rendered inside the dial, because there was nothing there
    // for it to be behind. A gauge is a physical object with a face. This is
    // the face.
    //
    // Drawn as a faceted band rather than a true arc — twelve straight segments
    // over the sweep — because everything else in this HUD is cut from straight
    // lines, right down to the O of the typeface being an octagon. A perfectly
    // smooth annulus in the middle of it reads as a different program.
    this.dialBand(ctx);

    // The readout plate. The top-left chamfer is not decoration: without it the
    // inner ends of the ticks at the low end of the sweep run into the plate's
    // corner. The cut takes exactly that corner away, so the tick ring is
    // unbroken.
    const p = this.plate;
    slab(ctx, p.x, p.y, p.w, p.h, {
      fill: P.panelDeep, ink: P.ink, inkWidth: INK_W, cuts: 0b0101, cut: 24,
      accent: P.gold, accentHeight: 4,
    });

    // Unlit ticks, every fifth long. There are NO numerals on this dial: the
    // only absolute speed figure in the HUD is the readout, and it comes from
    // the model. A scale printed here would be a second source for the same
    // fact and it would have to be derived from a top speed this file is not
    // allowed to know.
    for (let i = 0; i <= SPEED_TICKS; i++) {
      const f = i / SPEED_TICKS;
      const a = this.angleFor(f);
      const major = i % 5 === 0;
      const len = major ? 26 : 13;
      const c = Math.cos(a);
      const s = Math.sin(a);
      tick(
        ctx,
        this.cx + c * (this.rTick - len), this.cy + s * (this.rTick - len),
        this.cx + c * this.rTick, this.cy + s * this.rTick,
        major ? 4.5 : 2.2,
        major ? P.paperDim : cssA(HUD_PALETTE.paperDim, 0.5),
      );
    }

    // Two words on the outside of the ring instead: where the scale starts and
    // where it tops out. That is all the calibration a needle needs.
    for (const [f, txt] of [[0, 'IDLE'], [1, 'MAX']] as [number, string][]) {
      const a = this.angleFor(f);
      drawText(
        ctx, txt,
        this.cx + Math.cos(a) * this.rLabel,
        this.cy + Math.sin(a) * this.rLabel + SPEED_GAUGE.size * 0.4,
        f >= 1 ? { ...SPEED_GAUGE, fill: P.red } : SPEED_GAUGE,
      );
    }
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.present(stageLive(m.phase), dt, 0.08);

    this.frac = clamp01(m.speedFraction);
    this.display = Math.max(0, m.speedDisplay);
    this.boosting = m.boosting;
    this.mode = m.mode;
    // The digits are instantaneous; only the needle has mass, and only just
    // enough (omega 36 settles in ~90ms) so it does not lag a hard brake.
    springStep(this.needle, this.frac, 36, dt);

    this.sig(
      `${Math.round(this.display)}|${Math.round(this.needle.value * 120)}|` +
      `${this.boosting ? 1 : 0}|${this.mode}`,
    );
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const v = clamp(this.needle.value, 0, 1);
    const lit = Math.floor(v * SPEED_TICKS);
    const hot = this.boosting;

    // Lit ticks, over the unlit furniture ones.
    for (let i = 0; i <= lit; i++) {
      const f = i / SPEED_TICKS;
      const a = this.angleFor(f);
      const major = i % 5 === 0;
      const len = major ? 26 : 13;
      const c0 = Math.cos(a);
      const s0 = Math.sin(a);
      // The top fifth of the range shifts red — the "you are committed now"
      // read, which the needle alone does not give you.
      const col = hot ? P.boostFull : f > SPEED_HOT ? P.red : f > 0.6 ? P.goldHot : P.gold;
      tick(
        ctx,
        this.cx + c0 * (this.rTick - len), this.cy + s0 * (this.rTick - len),
        this.cx + c0 * this.rTick, this.cy + s0 * this.rTick,
        major ? 5.2 : 2.8,
        col,
      );
    }

    // Needle: a tapered blade, not a line.
    const a = this.angleFor(v);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const nx = -s;
    const ny = c;
    const r0 = this.rTick - 56;
    const r1 = this.rTick + 6;
    ctx.beginPath();
    ctx.moveTo(this.cx + c * r1, this.cy + s * r1);
    ctx.lineTo(this.cx + c * r0 + nx * 7, this.cy + s * r0 + ny * 7);
    ctx.lineTo(this.cx + c * (r0 - 16), this.cy + s * (r0 - 16));
    ctx.lineTo(this.cx + c * r0 - nx * 7, this.cy + s * r0 - ny * 7);
    ctx.closePath();
    ctx.fillStyle = hot ? P.boostFull : P.goldHot;
    ctx.fill();
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // The number, exactly as the model gave it. Tabular so it cannot shuffle
    // sideways between 99 and 100, and right-aligned so the units column is
    // nailed down — the whole point of the tabular advance is that a
    // three-digit reading grows LEFT into the plate, never right into its edge.
    drawText(ctx, String(Math.round(this.display)), this.numRight, this.numBase, {
      ...SPEED_NUM,
      fill: hot ? P.boostFull : P.paper,
    });

    const tag = modeTag(this.mode);
    if (tag) {
      drawText(ctx, tag, this.modeRight, this.modeBase, { ...SPEED_MODE, fill: modeColor(this.mode) });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boost meter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Segmented, and only segmented. A continuous bar would tell you the boost is
 * at 63%, which is not a number you can act on; ten discrete chunks tell you
 * "one more grind and I get a shot", which is.
 */
const BOOST_SEGMENTS = 10;

export class BoostWidget extends Widget {
  private filled = 0;
  private full = false;
  private boosting = false;
  private flash = 0;
  private phase = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = 90;
  }

  private segRect(i: number, w: number, h: number): { x: number; y: number; sw: number; sh: number } {
    const padX = 30;
    const gap = 6;
    const avail = w - padX * 2 - 22;
    const sw = (avail - gap * (BOOST_SEGMENTS - 1)) / BOOST_SEGMENTS;
    return { x: padX + i * (sw + gap), y: 50, sw, sh: 42 };
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // The slab starts at y = 4 and the label sits INSIDE it. It used to start
    // at 24 with the label on baseline 18 — i.e. floating on the raw frame, six
    // units clear of any panel, which is why scenery drew straight over the
    // word BOOST. Every piece of type in this HUD has panel underneath it.
    slab(ctx, 0, 4, w - 22, 98, { fill: P.panel, ink: P.ink, inkWidth: 2.6, cuts: 0b0101, cut: 16 });
    drawText(ctx, 'BOOST', 34, 36, {
      size: 15, weight: 0.18, fill: P.boost, ink: P.ink, tracking: 0.3, skew: SHEAR,
    });
    for (let i = 0; i < BOOST_SEGMENTS; i++) {
      const r = this.segRect(i, w, h);
      bar(ctx, r.x, r.y, r.sw, r.sh, cssA(HUD_PALETTE.ink, 0.5), cssA(HUD_PALETTE.paperDim, 0.35), 1.8);
    }
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.present(stagePlaying(m.phase) || m.phase === StagePhase.Cleared, dt, 0.08);

    const next = Math.floor(clamp01(m.boost) * BOOST_SEGMENTS + 1e-4);
    if (next > this.filled) this.flash = 1;
    this.filled = next;
    this.full = m.boost >= 0.999;
    this.boosting = m.boosting;
    this.flash = dampHL(this.flash, 0, 0.09, dt);
    this.phase = time;

    const anim = this.full || this.boosting ? Math.round(time * 12) : 0;
    this.sig(`${this.filled}|${this.full ? 1 : 0}|${this.boosting ? 1 : 0}|${Math.round(this.flash * 30)}|${anim}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const strobe = this.boosting ? (Math.floor(this.phase * 22) & 1) === 0 : false;
    for (let i = 0; i < this.filled; i++) {
      const r = this.segRect(i, w, h);
      const t = i / (BOOST_SEGMENTS - 1);
      let col = cssMix(HUD_PALETTE.boost, HUD_PALETTE.boostFull, t);
      if (this.full) col = (Math.floor(this.phase * 8) + i) % 4 === 0 ? P.boostFull : P.boost;
      if (strobe) col = P.paper;
      bar(ctx, r.x, r.y, r.sw, r.sh, col, P.ink, 2.2);
    }

    // The chunk that just landed gets a one-frame-ish white overshoot so gaining
    // boost is felt rather than merely displayed.
    if (this.flash > 0.02 && this.filled > 0) {
      const r = this.segRect(this.filled - 1, w, h);
      ctx.save();
      ctx.globalAlpha = clamp01(this.flash);
      bar(ctx, r.x - 3, r.y - 3, r.sw + 6, r.sh + 6, null, P.boostFull, 3.4);
      ctx.restore();
    }

    if (this.full || this.boosting) {
      const on = (Math.floor(this.phase * 6) & 1) === 0;
      const label = this.boosting ? 'BOOSTING' : 'READY';
      drawText(ctx, label, w - 34, 36, {
        size: 16,
        weight: 0.19,
        fill: on ? P.boostFull : P.boost,
        ink: P.ink,
        tracking: 0.24,
        align: 'right',
        skew: SHEAR,
      });
      // Full-state frame around the whole meter — this is the "distinct full
      // state" the meter needs so you never have to count segments.
      ctx.save();
      slabPath(ctx, -4, 0, w - 14, 106, 0b0101, 16, SHEAR);
      ctx.strokeStyle = on ? P.boostFull : P.boost;
      ctx.lineWidth = 3.2;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Popups
// ─────────────────────────────────────────────────────────────────────────────

interface Popup {
  text: string;
  value: number;
  kind: HudPopup['kind'];
  age: number;
  life: number;
  active: boolean;
}

const POPUP_POOL = 6;

/**
 * The column is a stack of bars and nothing else now. The running trick score
 * and the live trick plate that used to sit under it went with the bike; the
 * style score lives in the combo block on the other side of the frame, where it
 * is next to the number it is derived from.
 *
 * The bottom bar's top edge, and the pitch between bars. The pitch is 58: six
 * bars land inside 1.9 s and slide in over 0.2 s each, so a five-deep pile is a
 * flickering wall rather than information, and the column is capped by
 * `setCeiling()` rather than by shrinking the pitch until they touch.
 */
const POPUP_BASE = 40;
const POPUP_PITCH = 58;
const POPUP_BAR_H = 50;

/** Exported so a layout probe asserts against the numbers the widget draws
 *  with rather than a copy of them that can rot. */
export const POPUP_METRICS = { base: POPUP_BASE, pitch: POPUP_PITCH, barH: POPUP_BAR_H, pool: POPUP_POOL } as const;

export class PopupWidget extends Widget {
  private pool: Popup[] = [];
  /** Draw order, reused every frame. See the note in `draw()`. */
  private order: Popup[] = [];
  private live = 0;
  /** How many bars fit under the ceiling. See `setCeiling()`. */
  private depth = POPUP_POOL;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterX = 150;
    for (let i = 0; i < POPUP_POOL; i++) {
      this.pool.push({ text: '', value: 0, kind: 'pickup', age: 0, life: 0, active: false });
    }
  }

  override furniture(): void {
    // Popups are transient; there is no furniture to hold. Leaving the layer
    // background empty means every popup redraw starts from a plain clear.
  }

  /**
   * ── HOW DEEP THE COLUMN IS ALLOWED TO BE ─────────────────────────────────
   *
   * `ceiling` is the highest y, in this layer's own units, that a popup bar's
   * top edge may reach. `Hud.ts` derives it from the panel above, so the two
   * are laid out against each other instead of both being laid out against the
   * frame and hoping. That arithmetic used to live in a comment; it was wrong,
   * and it stayed wrong through a change that made it less wrong.
   *
   * The depth is not a cap on what is DRAWN — a bar dropped from the draw would
   * still be counted live, still hold the layer up, and still be a popup the
   * player was told about and never shown. It is a cap on what is ALIVE:
   * pushing past it hard-cuts the oldest, which is within a couple of hundred
   * milliseconds of cutting itself. `POPUP_POOL` stays at 6 so a burst is never
   * dropped at the source; it is aged out at the top instead.
   */
  setCeiling(ceiling: number): void {
    const room = this.layer.h - POPUP_BASE - ceiling;
    this.depth = Math.max(1, Math.min(POPUP_POOL, Math.floor(room / POPUP_PITCH) + 1));
  }

  /** How many bars the column can show at once. */
  get columnDepth(): number {
    return this.depth;
  }

  /** Hard-cut the oldest until the column fits. */
  private trim(): void {
    for (;;) {
      let n = 0;
      let oldest: Popup | null = null;
      for (const p of this.pool) {
        if (!p.active) continue;
        n++;
        if (!oldest || p.age > oldest.age) oldest = p;
      }
      if (n <= this.depth || !oldest) return;
      oldest.active = false;
    }
  }

  private push(text: string, value: number, kind: Popup['kind']): void {
    // Reuse the oldest slot rather than allocating — this runs on a landing,
    // which is exactly when the frame is already busy.
    let slot = this.pool.find((p) => !p.active);
    if (!slot) {
      slot = this.pool[0];
      for (const p of this.pool) if (p.age > slot.age) slot = p;
    }
    slot.text = text.toUpperCase();
    slot.value = value;
    slot.kind = kind;
    slot.age = 0;
    // A story beat is a sentence, not a score: it gets the longest hold.
    slot.life = kind === 'story' ? 3.2 : kind === 'warning' ? 2.2 : 1.9;
    slot.active = true;
  }

  override update(m: HudModel, dt: number, time: number): void {
    // Consume the model's queue — the contract says the HUD clears it.
    if (m.popups.length > 0) {
      for (const p of m.popups) this.push(p.text, p.value, p.kind);
      m.popups.length = 0;
      this.trim();
    }

    this.live = 0;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        // Hard cut. No fade out — the popup is gone between one frame and the
        // next, which is what makes the next one land.
        p.active = false;
        continue;
      }
      this.live++;
    }

    this.present(stageLive(m.phase) && this.live > 0, dt, 0.05);

    let s = '';
    for (const p of this.pool) if (p.active) s += `|${p.text}${p.value}${Math.round(p.age * 40)}`;
    this.sig(s);
  }

  /** The bar colour is the popup's KIND, and only its kind. */
  private colorFor(p: Popup): string {
    switch (p.kind) {
      case 'warning': return P.red;
      case 'combo': return P.violet;
      case 'style': return P.goldHot;
      case 'story': return P.teal;
      case 'split': return p.value <= 0 ? P.teal : P.red;
      default: return P.gold;
    }
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // ── The stack. Newest at the bottom, older ones pushed up the frame ──────
    //
    // The sort was `b.age - a.age`, which is the opposite of that: it put the
    // OLDEST at the bottom and made each new popup appear at the top of the
    // pile. That is backwards twice over. The bottom slot is the only one that
    // is guaranteed clear of the panel above and of the layer's own top edge,
    // so it is the slot the newest popup — the one the player is being told
    // something by — has to land in; and when the pile is deeper than the
    // column, the ones that get pushed out have to be the ones already on their
    // way out, not the one that just landed.
    //
    // Built into a pooled array, not `filter().sort()`. While popups are live
    // the signature changes every frame — `age` is in it — so this IS the
    // per-frame path, and the old form allocated a fresh array and a fresh
    // comparator closure on each of those frames. Six elements: an insertion
    // sort in place is both allocation-free and faster.
    let slot = 0;
    const ord = this.order;
    let n = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      let k = n++;
      while (k > 0 && ord[k - 1].age > p.age) {
        ord[k] = ord[k - 1];
        k--;
      }
      ord[k] = p;
    }
    for (let i = 0; i < n && i < this.depth; i++) {
      const p = ord[i];
      const k = ease.snap(clamp01(p.age / 0.20));
      const y = h - POPUP_BASE - POPUP_BAR_H - slot * POPUP_PITCH;
      slot++;
      // A bar that cannot fit whole in the backing store is not drawn at all.
      // The old guard let one through at y = −60, which is a bar clipped to
      // nothing — a failed draw wearing a popup's clothes.
      if (y < 4) continue;

      // A split's value is a DELTA in seconds and it is routinely negative —
      // which is the good one. `value > 0` therefore printed a bare `SPLIT`
      // with no number on exactly the splits worth celebrating, and rounded to
      // a whole second (i.e. to `+0`) on the rest. Splits get a signed
      // hundredths gap; a story beat gets no number at all; everything else
      // keeps the integer score it actually is.
      const isSplit = p.kind === 'split';
      const col = this.colorFor(p);
      const st: TextStyle = { size: 27, weight: 0.17, fill: P.paper, ink: P.ink, tracking: 0.1, skew: SHEAR };
      const vs = p.kind === 'story'
        ? ''
        : isSplit
          ? formatGap(p.value)
          : p.value > 0 ? `+${Math.round(p.value)}` : '';
      const tw = measureText(p.text, st);
      const vw = vs ? measureText(vs, { ...st, size: 27, tabular: true }) : 0;
      const bw = (tw + vw + (vs ? 34 : 0) + 40) * k;
      const x = w - 20 - bw;

      ctx.save();
      // Slide in from the right AND scale up: the snap ease overshoots by ~6%,
      // which is the tiny bit of impact that separates "appeared" from "landed".
      ctx.globalAlpha = clamp01(k * 1.6);
      bar(ctx, x, y, bw, POPUP_BAR_H, P.panelDeep, col, 3.0);
      if (k > 0.5) {
        const base = y + (POPUP_BAR_H + st.size) * 0.5 + 1;
        drawText(ctx, p.text, x + 20, base, st);
        if (vs) {
          drawText(ctx, vs, w - 34, base, { ...st, fill: col, align: 'right', tabular: true });
        }
      }
      ctx.restore();
    }
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Traversal prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contextual prompt: rail, wall, homing target, spring.
 *
 * This is the third and last thing allowed to be loud, and it has to be,
 * because it is the only readout in the HUD carrying information the player
 * cannot get from the picture in the time available. At 74 m/s a rail is
 * visible for well under a second and the window to commit to it is shorter
 * than that.
 *
 * ── WHY IT LATCHES ───────────────────────────────────────────────────────────
 *
 * Inherited wholesale from the corner call this widget replaces, because the
 * failure mode is identical and it cost four review passes to diagnose the
 * first time. The old call was invisible in every fast frame of the review set,
 * and the reason was not a fade and not a speed term: the SOURCE flickered. A
 * candidate sitting anywhere near a detection threshold is found on one frame
 * and missed on the next, and with a symmetric alpha damp that chatter parks
 * the layer between 5% and 20% — showing the PREVIOUS prompt, because the
 * signature only carried the payload and the payload freezes when the source
 * goes null. The critic read it exactly right: a failed draw, not a fade.
 *
 * Two mechanisms, both necessary. The prompt is LATCHED for `PROMPT_HOLD`
 * seconds past its last sighting, which is longer than any chatter gap a
 * per-frame scan can produce and short enough that it cannot outlive the
 * affordance at speed; and presence uses `presentCut`, so the layer is at full
 * alpha or at zero and never in between. `has` is in the signature, so when the
 * prompt does end the canvas is cleared rather than left holding a stale one.
 */
const PROMPT_HOLD = 0.30;

interface PromptStyle {
  label: string;
  verb: string;
  color: string;
  /** Which way the chevrons point: the shape of the move, not decoration. */
  dir: number;
}

/** One table, so a prompt's word and its colour cannot come from two lists. */
const PROMPT_STYLES: Record<TraversalPrompt, PromptStyle | null> = {
  [TraversalPrompt.None]: null,
  [TraversalPrompt.Rail]: { label: 'RAIL', verb: 'GRIND', color: P.teal, dir: 0 },
  [TraversalPrompt.Wall]: { label: 'WALL', verb: 'RUN', color: P.violet, dir: -Math.PI / 2 },
  [TraversalPrompt.Homing]: { label: 'TARGET', verb: 'HOME', color: P.red, dir: 0 },
  [TraversalPrompt.Spring]: { label: 'SPRING', verb: 'LAUNCH', color: P.gold, dir: -Math.PI / 2 },
};

export class PromptWidget extends Widget {
  private prompt: TraversalPrompt = TraversalPrompt.None;
  private style: PromptStyle | null = null;
  private has = false;
  private age = 0;
  /** Seconds of latch remaining. Refreshed on every frame the prompt exists. */
  private hold = 0;
  private phase = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = 46;
  }

  override furniture(): void {
    // The plate is tinted by the prompt's kind, so it is part of the call and
    // is drawn with it.
  }

  override update(m: HudModel, dt: number, time: number): void {
    const live = stagePlaying(m.phase);
    const p = m.prompt;
    this.phase = time;

    if (live && p !== TraversalPrompt.None) {
      if (p !== this.prompt) {
        this.prompt = p;
        this.style = PROMPT_STYLES[p];
        this.age = 0;
      }
      this.hold = PROMPT_HOLD;
    } else if (this.hold > 0) {
      this.hold = Math.max(0, this.hold - dt);
    }

    this.age += dt;
    this.has = live && this.hold > 0 && this.style !== null;
    if (!this.has) this.prompt = TraversalPrompt.None;

    // 0.018 s half-life: the call is at 76% one frame after it appears and full
    // the frame after. A slower ramp is a frame the shutter can land on.
    this.presentCut(this.has, dt, 0.018);
    this.sig(`${this.has ? this.prompt : 'off'}|${Math.round(Math.min(this.age, 1) * 40)}|${Math.floor(time * 8) & 1}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const st = this.style;
    if (!this.has || !st) return;

    const k = ease.snap(clamp01(this.age / 0.14));
    const pulse = (Math.floor(this.phase * 8) & 1) === 0;
    const cx = w * 0.5;

    const pw = w - 60;
    const ph = 74;
    const py = h - ph - 12;
    const px = cx - pw * 0.5 - SHEAR * ph * 0.5;

    ctx.save();
    ctx.globalAlpha = clamp01(k);
    slab(ctx, px, py, pw, ph, {
      fill: P.panelDeep, ink: st.color, inkWidth: 3.2, cuts: 0b0101, cut: 18,
      accent: st.color, accentHeight: 5,
    });

    // The kind, then the verb. Two words, because the kind is what you are
    // looking at and the verb is what to do about it, and at this speed the
    // player reads whichever one their eye lands on first.
    drawText(ctx, st.label, px + 34, py + 34, {
      size: 16, weight: 0.19, fill: st.color, ink: P.ink, tracking: 0.28, skew: SHEAR,
    });
    drawText(ctx, st.verb, px + 34, py + 64, {
      size: 26, weight: 0.18, fill: pulse ? P.paper : P.paperDim, ink: P.ink, tracking: 0.12, skew: SHEAR,
    });

    // Three chevrons marching toward the affordance, hard right. They carry the
    // call on their own if the type is unreadable at speed, which it will be.
    for (let i = 0; i < 3; i++) {
      const on = ((Math.floor(this.phase * 12) + i) % 3) === 0;
      const ox = px + pw - 96 + i * 30;
      chevron(ctx, ox, py + ph * 0.5, 15, 5, st.dir, on ? st.color : null,
        on ? P.ink : cssA(HUD_PALETTE.paperDim, 0.4), on ? 2.8 : 2.0);
    }
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrong-way warning
// ─────────────────────────────────────────────────────────────────────────────

export class WarningWidget extends Widget {
  private on = false;
  private phase = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = -50;
  }

  override furniture(): void {
    // Hazard stripes are phase-animated, so nothing here is static.
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.on = m.wrongWay && stagePlaying(m.phase);
    this.phase = time;
    this.present(this.on, dt, 0.04);
    this.sig(this.on ? String(Math.round(time * 20)) : 'off');
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.on) return;
    const blink = (Math.floor(this.phase * 5) & 1) === 0;
    const bx = 40;
    const bw = w - 80;
    const by = 40;
    const bh = 108;

    slabPath(ctx, bx, by, bw, bh, 0b0101, 22, SHEAR);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = blink ? P.red : P.ink;
    ctx.fillRect(bx - 40, by, bw + 80, bh);
    hazard(ctx, bx - 40, by, bw + 80, bh, cssA(HUD_PALETTE.ink, blink ? 0.5 : 0.85), 34, 0.5, -this.phase * 90);
    ctx.restore();
    slabPath(ctx, bx, by, bw, bh, 0b0101, 22, SHEAR);
    ctx.strokeStyle = blink ? P.goldHot : P.red;
    ctx.lineWidth = 4.0;
    ctx.stroke();

    drawText(ctx, 'WRONG WAY', w * 0.5, by + 76, {
      size: 54, weight: 0.19, fill: blink ? P.paper : P.red, ink: P.ink, inkWidth: 0.06,
      tracking: 0.16, align: 'center', skew: SHEAR,
    });

    // A U-turn arrow either side, so the instruction survives without the text.
    for (const sx of [bx + 46, bx + bw - 46]) {
      chevron(ctx, sx, by + bh * 0.5, 24, 8, Math.PI, blink ? P.paper : P.red, P.ink, 3.0);
    }

    cornerTicks(ctx, bx - 12, by - 12, bw + 24, bh + 24, 20, 2.6, blink ? P.goldHot : P.red);
  }
}
