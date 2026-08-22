/**
 * _lineab.mjs — does the speed-line field own the wide pale bars, or not?
 *
 * The bars across the lower frame and the left cliff in _camshot's `scree46`
 * look like drawn blinds, and the speed-line field was the obvious suspect
 * because its ramp was mis-ranged and pinned at full strength. It no longer is:
 * the published intensity at that site is 0.188 and CompositePass paints
 * `stroke * intensity * live * 0.62`, so the strokes cannot exceed 11.7% of the
 * way to paper white. That is an argument, not a measurement, so this measures.
 *
 * THE TRAP, inherited from _ab.mjs and worth repeating: PostPipeline.render()
 * calls composite.syncState() immediately before it draws, and syncState reloads
 * EVERY uniform out of POST_STATE. Writing a uniform and then rendering measures
 * nothing. The override goes on syncState itself.
 *
 * Unlike _ab.mjs this drives the live player to a route distance rather than
 * setting a canned pose, because the whole question is about a speed-dependent
 * effect at a specific grade.
 *
 * READ THE IDEMPOTENCE LINE FIRST, AND DISCARD ANY SITE WHERE IT IS NOT ZERO.
 * Two renders of the same instant are supposed to be identical, and at the start
 * line they are. On the scree face they are not: 9.5% of the frame moves at a
 * mean of 25/255 with nothing overridden at all, and hiding the dust takes that
 * to 6.1% — so the particle systems keep animating across a zero-dt render and
 * the remainder is probably the debris field doing the same. The game never
 * renders with dt = 0, so this is a probe-fidelity problem rather than a bug, but
 * it means an A/B at a dusty site measures the particles as much as the uniform.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/lineab';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  const cp = g.post.composite;
  const orig = cp.syncState.bind(cp);
  window.__OV__ = {};
  cp.syncState = (t) => { orig(t); for (const k in window.__OV__) cp.uniforms[k].value = window.__OV__[k]; };
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
});

// Grab the drawing buffer in-page so both frames come from the same canvas with
// no PNG round trip, and diff them there too — no image library needed.
const grab = () => page.evaluate(() => {
  const g = window.__DESCENT__.game;
  // NOT optional-call. `capture.render` did not exist when this probe was first
  // written and `render?.()` swallowed that, so both grabs read the same stale
  // framebuffer and every diff — including a control forced to full strength —
  // came back exactly zero. If the handle goes missing again this must throw.
  g.capture.render();
  const src = g.engine.renderer.domElement;
  const cv = document.createElement('canvas');
  cv.width = src.width; cv.height = src.height;
  cv.getContext('2d').drawImage(src, 0, 0);
  return cv.toDataURL('image/png');
});

// Per-pixel diff of two data URLs, run in-page so no image library is needed.
const diffFn = async ([a, b]) => {
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const px = (img) => {
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 0, cv.width, cv.height).data;
  };
  const pa = px(ia), pb = px(ib);
  let n = 0, sum = 0, max = 0, mx = 0, mfrom = null, mto = null;
  const bins = { '3-8': 0, '9-16': 0, '17-32': 0, '33-64': 0, '65-128': 0, '129+': 0 };
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.max(
      Math.abs(pa[i] - pb[i]),
      Math.abs(pa[i + 1] - pb[i + 1]),
      Math.abs(pa[i + 2] - pb[i + 2]),
    );
    if (d > 2) {
      n++; sum += d;
      bins[d <= 8 ? '3-8' : d <= 16 ? '9-16' : d <= 32 ? '17-32' : d <= 64 ? '33-64' : d <= 128 ? '65-128' : '129+']++;
    }
    if (d > max) {
      max = d; mx = i / 4;
      mto = [pa[i], pa[i + 1], pa[i + 2]];
      mfrom = [pb[i], pb[i + 1], pb[i + 2]];
    }
  }
  return {
    movedPct: +(100 * n / (pa.length / 4)).toFixed(2),
    meanDelta: +(sum / Math.max(n, 1)).toFixed(1),
    maxDelta: max,
    // WHERE the worst pixel is and what it went from and to. A peak the paint
    // coefficient cannot reach means something other than the paint moved, and
    // the two colours say which — a dark pixel going pale is a stroke, anything
    // else is a second effect keyed off the same uniform.
    worst: { x: mx % ia.width, y: Math.floor(mx / ia.width), from: mfrom, to: mto },
    // Coarse histogram of the moved pixels, because a mean of 24 made of a few
    // 240s and a lot of 5s is a different picture from a flat 24 everywhere.
    hist: bins,
  };
};

for (const [name, d0, mx] of [['scree46', 380, 0], ['start', 100, 0]]) {
  await page.evaluate(([d0, mx]) => {
    const g = window.__DESCENT__.game;
    const P = g.player;
    const s = g.track.sampleAtDistance(d0);
    g.stage.restart();
    g.stage.forceRunning();
    P.reset({ x: s.position.x, y: s.position.y, z: s.position.z }, Math.atan2(s.tangent.x, s.tangent.z));
    P.state.velocity.set(0, 0, 0);
    g.effects.cameraDirector.resetTo(P.state);
    g.input.intent.moveX = mx;
    g.input.intent.moveZ = 1;
    for (let i = 0; i < 240; i++) g.capture.step(1 / 120);
  }, [d0, mx]);

  // Frame A: whatever the game publishes. Frame B: field forced off. Nothing
  // steps in between, so the ONLY difference is the speed-line paint.
  const live = await page.evaluate(() => window.__DESCENT__.POST_STATE.speedLineIntensity);

  // IDEMPOTENCE CONTROL, and it has to come first. Everything below assumes two
  // renders of the same instant differ ONLY by the uniform being overridden. If
  // the renderer is not idempotent — a temporal history buffer, a shadow atlas
  // that refreshes on a cadence, anything with per-draw state — then the whole
  // measurement is noise and the numbers mean nothing. Diff two grabs with no
  // override at all; this must come back flat zero.
  const w0 = await grab();
  const w1 = await grab();
  const idem = await page.evaluate(diffFn, [w0, w1]);

  // If the frame is not idempotent, find out whether the dust owns it before
  // trusting or discarding anything: the worst-pixel colours at scree46 flip
  // between a warm puff fill and its near-black ink ring, which is a strong hint
  // but not a measurement.
  let idemNoDust = null;
  if (idem.movedPct > 0.5) {
    await page.evaluate(() => { window.__DESCENT__.game.effects.dust.object.visible = false; });
    const d0 = await grab();
    const d1 = await grab();
    idemNoDust = await page.evaluate(diffFn, [d0, d1]);
    await page.evaluate(() => { window.__DESCENT__.game.effects.dust.object.visible = true; });
    await grab();
  }

  const a = await grab();
  await page.evaluate(() => { window.__OV__.uSpeedIntensity = 0; });
  const b = await grab();
  // CONTROL. A zero diff between A and B is only evidence if the rig can see a
  // difference it is guaranteed to produce. Forcing the field to full strength
  // must move a lot of pixels; if it does not, the grab is broken and the real
  // measurement above means nothing.
  await page.evaluate(() => { window.__OV__.uSpeedIntensity = 1.0; });
  const ctl = await grab();
  await page.evaluate(() => { delete window.__OV__.uSpeedIntensity; });

  const stat = await page.evaluate(diffFn, [a, b]);
  const ctlStat = await page.evaluate(diffFn, [b, ctl]);

  const brief = (r) => r && JSON.stringify({ movedPct: r.movedPct, meanDelta: r.meanDelta, maxDelta: r.maxDelta });
  console.log(`${name.padEnd(9)} IDEMPOTENCE no-override-vs-itself ${brief(idem)}`);
  if (idemNoDust) console.log(`${' '.repeat(9)} IDEMPOTENCE with dust hidden ${brief(idemNoDust)}`);
  console.log(`${name.padEnd(9)} intensity ${live.toFixed(3)}  live-vs-off ${JSON.stringify(stat)}`);
  console.log(`${' '.repeat(9)} CONTROL forced-1.0-vs-off ${JSON.stringify(ctlStat)}`);
}
await browser.close();
