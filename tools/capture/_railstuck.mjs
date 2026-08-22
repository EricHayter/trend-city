/**
 * _railstuck.mjs — why does a grind never end?
 *
 * tools/capture/_playthrough.mjs caught the "getting stuck while rail grinding"
 * report as a hard number: the aiming trial reached route distance 1150 at
 * t=90 s and then sat at exactly 1150, at exactly 6.6 m/s, in mode `grinding`,
 * for the remaining 110 seconds of the run. 61.6% of every step in the trial was
 * spent on that one rail.
 *
 * A constant speed above `GRIND.minSpeed` rules out the stall this repo just
 * fixed, and zero route progress at a non-zero speed rules out simply riding a
 * long rail. So the question is what `railDistance` is doing, and there are only
 * a few possibilities: it oscillates (a dip in the rail is a pendulum), it is
 * pinned (something re-seats it every step), or it advances against a `len` that
 * the end-of-rail test can never reach.
 *
 * This drives the same controller to the stuck state, then dumps the rail's own
 * state every step for two seconds. `railSpeed` is private, so it is read off
 * the velocity projected on the tangent, which is what it is assigned from.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async () => {
  const g = window.__DESCENT__.game;
  const P = g.player;
  const cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const DT = 1 / 120;

  g.stage.restart();
  g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0);
  cam.resetTo(P.state);

  const rails = g.traversal.traversal.rails;
  let hint = 0;
  const drive = () => {
    const pos = P.state.position;
    const pr = g.track.project(pos, hint);
    hint = pr.distance;
    const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
    const want = Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z);
    const err = wrap(want - cam.yaw);
    g.input.intent.moveX = Math.sin(err);
    g.input.intent.moveZ = Math.cos(err);
    g.capture.step(DT);
    return pr.distance;
  };

  // Run to the stuck state: 100 simulated seconds is well past the t=90 s onset.
  let t = 0;
  for (let i = 0; i < Math.round(100 / DT); i++) { drive(); t += DT; }

  const s = P.state;
  const head = {
    mode: s.mode,
    railIndex: s.railIndex,
    len: s.railIndex >= 0 ? +rails.lengthOf(s.railIndex).toFixed(2) : null,
    railCount: rails.count ?? rails.length ?? null,
  };

  // A RailSample-shaped scratch, cloned off the state's own vectors so the probe
  // does not need a THREE import of its own.
  const scratch = {
    position: s.position.clone(),
    tangent: s.velocity.clone(),
    up: s.groundNormal.clone(),
    gradient: 0,
  };

  // Two seconds of per-step rail state, decimated to 20 Hz so it is readable.
  const rows = [];
  for (let i = 0; i < Math.round(2 / DT); i++) {
    drive();
    t += DT;
    if (i % 6) continue;
    // Everything read straight off PlayerState plus one sampleAt into a scratch
    // built from the state's own vectors, so nothing here depends on being able
    // to reach a private field of the physics.
    const sm = s.railIndex >= 0
      ? rails.sampleAt(s.railIndex, s.railDistance, scratch)
      : null;
    rows.push([
      +t.toFixed(2),
      s.mode,
      s.railIndex,
      String(s.railDistance),
      String(Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z)),
      sm ? String(sm.gradient) : 'n/a',
      String(s.position.y),
    ]);
  }
  return { head, rows };
});

console.log(JSON.stringify(out.head));
console.log('t\tmode\tidx\trailDist\talong\tgrad°\ty');
for (const r of out.rows) console.log(r.join('\t'));
await browser.close();
