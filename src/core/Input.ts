/**
 * Input — keyboard and gamepad, normalised into one player intent.
 *
 * ── WHAT THE PIVOT CHANGED HERE ─────────────────────────────────────────────
 * This was a bike's control surface: a smoothed steering axis, a pedal, two
 * independent brakes, a preload channel and a pitch-lean axis. A platformer
 * wants none of those. It wants a MOVE VECTOR in camera space plus six
 * discrete verbs, so that is what this now produces.
 *
 * Two design points that matter downstream:
 *
 *  1. THE MOVE AXES SNAP. They are not smoothed, and that is a reversal of the
 *     old file's first design point — deliberately.
 *
 *     `PlayerPhysics` reads `hypot(moveX, moveZ)` as the player's INTENT
 *     magnitude: "half stick is a jog rather than a slow sprint". So ramping a
 *     keyboard press from 0 to 1 over 60 ms does not soften the start, it tells
 *     the physics the player wants to jog for 60 ms and then sprint. At
 *     `GRAVITY.accel`-scale acceleration that is most of a metre surrendered
 *     off every standing start, and it is a lie about what the player asked for.
 *
 *     Smoothing was right for a steering axis, where the smoothing WAS the
 *     handling model and a snap read as being on rails. It is wrong for a run
 *     vector, because the equivalent softening already exists downstream and in
 *     the right place: the physics slews `facing` toward the wish direction at
 *     `RUN.turnRateLow`..`turnRateHigh` (12 rad/s dropping to 2.2 at top
 *     speed), so a hard 90-degree input change is a carved corner, not a
 *     teleport. Smoothing here would be a second, uncalibrated turn limiter in
 *     front of the tuned one.
 *
 *     A real stick still supplies its own curve and is passed through
 *     untouched, deadzone aside.
 *
 *  2. Every button exposes `pressed`, `justPressed`, `justReleased` and a
 *     `heldFor` timer, and the edges SURVIVE A FRAME IN WHICH SEVERAL PHYSICS
 *     STEPS RAN. That is load-bearing here: physics runs at a fixed 120 Hz and
 *     a rendered frame consumes two or more steps, so `Game` converts an edge
 *     into a single-step pulse itself. See `Game.buildPlayerInput`.
 *
 *  3. THERE IS A LOOK CHANNEL, and it is a DELTA rather than a level.
 *
 *     A mouse has no centre to return to, so `lookX` cannot be an axis the way
 *     `moveX` is — it is radians of yaw the player asked for since the last
 *     drain, and `Game` drains it every frame. A right stick IS a level, so its
 *     contribution is multiplied by the frame's dt before it goes into the same
 *     accumulator; both then mean the same thing downstream.
 *
 *     This exists because the camera had no player authority at all. The basis
 *     the move stick resolves against was a damped follow of the character's
 *     own facing, which makes it a unity-gain loop: the stick asks for facing
 *     plus phi, facing slews there, the basis follows, the request is still
 *     facing plus phi. Measured with tools/capture/_circle.mjs — holding A for
 *     six seconds turned 2.12 full revolutions and was still turning at 112
 *     deg/s, and holding W plus a light A orbited at 24 deg/s forever. Every
 *     lateral input was a circle with no way to stop turning. The camera needs
 *     its own yaw for that to have a fixed point, and a camera with its own yaw
 *     needs a way for the player to aim it. See `CameraDirector.inputYaw`.
 *
 * The whole struct is also settable from outside, which is how the capture
 * harness drives the game to an exact moment without touching the DOM.
 */

export interface ButtonState {
  pressed: boolean;
  justPressed: boolean;
  justReleased: boolean;
  /** Seconds held. Reset to 0 on release. */
  heldFor: number;
  /** Seconds since the last release edge — for buffered-input windows. */
  sinceRelease: number;
}

function makeButton(): ButtonState {
  return { pressed: false, justPressed: false, justReleased: false, heldFor: 0, sinceRelease: 999 };
}

/**
 * The action set. Everything the player can express.
 *
 * `crouch` is the slide: held on the ground it drops the hull and trades grip
 * for gradient, which is why it is a level and not a verb. `dive` is the
 * down-dash that resolves into a ground pound, and is deliberately a separate
 * action from `dash` rather than dash-plus-down — a modifier combination is
 * unreachable at 74 m/s.
 */
export const ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'jump',
  'dash',
  'attack',
  'crouch',       // slide / low hull
  'boost',
  'dive',         // down-dash into a ground pound
  'reset',
  'lookBack',
  'pause',
  'restart',
  'toggleCam',
  'toggleDebug',
] as const;
export type Action = (typeof ACTIONS)[number];

