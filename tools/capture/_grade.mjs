/**
 * _grade — how steep is the route, actually?
 *
 * `_slope` measured a 46.6-degree running surface at d=350 and a 44.1-degree one
 * near d=1850. The speed governor is not the problem there — horizontal speed
 * peaked at 21.65 m/s against a `RUN.hardMax` of 29.98 — but the 3D speed the
 * player and the camera experience is the governed horizontal divided by
 * cos(grade), so a 46-degree face turns a lawful 21.6 into 31.5.
 *
 * `SLOPE.walkableNormalY` of 0.52 permits up to 58.7 degrees, which is a pitch
 * you would use your hands on. This walks the ribbon and reports the actual
 * distribution, so the question of whether the ROUTE is the thing that is too
 * fast can be answered with numbers instead of a guess.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const data = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  const total = g.track.length;
  const STEP = 4;
  const grades = [];
  for (let d = 0; d + STEP <= total; d += STEP) {
    const a = g.track.sampleAtDistance(d);
    const b = g.track.sampleAtDistance(d + STEP);
    const dy = b.position.y - a.position.y;
    const dh = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
    grades.push({ d, deg: Math.atan2(-dy, Math.max(1e-6, dh)) * 180 / Math.PI });
  }
  // Also the TERRAIN grade at the ribbon centreline, which is what the character
  // actually resolves against — the ribbon is a spline, the collider is a field.
  const terr = [];
  for (let d = 0; d + STEP <= total; d += STEP) {
    const a = g.track.sampleAtDistance(d);
    const b = g.track.sampleAtDistance(d + STEP);
    const ya = g.terrain.heightAt(a.position.x, a.position.z);
    const yb = g.terrain.heightAt(b.position.x, b.position.z);
    const dh = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
    terr.push({ d, deg: Math.atan2(-(yb - ya), Math.max(1e-6, dh)) * 180 / Math.PI });
  }
  return { total, grades, terr, walkableLimit: Math.acos(0.52) * 180 / Math.PI };
});

const hist = (rows) => {
  const bins = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 90];
  const counts = new Array(bins.length - 1).fill(0);
  let up = 0;
  for (const r of rows) {
    if (r.deg < 0) { up++; continue; }
    for (let i = 0; i < counts.length; i++) if (r.deg >= bins[i] && r.deg < bins[i + 1]) { counts[i]++; break; }
  }
  const n = rows.length;
  const lines = [`  uphill        ${String(up).padStart(4)}  ${(100 * up / n).toFixed(1).padStart(5)}%`];
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    lines.push(`  ${String(bins[i]).padStart(2)}-${String(bins[i + 1]).padStart(2)} deg  ${String(counts[i]).padStart(6)}  ${(100 * counts[i] / n).toFixed(1).padStart(5)}%`);
  }
  return lines.join('\n');
};

console.log(`route ${data.total.toFixed(0)} m, sampled every 4 m, ${data.grades.length} samples`);
console.log(`SLOPE.walkableNormalY 0.52 permits up to ${data.walkableLimit.toFixed(1)} deg\n`);
console.log('RIBBON grade (the spline the route is authored on):');
console.log(hist(data.grades));
console.log('\nTERRAIN grade at the centreline (what the character resolves against):');
console.log(hist(data.terr));

const steepR = data.grades.filter((r) => r.deg >= 30).sort((a, b) => b.deg - a.deg);
const steepT = data.terr.filter((r) => r.deg >= 30).sort((a, b) => b.deg - a.deg);
console.log(`\nribbon >=30 deg: ${steepR.length} samples (${(4 * steepR.length).toFixed(0)} m). Worst 12:`);
console.log('  ' + steepR.slice(0, 12).map((r) => `${r.d}m:${r.deg.toFixed(0)}`).join('  '));
console.log(`terrain >=30 deg: ${steepT.length} samples (${(4 * steepT.length).toFixed(0)} m). Worst 12:`);
console.log('  ' + steepT.slice(0, 12).map((r) => `${r.d}m:${r.deg.toFixed(0)}`).join('  '));

await browser.close();
