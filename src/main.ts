import { Game } from './Game';

const gl = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;
const boot = document.getElementById('boot');

try {
  const game = new Game(gl, hud);
  game.start();
  if (boot) { boot.classList.add('gone'); setTimeout(() => boot.remove(), 600); }
} catch (err: any) {
  console.error(err);
  if (boot) boot.textContent = 'BOOT FAILED: ' + (err && err.message ? err.message : String(err));
}
