/**
 * Menus — title, countdown, pause and results.
 *
 * All four are the same object: one layer, one canvas, and a `kind` that
 * decides which furniture gets baked and which dynamic content gets drawn over
 * it. Switching kind re-bakes the furniture once; after that a menu costs one
 * small redraw whenever its selection or its blink phase changes, and nothing
 * at all in between.
 *
 * The countdown is separate because it has to sit on top of a menu-free frame
 * during the stage start, and because it is the one element in the HUD that is
 * genuinely animating every frame for a second and a half.
 *
 * ── WHAT THE PIVOT CHANGED HERE ─────────────────────────────────────────────
 * The results screen was a finishing order: four riders, their times, their
 * deltas and their trick scores. There is no field any more, so it is now the
 * stage debrief — a rank letter, the clock, and the collection and mastery
 * counts out of `StageStats`. Every figure on it comes from that one object,
 * which is the whole of the fix for the class of bug RESUME.md #10 belongs to:
 * the screen cannot show a name from one list and a colour from another if
 * there is only one list.
 */

import type { HudModel, StageStats } from '../game/Contracts';
import { StagePhase, StageRank } from '../game/Contracts';
import { HUD_PALETTE } from '../npr/Palette';
import { clamp01, ease } from '../core/MathX';
import {
  HudLayer,
  bar,
  chevron,
  cornerTicks,
  css,
  cssA,
  hazard,
  slab,
  slabPath,
  tick,
  SHEAR,
} from './HudCanvas';
import { drawText, drawWordmark, measureText, type TextStyle } from './Typeface';
import { Widget, clockString } from './Widgets';

const P = {
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
  panel: cssA(HUD_PALETTE.ink, 0.90),
  panelSoft: cssA(HUD_PALETTE.inkSoft, 0.72),
};

export type MenuKind = 'none' | 'title' | 'pause' | 'results';

