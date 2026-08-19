/**
 * Hud — implements IHud. Layout, state, animation, and the overlay pass.
 *
 * ── HOW IT RENDERS ──────────────────────────────────────────────────────────
 * The HUD is a flat group of screen-space quads with a vertex program that
 * ignores the camera entirely, so it can be rendered by itself, last, straight
 * to the default framebuffer:
 *
 *     post.render(scene, camera, dt, time);
 *     hud.render(renderer);
 *
 * It is deliberately NOT added to the main scene. If it were, it would go
 * through the bloom threshold and the LUT grade, and a HUD that gets graded is a
 * HUD whose colours are no longer the colours you authored — the gold would
 * bloom, the ink would lift toward violet, and the whole thing would stop
 * reading as ink on top of the picture. `object` is still exposed because the
 * contract requires it, and it will render correctly if it is parented into a
 * scene, but the intended wiring is the explicit `render()` call.
 *
 * ── WHAT IT COSTS ───────────────────────────────────────────────────────────
 * Nothing is redrawn unless its content changed. In a steady running frame that
 * is the clock (0.10 Mpx), the speed block (0.40 Mpx at ui=1) and, when the
 * marker has moved half a pixel, the route profile (0.19 Mpx). Everything else
 * — the health pips, the boost meter, the collection counts, the menus — is a
 * cached texture and a single draw call. Live figures are on `hud.stats`.
 */

import {
  Group,
  Object3D,
  OrthographicCamera,
  WebGLRenderer,
} from 'three';
import type { HudModel, IHud } from '../game/Contracts';
import { StagePhase } from '../game/Contracts';
import { HUD_PALETTE } from '../npr/Palette';
import { clamp01, dampHL } from '../core/MathX';
import { DESIGN_H, HudCanvasRoot, HudLayer, type LayerPlacement } from './HudCanvas';
import { buildTypeface } from './Typeface';
import {
  BoostWidget,
  ClockWidget,
  PopupWidget,
  PromptWidget,
  RouteProfileWidget,
  SpeedWidget,
  WarningWidget,
  Widget,
} from './Widgets';
import {
  BossWidget,
  CollectionWidget,
  ComboWidget,
  HealthWidget,
  TransmissionWidget,
  VerdictWidget,
} from './StageWidgets';
import { CountdownWidget, MenuScreen, type MenuKind, type ReplayFrameRect } from './Menus';

function place(
  anchor: LayerPlacement['anchor'],
  dx: number,
  dy: number,
  w: number,
  h: number,
): LayerPlacement {
  return { anchor, dx, dy, w, h };
}

export interface HudOptions {
  /** Start with the stage furniture hidden (the game boots into the title). */
  initialPhase?: StagePhase;
}

export class Hud implements IHud {
  readonly object: Object3D;

  private root: HudCanvasRoot;
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private byLayer = new Map<HudLayer, Widget>();
  private widgets: Widget[] = [];

  readonly profile: RouteProfileWidget;
  readonly clock: ClockWidget;
  readonly health: HealthWidget;
  readonly collection: CollectionWidget;
  readonly combo: ComboWidget;
  readonly boss: BossWidget;
  readonly speed: SpeedWidget;
  readonly boost: BoostWidget;
  readonly prompt: PromptWidget;
  readonly popups: PopupWidget;
  readonly warning: WarningWidget;
  readonly transmission: TransmissionWidget;
  readonly verdict: VerdictWidget;
  readonly countdown: CountdownWidget;
  readonly menu: MenuScreen;

  /** Live cost of the HUD, refreshed every frame. */
  readonly stats = { redrawMs: 0, layersRedrawn: 0, megapixels: 0, drawCalls: 0 };

  private scrimTarget = 0;
  private disposed = false;

