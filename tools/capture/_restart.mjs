/**
 * _restart.mjs — does a restart put two modals on screen at once?
 *
 * The report was "whenever we restart the game, jankiness with overlapping
 * modals and status menus and such (with each restart)", and there are two
 * distinguishable claims in it: that a restart shows overlapping panels, and
 * that it gets worse each time. Both are measurable, and neither is measurable
 * from a screenshot — a panel at 13% alpha over another panel is exactly the
 * thing a still frame makes look deliberate.
 *
 * So this reads the alphas directly. Every HUD layer carries its own `alpha`,
 * `HudCanvasRoot` keeps them in one array, and the game's own restart path is
 * driven here rather than simulated. For each of five restarts it walks the
 * transition a frame at a time and records, per frame, every layer that is
 * drawing at all.
 *
 * A layer being up is not by itself a defect — the HUD is layers, and a run has
 * a clock and a profile and pips permanently on screen. What matters is two
 * MODAL layers overlapping: a menu screen and a countdown, or a menu screen and
 * a verdict, are mutually exclusive statements about what the player should be
 * looking at. Those are named below and counted; everything else is reported as
 * a total so a leak would still show up as a number that climbs per restart.
 */
import { chromium } from 'playwright';

// The layer names as HudCanvasRoot actually holds them. The first version of
// this probe guessed 'menus' and 'warning'; the real names are 'menu' and 'warn',
// so two of the four modals were invisible to it and it reported a clean result
// it had no way of knowing.
const MODALS = ['menu', 'countdown', 'verdict', 'warn'];

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async (MODALS) => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const DT = 1 / 60;

  // `root` is private on Hud, which is a compile-time thing only.
  const P = g.player;
  const layers = g.hud.root.layers;
  const names = layers.map((l) => l.name);

  const modalsUp = () =>
    layers.filter((l) => l.alpha > 0.02 && l.visible && MODALS.includes(l.name)).map((l) => l.name);
  const anyUp = () => layers.filter((l) => l.alpha > 0.02 && l.visible).length;

  const rounds = [];
  for (let r = 0; r < 5; r++) {
    // Put the stage on a results screen the way a real run gets there, so the
    // restart under test is the one a player actually performs.
    g.stage.restart();
    g.stage.forceRunning();
    // Reaching Results honestly, and the obvious way does not work. The stage
    // finishes on route progress past 0.999, progress comes from
    // `StageDirector.stepProgress` projecting the player onto the route, and that
    // projection is a LOCAL search seeded from the previous frame's distance — so
    // teleporting the character to the finish line leaves the hint 2 km behind and
    // the projection simply never finds them. Twelve seconds of stepping at the
    // finish reported phase 'running' for exactly that reason.
    //
    // So the character is walked down the route in 25 m hops with a step between
    // each, which is what the hint is built to follow. 80 hops instead of 122
    // simulated seconds per round.
    for (let d = 0; d <= g.track.length && g.stage.phase === 'running'; d += 25) {
      const sm = g.track.sampleAtDistance(Math.min(d, g.track.length - 1));
      P.reset(
        { x: sm.position.x, y: sm.position.y + 1, z: sm.position.z },
        Math.atan2(sm.tangent.x, sm.tangent.z),
      );
      P.state.velocity.set(0, 0, 0);
      g.capture.step(DT);
    }
    // Cleared holds for VERDICT_HOLD before Results.
    for (let i = 0; i < 60 * 5 && g.stage.phase !== 'results'; i++) g.capture.step(DT);
    const phaseBefore = g.stage.phase;
    for (let i = 0; i < 60; i++) g.capture.step(DT);

    // THE RESTART. Then walk one second of transition, frame by frame.
    g.restart();
    let worstCount = 0;
    let worstSet = [];
    let worstAt = -1;
    const totals = [];
    for (let f = 0; f < 60; f++) {
      g.capture.step(DT);
      const m = modalsUp();
      if (m.length > worstCount) {
        worstCount = m.length;
        worstSet = m.slice();
        worstAt = f;
      }
      totals.push(anyUp());
    }
    rounds.push({
      restart: r + 1,
      phaseBefore,
      phaseAfter: g.stage.phase,
      worstModalOverlap: worstCount,
      worstModals: worstSet,
      atFrame: worstAt,
      layersUpMax: Math.max(...totals),
      layersUpEnd: totals[totals.length - 1],
    });
  }
  return { names, rounds };
}, MODALS);

console.log('layers: ' + out.names.join(' '));
for (const r of out.rounds) console.log(JSON.stringify(r));
await browser.close();
