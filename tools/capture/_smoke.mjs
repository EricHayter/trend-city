/**
 * Boot smoke test.
 *
 * Phase A  boot and free-run on the REAL rAF loop.
 * Phase B  real keyboard events through the live input path
 *          (keydown -> intent -> queueEdges -> fixedUpdate -> physics).
 * Phase C  deterministic capture poses/sequences under takeControl().
 *
 * Fails on any console error, page error, WebGL error, or non-finite state.
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:4173/?capture=1&pr=1';
const errors = [];
const warnings = [];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(`console.error: ${t}`);
  else if (m.type() === 'warning') warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));

await page.goto(URL, { waitUntil: 'load', timeout: 90_000 });
await page.waitForFunction(() => !!window.__DESCENT__, { timeout: 240_000 });
console.log('BOOTED');

const snap = () => page.evaluate(() => {
  const g = window.__DESCENT__.game;
  const s = g.player.state;
  const fin = [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.facing]
    .every(Number.isFinite);
  return {
    mode: s.mode, phase: g.stage.phase,
    pos: s.position.toArray().map((n) => +n.toFixed(1)),
    gs: +s.groundSpeed.toFixed(1), spd: +s.speed.toFixed(1),
    vy: +s.velocity.y.toFixed(1), air: +s.airHeight.toFixed(2),
    hp: s.health, finite: fin,
    prog: +g.stage.routeProgress.toFixed(4),
    tLeft: +g.getHudModelPeek?.()?.timeLeft?.toFixed?.(1) ?? null,
  };
});

console.log('INFO', JSON.stringify(await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  return {
    poses: g.capture.listPoses().length, sequences: g.capture.listSequences().length,
    trackLen: +g.track.length.toFixed(1), phase: g.stage.phase,
    maxHealth: g.player.state.health,
  };
})));

// ── Phase A: free-run on the real loop ───────────────────────────────────────
await page.waitForTimeout(2500);
console.log('A idle 2.5s  ', JSON.stringify(await snap()));

// ── Phase B: live input path ─────────────────────────────────────────────────
const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); };
const rel = (key) => page.keyboard.up(key);
const tap = async (key) => { await page.keyboard.down(key); await page.waitForTimeout(60); await page.keyboard.up(key); };

await hold('w', 2500);
console.log('B run (W 2.5s)', JSON.stringify(await snap()));

await tap('Space');
await page.waitForTimeout(180);
console.log('B jump        ', JSON.stringify(await snap()));

await tap('Shift');
await page.waitForTimeout(150);
console.log('B dash        ', JSON.stringify(await snap()));

await tap('k');
await page.waitForTimeout(150);
console.log('B dive        ', JSON.stringify(await snap()));

await page.waitForTimeout(700);
await hold('c', 900);
console.log('B slide (C)   ', JSON.stringify(await snap()));
await rel('c');

await hold('f', 600);
console.log('B boost (F)   ', JSON.stringify(await snap()));
await rel('f');

await hold('a', 700);
console.log('B turn (A)    ', JSON.stringify(await snap()));
await rel('a');
await rel('w');
await page.waitForTimeout(400);
console.log('B coast       ', JSON.stringify(await snap()));

await page.screenshot({ path: process.env.SHOT_PLAY || '/tmp/smoke-play.png' });

// ── Phase C: deterministic capture ───────────────────────────────────────────
const poses = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const out = [];
  for (const p of g.capture.listPoses()) {
    const ok = g.capture.setPose(p);
    for (let i = 0; i < 14; i++) g.capture.step(1 / 60);
    const s = g.player.state;
    const fin = [s.position.x, s.position.y, s.position.z, s.speed].every(Number.isFinite);
    out.push([p, ok, s.mode, +s.speed.toFixed(1), +s.position.y.toFixed(1), fin]);
  }
  return out;
});
console.log('C POSES');
for (const r of poses) console.log('   ', JSON.stringify(r));

const seqs = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  const out = [];
  for (const n of g.capture.listSequences()) {
    const ok = g.capture.setSequence(n);
    for (let i = 0; i < 40; i++) g.capture.step(1 / 60);
    const s = g.player.state;
    const fin = [s.position.x, s.position.y, s.position.z, s.speed].every(Number.isFinite);
    out.push([n, ok, s.mode, +s.speed.toFixed(1), fin]);
  }
  return out;
});
console.log('C SEQUENCES');
for (const r of seqs) console.log('   ', JSON.stringify(r));

const gl = await page.evaluate(() => {
  const e = window.__DESCENT__.engine;
  const r = e.renderer;
  const ctx = r.getContext();
  const codes = [];
  for (let i = 0; i < 8; i++) { const err = ctx.getError(); if (err === 0) break; codes.push(err); }
  return {
    glErrors: codes, programs: r.info.programs?.length ?? -1,
    calls: r.info.render.calls, tris: r.info.render.triangles,
    geometries: r.info.memory.geometries, textures: r.info.memory.textures,
  };
});
console.log('GL', JSON.stringify(gl));
await page.screenshot({ path: process.env.SHOT || '/tmp/smoke.png' });
await browser.close();

const badPose = poses.filter((p) => !p[1] || !p[5]);
const badSeq = seqs.filter((s) => !s[1] || !s[4]);
console.log('\n=== WARNINGS', warnings.length, '===');
for (const w of new Set(warnings)) console.log('   ', w.slice(0, 200));
console.log('=== GL ERRORS', gl.glErrors.length, '===');
console.log('=== BAD POSES', badPose.length, JSON.stringify(badPose), '===');
console.log('=== BAD SEQS ', badSeq.length, JSON.stringify(badSeq), '===');
console.log('=== ERRORS', errors.length, '===');
for (const e of errors) console.log('   ', e.slice(0, 1200));
process.exit(errors.length || gl.glErrors.length || badPose.length || badSeq.length ? 1 : 0);