  constructor(width = 1920, height = 1080, _opts: HudOptions = {}) {
    buildTypeface();

    this.root = new HudCanvasRoot(HUD_PALETTE.shadow);
    this.object = this.root.group;

    // ── Layer table. Insertion order is z-order. ────────────────────────────
    //
    // ── WHAT THE PIVOT CHANGED HERE ─────────────────────────────────────────
    // Three panels went with the race: the standings board (top-right), the
    // placement block (bottom-left) and the corner call (top-centre). Their
    // frame real estate is what the stage readouts are built into, so the
    // composition is inherited rather than reinvented:
    //
    //   standings  →  collection + combo, the same right-hand stack
    //   placement  →  health, the same bottom-left block
    //   corner     →  the boss bar, the same top-centre band under the clock
    //
    // Everything that is not about racing — profile, clock, speedometer, boost,
    // popups, warning, countdown, menus — keeps the placement it was tuned to,
    // and the notes below are the measurements that settled those.

    // ── THE PROFILE PANEL'S SIZE IS A COMPOSITION DECISION ────────────────────
    // It was 880 x 210 at (30, 24) — 46% of the design width and the whole
    // top-left quadrant. In eight of sixteen review frames it sat on the
    // horizon, which is the one line in a downhill shot that has to stay
    // readable. HUD furniture frames a picture; it does not stand in front of
    // it.
    //
    // 572 x 184 at (24, 16). The panel's bottom edge lands at design y 200 and
    // the highest horizon in the review set is at y 300, so it is furniture in
    // the corner and nowhere near the line that has to stay readable. The
    // HEIGHT is 184 rather than 158 because the plot holds three things at once
    // — the ridge, the player's chevron riding on it, and the checkpoint
    // hairlines — and at 158 there was not room for all of them between the
    // title and the digits: the chevron's ink crossed the `7` at 94% and hung
    // eight units below the baseline rule at 98%.
    this.profile = this.mount(new RouteProfileWidget(
      new HudLayer('profile', place('top-left', 24, 16, 572, 184)),
    ));
    this.clock = this.mount(new ClockWidget(
      new HudLayer('clock', place('top', 0, 22, 470, 200)),
    ));

    // ── THE RIGHT-HAND STACK ─────────────────────────────────────────────────
    // Collection above combo, both flying in from the right, because that is the
    // order they are read in: the counts are the objective and the combo is the
    // commentary on how you are meeting it. Sized to their own contents —
    // CollectionWidget bakes two 44-unit rows plus 20 of padding, and
    // ComboWidget bakes a 200-unit slab — so neither layer is larger than the
    // ink inside it.
    this.collection = this.mount(new CollectionWidget(
      new HudLayer('collect', place('top-right', 26, 24, 360, 116)),
    ));
    this.combo = this.mount(new ComboWidget(
      new HudLayer('combo', place('top-right', 26, 156, 380, 210)),
    ));

    // The boss bar takes the band the corner call had: top-centre, under the
    // clock, which is the one place in the frame a full-width readout can go
    // without covering the route ahead. 136 rather than the 126 the widget bakes,
    // so the slab's sheared corners land inside the backing store.
    this.boss = this.mount(new BossWidget(
      new HudLayer('boss', place('top', 0, 236, 940, 136)),
    ));

    // Health takes the placement block's corner. The widget bakes a 90-unit
    // slab and lifts a 98-unit `CRITICAL` frame around it when the pips are low,
    // so the layer is 100 to hold that outer frame rather than clip it.
    this.health = this.mount(new HealthWidget(
      new HudLayer('health', place('bottom-left', 26, 22, 440, 100)),
    ));

    // Transmission sits above health and stops short of design x 626, which is
    // 14 units clear of the traversal prompt's left edge. Both are bottom-anchored
    // and a dialogue line running under the prompt is two panels of type in the
    // same 100 units of frame.
    this.transmission = this.mount(new TransmissionWidget(
      new HudLayer('transmission', place('bottom-left', 26, 138, 600, 96)),
    ));

    // 580 x 360. The dial band's polygon needs 1.089 * R of width and of height
    // around its centre; at 560 x 340 it did not have it, and the band was
    // delivered with its top and right razored off by the backing store. The
    // extra 20 x 20 is what makes the gauge a whole object.
    this.speed = this.mount(new SpeedWidget(
      new HudLayer('speed', place('bottom-right', 20, 16, 580, 360)),
    ));
    // 552 rather than 680. This is the one panel that was measurably wider than
    // its content needs: the meter is ten chunks and a label, and at 680 the
    // chunks were 57 × 42 landscape rectangles in a slab that spanned 35% of
    // the frame's width, dead centre, directly under the subject and over the
    // dust plume — the emptiest 3.2% of frame the HUD owns, since it reads as a
    // black rail until you have actually earned some boost. At 552 the chunks
    // are square, which is a better chunk, and the bottom band stops being a
    // continuous strip of furniture. Everything in the widget derives from the
    // layer width, so this is a one-number change.
    this.boost = this.mount(new BoostWidget(
      new HudLayer('boost', place('bottom', 0, 26, 552, 120)),
    ));

    // The traversal prompt sits directly above the boost meter, centred, because
    // it is a call to act NOW and the centre-bottom is the only part of the
    // frame a player at 74 m/s is already looking at. The widget draws a 74-unit
    // plate 12 from the bottom of its layer, so 100 of layer height puts the
    // plate's top edge at design y 830 — 16 clear of the boost meter's top.
    this.prompt = this.mount(new PromptWidget(
      new HudLayer('prompt', place('bottom', 0, 162, 640, 100)),
    ));

    // 620 x 600, grown UPWARD. The column stacks bars whose heights are derived
    // from their own type rather than guessed (see POPUP_METRICS in Widgets.ts),
    // and six simultaneous popups do not fit in 520 — the top two bars were
    // being drawn off the backing store.
    //
    // The extra height is taken off the TOP, not the bottom: `dy` moves with the
    // height so the layer's bottom edge stays on design y 720. That edge is
    // load-bearing. The speed block's dial starts at design y 704 — grow this
    // layer downward instead and a running popup is set on top of the
    // speedometer.
    this.popups = this.mount(new PopupWidget(
      new HudLayer('popups', place('right', 24, -120, 620, 600)),
    ));
    this.warning = this.mount(new WarningWidget(
      new HudLayer('warn', place('center', 0, -200, 1040, 200)),
    ));
    // The verdict's bar is centred in its own layer, so the layer's dy is what
    // positions it: 70 puts the bar's top edge at design y 550, which is 10
    // clear of the wrong-way warning's floor. The two are phase-exclusive —
    // `wrongWay` only reads during play and the verdict only on Cleared/Failed —
    // but a layout that only works because two things never happen at once is a
    // layout waiting for a third thing to happen.
    this.verdict = this.mount(new VerdictWidget(
      new HudLayer('verdict', place('center', 0, 70, 900, 260)),
    ));
    this.countdown = this.mount(new CountdownWidget(
      new HudLayer('countdown', place('center', 0, 0, 760, 560), { background: false }),
    ));
    // The menu canvas is the largest surface in the HUD, so its backing store is
    // capped: at ui = 2.4 an uncapped 1360×860 layer would be a 47 MB texture,
    // and menu type is big enough that 1.4× is indistinguishable.
    this.menu = this.mount(new MenuScreen(
      new HudLayer('menu', place('center', 0, 0, 1360, 860), { maxScale: 1.4 }),
    ));

    // ── THE POPUP COLUMN IS LAID OUT AGAINST THE PANEL ABOVE IT ──────────────
    //
    // The popup column and the right-hand stack are both right-anchored and they
    // overlap in x by almost the whole of the narrower one, so the only thing
    // keeping a six-deep pile off the combo block is arithmetic. It used to be
    // done once, by hand, in a comment. It was wrong, and it stayed wrong
    // through a pitch change that made it less wrong.
    //
    // Here it is derived, and it is derived against the COMBO block rather than
    // the collection block above it — the combo is the lower of the two, and a
    // ceiling measured against the higher one lets the column run straight
    // through the panel in between. `layerFloor` is where the stack's backing
    // store ends in design space and `layerTop` is where the popup layer's
    // begins; the difference, plus clear air, is the ceiling the column may not
    // cross.
    //
    // This is the worst case over aspect ratios rather than a design-space
    // guess: the stack is TOP-anchored and the column is CENTRE-anchored, so on
    // anything taller than 16:9 the column moves down and away, and on anything
    // wider `ui` is height-limited and the design-space figure is exact.
    const stack = this.combo.layer.placement;
    const col = this.popups.layer.placement;
    const stackFloor = stack.dy + stack.h;
    const colTop = DESIGN_H * 0.5 - col.h * 0.5 + col.dy;
    this.popups.setCeiling(stackFloor - colTop + 10);

    this.resize(width, height);
  }

