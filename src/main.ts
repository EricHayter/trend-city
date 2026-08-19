import { Game } from './Game';
import { Shared } from './render/Shared';

const gl = document.getElementById('gl') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLCanvasElement;
const boot = document.getElementById('boot');

const params = new URLSearchParams(location.search);
const game = new Game({
  gl, ui,
  seed: params.get('seed') ?? 'TREND-CITY',
  deterministic: params.has('deterministic'),
});

(window as any).__game = game;
// harness hook: lets the capture tooling read and override global shader state
(window as any).__shared = Shared;
(window as any).__ready = true;

if (boot) boot.style.display = 'none';
if (!params.has('manual')) game.start();
