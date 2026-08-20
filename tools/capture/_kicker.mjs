/**
 * _kicker — does the ramp wedge exist to the physics, or only to the eye?
 *
 * `BoosterField` builds a ramp through `MeshBuilder`, which is render geometry,
 * and `BoosterKind.Ramp` is explicitly skipped by `probe` ("Ramps are geometry.
 * They never fire."). The player, meanwhile, resolves against the terrain
 * heightfield. If nothing registers the wedge as collision then the kicker is a
 * prop the character runs through, and the README's claim that "the geometry
 * does the work" is false.
 *
 * Test: run at the lip on the route tangent and watch Y. A real ramp shows
 * `velocity.y` going positive while still grounded, then a launch.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const out = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const L = g.traversal.layout;
  const P = g.player;
  const ramps = L.boosters.filter((b) => b.kind === 'ramp');
  if (!ramps.length) return { err: 'no ramps in layout' };

  g.scriptedInput = {
    moveX: 0, moveZ: 1, cameraYaw: 0,
    jump: false, jumpHeld: false, dash: false, crouch: false,
    attack: false, boost: false, dive: false,
  };

  const rows = [];
  for (const r of ramps) {
    // Start 18 m up-route of the lip, on the trail, at speed, so the character
    // arrives at the wedge the way a player would.
    const d0 = r.routeDistance - 18;
    const s = g.track.sampleAtDistance(d0);
    const top = (74 * 9.81) / 36;
    g.stage.restart();
    g.stage.forceRunning();
    P.reset({ x: s.position.x, y: s.position.y + 0.6, z: s.position.z }, Math.atan2(s.tangent.x, s.tangent.z));
    P.state.velocity.set(s.tangent.x * top, 0, s.tangent.z * top);

    const trace = [];
    let peakVy = -Infinity, peakAbove = -Infinity, airSteps = 0;
    for (let i = 0; i < 200; i++) {
      g.capture.step(1 / 120);
      const p = P.state.position;
      const ground = g.terrain.heightAt(p.x, p.z);
      const above = p.y - ground;
      if (P.state.velocity.y > peakVy) peakVy = P.state.velocity.y;
      if (above > peakAbove) peakAbove = above;
      if (P.state.mode === 'airborne') airSteps++;
      if (i % 20 === 0) {
        trace.push(`s${i} above=${above.toFixed(2)} vy=${P.state.velocity.y.toFixed(2)} ${P.state.mode}`);
      }
    }
    rows.push({
      d: Math.round(r.routeDistance),
      lipAngleDeg: +(r.power * 180 / Math.PI).toFixed(1),
      peakVy: +peakVy.toFixed(2),
      peakAboveGround: +peakAbove.toFixed(2),
      airSteps,
      trace,
    });
  }
  return { rows };
});

if (out.err) console.log('ERR', out.err);
else for (const r of out.rows) {
  console.log(`ramp d=${r.d} lip=${r.lipAngleDeg}deg  peakVy=${r.peakVy}  peakAboveGround=${r.peakAboveGround}  airborne ${r.airSteps}/200 steps`);
  for (const t of r.trace) console.log('    ' + t);
}
await browser.close();