  private mount<T extends Widget>(w: T): T {
    this.root.add(w.layer);
    this.byLayer.set(w.layer, w);
    this.widgets.push(w);
    return w;
  }

  // ── IHud ──────────────────────────────────────────────────────────────────

  resize(width: number, height: number): void {
    this.root.resize(width, height);
    // A resize reallocates backing stores, which invalidates the baked
    // furniture; layout() already flags that, but the widgets also need their
    // signatures cleared or a layer whose content did not change would be
    // uploaded blank.
    for (const w of this.widgets) w.layer.markFurniture();
  }

  update(model: HudModel, dt: number, time: number): void {
    if (this.disposed) return;

    for (const w of this.widgets) w.update(model, dt, time);

    // ── WHICH PHASES RAISE THE SCRIM ─────────────────────────────────────────
    //
    // The scrim only exists to hold a MENU off the picture behind it. It is a
    // flat fill, never a blur — a blurred pause background would be the only
    // out-of-focus pixel in the entire game.
    //
    // So the rule is not "which phases are not gameplay", it is "which phases
    // put a menu on screen", and the answer is exactly the set `MenuScreen`
    // mounts for: Title, Paused, Results. Deriving it from anything else lets
    // the two drift apart, and a scrim with no menu on it is a frame dimmed by
    // 68% for no reason a player can see.
    //
    //   Paused / Results  0.68 — a full table of type over a still picture.
    //                            The picture is context, the type is the
    //                            content, and 0.68 is what settled the
    //                            contrast on the results rows.
    //   Title             0.42 — softer, because the attract loop behind the
    //                            title IS the pitch. Hold it off the wordmark,
    //                            do not put it away.
    //   everything else      0 — including Intro. Intro is a character
    //                            introduction: it is a cinematic, the camera
    //                            is the content, and nothing is laid over it
    //                            to protect. Dimming it would be dimming the
    //                            thing the phase exists to show.
    //
    // Cleared and Failed also stay at 0 deliberately. `VerdictWidget` draws its
    // banner over a live run-out, and the run-out is the one moment in the
    // stage the player is allowed to look AT the screen rather than through it.
    const menuUp = model.phase === StagePhase.Paused || model.phase === StagePhase.Results;
    const titleUp = model.phase === StagePhase.Title;
    this.scrimTarget = menuUp ? 0.68 : titleUp ? 0.42 : 0;
    this.root.scrim.alpha = dampHL(this.root.scrim.alpha, this.scrimTarget, 0.09, dt);
    if (Math.abs(this.root.scrim.alpha - this.scrimTarget) < 0.003) this.root.scrim.alpha = this.scrimTarget;

    // Bake any furniture that a resize or a menu change invalidated, then redraw
    // only the layers whose signature moved.
    for (const w of this.widgets) {
      if (w.layer.furnitureDirty) {
        w.layer.drawFurniture((ctx, cw, ch) => w.furniture(ctx, cw, ch));
        w.layer.dirty = true;
      }
    }

    this.root.flush((layer, ctx) => {
      const w = this.byLayer.get(layer);
      if (w) w.draw(ctx, layer.w, layer.h);
    });

    this.stats.redrawMs = this.root.stats.redrawMs;
    this.stats.layersRedrawn = this.root.stats.layersRedrawn;
    this.stats.megapixels = this.root.stats.megapixels;
    let calls = this.root.scrim.mesh.visible ? 1 : 0;
    for (const l of this.root.layers) if (l.mesh.visible) calls++;
    this.stats.drawCalls = calls;
  }

