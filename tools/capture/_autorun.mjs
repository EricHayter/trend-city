// Can the course be completed? Autopilot from the start line to the finish.
//
// Steers on the route's own tangent rather than a camera, so what is measured is
// the physics and the layout, not the harness. moveZ is pinned at 1 for the
// whole run: the question is whether a player who only ever holds forward and
// corrects their line can get down the mountain inside the time limit.
import { chromium } from 'playwright';
const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const SECONDS = Number(process.env.RUNSECS ?? 180);
const SGN = Number(process.env.SGN ?? 1);
const LSGN = Number(process.env.LSGN ?? 1);
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log(`[err] ${m.text()}`); });
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180_000 });

const out = await page.evaluate(async ({ SECONDS, SGN, LSGN }) => {
  const { game } = window.__DESCENT__;
  const c = game.capture;
  c.takeControl();
  game.restart ? game.restart() : game.capture.setPose('summit-wide');
  // Straight to the start line, clock running.
  game.respawn?.();
  const st = game.player.state;
  const Vec = st.position.constructor;
  const probe = new Vec();

  const input = {
    moveX: 0, moveZ: 1, cameraYaw: 0,
    jump: false, jumpHeld: false, dash: false, crouch: false,
    attack: false, boost: false, dive: false,
  };
  game.scriptedInput = input;

  const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  const steps = Math.round(SECONDS * 120);
  const log = [];
  let lastD = 0, stuckFor = 0, airFor = 0, maxAir = 0;
  let finishedAt = -1;
let cleared = false;
  const gain = {}, drop = {};
  let biggest = { dv: 0 };
  const spikes = [];

  for (let i = 0; i < steps; i++) {
    probe.copy(st.position);
    const pr = game.track.project(probe);
    const s = game.track.sampleAtDistance(pr.distance);
    const wantYaw = Math.atan2(s.tangent.x, s.tangent.z);
    const headErr = wrap(wantYaw - st.facing);
    // Lateral sign: positive `lateral` is toward `left`, and moveX is the
    // character's right, so the correction is negative in `lateral`.
    const lat = pr.lateral ?? 0;
    input.moveX = Math.max(-1, Math.min(1, SGN * (headErr * 1.6) + LSGN * (lat * 0.09)));
    // Jump only where the ribbon bridges air ahead — the ravine.
    const ahead = game.track.sampleAtDistance(Math.min(game.track.length, pr.distance + 14));
    const voidAhead = ahead.position.y - game.terrain.heightAt(ahead.position.x, ahead.position.z);
    input.jump = voidAhead > 4 && st.mode !== 'airborne';

    const spdBefore = Math.hypot(st.velocity.x, st.velocity.z);
    const modeBefore = st.mode;
    c.step(1 / 120);
    // Where does speed actually come FROM? A terminal-velocity calculation is
    // only as good as the assumption that the slope term is the dominant one, so
    // attribute every per-step gain to the mode it happened in and let the
    // totals say which term is really driving the run.
    {
      const dv = Math.hypot(st.velocity.x, st.velocity.z) - spdBefore;
      if (dv > 0) gain[modeBefore] = (gain[modeBefore] ?? 0) + dv;
      else drop[modeBefore] = (drop[modeBefore] ?? 0) + dv;
      if (dv > biggest.dv) biggest = { dv: +dv.toFixed(3), mode: modeBefore, t: +(i / 120).toFixed(2), spd: +spdBefore.toFixed(1) };
      // A step cannot legitimately gain more than the largest acceleration in the
      // table times dt. Anything past that is a discontinuity, so log the context
      // that identifies which one.
      if (dv > 1.0 && spikes.length < 12) spikes.push({
        t: +(i / 120).toFixed(2), dv: +dv.toFixed(2),
        from: +spdBefore.toFixed(1), to: +Math.hypot(st.velocity.x, st.velocity.z).toFixed(1),
        modeBefore, modeAfter: st.mode,
        deg: +(Math.acos(Math.min(1, st.groundNormal.y)) * 180 / Math.PI).toFixed(0),
        d: Math.round(game.stage.routeDistance), vy: +st.velocity.y.toFixed(1),
      });
    }

    if (st.mode === 'airborne') { airFor += 1 / 120; if (airFor > maxAir) maxAir = airFor; } else airFor = 0;
    const d = game.stage.routeDistance;
    if (d - lastD < 0.02) stuckFor += 1 / 120; else stuckFor = 0;
    lastD = d;

    if (i % 240 === 0) {
      log.push({
        t: +(i / 120).toFixed(1), d: Math.round(d),
        spd: +Math.hypot(st.velocity.x, st.velocity.z).toFixed(1),
        // Local grade in degrees, from the ground normal the physics is using.
        // Speed without the grade beside it cannot tell a terminal velocity from
        // a runaway: both look like "fast".
        deg: +(Math.acos(Math.min(1, st.groundNormal.y)) * 180 / Math.PI).toFixed(0),
        y: Math.round(st.position.y), lat: +lat.toFixed(1),
        mode: st.mode, phase: game.stage.phase,
        cp: game.stage.getHudModel?.().checkpoint ?? '?',
      });
    }
    if (stuckFor > 4) { log.push({ STUCK_AT: Math.round(d), t: +(i / 120).toFixed(1), mode: st.mode, lat: +lat.toFixed(1) }); break; }
    // The stage never enters a phase called 'finished' — `finish()` sets Cleared
    // or Failed and then Results. Watching for the wrong name is why earlier runs
    // reported finishedAt=-1 on a run that demonstrably reached d=2000.
    if (finishedAt < 0 && (game.stage.phase === 'cleared' || game.stage.phase === 'failed')) {
      finishedAt = i / 120;
      cleared = game.stage.phase === 'cleared';
    }
    if (game.stage.phase === 'results') break;
  }
  return { log, finishedAt, maxAir, gain, drop, biggest, spikes, length: +game.track.length.toFixed(0), phase: game.stage.phase, elapsed: +(game.stage.elapsed ?? -1).toFixed(2) };
}, { SECONDS, SGN, LSGN });

for (const r of out.log) console.log(JSON.stringify(r));
console.log('gain per mode', JSON.stringify(out.gain));
console.log('loss per mode', JSON.stringify(out.drop));
for (const sp of out.spikes) console.log('SPIKE', JSON.stringify(sp));
console.log('biggest single-step gain', JSON.stringify(out.biggest));
console.log(`length=${out.length} finishedAt=${out.finishedAt} phase=${out.phase} maxAirborne=${out.maxAir.toFixed(2)}s`);
await browser.close();
