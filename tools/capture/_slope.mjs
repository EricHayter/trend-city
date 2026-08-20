/**
 * _slope — what speed does the mountain hand you for holding forward?
 *
 * Two questions, and the second only exists because the first one's answer was
 * a probe artefact.
 *
 * ONE: is the character grounded on the descent? `_kicker` reported 200 straight
 * steps of `airborne` at a constant 0.60 m of clearance with a vertical velocity
 * of -10 to -15 m/s, which would have meant the run never registers a foot
 * contact — and air control, friction, the run gears and every animation hang off
 * the mode. ANSWERED, NO DEFECT: every sample point here is `grounded` for
 * essentially all 360 steps with clearance over the heightfield of exactly zero.
 * `_kicker` started 0.6 m above the ribbon and never settled.
 *
 * TWO: `RUN.hardMax` is 29.98 m/s and this probe first read peaks of 31.5 and
 * 34.1 from a standing start with nothing held but forward. The 34.1 was a
 * booster — removing `BoosterField.items` drops it to 29.1. The 31.5 was not,
 * and survived the removal unchanged.
 *
 * So it reports HORIZONTAL speed as well as 3D. They are far apart on a mountain
 * and only the horizontal one is governed: `stepGrounded` clamps
 * `hypot(velocity.x, velocity.z)` to `RUN.hardMax` and then DERIVES
 * `velocity.y` from the floor normal, so the 3D magnitude a player experiences
 * is the clamped horizontal divided by `cos(grade)`, plus `GRAVITY.groundStick`.
 * At the 58.7-degree limit `SLOPE.walkableNormalY` allows, that is a factor of
 * 1.9 the clamp never sees.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const rows = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const P = g.player;
  g.scriptedInput = {
    moveX: 0, moveZ: 1, cameraYaw: 0,
    jump: false, jumpHeld: false, dash: false, crouch: false,
    attack: false, boost: false, dive: false,
  };

  // Boosters make the speed question unanswerable: a pad is +32% of top speed
  // and a dash ring is an absolute 1.24-1.30x, so a run that crosses either
  // measures the booster and not the slope. This probe is about the slope.
  g.traversal.traversal.boosters.items.length = 0;

  const out = [];
  for (const d0 of [100, 350, 600, 850, 1100, 1350, 1600, 1850]) {
    const s = g.track.sampleAtDistance(d0);
    g.stage.restart();
    g.stage.forceRunning();
    // Start ON the ribbon, at rest, and let it settle before measuring: a probe
    // that starts in the air and measures immediately measures its own drop.
    P.reset({ x: s.position.x, y: s.position.y, z: s.position.z }, Math.atan2(s.tangent.x, s.tangent.z));
    P.state.velocity.set(0, 0, 0);
    for (let i = 0; i < 60; i++) g.capture.step(1 / 120);

    const modes = {};
    let minTerr = Infinity, maxTerr = -Infinity, minRib = Infinity, maxRib = -Infinity;
    let peakH = 0, peak3 = 0, gradeAtPeak = 0, maxGrade = 0;
    for (let i = 0; i < 360; i++) {
      g.capture.step(1 / 120);
      const p = P.state.position;
      const v = P.state.velocity;
      const m = P.state.mode;
      modes[m] = (modes[m] ?? 0) + 1;
      const overT = p.y - g.terrain.heightAt(p.x, p.z);
      const proj = g.track.project(p);
      const overR = p.y - proj.sample.position.y;
      if (overT < minTerr) minTerr = overT;
      if (overT > maxTerr) maxTerr = overT;
      if (overR < minRib) minRib = overR;
      if (overR > maxRib) maxRib = overR;
      const h = Math.hypot(v.x, v.z);
      const grade = Math.atan2(-Math.min(0, v.y), Math.max(1e-6, h)) * 180 / Math.PI;
      if (grade > maxGrade) maxGrade = grade;
      if (h > peakH) { peakH = h; gradeAtPeak = grade; }
      if (P.state.speed > peak3) peak3 = P.state.speed;
    }
    out.push({
      d0,
      modes,
      overTerrain: [+minTerr.toFixed(2), +maxTerr.toFixed(2)],
      overRibbon: [+minRib.toFixed(2), +maxRib.toFixed(2)],
      peakH: +peakH.toFixed(2),
      peak3: +peak3.toFixed(2),
      gradeAtPeak: +gradeAtPeak.toFixed(1),
      maxGrade: +maxGrade.toFixed(1),
    });
  }
  return out;
});

console.log('boosters removed — slope and forward input only\n');
console.log('  d0   peakH  peak3   grade  maxGrade   overTerrain      overRibbon     modes');
for (const r of rows) {
  console.log(
    `${String(r.d0).padStart(5)}  ${String(r.peakH).padStart(5)}  ${String(r.peak3).padStart(5)}` +
    `  ${String(r.gradeAtPeak).padStart(5)}  ${String(r.maxGrade).padStart(8)}   ` +
    `${JSON.stringify(r.overTerrain).padEnd(15)}  ${JSON.stringify(r.overRibbon).padEnd(15)}  ${JSON.stringify(r.modes)}`,
  );
}
console.log('\nRUN.max 20.17   RUN.hardMax 29.98   both are HORIZONTAL ceilings.');
console.log('peakH over hardMax = the governor is broken. peak3 over it is just geometry.');
await browser.close();
