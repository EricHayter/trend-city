import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
const out = await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  const t = game.track, terr = game.terrain;
  const rows = [];
  for (let d = 1440; d <= 1560; d += 10) {
    const s = t.sampleAtDistance(d);
    rows.push({
      d, x: +s.position.x.toFixed(1), y: +s.position.y.toFixed(1), z: +s.position.z.toFixed(1),
      tx: +s.tangent.x.toFixed(2), tz: +s.tangent.z.toFixed(2),
      hw: +s.halfWidth.toFixed(1),
      terr: +terr.heightAt(s.position.x, s.position.z).toFixed(1),
    });
  }
  // Also: what does projectToRoute say about the traced character position?
  const probe = [];
  const P = game.player.state.position.constructor;
  for (const [x, y, z] of [[23, 202.1, 183.2], [32.6, 206.1, 179.6], [23, 202, 183]]) {
    const v = new P(x, y, z);
    const pr = t.project ? t.project(v) : (t.projectToRoute ? t.projectToRoute(v) : null);
    probe.push({ x, z, proj: pr ? { d: +pr.distance.toFixed(1), lat: +(pr.lateral ?? 0).toFixed(1) } : 'no project fn' });
  }
  return { rows, probe, fns: Object.keys(t).filter((k) => typeof t[k] === 'function') };
});
for (const r of out.rows) console.log(`d=${r.d} pos=(${r.x},${r.y},${r.z}) tan=(${r.tx},${r.tz}) hw=${r.hw} terrY=${r.terr}`);
console.log('PROBE', JSON.stringify(out.probe));
console.log('TRACK FNS', out.fns.join(','));
await browser.close();
