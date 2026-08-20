// Does the camera hold its subject at the CORRECTED speed?
//
// The unit fix moved top speed from 74 m/s to 20.17, and `CameraDirector` was
// calibrated on runs at "70 to 83 km/h" with a 3.05-to-6 m boom. This drives a
// real render loop — not `capture.step` — with forward held, and shoots at fixed
// intervals, so what lands in the frames is the rig's own damping, lag and boom
// solve rather than a teleported pose.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const OUT = process.env.OUT ?? 'captures/camrun';
const SHOTS = (process.env.SHOTS ?? '3,8,14,20,28,36').split(',').map(Number);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });

// Hand the game a scripted stick and let its OWN loop run. `takeControl` is not
// called: that freezes the engine clock for stepped capture, and the whole point
// here is the camera's response over real frames.
await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  game.restart?.();
  game.respawn?.();
  const input = { moveX: 0, moveZ: 1, cameraYaw: 0, jump: false, jumpHeld: false,
                  dash: false, crouch: false, attack: false, boost: false, dive: false };
  game.scriptedInput = input;
  const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  // Steer on the route tangent, same law the completability autopilot uses, so
  // the two runs are comparable.
  window.__STEER__ = setInterval(() => {
    const st = game.player.state;
    const pr = game.track.project(st.position);
    const s = game.track.sampleAtDistance(pr.distance);
    const err = wrap(Math.atan2(s.tangent.x, s.tangent.z) - st.facing);
    const lat = pr.lateral ?? 0;
    input.moveX = Math.max(-1, Math.min(1, -(err * 1.6) + lat * 0.09));
    const ahead = game.track.sampleAtDistance(Math.min(game.track.length, pr.distance + 14));
    input.jump = (ahead.position.y - game.terrain.heightAt(ahead.position.x, ahead.position.z)) > 4
                 && st.mode !== 'airborne';
  }, 8);
});

// Camera-versus-subject numbers, sampled alongside every shot. A frame says how
// it looks; these say whether the rig is inside the range it was solved for.
const read = () => page.evaluate(() => {
  const { game } = window.__DESCENT__;
  const st = game.player.state;
  const cam = game.camera ?? game.renderer?.camera ?? null;
  const spd = Math.hypot(st.velocity.x, st.velocity.z);
  let boom = -1, onScreen = null;
  if (cam) {
    boom = Math.hypot(cam.position.x - st.position.x, cam.position.y - st.position.y, cam.position.z - st.position.z);
    const v = st.position.clone(); v.y += 0.9; v.project(cam);
    onScreen = { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) };
  }
  return {
    spd: +spd.toFixed(1),
    display: Math.round(spd * 9.174),
    d: Math.round(game.stage?.stats?.distance ?? game.track.project(st.position).distance),
    mode: st.mode, phase: game.stage?.stats?.phase ?? '?',
    boom: +boom.toFixed(2), onScreen, fov: cam ? +cam.fov.toFixed(1) : -1,
  };
});

const rows = [];
let t0 = Date.now();
for (const at of SHOTS) {
  while ((Date.now() - t0) / 1000 < at) await page.waitForTimeout(50);
  const m = await read();
  const file = path.join(OUT, `t${String(at).padStart(2, '0')}.png`);
  await page.screenshot({ path: file });
  rows.push({ at, ...m });
  console.log(JSON.stringify({ at, ...m }));
}
await writeFile(path.join(OUT, 'metrics.json'), JSON.stringify(rows, null, 2));
await browser.close();
