import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
const out = await page.evaluate(() => {
  const t = window.__DESCENT__.game.track;
  const rows = [];
  for (let d = 0; d <= t.length; d += 25) rows.push([d, +t.sampleAtDistance(d).halfWidth.toFixed(1)]);
  return rows;
});
// print as bands of 8 per line
let line = [];
for (const [d, hw] of out) { line.push(`${d}:${hw}`); if (line.length === 10) { console.log(line.join(' ')); line = []; } }
if (line.length) console.log(line.join(' '));
const sorted = out.slice().sort((a, b) => a[1] - b[1]);
console.log('narrowest:', JSON.stringify(sorted.slice(0, 14)));
console.log('widest:', JSON.stringify(sorted.slice(-6)));
await browser.close();