export const DEFAULT_MENU_ITEMS: Record<MenuKind, string[]> = {
  none: [],
  title: ['START STAGE'],
  pause: ['RESUME', 'RESTART STAGE', 'QUIT TO TITLE'],
  results: ['RETRY STAGE', 'QUIT TO TITLE'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Countdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3 — 2 — 1 — GO.
 *
 * Each number snaps in over 130ms with `ease.snap` (which overshoots and settles
 * once), holds, then cuts. A hard octagonal ring expands out of it and vanishes.
 * Nothing crossfades: the number is either the old one or the new one, and the
 * ring is the thing that carries the beat.
 */
export class CountdownWidget extends Widget {
  private value: number | null = null;
  private curDigit = -99;
  private age = 0;
  private go = -99;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = 0;
  }

  override furniture(): void {
    // Nothing static — the countdown is pure animation.
  }

  override update(m: HudModel, dt: number, time: number): void {
    const cd = m.countdown;
    if (cd !== null && cd > 0) {
      // The director's countdown is longer than three seconds, so the first
      // tick would read "4". Clamp it.
      const n = Math.min(3, Math.max(1, Math.ceil(cd - 0.0001)));
      if (n !== this.curDigit) {
        this.curDigit = n;
        this.age = 0;
      }
      this.value = n;
      this.go = -99;
    } else if (cd !== null && cd <= 0) {
      if (this.go < -1) this.go = 0;
      this.value = 0;
    } else if (this.curDigit > 0 && this.go < -1) {
      // The model dropped the countdown without ever reporting <= 0; treat the
      // transition itself as the gun so GO is never skipped.
      this.go = 0;
      this.value = 0;
    }

    this.age += dt;
    if (this.go > -1) this.go += dt;

    const alive = (this.value !== null && this.value > 0) || (this.go >= 0 && this.go < 0.85);
    if (!alive) {
      this.value = null;
      this.curDigit = -99;
    }
    this.present(alive, dt, 0.02);
    this.sig(alive ? `${this.value}|${Math.round(this.age * 60)}|${Math.round(this.go * 60)}` : 'off');
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const going = this.go >= 0 && this.go < 0.85;
    const t = going ? this.go : this.age;
    const k = ease.snap(clamp01(t / 0.13));

    // Expanding ring — a hard octagon, because a circle would be the only
    // smooth curve in the frame.
    const ring = clamp01(t / 0.42);
    if (ring < 1) {
      const r = 70 + ease.outQuart(ring) * 210;
      ctx.save();
      ctx.globalAlpha = 1 - ring;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = going ? P.goldHot : P.paper;
      ctx.lineWidth = 8 * (1 - ring) + 2;
      ctx.stroke();
      ctx.restore();
    }

    const label = going ? 'GO' : String(this.value ?? 3);
    const size = (going ? 210 : 190) * (0.55 + k * 0.45);
    ctx.save();
    ctx.globalAlpha = clamp01(k * 2);
    drawWordmark(ctx, label, cx, cy + size * 0.42, size, going ? P.goldHot : P.paper, P.ink, 1);
    ctx.restore();

    if (going) {
      // Speed wedges either side on the gun.
      const spread = ease.outQuart(clamp01(this.go / 0.3));
      ctx.save();
      ctx.globalAlpha = clamp01(1 - this.go / 0.7);
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const x = cx + s * (150 + spread * (120 + i * 70));
          const hh = 46 - i * 8;
          bar(ctx, x - 60, cy - hh * 0.5, 120, hh, P.goldHot, null, 0, SHEAR);
        }
      }
      ctx.restore();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu screen
// ─────────────────────────────────────────────────────────────────────────────

export interface MenuState {
  kind: MenuKind;
  items: string[];
  selection: number;
}

/** Where the results screen leaves a hole for the highlight replay. */
export interface ReplayFrameRect {
  /** In the menu layer's design units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The same rect in 0..1 screen space — what the camera director needs. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * The debrief table, resolved from `StageStats` once per results screen.
 *
 * Pooled and rebuilt in place: the screen redraws on every frame of its
 * stagger, and a `map()` over eleven rows on each of those frames is eleven
 * objects and a closure per frame for a table that never changes size.
 */
interface StatRow {
  label: string;
  value: string;
  /** A second, dimmer figure printed after the value — the "out of" half. */
  outOf: string;
  hot: boolean;
}

const STAT_ROWS = 8;

/** Rank → colour. One table: the letter and its colour cannot disagree. */
const RANK_COLOR: Record<StageRank, string> = {
  [StageRank.S]: P.goldHot,
  [StageRank.A]: P.gold,
  [StageRank.B]: P.teal,
  [StageRank.C]: P.violet,
  [StageRank.D]: P.red,
};

export class MenuScreen extends Widget {
  kind: MenuKind = 'none';
  items: string[] = [];
  selection = 0;

  /** Set true once the results replay is running so the frame label changes. */
  replayActive = false;

  /** The wordmark and its kicker. The game names itself; the HUD does not. */
  private titleName = 'DESCENT';
  private titleTag = 'ONE MOUNTAIN  ·  ONE CLOCK  ·  NO BRAKES';

  private rows: StatRow[] = [];
  private rowCount = 0;
  private rank: StageRank = StageRank.C;
  private clearTime = '0:00.00';
  private timeLeft = '0:00.00';
  private newBest = false;
  private cleared = false;

  private age = 0;
  private blink = 0;
  private lastKind: MenuKind = 'none';
  private frame: ReplayFrameRect = { x: 0, y: 0, w: 0, h: 0, u0: 0, v0: 0, u1: 0, v1: 0 };

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = 60;
    for (let i = 0; i < STAT_ROWS; i++) this.rows.push({ label: '', value: '', outOf: '', hot: false });
  }

  /** The replay window in screen UV, for whoever drives the replay camera. */
  get replayFrame(): ReplayFrameRect {
    return this.frame;
  }

  /**
   * Name the game. The HUD has no business inventing one, and the old wordmark
   * was the BMX project's, so the default here is the mountain's name and the
   * orchestration layer is expected to overwrite it.
   */
  setTitle(name: string, tagline?: string): void {
    this.titleName = name.toUpperCase();
    if (tagline !== undefined) this.titleTag = tagline.toUpperCase();
    if (this.kind === 'title') {
      this.layer.markFurniture();
      this.invalidate();
    }
  }

  setKind(kind: MenuKind, items?: string[]): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.items = items ? items.slice() : DEFAULT_MENU_ITEMS[kind].slice();
    this.selection = 0;
    this.age = 0;
    this.layer.markFurniture();
    this.invalidate();
  }

  setItems(items: string[]): void {
    this.items = items.slice();
    this.selection = Math.min(this.selection, Math.max(0, items.length - 1));
    this.invalidate();
  }

  setSelection(i: number): void {
    const n = Math.max(1, this.items.length);
    const next = ((i % n) + n) % n;
    if (next !== this.selection) {
      this.selection = next;
      this.invalidate();
    }
  }

  moveSelection(delta: number): void {
    this.setSelection(this.selection + delta);
  }

  // ── Furniture ─────────────────────────────────────────────────────────────

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.kind === 'none') return;
    if (this.kind === 'title') this.titleFurniture(ctx, w, h);
    else if (this.kind === 'pause') this.pauseFurniture(ctx, w, h);
    else this.resultsFurniture(ctx, w, h);
  }

  private titleFurniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // A single raking band of hazard stripes behind the wordmark — the only
    // decoration on the screen, and it does the job of a background image.
    ctx.save();
    slabPath(ctx, 40, h * 0.30, w - 80, 190, 0b0101, 34, SHEAR);
    ctx.clip();
    ctx.fillStyle = cssA(HUD_PALETTE.ink, 0.86);
    ctx.fillRect(0, 0, w, h);
    hazard(ctx, 0, h * 0.30, w, 190, cssA(HUD_PALETTE.violet, 0.45), 44, 0.45, 0);
    ctx.restore();
    slabPath(ctx, 40, h * 0.30, w - 80, 190, 0b0101, 34, SHEAR);
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 4;
    ctx.stroke();

    drawText(ctx, 'HIGH SPEED DESCENT', w * 0.5, h * 0.30 - 26, {
      size: 24, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.46, align: 'center', skew: SHEAR,
    });
    drawText(ctx, this.titleTag, w * 0.5, h * 0.30 + 236, {
      size: 18, weight: 0.16, fill: P.paperDim, ink: P.ink, tracking: 0.20, align: 'center', skew: 0,
    });

    // The three verbs the whole game is made of, along the bottom. It used to
    // be the four rider colours; the field is gone, and what introduces this
    // game before it starts is its moveset.
    const verbs = ['RUN', 'GRIND', 'WALL RUN'];
    const cols = [P.gold, P.teal, P.violet];
    const sw = 200;
    for (let i = 0; i < verbs.length; i++) {
      const x = w * 0.5 - (verbs.length * (sw + 10)) * 0.5 + i * (sw + 10);
      bar(ctx, x, h - 96, sw, 12, cols[i], P.ink, 2);
      drawText(ctx, verbs[i], x + sw * 0.5, h - 62, {
        size: 15, weight: 0.17, fill: P.paperDim, ink: P.ink, tracking: 0.2, align: 'center', skew: 0,
      });
    }
  }

  private pauseFurniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const pw = 620;
    const ph = 460;
    const x = (w - pw) * 0.5;
    const y = (h - ph) * 0.5;
    slab(ctx, x, y, pw, ph, {
      fill: P.panel, ink: P.ink, inkWidth: 4, cuts: 0b0101, cut: 34, accent: P.gold, accentHeight: 8,
    });
    drawText(ctx, 'PAUSED', w * 0.5, y + 92, {
      size: 62, weight: 0.19, fill: P.paper, ink: P.ink, inkWidth: 0.06, tracking: 0.18, align: 'center', skew: SHEAR,
    });
    tick(ctx, x + 50, y + 122, x + pw - 50, y + 122, 3, P.gold);
  }

  private resultsFurniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    slab(ctx, 20, 20, w - 40, h - 40, {
      fill: P.panel, ink: P.ink, inkWidth: 4, cuts: 0b0101, cut: 40, accent: P.gold, accentHeight: 8,
    });
    drawText(ctx, this.cleared ? 'STAGE CLEAR' : 'STAGE FAILED', 70, 106, {
      size: 58, weight: 0.19, fill: this.cleared ? P.goldHot : P.red, ink: P.ink,
      inkWidth: 0.06, tracking: 0.16, skew: SHEAR,
    });
    tick(ctx, 62, 132, w * 0.52, 132, 3.4, P.gold);

    // The replay window. A genuine hole cut in the panel: everything behind the
    // HUD — the replay camera's view of the run's best moment — shows straight
    // through it. The frame is the only thing the HUD draws here.
    this.layoutFrame(w, h);
    const f = this.frame;
    ctx.clearRect(f.x, f.y, f.w, f.h);
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 5;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 2;
    ctx.strokeRect(f.x - 5, f.y - 5, f.w + 10, f.h + 10);
    cornerTicks(ctx, f.x + 10, f.y + 10, f.w - 20, f.h - 20, 28, 3, P.goldHot);
    drawText(ctx, 'HIGHLIGHT', f.x, f.y - 22, {
      size: 17, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.3, skew: SHEAR,
    });
  }

  private layoutFrame(w: number, h: number): void {
    const fw = 460;
    const fh = 300;
    const fx = w - fw - 70;
    const fy = 196;
    this.frame.x = fx;
    this.frame.y = fy;
    this.frame.w = fw;
    this.frame.h = fh;
    this.frame.u0 = fx / w;
    this.frame.v0 = fy / h;
    this.frame.u1 = (fx + fw) / w;
    this.frame.v1 = (fy + fh) / h;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  override update(m: HudModel, dt: number, time: number): void {
    const want: MenuKind =
      m.phase === StagePhase.Title ? 'title'
        : m.phase === StagePhase.Paused ? 'pause'
          : m.phase === StagePhase.Results ? 'results'
            : 'none';
    if (want !== this.kind) this.setKind(want);

    if (this.kind !== this.lastKind) {
      this.lastKind = this.kind;
      this.age = 0;
    }
    this.age += dt;
    this.blink = time;

    if (this.kind === 'results' && m.results) this.buildRows(m.results);

    // A MENU NEVER ANIMATES OUT, and this is the whole of the "overlapping modals
    // and status menus on every restart" report.
    //
    // Every exit this widget has is an exit into gameplay: Title to Countdown,
    // Paused to Running, Results to Countdown on a restart. There is nothing for
    // an outgoing menu to transition to except the game, and the game is already
    // behind it, so any frame the menu spends leaving is a frame with two modals
    // up. The original `present` damped out over ~0.2 s, which put the PREVIOUS
    // run's finish times over a fresh countdown for twelve frames on every single
    // restart. `presentCut` was tried next and is not the fix either: it holds
    // full alpha until `vis` crosses the floor, so it traded twelve translucent
    // frames for three opaque ones. Measured with tools/capture/_restart.mjs —
    // `worstModalOverlap: 2`, `["countdown", "menu"]`, at frame 0, on all five
    // restarts.
    //
    // The entrance still animates, because an arriving menu has something real to
    // arrive over.
    if (this.kind === 'none') this.snapOff();
    else this.present(true, dt, 0.05);

    // While the rows stagger in the layer must redraw; after 1.4s it settles to
    // the blink rate and stops costing anything.
    const settling = this.age < 1.4 ? Math.round(this.age * 60) : 0;
    this.sig(`${this.kind}|${this.selection}|${settling}|${Math.round(this.blink * 2)}|${this.rank}|${this.rowCount}`);
  }

  /** One `StageStats`, one table. Written into the pooled rows in place. */
  private buildRows(s: StageStats): void {
    const cleared = s.timeLeft > 0;
    if (cleared !== this.cleared) {
      this.cleared = cleared;
      this.layer.markFurniture();
    }
    this.rank = s.rank;
    this.clearTime = clockString(s.time);
    this.timeLeft = clockString(s.timeLeft);
    this.newBest = s.isNewBest;

    let i = 0;
    const put = (label: string, value: string, outOf = '', hot = false): void => {
      if (i >= this.rows.length) return;
      const r = this.rows[i++];
      r.label = label;
      r.value = value;
      r.outOf = outOf;
      r.hot = hot;
    };
    put('FRAGMENTS', String(s.fragments), `/ ${s.fragmentsTotal}`, s.fragments >= s.fragmentsTotal && s.fragmentsTotal > 0);
    put('SHARDS', String(s.shards), `/ ${s.shardsTotal}`, s.shards >= s.shardsTotal && s.shardsTotal > 0);
    put('ENEMIES', String(s.enemiesDefeated), `/ ${s.enemiesTotal}`, s.enemiesDefeated >= s.enemiesTotal && s.enemiesTotal > 0);
    put('SHORTCUTS', String(s.shortcuts), `/ ${s.shortcutsTotal}`, s.shortcuts >= s.shortcutsTotal && s.shortcutsTotal > 0);
    put('BEST COMBO', String(Math.round(s.bestCombo)), 'X', s.bestCombo >= 20);
    put('STYLE', String(Math.round(s.styleScore)), '', s.styleScore > 0);
    put('GRIND + WALL', String(Math.round(s.grindDistance + s.wallRunDistance)), 'M');
    // NOTE: `StageStats.topSpeed` is m/s, and the HUD's speed unit is the Spark
    // display figure. The conversion lives in SparkConstants and is not
    // permitted here (see the header of Widgets.ts), so this row is labelled in
    // the unit it actually arrives in rather than silently mislabelled. A
    // `topSpeedDisplay` on `StageStats` would let it join the rest of the HUD.
    put('TOP SPEED', s.topSpeed.toFixed(1), 'M/S', false);
    this.rowCount = i;
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.kind === 'none') return;
    if (this.kind === 'title') this.drawTitle(ctx, w, h);
    else if (this.kind === 'pause') this.drawPause(ctx, w, h);
    else this.drawResults(ctx, w, h);
  }

  private drawTitle(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // The wordmark scales in once, on a snap, and then never moves again.
    const k = ease.snap(clamp01(this.age / 0.55));
    ctx.save();
    ctx.globalAlpha = clamp01(k * 1.5);
    drawWordmark(ctx, this.titleName, w * 0.5, h * 0.30 + 148, 132 * (0.82 + k * 0.18), P.paper, P.ink, 1);
    ctx.restore();

    if (this.items.length > 1) {
      this.drawItems(ctx, w, h * 0.62, 300);
    } else {
      const on = (Math.floor(this.blink * 1.6) & 1) === 0;
      const label = this.items[0] ?? 'PRESS ENTER TO DROP IN';
      drawText(ctx, label, w * 0.5, h * 0.70, {
        size: 30, weight: 0.17, fill: on ? P.goldHot : P.gold, ink: P.ink,
        tracking: 0.26, align: 'center', skew: SHEAR, alpha: this.age > 0.6 ? 1 : 0,
      });
    }
  }

  private drawPause(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const ph = 460;
    const y = (h - ph) * 0.5;
    this.drawItems(ctx, w, y + 186, 480);
  }

  private drawResults(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // ── The stat table ───────────────────────────────────────────────────────
    // Staggered 70 ms apart, each on a snap, so eight rows land like eight
    // beats rather than appearing as a block.
    const rowH = 44;
    const tableX = 62;
    const tableW = 700;
    for (let i = 0; i < this.rowCount; i++) {
      const r = this.rows[i];
      const k = ease.snap(clamp01((this.age - 0.18 - i * 0.07) / 0.24));
      if (k <= 0) continue;
      const y = 200 + i * rowH;
      ctx.save();
      ctx.globalAlpha = clamp01(k * 1.6);
      tick(ctx, tableX, y + rowH - 8, tableX + tableW * k, y + rowH - 8, 1.4, cssA(HUD_PALETTE.paperDim, 0.28));
      if (k > 0.5) {
        drawText(ctx, r.label, tableX + 6, y + 26, {
          size: 18, weight: 0.17, fill: P.paperDim, ink: null, tracking: 0.18, skew: 0,
        });
        const unitSt: TextStyle = {
          size: 16, weight: 0.16, fill: P.paperDim, ink: null, tracking: 0.08, align: 'right', skew: 0,
        };
        const uw = r.outOf ? measureText(r.outOf, unitSt) + 12 : 0;
        if (r.outOf) drawText(ctx, r.outOf, tableX + tableW, y + 26, unitSt);
        drawText(ctx, r.value, tableX + tableW - uw, y + 28, {
          size: 26, weight: 0.17, fill: r.hot ? P.goldHot : P.paper, ink: null,
          tracking: 0.04, align: 'right', tabular: true, skew: 0,
        });
      }
      ctx.restore();
    }

    // ── The two clocks ───────────────────────────────────────────────────────
    if (this.age > 0.62) {
      const k = ease.snap(clamp01((this.age - 0.62) / 0.3));
      ctx.save();
      ctx.globalAlpha = clamp01(k * 1.5);
      drawText(ctx, 'CLEAR TIME', tableX, h - 148, {
        size: 16, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.3, skew: SHEAR,
      });
      drawText(ctx, this.clearTime, tableX, h - 92, {
        size: 52, weight: 0.17, fill: P.paper, ink: P.ink, tabular: true, skew: SHEAR,
      });
      drawText(ctx, 'TIME LEFT', tableX + 340, h - 148, {
        size: 16, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.3, skew: SHEAR,
      });
      drawText(ctx, this.timeLeft, tableX + 340, h - 92, {
        size: 52, weight: 0.17, fill: this.cleared ? P.teal : P.red, ink: P.ink, tabular: true, skew: SHEAR,
      });
      ctx.restore();
    }

    // ── The rank badge ───────────────────────────────────────────────────────
    // Last in, biggest, and the only thing on the screen that is allowed to
    // overshoot: it is the verdict, and a verdict that eases in politely is not
    // one. The plate is an octagon for the same reason the countdown's ring is.
    if (this.age > 0.95) {
      const k = ease.snap(clamp01((this.age - 0.95) / 0.34));
      const f = this.frame;
      const cx = f.x + f.w * 0.5;
      const cy = f.y + f.h + 138;
      const r = 86 * (0.6 + k * 0.4);
      const col = RANK_COLOR[this.rank] ?? P.paper;
      ctx.save();
      ctx.globalAlpha = clamp01(k * 1.5);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = cssA(HUD_PALETTE.ink, 0.92);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 5;
      ctx.stroke();
      drawText(ctx, String(this.rank), cx, cy + r * 0.42, {
        size: r * 1.05, weight: 0.19, fill: col, ink: P.ink, inkWidth: 0.06,
        align: 'center', tracking: 0, skew: SHEAR,
      });
      drawText(ctx, 'RANK', cx, cy - r - 18, {
        size: 15, weight: 0.18, fill: P.paperDim, ink: P.ink, tracking: 0.34, align: 'center', skew: SHEAR,
      });
      if (this.newBest) {
        const on = (Math.floor(this.blink * 3) & 1) === 0;
        drawText(ctx, 'NEW BEST', cx, cy + r + 40, {
          size: 20, weight: 0.19, fill: on ? P.goldHot : P.gold, ink: P.ink,
          tracking: 0.3, align: 'center', skew: SHEAR,
        });
      }
      ctx.restore();
    }

    if (this.age > 1.1) this.drawItems(ctx, w, h - 190, 420, 'right');

    // Keep the replay window transparent even after a dynamic redraw.
    const f = this.frame;
    if (f.w > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      ctx.fillRect(f.x + 2.5, f.y + 2.5, f.w - 5, f.h - 5);
      ctx.restore();
    }
  }

  /**
   * The item list. The cursor is a chevron that sits outside the tag, and the
   * selected tag is filled rather than outlined — selection must survive being
   * read out of the corner of your eye, so it changes value, not just colour.
   */
  private drawItems(
    ctx: CanvasRenderingContext2D,
    w: number,
    y0: number,
    width: number,
    align: 'center' | 'right' = 'center',
  ): void {
    const rowH = 58;
    const x = align === 'right' ? w - width - 70 : (w - width) * 0.5;
    for (let i = 0; i < this.items.length; i++) {
      const sel = i === this.selection;
      const y = y0 + i * (rowH + 12);
      const k = ease.snap(clamp01((this.age - 0.3 - i * 0.07) / 0.25));
      if (k <= 0) continue;
      ctx.save();
      ctx.globalAlpha = clamp01(k * 1.6);
      bar(ctx, x, y, width * k, rowH, sel ? P.gold : cssA(HUD_PALETTE.ink, 0.7), sel ? P.goldHot : P.paperDim, sel ? 3.4 : 2.2);
      if (k > 0.6) {
        drawText(ctx, this.items[i], x + 52, y + 40, {
          size: 27, weight: 0.17, fill: sel ? P.ink : P.paperDim, ink: sel ? null : P.ink,
          tracking: 0.18, skew: SHEAR,
        });
        if (sel) {
          const pulse = 1 + Math.sin(this.blink * 7) * 0.10;
          chevron(ctx, x - 26, y + rowH * 0.5, 15 * pulse, 5, 0, P.goldHot, P.ink, 2.6);
        }
      }
      ctx.restore();
    }
  }
}
