/**
 * StageWidgets — the readouts that arrived with the pivot.
 *
 * Health, the combo block, the collection counts, the boss bar and the
 * transmission line. They live in their own file rather than in `Widgets.ts`
 * because that file is the inherited framework — the base class, the descent
 * profile, the clock, the dial — and mixing eight hundred lines of new work
 * into it would make the retarget impossible to read as a diff.
 *
 * Same rules as everything else here: one layer each, a `sig()` that IS the
 * content, no allocation in a per-frame draw, no literal hex, and every colour
 * out of `HUD_PALETTE`.
 */

import type { HudModel } from '../game/Contracts';
import { BossPhase, StagePhase } from '../game/Contracts';
import { HUD_PALETTE } from '../npr/Palette';
import { clamp01, dampHL, ease } from '../core/MathX';
import {
  HudLayer,
  bar,
  cssA,
  slab,
  slabPath,
  tick,
  tri,
  INK_W,
  SHEAR,
} from './HudCanvas';
import { drawText, measureText, type TextStyle } from './Typeface';
import { P, Widget, stageLive, stagePlaying } from './Widgets';

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Health is PIPS, not a bar, for the same reason the boost meter is segments:
 * "62% health" is not a number anyone can act on, and "two hits left" is.
 *
 * The pip count is `maxHealth`, so the widget is sized by the model rather than
 * by a constant here — a pickup that raises the ceiling changes the readout
 * without changing this file. The furniture is therefore rebaked whenever the
 * ceiling moves, which is the one case where `markFurniture()` is driven by
 * game state rather than by a resize.
 */
const HP_MAX_PIPS = 12;