const DEFAULT_BINDINGS: Record<string, Action> = {
  KeyW: 'moveForward',
  ArrowUp: 'moveForward',
  KeyS: 'moveBack',
  ArrowDown: 'moveBack',
  KeyA: 'moveLeft',
  ArrowLeft: 'moveLeft',
  KeyD: 'moveRight',
  ArrowRight: 'moveRight',
  Space: 'jump',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  KeyJ: 'attack',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyF: 'boost',
  KeyK: 'dive',
  KeyR: 'reset',
  KeyB: 'lookBack',
  Escape: 'pause',
  // Enter USED to be bound straight to `restart`, and a single tap threw the run
  // away from anywhere — including mid-descent, and including the frame after a
  // results screen appeared. `Game.handleUiInput` now requires a hold, and the
  // HUD draws the hold as it fills. KeyR ('reset') is still the instant one,
  // because it only moves the character back to the line.
  Enter: 'restart',
  NumpadEnter: 'restart',
  KeyV: 'toggleCam',
  Backquote: 'toggleDebug',
};

/**
 * Player intent, consumed by `Game` and turned into a `PlayerInput`.
 *
 * The move vector is in CAMERA space and is not yet resolved against a yaw —
 * that is `Game`'s job, because the camera is the only thing that knows which
 * way it is pointing and this class must not depend on it.
 */
export interface PlayerIntent {
  /** -1 (left) .. +1 (right), camera space. */
  moveX: number;
  /** -1 (toward the camera) .. +1 (away from it), camera space. */
  moveZ: number;
  /**
   * Radians of yaw the player has asked the camera for since the last drain.
   *
   * A DELTA, not an axis — see design point 3. Positive is a look to the right.
   * `Game` reads it and zeroes it every frame; a consumer that forgets to zero
   * it gets an ever-growing request and a camera that spins, so the drain lives
   * in exactly one place (`Input.drainLook`).
   */
  lookX: number;
  /** Radians of pitch since the last drain. Positive looks DOWN. */
  lookY: number;
  /** Raw button states for edge-sensitive logic. */
  buttons: Record<Action, ButtonState>;
  /** True while any gamepad is providing input — HUD swaps its prompts. */
  usingGamepad: boolean;
  /** True while the pointer is locked to the canvas — the HUD shows a hint. */
  pointerLocked: boolean;
}

/**
 * Look sensitivity.
 *
 * The mouse figure is radians per device pixel of `movementX`. 0.0026 puts a
 * 180 deg turn at about 1200 px of travel, which is a normal third-person
 * setting and slow enough that the character's own turn rate is still the thing
 * limiting a corner rather than the wrist.
 *
 * The pad figure is radians per second at full stick, and is deliberately well
 * under `RUN.turnRateHigh` (2.2 rad/s): a right stick that can rotate the basis
 * faster than the character can turn re-creates the runaway loop by hand.
 */
export const LOOK = {
  mousePerPixel: 0.0026,
  padRadPerSec: 1.9,
  /** Deadzone on the right stick, which rests less cleanly than the left. */
  padDeadzone: 0.16,
  /** Multiplier on the vertical channel. Pitch wants less range than yaw. */
  pitchScale: 0.62,
  /** True inverts the vertical axis. */
  invertY: false,
} as const;

export class Input {
  readonly intent: PlayerIntent;
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  private bindings: Record<string, Action>;
  private enabled = true;
  private lockTarget: HTMLElement | null = null;
  /** When true, all hardware input is ignored and the harness drives `intent`. */
  scripted = false;
  private gamepadIndex: number | null = null;

