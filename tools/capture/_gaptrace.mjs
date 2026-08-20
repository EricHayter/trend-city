// Trace the ravine run-in step by step: where does the speed go?
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });
const out = await page.evaluate(() => {
  const { game } = window.__DESCENT__;
  const c = game.capture;
  c.takeControl();
  // Place with zero preroll so the trace starts at the spawn.
  c.setPose('dash-ring');
  const rows = [];
  const st = game.player.state;
  for (let i = 0; i < 140; i++) {
    rows.push({
      i,
      d: +game.stage.routeDistance.toFixed(1),
      spd: +Math.hypot(st.velocity.x, st.velocity.z).toFixed(1),
      vy: +st.velocity.y.toFixed(1),
      y: +st.position.y.toFixed(1),
      x: +st.position.x.toFixed(1),
      z: +st.position.z.toFixed(1),
      mode: st.mode,
      surf: st.surface,
      ground: st.onGround === undefined ? '?' : (st.onGround ? 1 : 0),
    });
    c.step(1 / 120);
  }
  return rows;
});
for (const r of out) if (r.i % 4 === 0) console.log(`${r.i}\td=${r.d}\tx=${r.x}\tz=${r.z}\tspd=${r.spd}\tvy=${r.vy}\ty=${r.y}\tmode=${r.mode}\tsurf=${r.surf}\tgnd=${r.ground}`);
await browser.close();
