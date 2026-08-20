/**
 * _camloop — is the camera/movement coupling stable?
 *
 * Movement is camera-relative: `Game.buildPlayerInput` sets
 * `p.cameraYaw = cameraDirector.yaw`, and `PlayerPhysics` resolves the move
 * stick against it. `cameraDirector.yaw` is read from the FULLY COMPOSED camera
 * (`getWorldDirection` after `lookAt`), so it carries the lagged heading, the
 * under-damped chase spring (`chaseZeta` 0.68), the corner-lead arc
 * (`cornerLookArc` 0.75, `cornerSwing` 0.24) and the buffet.
 *
 * That is a closed loop: heading -> lag and overshoot and corner lead -> move
 * basis -> heading. The corner-lead term is the dangerous one, because it aims
 * the camera FURTHER round the corner than the character is facing, which makes
 * "forward" point further into the turn, which turns the character further.
 * Positive feedback with a loop gain that has never been measured.
 *
 * Every physics probe so far has been blind to this. Scripted input takes the
 * other branch — `Game` line 678 sets `p.cameraYaw = player.state.facing` for
 * the autopilot on purpose — so `_slope`, `_railprobe` and `_kicker` all ran
 * with the loop OPEN and measured the physics alone.
 *
 * This closes it, holding pure forward from rest, and reports the heading and
 * the camera yaw against each other.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const data = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const P = g.player;
  const cam = g.effects.cameraDirector;

  // Drive the LIVE intent, not `scriptedInput`, so `buildPlayerInput` takes the
  // camera-relative branch. `Input.update` is neutered for the same reason: it
  // would overwrite the intent from a keyboard nobody is touching.
  g.input.setScripted(false);
  const inp = g.input;
  inp.update = () => {};

  const runs = [];
  for (const trial of [
    { name: 'forward only', mx: 0, mz: 1 },
    { name: 'forward+right 0.4', mx: 0.4, mz: 1 },
    { name: 'hard right', mx: 1, mz: 0 },
  ]) {
    const s = g.track.sampleAtDistance(1350);
    g.stage.restart();
    g.stage.forceRunning();
    P.reset({ x: s.position.x, y: s.position.y, z: s.position.z }, Math.atan2(s.tangent.x, s.tangent.z));
    P.state.velocity.set(0, 0, 0);
    cam.resetTo(P.state);

    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    inp.intent.moveX = trial.mx;
    inp.intent.moveZ = trial.mz;

    const trace = [];
    let maxLead = 0, maxTurnRate = 0, prevFacing = P.state.facing;
    for (let i = 0; i < 480; i++) {
      g.capture.step(1 / 120);
      const lead = wrap(cam.yaw - P.state.facing);
      const rate = Math.abs(wrap(P.state.facing - prevFacing)) * 120;
      prevFacing = P.state.facing;
      if (Math.abs(lead) > Math.abs(maxLead)) maxLead = lead;
      if (rate > maxTurnRate) maxTurnRate = rate;
      if (i % 40 === 0) {
        trace.push({
          t: +(i / 120).toFixed(2),
          facing: +(P.state.facing * 180 / Math.PI).toFixed(1),
          camYaw: +(cam.yaw * 180 / Math.PI).toFixed(1),
          lead: +(lead * 180 / Math.PI).toFixed(1),
          h: +Math.hypot(P.state.velocity.x, P.state.velocity.z).toFixed(2),
        });
      }
    }
    // Total yaw travelled over the run, unwrapped, tells a spiral from a settle.
    runs.push({ name: trial.name, maxLead: +(maxLead * 180 / Math.PI).toFixed(1), maxTurnRate: +maxTurnRate.toFixed(2), trace });
  }
  return { runs, turnRateLow: 12.0, turnRateHigh: 2.2 };
});

for (const r of data.runs) {
  console.log(`\n=== ${r.name} ===  worst camera lead ${r.maxLead} deg, peak turn rate ${r.maxTurnRate} rad/s`);
  console.log('    t     facing   camYaw    lead    h');
  for (const s of r.trace) {
    console.log(`  ${String(s.t).padStart(5)}  ${String(s.facing).padStart(7)}  ${String(s.camYaw).padStart(7)}  ${String(s.lead).padStart(6)}  ${String(s.h).padStart(5)}`);
  }
}
console.log('\nlead is camera yaw minus character facing. Holding pure forward, a stable loop');
console.log('settles it near zero. A lead that grows, or flips sign every second, is the loop.');
await browser.close();