  /**
   * Draw the overlay. Call once per frame, AFTER the post pipeline has written
   * the final image to the default framebuffer.
   */
  render(renderer: WebGLRenderer): void {
    if (this.disposed) return;
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(this.object, this.camera);
    renderer.autoClear = prevAuto;
    if (prev) renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.disposed = true;
    this.root.dispose();
    this.byLayer.clear();
    this.widgets.length = 0;
  }

  // ── Menu control ──────────────────────────────────────────────────────────
  //
  // The HUD does not read input — it has no idea what a key is. The game drives
  // the cursor through these and reads `menuSelection` back when it wants to
  // act on a confirm.

  get menuKind(): MenuKind {
    return this.menu.kind;
  }

  get menuItems(): string[] {
    return this.menu.items;
  }

  get menuSelection(): number {
    return this.menu.selection;
  }

  setMenuItems(items: string[]): void {
    this.menu.setItems(items);
  }

  setMenuSelection(i: number): void {
    this.menu.setSelection(i);
  }

  moveMenuSelection(delta: number): void {
    this.menu.moveSelection(delta);
  }

  /**
   * The results screen's replay window, in 0..1 screen UV. Hand this to the
   * camera director so the biggest-air replay is framed inside the hole the HUD
   * cut for it rather than behind the results table.
   */
  get replayFrame(): ReplayFrameRect {
    return this.menu.replayFrame;
  }

