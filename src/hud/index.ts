/**
 * The HUD subsystem.
 *
 * Construct one `Hud`, feed it a `HudModel` every frame, and render it last.
 * Nothing else in the game needs to know anything about canvases or layers.
 */

export { Hud } from './Hud';
export type { HudOptions } from './Hud';

export { MenuScreen, CountdownWidget, DEFAULT_MENU_ITEMS } from './Menus';
export type { MenuKind, MenuState, ReplayFrameRect } from './Menus';

export {
  Widget,
  RouteProfileWidget,
  ClockWidget,
  SpeedWidget,
  BoostWidget,
  PopupWidget,
  PromptWidget,
  WarningWidget,
  clockString,
  stageLive,
  stagePlaying,
  P,
  LABEL,
  VALUE,
  PROFILE_METRICS,
  POPUP_METRICS,
} from './Widgets';

// The stage readouts are part of the subsystem's public surface now, not an
// internal detail of it: they replaced the racing panels one for one (see the
// layer table in Hud.ts) and nothing outside `src/hud/` should have to know
// that the pivot happened to put them in a second file.
export {
  HealthWidget,
  ComboWidget,
  CollectionWidget,
  BossWidget,
  TransmissionWidget,
  VerdictWidget,
} from './StageWidgets';

export { HudCanvasRoot, HudLayer, SolidQuad, css, cssA, cssMix } from './HudCanvas';
export type { Anchor, LayerPlacement } from './HudCanvas';

export { drawText, drawWordmark, measureText, buildTypeface } from './Typeface';
export type { TextStyle } from './Typeface';
