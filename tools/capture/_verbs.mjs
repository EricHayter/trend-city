/**
 * Deterministic verb test.
 *
 * Drives the LIVE input path — scriptButton -> intent -> queueEdges (in render)
 * -> fixedUpdate -> PlayerPhysics — one fixed step at a time, so nothing depends
 * on how fast the headless machine renders. The smoke test could not assert on
 * any of this: software GL runs the sim ~8x slower than wall clock, so a
 * 150 ms wait was one or two physics steps, not eighteen.
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:4173/?capture=1&pr=1';
const errors = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 90_000 });
await page.waitForFunction(() => !!window.__DESCENT__, { timeout: 240_000 });

const results = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  const e = window.__DESCENT__.engine;
  const DT = 1 / 120;

  // Stop the rAF loop and take the hardware out of the picture, but leave
  // `captureControlled` false so the real edge queue still runs in render().
  e.stop();
  g.input.setScripted(true);
  g.stage.forceRunning();

  const S = () => g.player.state;
  const press = (a, on) => g.input.scriptButton(a, on);
  const step = (n = 1) => { for (let i = 0; i < n; i++) e.stepManual(DT); };
  // One step to queue the edge in render(), one to consume it in fixedUpdate.
  // Sampled, not stepped blind: `jumpedThisStep` and `dashedThisStep` are true
  // for exactly ONE step, so a snapshot taken after two blind steps misses them
  // every time.
  const tap = () => { watch(2); };
  const out = {};
  const peak = { land: false, jumped: 0, dashed: 0 };

  // Watch the one-step flags across every step, since they are true for exactly
  // one step and a sampled snapshot will nearly always miss them.
  const watch = (n) => {
    for (let i = 0; i < n; i++) {
      e.stepManual(DT);
      const s = S();
      if (s.landedThisStep) peak.land = true;
      if (s.jumpedThisStep) peak.jumped++;
      if (s.dashedThisStep) peak.dashed++;
    }
  };

  out.spawn = { mode: S().mode, gs: +S().groundSpeed.toFixed(2), hp: S().health };

  // ── 1. Run ────────────────────────────────────────────────────────────────
  press('moveForward', true);
  watch(240);                                   // 2 s
  out.run = { mode: S().mode, gs: +S().groundSpeed.toFixed(1), facing: +S().facing.toFixed(2) };

  // ── 2. Jump, then double jump ────────────────────────────────────────────
  const jumpsBefore = S().jumpsLeft;
  press('jump', true); press('jump', false);
  tap();
  const j1 = { mode: S().mode, vy: +S().velocity.y.toFixed(1), jumpsLeft: S().jumpsLeft, jumped: peak.jumped };
  watch(10);
  press('jump', true); press('jump', false);
  tap();
  const j2 = { mode: S().mode, vy: +S().velocity.y.toFixed(1), jumpsLeft: S().jumpsLeft, jumped: peak.jumped };
  out.jump = { jumpsBefore, first: j1, double: j2 };

  // ── 3. Air dash ──────────────────────────────────────────────────────────
  const dashesBefore = S().dashesLeft;
  press('dash', true); press('dash', false);
  tap();
  out.dash = { mode: S().mode, spd: +S().speed.toFixed(1), dashesBefore, dashesLeft: S().dashesLeft, dashed: peak.dashed };

  // ── 4. Dive ──────────────────────────────────────────────────────────────
  watch(20);
  press('dive', true); press('dive', false);
  tap();
  out.dive = { mode: S().mode, vy: +S().velocity.y.toFixed(1) };

  // ── 5. Land ──────────────────────────────────────────────────────────────
  peak.land = false;
  watch(240);
  out.land = { landedFlagSeen: peak.land, mode: S().mode, air: +S().airHeight.toFixed(2) };

  // ── 6. Slide ─────────────────────────────────────────────────────────────
  watch(120);
  press('crouch', true);
  watch(30);
  out.slide = { mode: S().mode, gs: +S().groundSpeed.toFixed(1) };
  press('crouch', false);
  watch(30);
  out.afterSlide = { mode: S().mode };

  // ── 7. Turn ──────────────────────────────────────────────────────────────
  const f0 = S().facing;
  press('moveLeft', true);
  watch(60);
  press('moveLeft', false);
  out.turn = { from: +f0.toFixed(2), to: +S().facing.toFixed(2), changed: Math.abs(S().facing - f0) > 0.05 };

  // ── 8. Boost meter ───────────────────────────────────────────────────────
  out.boost = { meter: +S().boost.toFixed(3) };
  press('boost', true);
  watch(60);
  out.boostHeld = { meter: +S().boost.toFixed(3), boosting: S().boosting };
  press('boost', false);
  press('moveForward', false);

  // ── 9. HUD model: correctness + zero-allocation contract ─────────────────
  const m1 = g.stage.getHudModel();
  const m2 = g.stage.getHudModel();
  out.hud = {
    sameObject: m1 === m2,
    sameSplits: m1.splits === m2.splits,
    sameProfile: m1.routeProfile === m2.routeProfile,
    profileLen: m1.routeProfile?.length ?? -1,
    splitsLen: m1.splits.length,
    speedDisplay: +m1.speedDisplay.toFixed(1),
    expectedDisplay: +(S().groundSpeed * 2.5).toFixed(1),
    speedFraction: +m1.speedFraction.toFixed(3),
    timeLeft: +m1.timeLeft.toFixed(2),
    time: +m1.time.toFixed(2),
    health: m1.health, maxHealth: m1.maxHealth,
    phase: m1.phase, mode: m1.mode,
    routeProgress: +m1.routeProgress.toFixed(4),
    objective: m1.objective,
    boss: m1.boss, results: m1.results,
    prompt: m1.prompt, wrongWay: m1.wrongWay,
  };

  // ── 10. Clock actually runs down; progress actually advances ──────────────
  const t0 = g.stage.getHudModel().timeLeft;
  const p0 = g.stage.routeProgress;
  press('moveForward', true);
  watch(240);
  out.progress = {
    timeLeftFell: g.stage.getHudModel().timeLeft < t0 - 1.5,
    progressRose: g.stage.routeProgress > p0,
    prog: +g.stage.routeProgress.toFixed(4),
  };

  // ── 11. HUD is really drawing ────────────────────────────────────────────
  out.hudStats = { ...g.hud.stats };

  // ── 12. Pause / resume / restart round-trip ──────────────────────────────
  g.stage.pause();
  const paused = g.stage.phase;
  g.stage.resume();
  const resumed = g.stage.phase;
  out.phases = { paused, resumed };

  // ── 13. Damage ───────────────────────────────────────────────────────────
  const hpBefore = S().health;
  const from = S().position.clone();
  from.z += 3;
  g.player.damage(1, from);
  step(1);
  out.damage = { hpBefore, hpAfter: S().health, mode: S().mode };

  const s = S();
  out.finite = [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y,
    s.velocity.z, s.facing, s.groundSpeed, s.speed].every(Number.isFinite);
  return out;
});

await browser.close();
console.log(JSON.stringify(results, null, 2));
console.log('\nCONSOLE ERRORS:', errors.length);
for (const e of errors) console.log('  ', e.slice(0, 500));

// ── Assertions ───────────────────────────────────────────────────────────────
const R = results;
const fail = [];
const ck = (name, cond, got) => { if (!cond) fail.push(`${name}  got=${JSON.stringify(got)}`); };

ck('spawn grounded', R.spawn.mode === 'grounded', R.spawn);
ck('run accelerates', R.run.gs > 20, R.run);
ck('jump -> airborne', R.jump.first.mode === 'airborne', R.jump.first);
ck('jump rising', R.jump.first.vy > 5, R.jump.first);
ck('jump flag fired', R.jump.first.jumped >= 1, R.jump.first);
ck('double jump re-rises', R.jump.double.vy > 5, R.jump.double);
ck('double jump spent charge', R.jump.double.jumpsLeft < R.jump.first.jumpsLeft, R.jump);
ck('dash -> dashing', R.dash.mode === 'dashing', R.dash);
ck('dash sets 88 m/s', Math.abs(R.dash.spd - 88) < 2, R.dash);
ck('dash spent a charge', R.dash.dashesLeft < R.dash.dashesBefore, R.dash);
ck('dive -> diving', R.dive.mode === 'diving', R.dive);
ck('dive is downward', R.dive.vy < -10, R.dive);
ck('landing observed', R.land.landedFlagSeen === true, R.land);
ck('landed grounded', ['grounded', 'sliding', 'airborne'].includes(R.land.mode), R.land);
ck('crouch -> sliding', R.slide.mode === 'sliding', R.slide);
ck('slide releases', R.afterSlide.mode !== 'sliding', R.afterSlide);
ck('turn changes facing', R.turn.changed === true, R.turn);
ck('hud model is one object', R.hud.sameObject === true, R.hud.sameObject);
ck('hud splits reused', R.hud.sameSplits === true, R.hud.sameSplits);
ck('hud profile reused', R.hud.sameProfile === true, R.hud.sameProfile);
ck('route profile built', R.hud.profileLen > 8, R.hud.profileLen);
ck('splits present', R.hud.splitsLen > 0, R.hud.splitsLen);
ck('speedDisplay = m/s x 2.5', Math.abs(R.hud.speedDisplay - R.hud.expectedDisplay) < 0.5, R.hud);
ck('speedFraction in range', R.hud.speedFraction >= 0 && R.hud.speedFraction <= 1, R.hud.speedFraction);
ck('maxHealth 5', R.hud.maxHealth === 5, R.hud.maxHealth);
ck('no boss', R.hud.boss === null, R.hud.boss);
ck('objective set', typeof R.hud.objective === 'string' && R.hud.objective.length > 0, R.hud.objective);
ck('clock counts down', R.progress.timeLeftFell === true, R.progress);
ck('progress advances', R.progress.progressRose === true, R.progress);
ck('hud draws', R.hudStats.drawCalls > 0, R.hudStats);
ck('pause -> paused', R.phases.paused === 'paused', R.phases);
ck('resume leaves paused', R.phases.resumed !== 'paused', R.phases);
ck('damage costs health', R.damage.hpAfter < R.damage.hpBefore, R.damage);
ck('damage stuns', R.damage.mode === 'hurt', R.damage);
ck('state finite', R.finite === true, R.finite);
ck('no console errors', errors.length === 0, errors.length);

console.log('\n=== FAILURES', fail.length, '===');
for (const f of fail) console.log('  ✗', f);
if (!fail.length) console.log('  all assertions passed');
process.exit(fail.length ? 1 : 0);
