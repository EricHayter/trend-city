/**
 * main.ts — boot.
 *
 * Constructs the engine, hands it to the Game, and gets out of the way.
 * Everything interesting lives in src/game/Game.ts.
 */

import { Engine } from './core/Engine';
import { Game } from './game/Game';
import { POST_STATE } from './npr/NprGlobals';

const bootEl = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar') as HTMLElement | null;
const bootLabel = document.getElementById('boot-label') as HTMLElement | null;

function progress(p: number, label?: string): void {
  if (bootBar) bootBar.style.width = `${Math.round(p * 100)}%`;
  if (label && bootLabel) bootLabel.textContent = label;
}

async function boot(): Promise<void> {
  const container = document.getElementById('app')!;

  // The capture harness pins resolution and drives the clock manually.
  const params = new URLSearchParams(location.search);
  const fixedPr = params.has('pr') ? Number(params.get('pr')) : null;

  const engine = new Engine({
    container,
    maxPixelRatio: 2,
    fixedPixelRatio: fixedPr,
  });

  const game = new Game(engine, { params });
  await game.load(progress);

  progress(1, 'Ready');
  bootEl?.classList.add('done');
  setTimeout(() => bootEl?.remove(), 500);

  engine.start();

  // Exposed for the Playwright capture harness — see tools/capture/.
  //
  // `POST_STATE` is in there because the post effects are ramped against player
  // speed and several of those ramps were mis-ranged in ways no screenshot can
  // settle — an effect pinned at full strength and an effect correctly at full
  // strength look identical. The probes read the published intensity instead.
  (window as unknown as Record<string, unknown>).__DESCENT__ = { engine, game, POST_STATE };
}

boot().catch((err) => {
  console.error(err);
  if (bootLabel) bootLabel.textContent = 'Failed to start — see console';
  if (bootBar) bootBar.style.background = '#e0574c';
});
