// SCREENSHOT / MOTION HARNESS
// Drives the real game in a real browser: selects a deterministic seed, injects input
// through window.__input, captures retina stills, multi-angle turntables of the player,
// enemies and boss, and deterministic frame sequences for motion review.
//   node harness/capture.mjs --set=stills|motion|turntable|all [--url=http://127.0.0.1:5173]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const URL = args.url || 'http://127.0.0.1:5173/';
const SET = args.set || 'all';
const OUT = args.out || 'captures';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[error]', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });

const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('captured', name); };
const hold = async (keys, ms) => {
  await page.evaluate((k) => window.__input.set(k), keys);
  await page.waitForTimeout(ms);
};
const release = () => page.evaluate(() => window.__input.set({ moveX: 0, moveY: 0, jump: false, dash: false, attack: false, boost: false, slide: false }));
const tap = async (a) => { await page.evaluate((x) => window.__input.tap(x), a); await page.waitForTimeout(60); };

// Deterministic entry: title -> intro -> select -> play on a fixed seed.
const enterStage = async (seed = 'VOLT-CORE-001') => {
  await page.evaluate((s) => {
    const g = window.__game;
    g.buildStage(s);
    g.screen = 'play';
    g.cam.snapTo(g.player);
  }, seed);
  await page.waitForTimeout(700);
};

if (SET === 'stills' || SET === 'all') {
  await shot('01-title');
  await page.evaluate(() => { window.__game.screen = 'intro'; });
  await page.waitForTimeout(600); await shot('02-character-intro');
  await page.evaluate(() => { const g = window.__game; g.screen = 'select'; g.prepareCards ? g.prepareCards() : null; });
  await page.waitForTimeout(600); await shot('03-stage-select');
  await enterStage();
  await shot('04-idle');
  await hold({ moveY: 1 }, 1400); await shot('05-running');
  await hold({ moveY: 1, boost: true }, 1800); await shot('06-high-speed-boost');
  await tap('jump'); await page.waitForTimeout(180); await shot('07-jump');
  await tap('jump'); await page.waitForTimeout(150); await shot('08-double-jump');
  await tap('dash'); await page.waitForTimeout(120); await shot('09-air-dash');
  await release(); await page.waitForTimeout(900);
  await hold({ moveY: 1 }, 900); await tap('attack'); await page.waitForTimeout(90); await shot('10-combat');
  await hold({ moveY: 1, slide: true }, 300); await shot('11-slide');
  await release();
  await page.evaluate(() => { const g = window.__game; g.goalReached = true; g.player.spawn(g.stage.bossCenter.clone().setY(g.stage.bossCenter.y - 14), 0); });
  await page.waitForTimeout(1600); await shot('12-boss');
  await page.evaluate(() => window.__game.finish(true));
  await page.waitForTimeout(900); await shot('13-results');
}

if (SET === 'turntable' || SET === 'all') {
  // Multi-angle inspection: the camera is placed deterministically around the subject so
  // silhouettes, undersides and outline quality can be compared after every fix.
  await enterStage();
  const angles = [
    ['front', 0, 1.6, 0], ['rear', Math.PI, 1.6, 0], ['left', -Math.PI / 2, 1.6, 0],
    ['right', Math.PI / 2, 1.6, 0], ['top', 0.4, 7.5, -0.9], ['low', 0.9, 0.4, 0.45],
    ['close', 2.2, 1.5, 0], ['far', 5.4, 3.0, 0.1],
  ];
  for (const [name, yaw, height, pitch] of angles) {
    await page.evaluate(({ yaw, height, pitch, name }) => {
      const g = window.__game;
      const p = g.player.pos;
      const r = name === 'close' ? 3.2 : name === 'far' ? 26 : 6.5;
      g.cam.camera.position.set(p.x + Math.sin(yaw) * r, p.y + height, p.z + Math.cos(yaw) * r);
      g.cam.camera.up.set(0, 1, 0);
      g.cam.camera.lookAt(p.x, p.y + 1.1 + pitch, p.z);
      g.screen = 'paused';
    }, { yaw, height, pitch, name });
    await page.waitForTimeout(180);
    await shot('turntable-player-' + name);
  }
}

if (SET === 'motion' || SET === 'all') {
  // Frame sequences: stills cannot show whether movement reads as fast and weighty.
  await enterStage();
  const seq = async (label, keys, frames, gap = 60) => {
    await page.evaluate((k) => window.__input.set(k), keys);
    for (let i = 0; i < frames; i++) { await page.waitForTimeout(gap); await shot(`motion-${label}-${String(i).padStart(2, '0')}`); }
    await release();
  };
  await seq('sprint', { moveY: 1, dash: false }, 8);
  await seq('boost', { moveY: 1, boost: true }, 8);
  await page.evaluate(() => window.__input.tap('jump'));
  await seq('air', { moveY: 1 }, 8);
  await seq('attack', { moveY: 1, attack: true }, 6);
}

console.log(await page.evaluate(() => {
  const g = window.__game;
  return {
    seed: g.stage.seed,
    modules: g.stage.plan.length,
    distance: g.stage.totalDistance,
    solids: g.stage.data.physics.solids.length,
    rails: g.stage.data.physics.rails.length,
    pickups: g.stage.pickupTotal,
    enemies: g.stage.enemyTotal,
    drawCalls: g.pipeline.renderer.info.render.calls,
    triangles: g.pipeline.renderer.info.render.triangles,
    activeChunks: g.stage.streamer.activeCount,
    validation: g.stage.report,
  };
}));
await browser.close();