  /**
   * Wipe every scrap of state that outlives a frame. Call on restart, and on
   * every capture pose.
   *
   * ── WHY THIS IS A LIST AND NOT A LOOP ────────────────────────────────────
   * `--poses` shoots all 16 stills in ONE page, so anything a widget latches
   * leaks forward into the next review frame. RESUME.md item 3 is that bug
   * exactly: a motion smear pinned at 0.821 by the `crash` pose dissolved the
   * rider in `rider-closeup`, a pose that asks for 0.0, and three critic passes
   * reviewed the artefact instead of the game. The fix there was
   * `applySituation` calling `effects.reset()`; this is the same call for the
   * HUD, and it has to be maintained by hand because "stateful" is not
   * something the `Widget` base class can see.
   *
   * The three that carry state across a run:
   *
   *   ClockWidget         holds `seen`, the set of splits it has already
   *                       announced, plus the live split banner and its age.
   *                       Left alone, pose 2 opens with pose 1's split card.
   *   PopupWidget         a pool of live bars with ~1.9 s of life each. A pose
   *                       that crosses three checkpoints hands its stack to
   *                       the next three poses.
   *   TransmissionWidget  a typed-out line with a reveal cursor and a hold
   *                       timer. It is the newest of the three and the easiest
   *                       to forget — it only shows up in a capture when a
   *                       pose happens to fire a line, which is the definition
   *                       of an intermittent defect.
   *
   * Everything else on the HUD is a pure function of the model it is handed:
   * the verdict reads `phase`, the health pips read `health`, the profile
   * marker snaps on a jump of more than 0.01 of the course. Those need nothing
   * here, and adding them would be a list that lies about what it is for.
   */
  resetRun(): void {
    this.clock.reset();
    this.popups.clear();
    this.transmission.clear();
  }
}
