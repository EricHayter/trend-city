// How much does terrain actually rise beside the trail? planWalls' `natural`
// test needs > 45 total and never fires, so the threshold is either wrong or
// the terrain is flatter beside the trail than the test assumes.
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
const out = await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  const track = game.track, terrain = game.terrain;
  const rows = [];
  const v = new (window.__DESCENT__.THREE?.Vector3 ?? Object)();
  for (let d0 = 70; d0 < 1940; d0 += 230) {
    const per = [];
    for (const side of [-1, 1]) {
      let score = 0, maxRise = 0;
      for (let u = 0; u < 60; u += 6) {
        const s = track.sampleAtDistance(d0 + u);
        const px = s.position.x + s.left.x * side * (s.halfWidth + 1.5);
        const pz = s.position.z + s.left.z * side * (s.halfWidth + 1.5);
        const h0 = terrain.heightAt(px, pz);
        const qx = px + s.left.x * side * 6;
        const qz = pz + s.left.z * side * 6;
        const h1 = terrain.heightAt(qx, qz);
        const rise = h1 - h0;
        if (rise > maxRise) maxRise = rise;
        if (rise > 3.2) score += rise;
      }
      per.push({ side, score: +score.toFixed(1), maxRise: +maxRise.toFixed(2) });
    }
    rows.push({ d: d0, halfWidth: +track.sampleAtDistance(d0).halfWidth.toFixed(1), per });
  }
  return rows;
});
for (const r of out) console.log(`d=${r.d} hw=${r.halfWidth} L:score=${r.per[0].score} max=${r.per[0].maxRise}  R:score=${r.per[1].score} max=${r.per[1].maxRise}`);
await browser.close();
