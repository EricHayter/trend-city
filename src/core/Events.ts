/**
 * Bus — tiny typed pub/sub. Used for cross-system "something happened" signals
 * (landed, hit, killed, checkpoint) so audio / camera / HUD / fx can all react
 * without the gameplay code knowing any of them exist.
 */
export type GameEvent =
  | { t: 'jump'; n: number; power: number }
  | { t: 'land'; speed: number; hard: boolean; x: number; y: number; z: number }
  | { t: 'dash'; air: boolean }
  | { t: 'boost'; on: boolean }
  | { t: 'grindOn' } | { t: 'grindOff' }
  | { t: 'wallOn'; dir: number } | { t: 'wallOff' }
  | { t: 'slide'; on: boolean }
  | { t: 'attack'; index: number; kind: 'combo' | 'air' | 'dash' | 'launch' | 'slam' | 'charge' }
  | { t: 'hitEnemy'; x: number; y: number; z: number; damage: number; heavy: boolean; killed: boolean; kind: string }
  | { t: 'homing'; x: number; y: number; z: number }
  | { t: 'playerHurt'; damage: number; x: number; y: number; z: number }
  | { t: 'pickup'; kind: 'shard' | 'ring' | 'token' | 'health' | 'boost'; x: number; y: number; z: number; value: number }
  | { t: 'combo'; count: number; score: number }
  | { t: 'rankUp'; rank: string }
  | { t: 'bossPhase'; phase: number }
  | { t: 'bossHit'; damage: number; x: number; y: number; z: number }
  | { t: 'bossDead' }
  | { t: 'setpiece'; id: string; on: boolean }
  | { t: 'transmission'; text: string; speaker: string; hold: number }
  | { t: 'checkpoint'; index: number }
  | { t: 'stageDone'; win: boolean }
  | { t: 'shortcut'; id: number }
  | { t: 'ui'; kind: 'move' | 'confirm' | 'back' | 'deny' };

type Handler = (e: GameEvent) => void;

export class Bus {
  private all: Handler[] = [];
  private byType = new Map<string, Handler[]>();

  on(h: Handler): () => void {
    this.all.push(h);
    return () => { const i = this.all.indexOf(h); if (i >= 0) this.all.splice(i, 1); };
  }
  onType<T extends GameEvent['t']>(t: T, h: (e: Extract<GameEvent, { t: T }>) => void) {
    let a = this.byType.get(t);
    if (!a) { a = []; this.byType.set(t, a); }
    a.push(h as Handler);
  }
  emit(e: GameEvent) {
    for (let i = 0; i < this.all.length; i++) this.all[i](e);
    const a = this.byType.get(e.t);
    if (a) for (let i = 0; i < a.length; i++) a[i](e);
  }
}
