// Track/course geometry probe: length, start, finish, gradient profile.
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
  const t = game.track;
  const L = t.length;
  const rows = [];
  for (const d of [1900, 1950, 2000, 2050, 2100, L]) {
    const s = t.sampleAtDistance(d);
    rows.push({ d: Math.round(d), x: +s.position.x.toFixed(1), y: +s.position.y.toFixed(1), z: +s.position.z.toFixed(1) });
  }
  return { length: +L.toFixed(1), rows };
});
console.log('track length', out.length);
for (const r of out.rows) console.log(JSON.stringify(r));
await browser.close();
