/**
 * _camshot — look at the camera while the character is actually running.
 *
 * `_camloop` proved the input basis is stable now, but it proved it in numbers.
 * The chase rig still takes its anchor from `travelYaw`, which is the VELOCITY
 * direction, while the character's facing is now an independent state — so on a
 * traverse the two disagree and the character crabs across the frame. Whether
 * that reads as life or as a bug is not a thing numbers answer.
 */
import { chromium } from 'playwright';

const OUT = '/tmp/camshots';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
});

for (const [name, d0, mx] of [['start', 100, 0], ['scree46', 380, 0], ['switchback', 900, 0.35], ['ridge', 1650, 0]]) {
  await page.evaluate(([d0, mx]) => {
    const g = window.__DESCENT__.game;
    const P = g.player;
    const s = g.track.sampleAtDistance(d0);
    g.stage.restart();
    g.stage.forceRunning();
    P.reset({ x: s.position.x, y: s.position.y, z: s.position.z }, Math.atan2(s.tangent.x, s.tangent.z));
    P.state.velocity.set(0, 0, 0);
    g.effects.cameraDirector.resetTo(P.state);
    g.input.intent.moveX = mx;
    g.input.intent.moveZ = 1;
    // Two seconds to reach speed and let the rig settle.
    for (let i = 0; i < 240; i++) g.capture.step(1 / 120);
  }, [d0, mx]);
  await page.evaluate(() => window.__DESCENT__.game.capture.render?.());
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const info = await page.evaluate(() => {
    const g = window.__DESCENT__.game;
    const P = g.player.state;
    const c = g.effects.cameraDirector;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const travel = Math.atan2(P.velocity.x, P.velocity.z);
    return {
      mode: P.mode,
      h: +Math.hypot(P.velocity.x, P.velocity.z).toFixed(2),
      crab: +(wrap(travel - P.facing) * 180 / Math.PI).toFixed(1),
      inputLead: +(wrap(c.yaw - P.facing) * 180 / Math.PI).toFixed(1),
      lensLead: +(wrap(c.lensYaw - P.facing) * 180 / Math.PI).toFixed(1),
    };
  });
  console.log(`${name.padEnd(11)} ${JSON.stringify(info)}`);
}
await browser.close();
