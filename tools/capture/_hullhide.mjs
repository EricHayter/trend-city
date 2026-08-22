/**
 * _hullhide.mjs — is the black column the plate, or the plate's outline hull?
 *
 * _namebox.mjs named the thing filling the upper middle of the frame at d=980:
 * `wall-plate-4` and `wall-plate-4:hull`, 54 vertices each in the box, 20 to 41 m
 * out, at the same depths. Two meshes at the same place, one of which is an
 * inverted hull drawn in ink — so which of them is the black?
 *
 * Naming it does not answer that and neither does any pixel arithmetic: two
 * renders of the same frozen state differ here (dither, jitter, particles), and
 * an earlier attempt to attribute a change by byte-comparing crops reported that
 * all 170 meshes changed the frame. So this does the one thing that does work,
 * which is to hide one of the two and LOOK. Black to grey is not a dither-level
 * difference and does not need a diff to see.
 *
 * Usage: node tools/capture/_hullhide.mjs
 * Writes tools/capture/_out/hullhide-{asis,nohull,noplate}.png
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('tools/capture/_out');
await mkdir(OUT, { recursive: true });
const D = 980;

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const info = await page.evaluate(async (D) => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let hint = 0;
  g.stage.restart(); g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0); cam.resetTo(P.state);
  for (let i = 0; i < 120 * 400 && hint < D; i++) {
    const pos = P.state.position;
    const pr = g.track.project(pos, hint); hint = pr.distance;
    const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
    const err = wrap(Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z) - cam.yaw);
    g.input.intent.moveX = Math.sin(err); g.input.intent.moveZ = Math.cos(err);
    g.capture.step(1 / 120);
    if (['cleared', 'failed', 'results'].includes(g.stage.phase)) break;
  }

  const scene = window.__DESCENT__.engine.scene;
  const found = {};
  scene.traverse((o) => {
    if (o.name === 'wall-plate-4' || o.name === 'wall-plate-4:hull') found[o.name] = o;
  });
  // Every plate and hull in the scene, so the fix can be judged across all of
  // them rather than on the one that happened to be in this frame.
  let plates = 0, hulls = 0;
  scene.traverse((o) => {
    if (/^wall-plate-\d+$/.test(o.name)) plates++;
    if (/^wall-plate-\d+:hull$/.test(o.name)) hulls++;
  });

  window.__H__ = {
    set(which) {
      for (const k of Object.keys(found)) found[k].visible = true;
      if (which === 'nohull') found['wall-plate-4:hull'].visible = false;
      if (which === 'noplate') found['wall-plate-4'].visible = false;
      g.capture.render();
    },
  };
  return { d: +hint.toFixed(0), have: Object.keys(found), plates, hulls };
}, D);

console.log(JSON.stringify(info));
for (const which of ['asis', 'nohull', 'noplate']) {
  await page.evaluate((w) => window.__H__.set(w), which);
  await page.screenshot({ path: path.join(OUT, `hullhide-${which}.png`) });
}
await browser.close();
