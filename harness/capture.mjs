/**
 * TREND CITY capture harness.
 *
 * Drives the real game in Chromium with deterministic input and a fixed
 * timestep, then captures stills, motion sequences, multi-angle turntables and
 * performance traces. Every visual claim in this project is checked against
 * output from this script.
 *
 *   node harness/capture.mjs --set=stills
 *   node harness/capture.mjs --set=motion --seed=ABC
 *   node harness/capture.mjs --set=turntable
 *   node harness/capture.mjs --set=perf
 *   node harness/capture.mjs --set=all
 *
 * Flags: --seed --w --h --dpr --out --url --headed --keep
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const SET = args.set ?? 'stills';
const SEED = args.seed ?? 'TREND-CITY';
const W = +(args.w ?? 1280);
const H = +(args.h ?? 720);
const DPR = +(args.dpr ?? 2);
const OUT = path.resolve(args.out ?? 'shots');
const URL = args.url ?? 'http://127.0.0.1:5173';
const FPS = 60;

// ───────────────────────────────────────────────────────── dev server

async function reachable(url, ms = 900) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let child = null;
async function ensureServer() {
  if (await reachable(URL)) { console.log('· dev server already up'); return; }
  console.log('· starting vite…');
  child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5173'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[vite] ' + d));
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await reachable(URL)) { console.log('· vite ready'); return; }
  }
  throw new Error('vite did not come up');
}

// ───────────────────────────────────────────────────────── page control

async function openPage(browser, { seed = SEED, w = W, h = H, dpr = DPR } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: dpr,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') { errors.push(m.text()); console.log('  [console] ' + m.text()); }
  });
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('  [pageerror] ' + e.message); });
  page.__errors = errors;

  await page.goto(`${URL}/?seed=${encodeURIComponent(seed)}&manual&deterministic`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', null, { timeout: 30000 });
  // one warm frame so every shader compiles before we time anything
  await page.evaluate(() => {
    window.__t = 1000;
    window.__game.clock.reset(window.__t);
    window.__game.step(window.__t);
  });
  await page.waitForTimeout(400);
  return page;
}

/**
 * Advance N frames at a fixed timestep with a deterministic input timeline.
 * timeline entries: [fromFrame, [actions], {x,y}]
 */
async function advance(page, frames, timeline = []) {
  await page.evaluate(async ({ frames, timeline, fps }) => {
    const g = window.__game;
    const dt = 1000 / fps;
    let ti = 0;
    for (let f = 0; f < frames; f++) {
      while (ti < timeline.length && timeline[ti][0] <= f) {
        const [, acts, axis] = timeline[ti];
        g.input.setVirtual(acts ?? [], axis ?? undefined);
        ti++;
      }
      window.__t += dt;
      g.step(window.__t);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, { frames, timeline, fps: FPS });
}

async function shot(page, dir, name) {
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name + '.png');
  await page.screenshot({ path: p, animations: 'disabled' });
  console.log('  ✓ ' + path.relative(process.cwd(), p));
  return p;
}

async function setCam(page, px, py, pz, tx, ty, tz, fov) {
  await page.evaluate(([a, b, c, d, e, f, g2]) => {
    window.__game.setCamera(a, b, c, d, e, f, g2 ?? undefined);
    window.__game.step(window.__t += 1000 / 60);
  }, [px, py, pz, tx, ty, tz, fov ?? null]);
  await page.waitForTimeout(60);
}

/** Builds a contact sheet from captured PNGs using the browser itself. */
async function contactSheet(browser, files, outPath, cols = 4, label = '') {
  if (!files.length) return;
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const rows = Math.ceil(files.length / cols);
  const cw = 480, ch = Math.round(cw * H / W);
  await page.setViewportSize({ width: cols * cw, height: rows * ch + 34 });
  // file:// sources do not load inside a setContent page, so inline the PNGs.
  const imgs = (await Promise.all(files.map(async (f, i) => {
    const b64 = (await readFile(f)).toString('base64');
    return `<div class="c"><img src="data:image/png;base64,${b64}"><span>${i}&nbsp;${path.basename(f, '.png')}</span></div>`;
  }))).join('');
  await page.setContent(`<style>
    body{margin:0;background:#0a0713;font:11px ui-monospace,monospace;color:#35e8ff}
    h1{margin:0;padding:8px 10px;font-size:13px;letter-spacing:.14em;color:#ff2e6e}
    .g{display:grid;grid-template-columns:repeat(${cols},${cw}px)}
    .c{position:relative}.c img{width:${cw}px;height:${ch}px;display:block}
    .c span{position:absolute;left:4px;top:4px;background:#0a0713cc;padding:1px 5px}
  </style><h1>${label}</h1><div class="g">${imgs}</div>`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: outPath, fullPage: true });
  await ctx.close();
  console.log('  ✓ SHEET ' + path.relative(process.cwd(), outPath));
}

// ───────────────────────────────────────────────────────── sets

const HOLD_FWD = [[0, [], { x: 0, y: 1 }]];

