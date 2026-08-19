/**
 * The audio subsystem. Everything you hear is synthesised here at runtime —
 * there is not one sample file in the project.
 */

export { AudioEngine } from './AudioEngine';
export type { AudioOptions } from './AudioEngine';

export {
  MasterBus,
  NoiseBank,
  WindVoice,
  TyreVoice,
  ImpactPool,
  HornVoice,
  BoostVoice,
  UiPool,
  Smooth,
  strike,
  swell,
  pitchDrop,
} from './Synths';
export type { SurfaceTone, UiKind, NoiseKind } from './Synths';

export {
  JumpVoice,
  DashVoice,
  AttackVoice,
  HitVoice,
  GrindVoice,
  MountVoice,
  PickupVoice,
  StingerVoice,
  MusicBed,
} from './PlayerVoices';
export type { StingerKind, MusicLayer } from './PlayerVoices';
