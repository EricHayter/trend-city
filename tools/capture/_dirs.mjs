/**
 * Left/right and speed-scale verification.
 *
 * Drives moveX/moveZ directly at known camera yaws and asserts the character
 * goes where the screen says it should. `right` is cross(forward, up) for a
 * three.js camera, which is (-cos y, 0, sin y) for yaw y.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://127.0.0.1:4173/?capture=1&pr=1', { waitUntil: 'load', timeout: 90_000 });
await page.waitForFunction(() => !!window.__DESCENT__, { timeout: 240_000 });

const R = await page.evaluate(() => {
  const g = window.__DESCENT__.game, e = window.__DESCENT__.engine, DT = 1 / 120;
  e.stop(); g.input.setScripted(true); g.stage.forceRunning();
  const S = () => g.player.state;

  // Drive the physics directly with a known cameraYaw, bypassing the camera so
  // the test asserts the CONVENTION and not the camera's current heading.
  const probe = (moveX, moveZ, yaw, steps = 90) => {
    g.player.reset(S().position.clone(), yaw);
    const p0 = S().position.clone();
    const inp = { moveX, moveZ, cameraYaw: yaw, jump: false, jumpHeld: false,
      dash: false, crouch: false, attack: false, boost: false, dive: false };
    for (let i = 0; i < steps; i++) { g.player.step(inp, DT); }
    const d = S().position.clone().sub(p0);
    return { dx: +d.x.toFixed(2), dz: +d.z.toFixed(2), gs: +S().groundSpeed.toFixed(1) };
  };

  const out = {};
  // Camera yaw 0 => forward = +Z, so screen-right = -X.
  out.y0_fwd   = probe(0,  1, 0);
  out.y0_right = probe(1,  0, 0);
  out.y0_left  = probe(-1, 0, 0);
  // Camera yaw PI/2 => forward = +X, so screen-right = +Z.
  const H = Math.PI / 2;
  out.y90_fwd   = probe(0, 1, H);
  out.y90_right = probe(1, 0, H);
  // Top speed reached from a standstill on flat-ish ground, and how long.
  g.player.reset(S().position.clone(), 0);
  const inp = { moveX: 0, moveZ: 1, cameraYaw: 0, jump: false, jumpHeld: false,
    dash: false, crouch: false, attack: false, boost: false, dive: false };
  let tToTop = -1;
  for (let i = 0; i < 1200; i++) {
    g.player.step(inp, DT);
    if (tToTop < 0 && S().groundSpeed > 19.0) tToTop = +(i * DT).toFixed(2);
  }
  out.topSpeed = { gs: +S().groundSpeed.toFixed(1), secondsTo19: tToTop };
  out.hud = { speedDisplay: +g.stage.getHudModel().speedDisplay.toFixed(0),
              timeLimit: +g.stage.getHudModel().timeLeft.toFixed(0) };
  return out;
});
await browser.close();
console.log(JSON.stringify(R, null, 2));

const fail = [];
const ck = (n, c, got) => { if (!c) fail.push(`${n}  got=${JSON.stringify(got)}`); };
// yaw 0: forward is +Z
ck('yaw0 forward -> +Z', R.y0_fwd.dz > 5 && Math.abs(R.y0_fwd.dx) < Math.abs(R.y0_fwd.dz), R.y0_fwd);
// yaw 0: screen-right is -X
ck('yaw0 RIGHT -> -X', R.y0_right.dx < -5, R.y0_right);
ck('yaw0 LEFT  -> +X', R.y0_left.dx > 5, R.y0_left);
ck('left/right are opposite', Math.sign(R.y0_right.dx) === -Math.sign(R.y0_left.dx), [R.y0_right.dx, R.y0_left.dx]);
// yaw 90: forward is +X, screen-right is +Z
ck('yaw90 forward -> +X', R.y90_fwd.dx > 5, R.y90_fwd);
ck('yaw90 RIGHT -> +Z', R.y90_right.dz > 5, R.y90_right);
// speed scale
ck('top speed ~20', R.topSpeed.gs > 18 && R.topSpeed.gs < 33, R.topSpeed);
ck('reaches speed in a sane time', R.topSpeed.secondsTo19 > 0 && R.topSpeed.secondsTo19 < 6, R.topSpeed);
ck('stage clock lengthened', R.hud.timeLimit > 120, R.hud);
ck('no errors', errs.length === 0, errs);

console.log('\n=== FAILURES', fail.length, '===');
for (const f of fail) console.log('  ✗', f);
if (!fail.length) console.log('  all direction + scale assertions passed');
process.exit(fail.length ? 1 : 0);
