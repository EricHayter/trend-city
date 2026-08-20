// Dump the live rig's internal state for a pose: pose channels, foot targets,
// gait phase and the physics state that drives them.
import { chromium } from 'playwright';

const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const POSE = process.argv[2] ?? 'run-cycle';
const FRAMES = Number(process.argv[3] ?? 40);

const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 120_000 });

const out = await page.evaluate(({ pose, frames }) => {
  const { game } = window.__DESCENT__;
  game.capture.takeControl();
  game.capture.setPose(pose);
  const trail = [];
  for (let i = 0; i < frames; i++) {
    game.capture.step(1 / 60);
    const r = game.player.rig, st = game.player.physics.state;
    if (i >= frames - 6) {
      trail.push({
        f: i,
        mode: st.mode, gs: +st.groundSpeed.toFixed(2), grad: +st.gradient.toFixed(3),
        phase: +r.gaitPhase.toFixed(3), rate: +r.cycleRate.toFixed(3), stride: +r.stride.toFixed(3),
        reachXZ: +r.reachXZ.toFixed(3), hipY: +r.hipY.toFixed(3),
        lean: +r.pose.lean.toFixed(3), hipDrop: +r.pose.hipDrop.toFixed(3), hyper: +r.pose.hyper.toFixed(3),
        legHold: +r.pose.legHold.toFixed(3),
        fL: r.feet[0].target.toArray().map((v) => +v.toFixed(3)),
        fR: r.feet[1].target.toArray().map((v) => +v.toFixed(3)),
        cL: +r.feet[0].contact.toFixed(2), cR: +r.feet[1].contact.toFixed(2),
        pL: r.feet[0].planted, pR: r.feet[1].planted,
      });
    }
  }
  return trail;
}, { pose: POSE, frames: FRAMES });

for (const t of out) console.log(JSON.stringify(t));
await browser.close();
