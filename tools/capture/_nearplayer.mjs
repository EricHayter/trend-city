// What is that object sitting on top of the character? Dump everything within a
// radius of the player, with its WORLD size, at a set of times in a live run.
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const AT = (process.env.AT ?? '3,8').split(',').map(Number);
const R = Number(process.env.R ?? 6);

const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  game.restart?.(); game.respawn?.();
  const input = { moveX: 0, moveZ: 1, cameraYaw: 0, jump: false, jumpHeld: false,
                  dash: false, crouch: false, attack: false, boost: false, dive: false };
  game.scriptedInput = input;
});
const t0 = Date.now();
for (const at of AT) {
  while ((Date.now() - t0) / 1000 < at) await page.waitForTimeout(40);
  const rows = await page.evaluate((R) => {
    const { game, engine } = window.__DESCENT__;
    const st = game.player.state;
    const scene = engine?.scene ?? game.scene;
    if (!scene) return ['no scene handle'];
    const THREE = window.__THREE__ ?? null;
    const out = [];
    scene.traverse((o) => {
      if (!o.visible) return;
      if (!o.geometry && !o.isInstancedMesh) return;
      const p = o.getWorldPosition(new o.position.constructor());
      const dist = Math.hypot(p.x - st.position.x, p.y - st.position.y, p.z - st.position.z);
      if (dist > R) return;
      const bb = o.geometry?.boundingBox ?? (o.geometry?.computeBoundingBox(), o.geometry?.boundingBox);
      const sc = o.getWorldScale(new o.position.constructor());
      const size = bb
        ? [(bb.max.x - bb.min.x) * sc.x, (bb.max.y - bb.min.y) * sc.y, (bb.max.z - bb.min.z) * sc.z]
            .map((v) => +v.toFixed(2))
        : null;
      out.push({ name: o.name || o.type, dist: +dist.toFixed(2), size, inst: !!o.isInstancedMesh, cnt: o.count ?? 0 });
    });
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, 22);
  }, R);
  console.log(`--- t=${at}s ---`);
  for (const r of rows) console.log(typeof r === 'string' ? r : JSON.stringify(r));
}
await browser.close();
