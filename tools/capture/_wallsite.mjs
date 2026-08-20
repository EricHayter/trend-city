/**
 * _wallsite — is each wall plate actually standing on the ground it claims?
 *
 * `_railprobe` mounts 2 of 12 plates. The 10 misses all report an end height
 * well above the plate's own `baseY`, which is the signature of a plate whose
 * runnable band is buried in the hillside rather than of a probe aiming badly:
 * `WallSet.probe` gates on `from.y > baseY + bandBottom`, so a plate sunk into
 * the slope has a band the character cannot stand in front of.
 *
 * This measures it without physics. For each plate it samples terrain height at
 * the plate's own nodes and one contact-width out along the face normal, and
 * reports how much of the plate's height is above ground on the player's side.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const rows = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  const L = g.traversal.layout;
  const T = g.terrain;
  const h = (x, z) => T.heightAt(x, z);
  const BAND_BOTTOM = 0.6, BAND_TOP = 0.3, CONTACT = 0.42 + 0.34;

  return L.walls.map((w, i) => {
    // The plate's own base/top, exactly as WallSet builds its panel.
    let baseY = Infinity, topAt = -Infinity;
    for (const n of w.nodes) { if (n.y < baseY) baseY = n.y; if (n.y > topAt) topAt = n.y; }
    const topY = baseY + w.height;

    // Terrain on the player's side of the face, one contact width out.
    const out = [];
    for (let k = 0; k < w.nodes.length; k++) {
      const n = w.nodes[k], nm = w.normals[k];
      out.push(h(n.x + nm.x * CONTACT, n.z + nm.z * CONTACT));
    }
    const gMin = Math.min(...out), gMax = Math.max(...out), gMid = out[Math.floor(out.length / 2)];

    // The band the probe will accept, and how much of it is above the ground
    // the player would actually be standing on / falling past.
    const bandLo = baseY + BAND_BOTTOM, bandHi = topY - BAND_TOP;
    const usable = bandHi - Math.max(bandLo, gMid);

    return {
      i, chimney: w.chimney, d: Math.round(w.routeDistance), nodes: w.nodes.length,
      baseY: +baseY.toFixed(1), topY: +topY.toFixed(1), height: +w.height.toFixed(1),
      groundMid: +gMid.toFixed(1), groundMin: +gMin.toFixed(1), groundMax: +gMax.toFixed(1),
      // Positive = plate base is below the ground in front of it, i.e. buried.
      buried: +(gMid - baseY).toFixed(1),
      usableBand: +usable.toFixed(1),
    };
  });
});

console.log('idx kind     d     baseY  topY   h     groundMid  buried  usableBand');
for (const r of rows) {
  const flag = r.usableBand < 1.5 ? '  <-- UNRUNNABLE' : r.buried > r.height * 0.5 ? '  <-- mostly buried' : '';
  console.log(
    `${String(r.i).padStart(3)} ${(r.chimney ? 'chimney' : 'plain  ')} ${String(r.d).padStart(5)} ` +
    `${String(r.baseY).padStart(7)} ${String(r.topY).padStart(6)} ${String(r.height).padStart(5)} ` +
    `${String(r.groundMid).padStart(10)} ${String(r.buried).padStart(7)} ${String(r.usableBand).padStart(10)}${flag}`,
  );
}
const bad = rows.filter((r) => r.usableBand < 1.5).length;
console.log(`\n${bad}/${rows.length} plates have under 1.5 m of runnable band above the ground in front of them.`);
await browser.close();