export class HealthWidget extends Widget {
  private pips = 0;
  private filled = 0;
  /** Fractional part of the leading pip — a partial hit reads as a partial pip. */
  private partial = 0;
  private hurt = 0;
  private low = false;
  private phase = 0;
  private lastHealth = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterX = -120;
  }

  private pipRect(i: number, w: number): { x: number; y: number; pw: number; ph: number } {
    const padX = 30;
    const gap = 6;
    const n = Math.max(1, this.pips);
    const avail = w - padX * 2 - 22;
    const pw = (avail - gap * (n - 1)) / n;
    return { x: padX + i * (pw + gap), y: 42, pw, ph: 34 };
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    slab(ctx, 0, 0, w - 22, 90, { fill: P.panel, ink: P.ink, inkWidth: 2.6, cuts: 0b0101, cut: 16 });
    drawText(ctx, 'VITALS', 34, 30, {
      size: 15, weight: 0.18, fill: P.red, ink: P.ink, tracking: 0.3, skew: SHEAR,
    });
    for (let i = 0; i < this.pips; i++) {
      const r = this.pipRect(i, w);
      bar(ctx, r.x, r.y, r.pw, r.ph, cssA(HUD_PALETTE.ink, 0.5), cssA(HUD_PALETTE.paperDim, 0.35), 1.8);
    }
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.present(stageLive(m.phase), dt, 0.08);
    this.phase = time;

    const want = Math.max(1, Math.min(HP_MAX_PIPS, Math.round(m.maxHealth)));
    if (want !== this.pips) {
      this.pips = want;
      this.layer.markFurniture();
      this.invalidate();
    }

    const hp = Math.max(0, Math.min(m.maxHealth, m.health));
    // A drop flashes the whole strip. Rising health does not — healing is good
    // news and good news does not get an alarm.
    if (hp < this.lastHealth - 1e-3) this.hurt = 1;
    this.lastHealth = hp;
    this.hurt = dampHL(this.hurt, 0, 0.10, dt);

    this.filled = Math.floor(hp + 1e-4);
    this.partial = clamp01(hp - this.filled);
    // "One hit from dead" is the state that has to be unmissable, and it is a
    // fraction of the ceiling rather than an absolute so it survives a
    // max-health pickup.
    this.low = m.maxHealth > 0 && hp / m.maxHealth <= 0.34;

    const blink = this.low ? Math.floor(time * 6) & 1 : 0;
    this.sig(`${this.pips}|${this.filled}|${Math.round(this.partial * 8)}|${Math.round(this.hurt * 20)}|${blink}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const blink = this.low ? (Math.floor(this.phase * 6) & 1) === 0 : false;
    for (let i = 0; i < this.filled; i++) {
      const r = this.pipRect(i, w);
      const col = this.low ? (blink ? P.red : P.goldHot) : P.red;
      bar(ctx, r.x, r.y, r.pw, r.ph, col, P.ink, 2.2);
    }
    if (this.partial > 0.02 && this.filled < this.pips) {
      const r = this.pipRect(this.filled, w);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x - 2, r.y - 4, r.pw * this.partial + SHEAR * r.ph, r.ph + 8);
      ctx.clip();
      bar(ctx, r.x, r.y, r.pw, r.ph, cssA(HUD_PALETTE.red, 0.55), null, 0);
      ctx.restore();
    }

    // The damage flash is a frame around the whole strip, not a colour swap on
    // the pip that went: the pip that went is the one that is no longer there.
    if (this.hurt > 0.02) {
      ctx.save();
      ctx.globalAlpha = clamp01(this.hurt);
      slabPath(ctx, -4, -4, w - 14, 98, 0b0101, 16, SHEAR);
      ctx.strokeStyle = P.paper;
      ctx.lineWidth = 3.6;
      ctx.stroke();
      ctx.restore();
    }

    if (this.low) {
      drawText(ctx, 'CRITICAL', w - 34, 30, {
        size: 15, weight: 0.19, fill: blink ? P.paper : P.red, ink: P.ink,
        tracking: 0.26, align: 'right', skew: SHEAR,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Combo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The combo block: the count, the window draining around it, the style grade
 * and the running style score.
 *
 * The draining window is the point of the whole widget. A combo counter without
 * one tells you what you have; with one it tells you how long you have to keep
 * it, which is the decision the player is actually making at 74 m/s. It is a
 * RING rather than a bar because it surrounds the grade letter — the two are
 * one object, and the letter is what the ring is protecting.
 *
 * The ring is a twelve-sided polygon, not a circle. There is not a single true
 * curve anywhere else in this HUD, right down to the O of the typeface being an
 * octagon, and one smooth arc in the middle of it reads as a different program.
 */
const RING_SIDES = 12;
const RING_R = 46;
const RING_CX = 78;
const RING_CY = 104;

export class ComboWidget extends Widget {
  private combo = 0;
  private window = 0;
  private grade = '';
  private score = 0;
  private punch = 0;
  private lastCombo = 0;
  private phase = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterX = 150;
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    slab(ctx, 0, 0, w - 24, 200, {
      fill: P.panelDeep, ink: P.ink, inkWidth: INK_W, cuts: 0b0110, cut: 20,
      accent: P.violet, accentHeight: 5,
    });
    drawText(ctx, 'COMBO', w - 44, 44, {
      size: 15, weight: 0.18, fill: P.violet, ink: P.ink, tracking: 0.28, align: 'right', skew: SHEAR,
    });
    // The ring's unlit track, so the drained part of the window is still a
    // shape rather than an absence.
    this.ringPath(ctx, 1);
    ctx.strokeStyle = cssA(HUD_PALETTE.paperDim, 0.28);
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  /** `frac` of the polygon, starting at the top and running clockwise. */
  private ringPath(ctx: CanvasRenderingContext2D, frac: number): void {
    const n = Math.max(1, Math.ceil(RING_SIDES * clamp01(frac)));
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const t = Math.min(i / RING_SIDES, clamp01(frac));
      const a = -Math.PI * 0.5 + t * Math.PI * 2;
      const x = RING_CX + Math.cos(a) * RING_R;
      const y = RING_CY + Math.sin(a) * RING_R;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.phase = time;
    if (m.combo > this.lastCombo) this.punch = 1;
    this.lastCombo = m.combo;
    this.punch = dampHL(this.punch, 0, 0.10, dt);

    this.combo = m.combo;
    this.window = clamp01(m.comboWindow);
    this.grade = m.styleGrade ? m.styleGrade.toUpperCase() : '';
    this.score = Math.max(0, m.styleScore);

    this.present(stageLive(m.phase) && (this.combo > 0 || this.score > 0), dt, 0.06);

    // The ring is quantised to a quarter of a side: below that the polygon does
    // not change and a redraw would be pure cost.
    const ring = Math.round(this.window * RING_SIDES * 4);
    const urgent = this.window < 0.25 ? Math.floor(time * 10) & 1 : 0;
    this.sig(`${this.combo}|${ring}|${this.grade}|${Math.round(this.score)}|${Math.round(this.punch * 30)}|${urgent}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // ── The window ring ──────────────────────────────────────────────────────
    // Colour is the URGENCY, and it steps rather than ramping: a continuous
    // hue slide is unreadable in peripheral vision, and the only thing the
    // player needs from this is "still fine" / "about to go".
    const urgent = this.window < 0.25;
    const blink = urgent ? (Math.floor(this.phase * 10) & 1) === 0 : false;
    if (this.combo > 0 && this.window > 0) {
      this.ringPath(ctx, this.window);
      ctx.strokeStyle = urgent ? (blink ? P.paper : P.red) : this.window < 0.5 ? P.gold : P.violet;
      ctx.lineWidth = 6;
      ctx.lineJoin = 'miter';
      ctx.stroke();
    }

    // The grade letter, inside the ring. It is the biggest single glyph in the
    // block because it is the only part of the readout that means anything on
    // its own — a bare combo number is a count, a grade is a verdict.
    if (this.grade) {
      drawText(ctx, this.grade, RING_CX, RING_CY + 22, {
        size: 58, weight: 0.19, fill: P.goldHot, ink: P.ink, inkWidth: 0.06,
        align: 'center', tracking: 0, skew: SHEAR,
      });
    }

    // The count. Punches on a change, about its own baseline — scaling the
    // whole block would drag the label into the panel edge at full punch.
    if (this.combo > 0) {
      const k = 1 + ease.outQuart(clamp01(this.punch)) * 0.14;
      const numRight = w - 74;
      ctx.save();
      ctx.translate(numRight, 124);
      ctx.scale(k, k);
      drawText(ctx, String(this.combo), 0, 0, {
        size: 62, weight: 0.17, fill: urgent && blink ? P.red : P.paper, ink: P.ink,
        inkWidth: 0.055, tracking: 0.03, align: 'right', tabular: true, skew: SHEAR,
      });
      ctx.restore();
      drawText(ctx, 'X', w - 42, 124, {
        size: 34, weight: 0.19, fill: P.violet, ink: P.ink, tracking: 0, align: 'right', skew: SHEAR,
      });
    }

    // The running style score, on the bottom rule of the panel.
    if (this.score > 0) {
      drawText(ctx, 'STYLE', 34, 176, {
        size: 14, weight: 0.18, fill: P.gold, ink: P.ink, tracking: 0.24, skew: SHEAR,
      });
      drawText(ctx, String(Math.round(this.score)), w - 44, 178, {
        size: 28, weight: 0.17, fill: P.goldHot, ink: P.ink, tracking: 0.04,
        align: 'right', tabular: true, skew: SHEAR,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fragments and shards, each as `have / total`.
 *
 * Two rows, one mark each, and the mark is the only thing distinguishing them
 * — a diamond for the fragments strewn along the route, a wedge for the shards
 * hidden off it. Colour backs the mark up but does not carry it alone, which is
 * the same rule the traversal prompt follows and the rule bug #10 was a
 * violation of: one fact, one source, and never a colour standing in for an
 * identity on its own.
 */
const COLLECT_ROW_H = 44;

export class CollectionWidget extends Widget {
  private frag = 0;
  private fragTotal = 0;
  private shard = 0;
  private shardTotal = 0;
  private pickup = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterX = 120;
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    slab(ctx, 0, 0, w - 22, 2 * COLLECT_ROW_H + 20, {
      fill: P.panel, ink: P.ink, inkWidth: 2.6, cuts: 0b0101, cut: 14,
    });
  }

  private row(
    ctx: CanvasRenderingContext2D,
    w: number,
    i: number,
    have: number,
    total: number,
    col: string,
    diamond: boolean,
  ): void {
    const y = 14 + i * COLLECT_ROW_H;
    const cy = y + COLLECT_ROW_H * 0.5 - 4;
    const done = total > 0 && have >= total;

    if (diamond) {
      // A diamond: two triangles, so the mark is built from the same primitive
      // as everything else on the profile panel.
      tri(ctx, 34, cy - 4, 11, -Math.PI / 2, col, P.ink, 2.0);
      tri(ctx, 34, cy + 4, 11, Math.PI / 2, col, P.ink, 2.0);
    } else {
      tri(ctx, 34, cy, 13, -Math.PI / 2, col, P.ink, 2.0);
    }

    const st: TextStyle = {
      size: 24, weight: 0.17, fill: done ? P.goldHot : P.paper, ink: P.ink,
      tracking: 0.04, align: 'right', tabular: true, skew: 0,
    };
    const totalTxt = `/ ${total}`;
    const tw = measureText(totalTxt, { ...st, size: 16 });
    drawText(ctx, totalTxt, w - 30, cy + 9, {
      size: 16, weight: 0.16, fill: P.paperDim, ink: P.ink,
      tracking: 0.06, align: 'right', tabular: true, skew: 0,
    });
    drawText(ctx, String(have), w - 38 - tw, cy + 9, st);
  }

  override update(m: HudModel, dt: number, time: number): void {
    this.present(stageLive(m.phase), dt, 0.08);
    if (m.fragments !== this.frag || m.shards !== this.shard) this.pickup = 1;
    this.pickup = dampHL(this.pickup, 0, 0.12, dt);

    this.frag = m.fragments;
    this.fragTotal = m.fragmentsTotal;
    this.shard = m.shards;
    this.shardTotal = m.shardsTotal;

    this.sig(`${this.frag}/${this.fragTotal}|${this.shard}/${this.shardTotal}|${Math.round(this.pickup * 20)}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.row(ctx, w, 0, this.frag, this.fragTotal, P.gold, true);
    this.row(ctx, w, 1, this.shard, this.shardTotal, P.teal, false);

    if (this.pickup > 0.02) {
      ctx.save();
      ctx.globalAlpha = clamp01(this.pickup);
      slabPath(ctx, -3, -3, w - 16, 2 * COLLECT_ROW_H + 26, 0b0101, 14, SHEAR);
      ctx.strokeStyle = P.goldHot;
      ctx.lineWidth = 3.0;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boss
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The boss bar. Off screen entirely until `HudModel.boss` is non-null, which is
 * the only widget in the HUD whose presence is driven by a nullable field
 * rather than by a phase.
 *
 * ── THE BAR IS SEGMENTED BY PHASE, NOT BY A ROUND NUMBER ─────────────────────
 * `phases` divisions across one continuous fill, so the player can see how much
 * of the fight is left in units of "the thing it does next" rather than in
 * percent. The separators are drawn OVER the fill rather than the fill being
 * drawn per-segment: a segment boundary that eats two pixels of health at every
 * crossing is a bar that lies about the last hit of every phase.
 *
 * ── THE TELEGRAPH ───────────────────────────────────────────────────────────
 * `telegraph` is 0..1 of a wind-up. It is drawn as a red front sweeping the bar
 * from both ends toward the middle, plus a hazard flash on the frame — a wipe
 * that CLOSES is read as time running out, where a bar that fills is read as
 * something being earned. It reaches the middle exactly as the attack lands.
 */
const BOSS_BAR_H = 34;

function bossPhaseTag(p: BossPhase): string {
  switch (p) {
    case BossPhase.Intro: return 'ENGAGING';
    case BossPhase.Phase1: return 'PHASE 1';
    case BossPhase.Transition: return 'SHIFTING';
    case BossPhase.Phase2: return 'PHASE 2';
    case BossPhase.Enraged: return 'ENRAGED';
    case BossPhase.Defeated: return 'DOWN';
    case BossPhase.Outro: return 'DOWN';
    default: return '';
  }
}

export class BossWidget extends Widget {
  private has = false;
  private name = '';
  private tag = '';
  private health = 0;
  private fillFrac = 0;
  private phases = 1;
  private telegraph = 0;
  private enraged = false;
  private phase = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = -70;
  }

  private barRect(w: number): { x: number; y: number; bw: number } {
    return { x: 40, y: 74, bw: w - 120 };
  }

  override furniture(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    slab(ctx, 0, 0, w - 26, 126, {
      fill: P.panelDeep, ink: P.ink, inkWidth: INK_W, cuts: 0b0101, cut: 22,
      accent: P.red, accentHeight: 5,
    });
    const r = this.barRect(w);
    bar(ctx, r.x, r.y, r.bw, BOSS_BAR_H, cssA(HUD_PALETTE.ink, 0.7), cssA(HUD_PALETTE.paperDim, 0.4), 2.0);
  }

  override update(m: HudModel, dt: number, time: number): void {
    const b = m.boss;
    this.phase = time;
    this.has = b !== null && stageLive(m.phase);
    if (b) {
      this.name = b.name.toUpperCase();
      this.tag = bossPhaseTag(b.phase);
      this.enraged = b.phase === BossPhase.Enraged;
      // `phases` is the segment count; one is the degenerate but legal case.
      const next = Math.max(1, Math.round(b.phases));
      if (next !== this.phases) {
        this.phases = next;
        this.layer.markFurniture();
        this.invalidate();
      }
      this.health = clamp01(b.health);
      this.telegraph = clamp01(b.telegraph);
    } else {
      this.telegraph = 0;
    }

    // The fill chases the true value rather than snapping to it, so a burst of
    // damage reads as a lunge instead of a teleport. It is the only damped
    // number in the widget: the telegraph must never lag.
    this.fillFrac = dampHL(this.fillFrac, this.health, 0.08, dt);
    if (Math.abs(this.fillFrac - this.health) < 0.002) this.fillFrac = this.health;

    this.present(this.has, dt, 0.10);

    const tel = this.telegraph > 0 ? Math.round(this.telegraph * 40) : 0;
    const flash = this.telegraph > 0 || this.enraged ? Math.floor(time * 12) & 1 : 0;
    this.sig(`${this.has ? 1 : 0}|${this.name}|${this.tag}|${Math.round(this.fillFrac * 400)}|${tel}|${flash}`);
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.has) return;
    const r = this.barRect(w);
    const flash = (Math.floor(this.phase * 12) & 1) === 0;

    drawText(ctx, this.name, 40, 46, {
      size: 26, weight: 0.18, fill: this.enraged && flash ? P.red : P.paper, ink: P.ink,
      tracking: 0.14, skew: SHEAR,
    });
    if (this.tag) {
      drawText(ctx, this.tag, w - 66, 44, {
        size: 15, weight: 0.19, fill: this.enraged ? P.red : P.gold, ink: P.ink,
        tracking: 0.28, align: 'right', skew: SHEAR,
      });
    }

    // The fill, then the phase separators over it.
    const fw = r.bw * this.fillFrac;
    if (fw > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x - 2, r.y - 4, fw + SHEAR * BOSS_BAR_H, BOSS_BAR_H + 8);
      ctx.clip();
      bar(ctx, r.x, r.y, r.bw, BOSS_BAR_H, this.enraged ? P.red : P.violet, null, 0);
      ctx.restore();
    }
    for (let i = 1; i < this.phases; i++) {
      const x = r.x + (r.bw * i) / this.phases;
      tick(ctx, x + SHEAR * BOSS_BAR_H, r.y, x, r.y + BOSS_BAR_H, 2.4, P.ink);
    }
    bar(ctx, r.x, r.y, r.bw, BOSS_BAR_H, null, P.paperDim, 2.0);

    // The telegraph: two fronts closing on the middle.
    if (this.telegraph > 0.001) {
      const t = this.telegraph;
      const half = r.bw * 0.5 * t;
      ctx.save();
      ctx.globalAlpha = flash ? 0.9 : 0.55;
      bar(ctx, r.x, r.y, half, BOSS_BAR_H, cssA(HUD_PALETTE.red, 0.8), null, 0);
      bar(ctx, r.x + r.bw - half, r.y, half, BOSS_BAR_H, cssA(HUD_PALETTE.red, 0.8), null, 0);
      ctx.restore();

      ctx.save();
      slabPath(ctx, -4, -4, w - 18, 134, 0b0101, 22, SHEAR);
      ctx.strokeStyle = flash ? P.goldHot : P.red;
      ctx.lineWidth = 3.6;
      ctx.stroke();
      ctx.restore();

      if (t > 0.35) {
        drawText(ctx, 'INCOMING', w * 0.5, 46, {
          size: 18, weight: 0.19, fill: flash ? P.paper : P.red, ink: P.ink,
          tracking: 0.3, align: 'center', skew: SHEAR,
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transmission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A line of dialogue, typed out.
 *
 * Typed rather than dropped in whole because a line that appears complete is a
 * line the player's eye has already left before it registers as new, and this
 * is the one element in the HUD that has to be noticed without being urgent.
 * It sits bottom-left, the quietest corner of the frame, and it never blinks:
 * everything else that moves in this HUD is telling the player to do something
 * and this one is not.
 *
 * The revealed substring is cached and rebuilt ONLY when the character count
 * changes — about 24 allocations a second while a line is running and none at
 * all when it is not. `draw()` never calls `substring`.
 */
const TYPE_RATE = 34; // characters per second
/** How long a completed line stays up after the last character lands. */
const TYPE_HOLD = 2.6;

export class TransmissionWidget extends Widget {
  private full = '';
  private shown = '';
  private chars = 0;
  private lastChars = -1;
  private t = 0;
  private done = 0;
  private live = false;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = 60;
  }

  override furniture(): void {
    // The plate is drawn with the line: it is sized to the type, and the type
    // grows a character at a time.
  }

  override update(m: HudModel, dt: number, time: number): void {
    const line = m.transmission;
    if (line !== null && line !== this.full) {
      this.full = line.toUpperCase();
      this.t = 0;
      this.chars = 0;
      this.done = 0;
      this.live = true;
    } else if (line === null && this.live && this.done <= 0 && this.chars >= this.full.length) {
      // The model dropped the line after it finished typing — start the hold.
      this.done = TYPE_HOLD;
    }

    if (this.live) {
      this.t += dt;
      this.chars = Math.min(this.full.length, Math.floor(this.t * TYPE_RATE));
      if (this.chars >= this.full.length) {
        this.done = this.done > 0 ? this.done - dt : TYPE_HOLD;
        if (this.done <= 0) this.live = false;
      }
    }

    if (this.chars !== this.lastChars) {
      this.lastChars = this.chars;
      this.shown = this.full.substring(0, this.chars);
    }

    const on = this.live && stageLive(m.phase) && this.full.length > 0;
    this.present(on, dt, 0.07);
    // The caret blinks at 4 Hz while typing and is gone once the line is whole.
    const caret = this.chars < this.full.length ? Math.floor(time * 4) & 1 : 2;
    this.sig(on ? `${this.chars}|${caret}|${this.full.length}` : 'off');
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.live || this.full.length === 0) return;
    const st: TextStyle = {
      size: 22, weight: 0.16, fill: P.paper, ink: P.ink, tracking: 0.10, skew: 0,
    };
    const ph = 76;
    const py = h - ph - 10;
    const pw = w - 30;

    slab(ctx, 0, py, pw, ph, {
      fill: P.panelDeep, ink: P.teal, inkWidth: 2.6, cuts: 0b0101, cut: 16,
      accent: P.teal, accentHeight: 4,
    });
    drawText(ctx, 'TRANSMISSION', 30, py + 26, {
      size: 13, weight: 0.18, fill: P.teal, ink: P.ink, tracking: 0.3, skew: SHEAR,
    });

    // The line is clipped to the plate rather than allowed to run off it. A
    // longer line degrades by being cut off instead of by printing on the
    // frame — the same call the descent profile's objective makes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(24, py + 32, pw - 48, 40);
    ctx.clip();
    const tw = drawText(ctx, this.shown, 30, py + 60, st);
    if (this.chars < this.full.length && (Math.floor(this.t * 4) & 1) === 0) {
      tick(ctx, 30 + tw + 6, py + 60, 30 + tw + 6, py + 60 - st.size, 3, P.teal);
    }
    ctx.restore();
  }

  clear(): void {
    this.full = '';
    this.shown = '';
    this.chars = 0;
    this.lastChars = -1;
    this.live = false;
    this.done = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage banner — CLEARED / TIME UP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one-word verdict, held for a beat before the results screen arrives.
 *
 * It exists because `Cleared` and `Failed` are real phases with a run-out
 * behind them, and dropping straight from gameplay to a menu throws away the
 * only moment in the stage where the player is allowed to look at the screen
 * rather than through it.
 */
export class VerdictWidget extends Widget {
  private text = '';
  private good = true;
  private age = 0;

  constructor(layer: HudLayer) {
    super(layer);
    this.enterY = -40;
  }

  override furniture(): void {
    // Sized to the word, and the word changes.
  }

  override update(m: HudModel, dt: number, time: number): void {
    let want = '';
    if (m.phase === StagePhase.Cleared) want = 'STAGE CLEAR';
    else if (m.phase === StagePhase.Failed) want = 'TIME UP';
    if (want !== this.text) {
      this.text = want;
      this.age = 0;
      this.good = want === 'STAGE CLEAR';
    }
    this.age += dt;
    this.present(this.text.length > 0, dt, 0.05);
    this.sig(this.text ? `${this.text}|${Math.round(Math.min(this.age, 1.2) * 40)}` : 'off');
  }

  override draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.text) return;
    const k = ease.snap(clamp01(this.age / 0.3));
    const col = this.good ? P.goldHot : P.red;
    const bh = 120;
    const by = (h - bh) * 0.5;

    ctx.save();
    ctx.globalAlpha = clamp01(k);
    const bw = (w - 120) * k;
    bar(ctx, (w - bw) * 0.5 - SHEAR * bh * 0.5, by, bw, bh, cssA(HUD_PALETTE.ink, 0.9), col, 4.0);
    if (k > 0.5) {
      drawText(ctx, this.text, w * 0.5, by + 82, {
        size: 66, weight: 0.19, fill: col, ink: P.ink, inkWidth: 0.06,
        tracking: 0.18, align: 'center', skew: SHEAR,
      });
    }
    ctx.restore();
  }
}
