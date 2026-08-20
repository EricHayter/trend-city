// Where is everything, in route t, so poses can be authored to look at it.
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
const out = await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  const L = game.traversal.layout;
  const T = L.courseLength;
  const f = (n) => +n.toFixed(4);
  return {
    rails: L.rails.map((r) => ({
      kind: r.kind, t: f(r.routeDistance / T), d: Math.round(r.routeDistance),
      len: Math.round(r.exitRouteDistance - r.routeDistance),
      dy: +(r.cage[r.cage.length - 1].y - r.cage[0].y).toFixed(1),
      nodes: r.cage.length, radius: r.radius,
    })),
    walls: L.walls.map((w) => ({
      t: f(w.routeDistance / T), d: Math.round(w.routeDistance),
      h: +w.height.toFixed(1), chimney: !!w.chimney, nodes: w.nodes.length,
    })),
    boosters: L.boosters.map((b) => ({ kind: b.kind, t: f(b.routeDistance / T), d: Math.round(b.routeDistance), r: b.radius, p: +b.power.toFixed(2) })),
    gaps: L.gaps.map((g) => ({ ...Object.fromEntries(Object.entries(g).filter(([, v]) => typeof v === 'number')) })),
  };
});
console.log('RAILS'); for (const r of out.rails) console.log(JSON.stringify(r));
console.log('WALLS'); for (const w of out.walls) console.log(JSON.stringify(w));
console.log('BOOSTERS'); for (const b of out.boosters) console.log(JSON.stringify(b));
console.log('GAPS'); for (const g of out.gaps) console.log(JSON.stringify(g));
await browser.close();
