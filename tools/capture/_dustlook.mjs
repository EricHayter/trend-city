/**
 * _dustlook.mjs — one big clean look at the character at speed.
 *
 * This exists because of a wrong call I made from a picture. The movement strips
 * from _motionseq.mjs are 480x270 tiles, and at that size the dust at the
 * character's feet reads as dust ON the character — I recorded the plume as "the
 * largest thing in the frame, sitting on the character, making them unreadable"
 * and opened it as a defect on that basis.
 *
 * _dustcover.mjs then measured the actual quantity, per height band across the
 * silhouette, over 60 samples at race pace: feet 100% covered, shins 97%, knee
 * 40%, hip 1%, torso and head 0%. The dust never reaches the body. Feet-and-
 * shins dust is what the effect is FOR.
 *
 * So this captures the same moment big enough to judge, because a claim about a
 * picture has to be checked against a picture at a size where the thing being
 * claimed is visible.
 *
 * Usage: node tools/capture/_dustlook.mjs
 * Writes tools/capture/_out/dustlook-<d>.png
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('tools/capture/_out');
await mkdir(OUT, { recursive: true });
const STOPS = [340, 520, 980];

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

await page.evaluate(() => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let hint = 0;
  window.__L__ = {
    reset() {
      g.stage.restart(); g.stage.forceRunning();
      const s0 = g.track.sampleAtDistance(0);
      P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
      P.state.velocity.set(0, 0, 0); cam.resetTo(P.state); hint = 0;
    },
    drive() {
      const pos = P.state.position;
      const pr = g.track.project(pos, hint); hint = pr.distance;
      const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
      const err = wrap(Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z) - cam.yaw);
      g.input.intent.moveX = Math.sin(err); g.input.intent.moveZ = Math.cos(err);
      g.capture.step(1 / 120);
      return ['cleared', 'failed', 'results'].includes(g.stage.phase);
    },
    to(target) {
      for (let i = 0; i < 120 * 400; i++) { if (this.drive()) break; if (hint >= target) break; }
      const st = P.state;
      return { d: +hint.toFixed(0), spd: +st.speed.toFixed(1), mode: st.mode, live: g.effects.dust.countAlive() };
    },
  };
});

await page.evaluate(() => window.__L__.reset());
for (const d of STOPS) {
  const info = await page.evaluate((d) => window.__L__.to(d), d);
  await page.screenshot({ path: path.join(OUT, `dustlook-${info.d}.png`) });
  console.log(JSON.stringify(info));
}
await browser.close();
