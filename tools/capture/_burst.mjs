// A burst of frames over a short window of a live run, so a transient artefact
// can be caught and read rather than inferred from one unlucky shot.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const OUT = process.env.OUT ?? 'captures/burst';
const FROM = Number(process.env.FROM ?? 5);
const TO = Number(process.env.TO ?? 11);
const EVERY = Number(process.env.EVERY ?? 0.6);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 506 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  game.restart?.(); game.respawn?.();
  const input = { moveX: 0, moveZ: 1, cameraYaw: 0, jump: false, jumpHeld: false,
                  dash: false, crouch: false, attack: false, boost: false, dive: false };
  game.scriptedInput = input;
  const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  setInterval(() => {
    const st = game.player.state;
    const pr = game.track.project(st.position);
    const s = game.track.sampleAtDistance(pr.distance);
    input.moveX = Math.max(-1, Math.min(1, -(wrap(Math.atan2(s.tangent.x, s.tangent.z) - st.facing) * 1.6) + (pr.lateral ?? 0) * 0.09));
  }, 8);
});
const t0 = Date.now();
for (let at = FROM; at <= TO + 1e-6; at += EVERY) {
  while ((Date.now() - t0) / 1000 < at) await page.waitForTimeout(25);
  const tag = at.toFixed(1).replace('.', '_');
  await page.screenshot({ path: path.join(OUT, `t${tag}.png`) });
  const m = await page.evaluate(() => {
    const { game } = window.__DESCENT__;
    const st = game.player.state;
    return { mode: st.mode, spd: +Math.hypot(st.velocity.x, st.velocity.z).toFixed(1) };
  });
  console.log(at.toFixed(1), JSON.stringify(m));
}
await browser.close();
