import { clamp } from './MathX';

export type Action =
  | 'jump' | 'dash' | 'attack' | 'boost' | 'slide' | 'start' | 'back'
  | 'camLeft' | 'camRight' | 'restart';

const ACTIONS: Action[] = ['jump', 'dash', 'attack', 'boost', 'slide', 'start', 'back', 'camLeft', 'camRight', 'restart'];

const KEY_MAP: Record<string, Action[]> = {
  Space: ['jump'],
  KeyZ: ['jump'],
  ShiftLeft: ['dash'],
  ShiftRight: ['dash'],
  KeyX: ['dash'],
  KeyC: ['attack'],
  KeyJ: ['attack'],
  KeyV: ['boost'],
  KeyK: ['boost'],
  ControlLeft: ['slide'],
  KeyS_slide: ['slide'],
  KeyL: ['slide'],
  Enter: ['start'],
  NumpadEnter: ['start'],
  Escape: ['back'],
  KeyQ: ['camLeft'],
  KeyE: ['camRight'],
  KeyR: ['restart'],
};

/**
 * Input hub. Three sources feed the same state: keyboard, gamepad, and a scripted
 * channel used by the screenshot harness so deterministic input sequences can be
 * replayed frame for frame after a fix.
 */
export class Input {
  moveX = 0;
  moveY = 0;
  private down = new Set<Action>();
  private pressedThisFrame = new Set<Action>();
  private releasedThisFrame = new Set<Action>();
  private keys = new Set<string>();
  private scripted: { down: Set<Action>; moveX: number; moveY: number } | null = null;
  private padIndex = -1;
  anyInputSeen = false;
  pointerLocked = false;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => { this.keys.clear(); this.down.clear(); });
    window.addEventListener('gamepadconnected', (e: any) => { this.padIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = -1; });
    target.addEventListener('pointerdown', () => { this.anyInputSeen = true; this.pressScripted('start'); });
    // Harness hook: window.__input.set({ moveY: 1, jump: true })
    (window as any).__input = {
      set: (o: any) => {
        if (!this.scripted) this.scripted = { down: new Set(), moveX: 0, moveY: 0 };
        if (o.moveX !== undefined) this.scripted.moveX = o.moveX;
        if (o.moveY !== undefined) this.scripted.moveY = o.moveY;
        for (const a of ACTIONS) if (o[a] !== undefined) { if (o[a]) this.scripted.down.add(a); else this.scripted.down.delete(a); }
      },
      clear: () => { this.scripted = null; },
      tap: (a: Action) => { this.pressScripted(a); },
    };
  }

  private queuedTaps: Action[] = [];
  private pressScripted(a: Action) { this.queuedTaps.push(a); }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.anyInputSeen = true;
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
    this.keys.add(e.code);
    const acts = KEY_MAP[e.code];
    if (acts) for (const a of acts) { this.down.add(a); this.pressedThisFrame.add(a); }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    const acts = KEY_MAP[e.code];
    if (acts) for (const a of acts) { this.down.delete(a); this.releasedThisFrame.add(a); }
  };

  /** Called once per frame before gameplay update. */
  poll() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();

    for (const a of this.queuedTaps) { this.pressedThisFrame.add(a); }
    this.queuedTaps.length = 0;

    let x = 0, y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;

    if (this.padIndex >= 0 && navigator.getGamepads) {
      const pad = navigator.getGamepads()[this.padIndex];
      if (pad) {
        const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
        x += dz(pad.axes[0] || 0);
        y -= dz(pad.axes[1] || 0);
        const btn = (i: number) => !!(pad.buttons[i] && pad.buttons[i].pressed);
        this.setHeld('jump', btn(0));
        this.setHeld('attack', btn(2));
        this.setHeld('dash', btn(1) || btn(7));
        this.setHeld('boost', btn(3) || btn(6));
        this.setHeld('slide', btn(5) || btn(4));
        this.setHeld('start', btn(9));
        this.setHeld('back', btn(8));
      }
    }

    if (this.scripted) {
      x = this.scripted.moveX;
      y = this.scripted.moveY;
      for (const a of ACTIONS) {
        const held = this.scripted.down.has(a);
        this.setHeld(a, held);
      }
    }

    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    this.moveX = clamp(x, -1, 1);
    this.moveY = clamp(y, -1, 1);
  }

  private prevHeld = new Set<Action>();
  private setHeld(a: Action, held: boolean) {
    const was = this.prevHeld.has(a);
    if (held && !was) this.pressedThisFrame.add(a);
    if (!held && was) this.releasedThisFrame.add(a);
    if (held) { this.down.add(a); this.prevHeld.add(a); }
    else { this.prevHeld.delete(a); if (this.scripted || this.padIndex >= 0) this.down.delete(a); }
  }

  held(a: Action) { return this.down.has(a); }
  pressed(a: Action) { return this.pressedThisFrame.has(a); }
  released(a: Action) { return this.releasedThisFrame.has(a); }
  get hasMoveInput() { return Math.abs(this.moveX) + Math.abs(this.moveY) > 0.08; }
}
