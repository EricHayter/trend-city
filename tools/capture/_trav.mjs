// Traversal census: does planLayout produce rails/walls/boosters/pickups, and
// are they reachable from the route?
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
const out = await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  const b = game.traversal;
  if (!b) return { error: 'no game.traversal' };
  const L = b.layout;
  const hist = (arr, key) => {
    const m = {};
    for (const it of arr) { const k = String(it[key]); m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  // Draw-call and node census under the traversal root.
  let meshes = 0, inst = 0, tris = 0;
  b.object.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh) { inst++; }
    meshes++;
    const g = o.geometry;
    const n = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3;
    tris += Math.round(n) * (o.isInstancedMesh ? o.count : 1);
  });
  return {
    courseLength: +L.courseLength.toFixed(1),
    counts: {
      rails: L.rails.length,
      walls: L.walls.length,
      boosters: L.boosters.length,
      pickups: L.pickups.length,
      gaps: L.gaps.length,
    },
    boosterKinds: hist(L.boosters, 'kind'),
    pickupKinds: hist(L.pickups, 'kind'),
    railSpan: L.rails.length
      ? [Math.round(Math.min(...L.rails.map((r) => r.routeDistance))),
         Math.round(Math.max(...L.rails.map((r) => r.routeDistance)))]
      : null,
    railLengths: L.rails.slice(0, 8).map((r) => +(r.points
      ? r.points.reduce((a, p, i, arr) => i ? a + p.distanceTo(arr[i - 1]) : 0, 0)
      : 0).toFixed(1)),
    wallSpan: L.walls.length
      ? [Math.round(Math.min(...L.walls.map((w) => w.routeDistance))),
         Math.round(Math.max(...L.walls.map((w) => w.routeDistance)))]
      : null,
    scene: { meshes, instanced: inst, tris },
    totals: b.pickups.totals,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
