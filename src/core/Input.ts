/**
 * Input — one place that owns "what is the player asking for this frame".
 *
 * Supports three sources that all resolve into the same `Intent`:
 *   1. keyboard      (physical)
 *   2. gamepad       (physical, analog)
 *   3. virtual       (a Set of action names pushed in by the capture harness)
 *
 * When a virtual set is installed the physical sources are ignored entirely, so a
 * recorded input timeline replays frame-for-frame identically every run.
 */

export type Action =
  | 'left' | 'right' | 'fwd' | 'back'
  | 'jump' | 'dash' | 'attack' | 'boost' | 'pound' | 'special'
  | 'camLeft' | 'camRight' | 'start' | 'restart' | 'debug';

const KEYMAP: Record<string, Action> = {
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  Space: 'jump',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyJ: 'attack', KeyK: 'attack', Enter: 'start',
  KeyL: 'boost', KeyE: 'boost',
  KeyC: 'pound', ControlLeft: 'pound',
  KeyF: 'special', KeyQ: 'camLeft',
  KeyR: 'restart',
  Backquote: 'debug',
};

export interface Intent {
  /** Stick / WASD direction in camera space, magnitude 0..1. */
  moveX: number;
  moveY: number;
  moveMag: number;
  /** True while the analog stick / keys are pushed past the walk threshold. */
  moving: boolean;
}

export class Input {
  readonly intent: Intent = { moveX: 0, moveY: 0, moveMag: 0, moving: false };

  private down = new Set<Action>();
  private prev = new Set<Action>();
  private pressedAt = new Map<Action, number>();
  private releasedAt = new Map<Action, number>();
  private virtual: Set<Action> | null = null;
  private virtualAxis: { x: number; y: number } | null = null;
  private time = 0;
  private padIndex = -1;
  /** Set by the harness so gamepad polling can be skipped deterministically. */
  deterministic = false;

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', this.onKey as EventListener);
    target.addEventListener('keyup', this.onKey as EventListener);
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = -1; });
  }

  private onKey = (e: KeyboardEvent) => {
    const a = KEYMAP[e.code];
    // Space / arrows must not scroll the page.
    if (a) e.preventDefault();
    if (!a || this.virtual) return;
    if (e.type === 'keydown') { if (!e.repeat) this.down.add(a); }
    else this.down.delete(a);
  };

  /** Harness entry point. Pass null to hand control back to the keyboard. */
  setVirtual(actions: Action[] | null, axis?: { x: number; y: number }) {
    if (actions === null) { this.virtual = null; this.virtualAxis = null; return; }
    this.virtual = new Set(actions);
    this.virtualAxis = axis ?? null;
    this.deterministic = true;
  }

  /** Call once per frame BEFORE any consumer reads state. */
  update(dt: number) {
    this.time += dt;

    this.prev.clear();
    for (const a of this.down) this.prev.add(a);

    let src = this.down;
    if (this.virtual) {
      // Rebuild `down` from the virtual set so edge detection still works.
      this.down = new Set(this.virtual);
      src = this.down;
    }

    // edge bookkeeping
    for (const a of src) if (!this.prev.has(a)) this.pressedAt.set(a, this.time);
    for (const a of this.prev) if (!src.has(a)) this.releasedAt.set(a, this.time);

    let ax = 0, ay = 0;
    if (this.virtualAxis) { ax = this.virtualAxis.x; ay = this.virtualAxis.y; }
    else {
      if (src.has('left')) ax -= 1;
      if (src.has('right')) ax += 1;
      if (src.has('fwd')) ay += 1;
      if (src.has('back')) ay -= 1;
      if (!this.virtual && !this.deterministic && this.padIndex >= 0) {
        const pad = navigator.getGamepads?.()[this.padIndex];
        if (pad) {
          const dx = dz(pad.axes[0] ?? 0), dy = dz(-(pad.axes[1] ?? 0));
          if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) { ax = dx; ay = dy; }
          this.padButton(pad, 0, 'jump'); this.padButton(pad, 2, 'attack');
          this.padButton(pad, 1, 'dash'); this.padButton(pad, 3, 'special');
          this.padButton(pad, 5, 'boost'); this.padButton(pad, 7, 'boost');
          this.padButton(pad, 6, 'pound'); this.padButton(pad, 9, 'start');
        }
      }
    }

    const m = Math.hypot(ax, ay);
    if (m > 1) { ax /= m; ay /= m; }
    const it = this.intent;
    it.moveX = ax; it.moveY = ay;
    it.moveMag = Math.min(1, m);
    it.moving = it.moveMag > 0.16;
  }

  private padButton(pad: Gamepad, i: number, a: Action) {
    if (pad.buttons[i]?.pressed) this.down.add(a); else this.down.delete(a);
  }

  held(a: Action) { return this.down.has(a); }
  pressed(a: Action) { return this.down.has(a) && !this.prev.has(a); }
  released(a: Action) { return !this.down.has(a) && this.prev.has(a); }

  /**
   * True if the action was pressed within `window` seconds and hasn't been consumed.
   * This is what makes jumps feel forgiving at 60fps.
   */
  buffered(a: Action, window = 0.13) {
    const t = this.pressedAt.get(a);
    return t !== undefined && this.time - t <= window;
  }
  consume(a: Action) { this.pressedAt.delete(a); }
  anyPressed() { for (const a of this.down) if (!this.prev.has(a)) return true; return false; }
  clear() { this.down.clear(); this.prev.clear(); this.pressedAt.clear(); }
}

const dz = (v: number) => {
  const a = Math.abs(v);
  if (a < 0.22) return 0;
  return Math.sign(v) * ((a - 0.22) / 0.78) ** 1.4;
};
