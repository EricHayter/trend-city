/**
 * _circle.mjs — does a held lateral stick converge, or orbit?
 *
 * `CameraDirector.inputYaw` is documented as a pure damped follow of the
 * subject's facing, chosen to kill a runaway feedback loop that the cinematic
 * lead term used to create. It does kill that loop, but a pure follow is
 * UNITY gain rather than positive gain, and a unity-gain loop preserves the
 * offset it is given: the stick asks for facing + 90 deg, facing slews there,
 * the basis follows facing, the request is still facing + 90 deg. The fixed
 * point the comment claims exists is only a fixed point when the stick is
 * centred or dead forward.
 *
 * If that reading is right, holding W+A rotates the character forever at
 * roughly `RUN.turnRate` and the path is a circle, which is the whole of
 * "movement feels stiff and janky" — there is no way to make a controlled turn
 * and then stop turning.
 *
 * Reports, per stick: yaw rate averaged over the last second of a 6 s hold, and
 * total heading travelled. A convergent control scheme ends with a rate near
 * zero. An orbit ends with a rate near the turn rate and a heading total of
 * several full revolutions.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=default'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await p.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const out = await p.evaluate(async () => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const DT = 1 / 120, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const rows = [];
  for (const [name, mx, mz] of [['W', 0, 1], ['W+A', -1, 1], ['A', -1, 0], ['W+slight A', -0.35, 1]]) {
    g.stage.restart(); g.stage.forceRunning();
    const s0 = g.track.sampleAtDistance(0);
    P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z },
      Math.atan2(s0.tangent.x, s0.tangent.z));
    P.state.velocity.set(0, 0, 0);
    cam.resetTo(P.state);
    g.input.intent.moveX = mx; g.input.intent.moveZ = mz;
    let total = 0, prev = P.state.facing, lastSecond = 0, prevAt5 = 0;
    const steps = Math.round(6 / DT);
    for (let i = 0; i < steps; i++) {
      g.capture.step(DT);
      const d = wrap(P.state.facing - prev); prev = P.state.facing; total += d;
      if (i === Math.round(5 / DT)) prevAt5 = total;
    }
    lastSecond = total - prevAt5;
    rows.push({
      stick: name,
      degPerSecFinal: +(lastSecond * 180 / Math.PI).toFixed(1),
      totalRevs: +(total / (2 * Math.PI)).toFixed(2),
      basisMinusFacingDeg: +(wrap(cam.yaw - P.state.facing) * 180 / Math.PI).toFixed(1),
      speed: +P.state.groundSpeed.toFixed(1),
    });
  }
  return rows;
});
for (const r of out) console.log(JSON.stringify(r));
await b.close();