  constructor(target: HTMLElement | Window = window, bindings = DEFAULT_BINDINGS) {
    this.bindings = bindings;
    const buttons = {} as Record<Action, ButtonState>;
    for (const a of ACTIONS) buttons[a] = makeButton();
    this.intent = {
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      buttons,
      usingGamepad: false,
      pointerLocked: false,
    };

    const el = target as Window;
    el.addEventListener('keydown', this.onKeyDown as EventListener);
    el.addEventListener('keyup', this.onKeyUp as EventListener);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove as EventListener);
  }

  /**
   * Give the mouse somewhere to lock to.
   *
   * Called with the renderer's canvas. Kept out of the constructor because this
   * class deliberately knows nothing about the renderer, and because the capture
   * harness constructs an `Input` with no canvas and must not acquire a pointer
   * lock it never asked for.
   *
   * A click is the gesture, because `requestPointerLock` is only granted from a
   * user gesture in every browser — there is no way to start already locked.
   */
  attachPointerLock(el: HTMLElement): void {
    this.lockTarget = el;
    el.addEventListener('mousedown', this.onMouseDown);
  }

  /** Release the mouse — for a pause menu, which wants a visible cursor. */
  releasePointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private onMouseDown = (): void => {
    if (!this.enabled || this.scripted) return;
    if (this.lockTarget && !document.pointerLockElement) {
      // Not awaited. The promise form is newer than the callback form and rejects
      // on a gesture the browser did not like; either way `pointerlockchange` is
      // the single source of truth for whether we are locked, so there is nothing
      // useful to do with the result.
      void (
        this.lockTarget.requestPointerLock() as unknown as Promise<void> | undefined
      )?.catch?.(() => {});
    }
  };

  private onPointerLockChange = (): void => {
    const locked = !!this.lockTarget && document.pointerLockElement === this.lockTarget;
    this.intent.pointerLocked = locked;
    // Losing the lock mid-motion would otherwise leave the last delta banked and
    // apply it the next time the player locks back in, which reads as the camera
    // flicking on click.
    if (!locked) {
      this.intent.lookX = 0;
      this.intent.lookY = 0;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled || this.scripted) return;
    if (!this.intent.pointerLocked) return;
    // `movementX/Y`, not a difference of `clientX/Y`: under a pointer lock the
    // cursor does not move, so the client coordinates are frozen and a difference
    // of them is always zero.
    this.intent.lookX += e.movementX * LOOK.mousePerPixel;
    this.intent.lookY +=
      e.movementY * LOOK.mousePerPixel * LOOK.pitchScale * (LOOK.invertY ? -1 : 1);
    this.intent.usingGamepad = false;
  };

  /**
   * Read the accumulated look request and clear it.
   *
   * The clear is the point. `lookX` is a delta, so a caller that reads without
   * clearing re-applies every mouse movement the player has ever made, every
   * frame. Written into a caller-supplied pair to keep the per-frame path free of
   * allocation.
   */
  drainLook(out: { x: number; y: number }): void {
    out.x = this.intent.lookX;
    out.y = this.intent.lookY;
    this.intent.lookX = 0;
    this.intent.lookY = 0;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || this.scripted) return;
    if (e.repeat) return;
    if (this.bindings[e.code]) {
      e.preventDefault();
      this.down.add(e.code);
      this.pressedThisFrame.add(e.code);
      this.intent.usingGamepad = false;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.enabled || this.scripted) return;
    if (this.bindings[e.code]) {
      e.preventDefault();
      this.down.delete(e.code);
      this.releasedThisFrame.add(e.code);
    }
  };

  /** Losing focus mid-input would otherwise leave a key stuck down forever. */
  private onBlur = (): void => {
    for (const code of this.down) this.releasedThisFrame.add(code);
    this.down.clear();
  };

  private onGamepadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private onGamepadDisconnected = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
  };

  private isActionDown(a: Action): boolean {
    for (const code in this.bindings) {
      if (this.bindings[code] === a && this.down.has(code)) return true;
    }
    return false;
  }

  private wasActionPressed(a: Action): boolean {
    for (const code of this.pressedThisFrame) if (this.bindings[code] === a) return true;
    return false;
  }

  private wasActionReleased(a: Action): boolean {
    for (const code of this.releasedThisFrame) if (this.bindings[code] === a) return true;
    return false;
  }

  /** Call once per frame, before the fixed-update loop. */
  update(dt: number): void {
    if (this.scripted) {
      this.updateButtonTimers(dt);
      // The move vector is synthesised in scripted mode too.
      //
      // It used to be skipped, on the assumption that a scripted caller writes
      // the analogue channels directly — which was true of the bike, whose
      // harness set `intent.steer` and `intent.pedal` by hand. It is a trap
      // here: `scriptButton('moveForward', true)` is the obvious way to drive
      // the game from a test, it moves a button the physics never reads, and
      // the failure is silent — a character that will not walk, with a pressed
      // button to prove it should. Measured: 2 s of held `moveForward` produced
      // 0.1 m/s.
      //
      // A caller that wants the raw axes writes them AFTER `update()`, which is
      // where a per-frame override has to go regardless.
      this.synthMoveFromButtons();
      return;
    }

    const pad = this.pollGamepad();

    for (const a of ACTIONS) {
      const b = this.intent.buttons[a];
      const wasPressed = b.pressed;
      const nowPressed = this.isActionDown(a) || (pad ? padActionDown(pad, a) : false);

      b.justPressed = (!wasPressed && nowPressed) || this.wasActionPressed(a);
      b.justReleased = (wasPressed && !nowPressed) || this.wasActionReleased(a);
      b.pressed = nowPressed;

      if (nowPressed) {
        b.heldFor += dt;
        b.sinceRelease = 0;
      } else {
        if (wasPressed) b.heldFor = 0;
        b.sinceRelease += dt;
      }
    }

    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();

    // ── The move vector ─────────────────────────────────────────────────────
    const i = this.intent;

    if (pad) {
      // A real stick bypasses everything — the player is already providing the
      // curve with their thumb. Y is inverted because a stick pushed AWAY from
      // the player reads negative and means "away from the camera".
      i.moveX = deadzone(pad.axes[0] ?? 0, 0.12);
      i.moveZ = -deadzone(pad.axes[1] ?? 0, 0.12);
      i.usingGamepad = true;

      // The right stick, integrated into the same delta the mouse writes to. A
      // stick is a LEVEL, so it has to be multiplied by dt to become the same
      // quantity a mouse movement already is.
      const rx = deadzone(pad.axes[2] ?? 0, LOOK.padDeadzone);
      const ry = deadzone(pad.axes[3] ?? 0, LOOK.padDeadzone);
      i.lookX += rx * LOOK.padRadPerSec * dt;
      i.lookY += ry * LOOK.padRadPerSec * LOOK.pitchScale * dt * (LOOK.invertY ? -1 : 1);
    } else {
      this.synthMoveFromButtons();
    }
  }

  /**
   * The keyboard move vector: snapped, not smoothed. See design point 1 in the
   * header for why there is no ramp here.
   *
   * A diagonal is left at magnitude 1.41 rather than normalised, and that is not
   * an oversight: `PlayerPhysics` clamps `wishMag` to 1 itself, so normalising
   * would be a second clamp, and a caller that wants the raw pressed pair (a
   * debug overlay, a replay diff) would have lost it.
   */
  private synthMoveFromButtons(): void {
    const i = this.intent;
    i.moveX = (i.buttons.moveRight.pressed ? 1 : 0) - (i.buttons.moveLeft.pressed ? 1 : 0);
    i.moveZ = (i.buttons.moveForward.pressed ? 1 : 0) - (i.buttons.moveBack.pressed ? 1 : 0);
  }

  private updateButtonTimers(dt: number): void {
    for (const a of ACTIONS) {
      const b = this.intent.buttons[a];
      if (b.pressed) {
        b.heldFor += dt;
        b.sinceRelease = 0;
      } else {
        b.sinceRelease += dt;
      }
    }
  }

  private pollGamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.gamepadIndex !== null) {
      const p = pads[this.gamepadIndex];
      if (p && p.connected) return p;
    }
    for (const p of pads) {
      if (p && p.connected) {
        this.gamepadIndex = p.index;
        return p;
      }
    }
    return null;
  }

  /** Used by the capture harness and the scripted attract mode. */
  setScripted(on: boolean): void {
    this.scripted = on;
    if (on) {
      this.down.clear();
      const i = this.intent;
      i.moveX = 0;
      i.moveZ = 0;
      i.lookX = 0;
      i.lookY = 0;
      for (const a of ACTIONS) {
        const b = i.buttons[a];
        b.pressed = b.justPressed = b.justReleased = false;
      }
    }
  }

  /** Programmatically press/release, for scripted playback. */
  scriptButton(a: Action, pressed: boolean): void {
    const b = this.intent.buttons[a];
    if (pressed && !b.pressed) b.justPressed = true;
    if (!pressed && b.pressed) b.justReleased = true;
    b.pressed = pressed;
  }

  /** Clear all justPressed/justReleased edges. Call at the end of a frame. */
  clearEdges(): void {
    for (const a of ACTIONS) {
      const b = this.intent.buttons[a];
      b.justPressed = false;
      b.justReleased = false;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.onBlur();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown as EventListener);
    window.removeEventListener('keyup', this.onKeyUp as EventListener);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove as EventListener);
    this.lockTarget?.removeEventListener('mousedown', this.onMouseDown);
  }
}

// ── Gamepad helpers ──────────────────────────────────────────────────────────
function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/**
 * Standard-mapping gamepad layout.
 *
 * The face buttons are laid out for a runner: jump under the thumb, dash on the
 * shoulder where it can be held through a corner, attack next to jump. The
 * triggers are the two levels — boost and slide — because a level wants a
 * trigger and a verb wants a button.
 */
const PAD_MAP: Partial<Record<Action, number>> = {
  jump: 0,          // A / cross
  attack: 2,        // X / square
  dive: 3,          // Y / triangle
  dash: 5,          // RB
  crouch: 6,        // LT
  boost: 7,         // RT
  lookBack: 10,
  reset: 8,
  pause: 9,
  toggleCam: 11,
};

function padActionDown(pad: Gamepad, a: Action): boolean {
  const idx = PAD_MAP[a];
  if (idx === undefined) return false;
  const b = pad.buttons[idx];
  return !!b && b.pressed;
}
