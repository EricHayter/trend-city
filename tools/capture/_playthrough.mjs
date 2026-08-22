/**
 * _playthrough.mjs — can a PLAYER get down the mountain?
 *
 * _autorun.mjs answers a different question. It steers on the route's own
 * tangent, writing the heading it wants straight into the physics, and it uses
 * the scripted-input path — which Game.ts deliberately feeds
 * `p.cameraYaw = player.state.facing`. So it measures the physics and the layout
 * with the camera and the input basis taken out of the loop, which is exactly
 * what it was for, and exactly why it could not see the defect that made this
 * build unplayable: holding forward rotated the character continuously at about
 * 65 deg/s, and holding forward plus a touch of right drove a perfect circle at
 * 115 deg/s forever.
 *
 * This drives `input.intent` with `setScripted(false)`, so the move vector goes
 * through `CameraDirector.yaw` the way a keyboard does. Two trials:
 *
 *   FORWARD ONLY   — no correction at all. A stable loop should hold a line and
 *                    get a long way down purely on the corridor.
 *   FORWARD + AIM  — plus a proportional correction toward the route tangent,
 *                    expressed IN CAMERA SPACE, because that is the only thing a
 *                    player can actually do: push the stick toward where they
 *                    want to end up and let the basis resolve it.
 *
 * The second trial is the playability claim. If it finishes inside the limit,
 * the game is completable by a player holding forward and steering.
 */
import { chromium } from 'playwright';

const SECONDS = Number(process.env.RUNSECS ?? 200);
const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async (SECONDS) => {
  const g = window.__DESCENT__.game;
  const P = g.player;
  const cam = g.effects.cameraDirector;
  g.capture.takeControl();
  // THE POINT OF THE WHOLE PROBE. Scripted input takes the other branch in
  // Game.update and pins cameraYaw to facing, which short-circuits the loop
  // under test.
  g.input.setScripted(false);
  g.input.update = () => {};

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const DT = 1 / 120;
  const trials = [];

  // StagePhase is a STRING enum, so the phase getter returns 'running' and the
  // like. Compared as strings rather than through any index arithmetic — the
  // first version of this counted offsets from Running and would have matched
  // nothing at all.
  const TERMINAL = new Set(['cleared', 'failed', 'results']);

  for (const aim of [0, 1]) {
    g.stage.restart();
    g.stage.forceRunning();
    const s0 = g.track.sampleAtDistance(0);
    P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
    P.state.velocity.set(0, 0, 0);
    cam.resetTo(P.state);

    let hint = 0, maxD = 0, offMax = 0, finished = null, t = 0;
    let endPhase = null;
    let airSteps = 0, slideSteps = 0, grindSteps = 0, wallSteps = 0, hurtSteps = 0;
    const steps = Math.round(SECONDS / DT);

    // A 1 Hz trace, because the summary line cannot answer the question the
    // summary line raises. 1150 m in 200 s is 5.75 m/s average against a top
    // speed of 20.2, and an average has two completely different explanations:
    // running the whole way at a third of top speed, or running at top speed
    // and losing most of the clock stuck somewhere. Those need opposite fixes.
    // Sampled per simulated second, so 200 rows, not 24000.
    const trace = [];
    let nextSample = 0;

    for (let i = 0; i < steps; i++) {
      const pos = P.state.position;
      const pr = g.track.project(pos, hint);
      hint = pr.distance;
      if (pr.distance > maxD) maxD = pr.distance;
      const off = Math.abs(pr.lateral ?? 0);
      if (off > offMax) offMax = off;

      let mx = 0, mz = 1;
      if (aim) {
        // PURE PURSUIT, and both halves of this were wrong in the first version.
        //
        // (1) Aim at a point AHEAD on the route, not at the tangent under your
        //     feet. Steering on the instantaneous tangent is a proportional
        //     controller with no phase lead, fed an error measured against a
        //     basis that lags 0.55 s by design, and it oscillated hard enough to
        //     quick-turn on nearly every step. That is what put the first run at
        //     35 m with 86% of its steps in a slide: the oscillation walked it
        //     off the corridor onto a face steeper than SLOPE.walkableNormalY,
        //     and PlayerPhysics forces a slip there (see the WALL.maxNormalY
        //     branch in the ground resolve). Lookahead is the phase lead.
        //
        // (2) A stick is a VECTOR. Pinning moveZ at 1 and putting the correction
        //     in moveX describes a stick that can only ever point within 45 deg
        //     of the basis, so no amount of gain can ask for a real turn. A
        //     player who wants to go left pushes the stick LEFT.
        const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
        const want = Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z);
        const err = wrap(want - cam.yaw);
        mx = Math.sin(err);
        mz = Math.cos(err);
      }
      g.input.intent.moveX = mx;
      g.input.intent.moveZ = mz;
      g.capture.step(DT);
      t += DT;

      const m = P.state.mode;
      if (m === 'airborne') airSteps++;
      else if (m === 'sliding') slideSteps++;
      else if (m === 'grinding') grindSteps++;
      else if (m === 'wall-run') wallSteps++;
      else if (m === 'hurt') hurtSteps++;

      if (t >= nextSample) {
        nextSample += 1;
        trace.push([
          +t.toFixed(0),
          +pr.distance.toFixed(0),
          +P.state.groundSpeed.toFixed(1),
          P.state.mode,
          +off.toFixed(0),
        ]);
      }

      // STAGE PHASE, not a `finished` flag — `StageDirector` has no such property
      // and never did, so `g.stage.state?.finished || g.stage.finished` was
      // `undefined || undefined` and this loop never broke. That is why an earlier
      // run of this probe reported `finishedAt: null` while its own trace showed
      // the route distance pinned at 2000 of 2000 from t=123 s onward: the stage
      // had cleared, gone to Results, and the probe kept driving a character who
      // was already done for another 77 seconds. Reading the phase is the only
      // honest test, and the phase is a getter that exists.
      const ph = g.stage.phase;
      if (TERMINAL.has(ph)) {
        finished = t;
        endPhase = ph;
        break;
      }
    }

    trials.push({
      trial: aim ? 'forward+aim' : 'forward only',
      finishedAt: finished === null ? null : +finished.toFixed(1),
      endPhase: endPhase ?? g.stage.phase,
      timeLimit: +(g.stage.stats?.timeLeft ?? 0).toFixed(1),
      reached: +maxD.toFixed(0),
      routeLen: +g.track.length.toFixed(0),
      pctOfRoute: +(100 * maxD / g.track.length).toFixed(1),
      maxOffLine: +offMax.toFixed(1),
      seconds: +t.toFixed(1),
      air: +(100 * airSteps / (t / DT)).toFixed(1),
      slide: +(100 * slideSteps / (t / DT)).toFixed(1),
      grind: +(100 * grindSteps / (t / DT)).toFixed(1),
      wall: +(100 * wallSteps / (t / DT)).toFixed(1),
      hurt: +(100 * hurtSteps / (t / DT)).toFixed(1),
      trace,
    });
  }
  return trials;
}, SECONDS);

for (const r of out) {
  const { trace, ...head } = r;
  console.log(JSON.stringify(head));
  // One row per simulated second: t, distance, horizontal speed, mode, off-line.
  for (const row of trace) console.log('   ' + row.join('\t'));
}
await browser.close();
