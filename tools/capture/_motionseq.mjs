/**
 * _motionseq.mjs — LOOK at the movement, frame by frame.
 *
 * Everything about the movement work so far has been measured numerically:
 * degrees per second of camera rotation, percentage of steps in a slide,
 * route distance reached. Those numbers are the right evidence for "does it
 * diverge" and the wrong evidence for "does it look janky", which is the actual
 * report. A camera can be provably non-divergent and still snap; a character can
 * hold top speed and still read as sliding on ice.
 *
 * So this captures evenly spaced frames through two motions that the report
 * named — a corner at speed, and a rail grind — and tiles them into one strip
 * per motion. Even spacing is the point: the eye reads acceleration off the gap
 * between successive positions, so a strip at a fixed dt shows a snap as an
 * uneven stride and a smooth turn as an even one.
 *
 * Usage: node tools/capture/_motionseq.mjs
 * Writes tools/capture/_out/motion-<name>.png
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('tools/capture/_out');
await mkdir(OUT, { recursive: true });

const FRAMES = 10;
const GAP = 0.2;          // seconds between captured frames
const DT = 1 / 120;

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

// The pursuit controller and the drive-to-distance loop live in the page so the
// per-step work never crosses the bridge; only "advance one frame" does, because
// a screenshot has to happen between frames from out here.
await page.evaluate(() => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let hint = 0;

  window.__M__ = {
    // Start a run at the top and drive the pursuit controller to `target` metres.
    seek(target) {
      g.stage.restart();
      g.stage.forceRunning();
      const s0 = g.track.sampleAtDistance(0);
      P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
      P.state.velocity.set(0, 0, 0);
      cam.resetTo(P.state);
      hint = 0;
      for (let i = 0; i < 120 * 400; i++) {
        if (this.drive()) break;
        if (hint >= target) return { d: hint, ok: true };
      }
      return { d: hint, ok: false };
    },
    // One physics step under pursuit. Returns true if the stage ended.
    drive(steerBias = 0) {
      const pos = P.state.position;
      const pr = g.track.project(pos, hint);
      hint = pr.distance;
      const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
      const want = Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z);
      const err = wrap(want - cam.yaw + steerBias);
      g.input.intent.moveX = Math.sin(err);
      g.input.intent.moveZ = Math.cos(err);
      g.capture.step(1 / 120);
      return ['cleared', 'failed', 'results'].includes(g.stage.phase);
    },
    // Advance `n` steps, then report what the frame contains.
    advance(n, steerBias = 0) {
      for (let i = 0; i < n; i++) if (this.drive(steerBias)) break;
      const s = P.state;
      return {
        d: +hint.toFixed(0),
        mode: s.mode,
        spd: +s.groundSpeed.toFixed(1),
        yaw: +((s.facing * 180) / Math.PI).toFixed(0),
        cam: +((g.effects.cameraDirector.yaw * 180) / Math.PI).toFixed(0),
      };
    },
    // Route distance of the nearest rail mount past `from`, so the grind strip
    // is aimed at real geometry rather than a guess.
    railAhead(from) {
      const rails = g.traversal?.traversal?.rails;
      if (!rails) return null;
      let best = null;
      for (let i = 0; i < rails.count; i++) {
        const p = rails.startOf ? rails.startOf(i) : null;
        if (!p) continue;
        const pr = g.track.project(p, from);
        if (pr.distance > from && (!best || pr.distance < best)) best = pr.distance;
      }
      return best;
    },
  };
});

async function strip(name, seekTo, steerBias) {
  const start = await page.evaluate((t) => window.__M__.seek(t), seekTo);
  const rows = [];
  const files = [];
  for (let f = 0; f < FRAMES; f++) {
    const info = await page.evaluate(
      ([n, b]) => window.__M__.advance(n, b),
      [f === 0 ? 1 : Math.round(GAP / DT), steerBias],
    );
    const fp = `${OUT}/_seq-${name}-${String(f).padStart(2, '0')}.png`;
    await page.screenshot({ path: fp });
    files.push(fp);
    rows.push(`${(f * GAP).toFixed(1)}s d=${info.d} ${info.mode} ${info.spd}m/s yaw=${info.yaw} cam=${info.cam}`);
  }
  console.log(`--- ${name} (seek ${start.d}m, ok=${start.ok}) ---`);
  for (const r of rows) console.log(r);
  return files;
}

const corner = await strip('corner', 420, 0);
const grind = await strip('grind', 980, 0);
await browser.close();

import { execFileSync } from 'node:child_process';

// `magick` append rather than `montage`: montage draws a label under every tile
// and reaches for a font, which on this machine is `unable to read font ''` and
// takes the whole tiling down with it. Rows first, then stack the rows.
for (const [name, files] of [['corner', corner], ['grind', grind]]) {
  const rows = [];
  for (let i = 0; i < files.length; i += 5) {
    const r = `${OUT}/_row-${name}-${i}.png`;
    execFileSync('magick', [...files.slice(i, i + 5), '+append', r]);
    rows.push(r);
  }
  execFileSync('magick', [...rows, '-append', `${OUT}/motion-${name}.png`]);
  console.log(`wrote ${OUT}/motion-${name}.png`);
}
