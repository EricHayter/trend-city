// One-off diagnostic: dump the live rig's world-space bone positions for a pose.
import { chromium } from 'playwright';

const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5176';
const POSE = process.argv[2] ?? 'run-cycle';
const FRAMES = Number(process.argv[3] ?? 30);

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log(`[exception] ${e.message}`));
await page.goto(`${URL_BASE}/?capture=1&pr=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 120_000 });

const out = await page.evaluate(async ({ pose, frames }) => {
  const { engine, game } = window.__DESCENT__;
  game.capture.takeControl();
  game.capture.setPose(pose);
  for (let i = 0; i < frames; i++) game.capture.step(1 / 60);

  const byName = new Map();
  engine.scene.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });

  const dump = (n) => {
    const o = byName.get(n);
    if (!o) return null;
    const p = new (o.position.constructor)();
    o.getWorldPosition(p);
    return { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) };
  };

  const character = byName.get('character');
  const player = byName.get('player');

  return {
    gameKeys: Object.keys(game),
    charParents: (() => {
      const out = [];
      let n = byName.get('pelvis');
      while (n) { out.push({ name: n.name || n.type, s: n.scale.toArray().map((v) => +v.toFixed(4)), p: n.position.toArray().map((v)=>+v.toFixed(3)) }); n = n.parent; }
      return out;
    })(),
    names: [...byName.keys()].filter((n) => /player|character|body|pelvis|head|foot/i.test(n)).slice(0, 40),
    playerXform: player && {
      pos: player.position.toArray().map((v) => +v.toFixed(3)),
      scale: player.scale.toArray().map((v) => +v.toFixed(4)),
    },
    charXform: character && {
      pos: character.position.toArray().map((v) => +v.toFixed(3)),
      quat: character.quaternion.toArray().map((v) => +v.toFixed(4)),
      scale: character.scale.toArray().map((v) => +v.toFixed(4)),
    },
    localOffsets: (() => {
      const names = ['pelvis','spine1','spine2','chest','neck','head','headEnd','thighL','shinL','footL','toeL','clavL','upperArmL','forearmL','handL'];
      const o = {};
      for (const n of names) {
        const b = byName.get(n);
        o[n] = b ? { p: b.position.toArray().map((v) => +v.toFixed(4)), s: b.scale.toArray().map((v) => +v.toFixed(4)) } : null;
      }
      return o;
    })(),
    bones: {
      pelvis: dump('pelvis'), spine1: dump('spine1'), chest: dump('chest'),
      head: dump('head'), headEnd: dump('headEnd'),
      thighL: dump('thighL'), shinL: dump('shinL'), footL: dump('footL'),
      thighR: dump('thighR'), footR: dump('footR'),
      handL: dump('handL'), handR: dump('handR'),
    },
  };
}, { pose: POSE, frames: FRAMES });

console.log(JSON.stringify(out, null, 2));
await browser.close();