async function setStills(browser) {
  const dir = path.join(OUT, 'stills');
  const page = await openPage(browser);
  const files = [];

  // The gameplay camera, on the deck, looking down the route. This is the shot
  // that has to work as a standalone clip frame.
  await advance(page, 8);
  files.push(await shot(page, dir, '01-route-forward'));

  await setCam(page, 26, 24, 40, 0, 9, 120);
  files.push(await shot(page, dir, '02-highway-sweep'));

  await setCam(page, -120, 60, 200, 0, 20, 240);
  files.push(await shot(page, dir, '03-skyline-wide'));

  await setCam(page, 6, 11, 180, 6, 11, 320, 78);
  files.push(await shot(page, dir, '04-low-speed-fov'));

  await setCam(page, 40, 150, -60, 0, 0, 300);
  files.push(await shot(page, dir, '05-elevated'));

  await setCam(page, 0, -20, 60, 0, 30, 200);
  files.push(await shot(page, dir, '06-underside'));

  await setCam(page, -240, 90, 900, -330, 60, 620, 50);
  files.push(await shot(page, dir, '07-landmark'));

  await setCam(page, 3, 9.6, 240, 3, 10.4, 260, 40);
  files.push(await shot(page, dir, '08-surface-closeup'));

  await setCam(page, 90, 30, 470, 0, 14, 430);
  files.push(await shot(page, dir, '09-ramp-rail'));

  await setCam(page, 0, 420, 500, 0, 0, 500);
  files.push(await shot(page, dir, '10-topdown'));

  await contactSheet(browser, files, path.join(OUT, 'sheet-stills.png'), 4, `STILLS · seed ${SEED}`);
  await page.context().close();
  return files;
}

async function setMotion(browser) {
  const dir = path.join(OUT, 'motion');
  if (existsSync(dir) && !args.keep) await rm(dir, { recursive: true, force: true });
  const page = await openPage(browser);
  const files = [];
  // forward run down the deck, sampled every 10 frames over 2 seconds
  for (let k = 0; k < 12; k++) {
    await advance(page, 10, k === 0 ? HOLD_FWD : []);
    files.push(await shot(page, dir, `run-${String(k).padStart(2, '0')}`));
  }
  await contactSheet(browser, files, path.join(OUT, 'sheet-motion-run.png'), 4, `MOTION run · seed ${SEED}`);
  await page.context().close();
  return files;
}

/**
 * Orbits a fixed world point and captures a full ring plus high and low angles.
 * Any geometry that only looks right from one direction fails here.
 */
async function setTurntable(browser) {
  const page = await openPage(browser);
  const targets = [
    { name: 'deck-join', at: [0, 10, 120], r: 34, h: 10 },
    { name: 'wallrun-slab', at: [30, 14, 200], r: 40, h: 14 },
    { name: 'tower', at: [70, 20, 300], r: 90, h: 40 },
    { name: 'rail-arc', at: [0, 22, 220], r: 46, h: 16 },
  ];
  const all = [];
  for (const t of targets) {
    const dir = path.join(OUT, 'turntable', t.name);
    const files = [];
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      await setCam(page, t.at[0] + Math.sin(ang) * t.r, t.at[1] + t.h, t.at[2] + Math.cos(ang) * t.r,
        t.at[0], t.at[1], t.at[2], 50);
      files.push(await shot(page, dir, `a${a}`));
    }
    // top and bottom expose broken caps and inverted normals
    await setCam(page, t.at[0] + 0.01, t.at[1] + t.r, t.at[2], t.at[0], t.at[1], t.at[2], 50);
    files.push(await shot(page, dir, 'top'));
    await setCam(page, t.at[0] + 0.01, t.at[1] - t.r * 0.8, t.at[2], t.at[0], t.at[1], t.at[2], 50);
    files.push(await shot(page, dir, 'bottom'));
    await contactSheet(browser, files, path.join(OUT, `sheet-turn-${t.name}.png`), 5, `TURNTABLE ${t.name}`);
    all.push(...files);
  }
  await page.context().close();
  return all;
}

async function setPerf(browser) {
  const page = await openPage(browser);
  await advance(page, 40, HOLD_FWD);
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await advance(page, 60);
    samples.push(await page.evaluate(() => ({
      avgMs: window.__game.clock.avgMs,
      worstMs: window.__game.clock.worstMs,
      scale: window.__game.pipeline.scale,
      ...window.__game.pipeline.stats,
      kitTris: window.__game.stats.tris,
      colliderTris: window.__game.stats.colliderTris,
    })));
  }
  const avg = samples.reduce((a, s) => a + s.avgMs, 0) / samples.length;
  const worst = Math.max(...samples.map((s) => s.worstMs));
  const report = { seed: SEED, viewport: [W, H], dpr: DPR, avgMs: +avg.toFixed(2), worstMs: +worst.toFixed(2), samples };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'perf.json'), JSON.stringify(report, null, 2));
  console.log(`  avg ${avg.toFixed(2)}ms  worst ${worst.toFixed(2)}ms  calls ${samples.at(-1).calls}  tris ${samples.at(-1).tris}`);
  await page.context().close();
  return report;
}

// ───────────────────────────────────────────────────────── main

(async () => {
  await ensureServer();
  const browser = await chromium.launch({
    headless: !args.headed,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
  });
  try {
    const sets = SET === 'all' ? ['stills', 'motion', 'turntable', 'perf'] : SET.split(',');
    for (const s of sets) {
      console.log(`\n── ${s.toUpperCase()} ─────────────────────────────`);
      if (s === 'stills') await setStills(browser);
      else if (s === 'motion') await setMotion(browser);
      else if (s === 'turntable') await setTurntable(browser);
      else if (s === 'perf') await setPerf(browser);
      else console.log('  ? unknown set ' + s);
    }
    const n = existsSync(OUT) ? (await readdir(OUT)).length : 0;
    console.log(`\n· done, ${n} entries in ${path.relative(process.cwd(), OUT)}`);
  } finally {
    await browser.close();
    if (child) child.kill('SIGTERM');
  }
})().catch((e) => { console.error(e); if (child) child.kill('SIGTERM'); process.exit(1); });
