/**
 * _namebox.mjs — name whatever is filling a region of the frame.
 *
 * The generalisation of _wedge.mjs. That probe answered one question — what is
 * the black wedge at d=435 — and the answer came from the only method that works
 * here: push every candidate vertex through the camera's own view-projection
 * matrix and keep the ones that land inside a given box of the frame. Exact,
 * deterministic, one frame, no pixels.
 *
 * The pixel approaches all failed, and the failures are worth keeping:
 *   - Per-mesh bounding spheres are useless. Traversal geometry is MERGED per
 *     tag per chunk, so one mesh holds every rail marker in a 128 m chunk and its
 *     sphere spans the mountain. That reported 88.4% of steps inside a prop.
 *   - Hide-a-mesh-and-diff-the-PNG is useless. Two renders of the SAME frozen
 *     state already differ (dither, jitter, animated particles), so the control
 *     said all 170 meshes changed the frame.
 *
 * Takes a route distance and an NDC box on the command line and reports every
 * mesh with vertices inside it, nearest first, with how much of the box each
 * one owns. Sky and HUD are not in the scene graph, so anything reported is real
 * geometry.
 *
 * Usage: node tools/capture/_namebox.mjs [distance] [x0 y0 x1 y1]
 *   NDC: x right, y UP, both -1..1. Default box is the upper middle.
 * Example, the black column in dustlook-980.png:
 *   node tools/capture/_namebox.mjs 980 -0.05 0.25 0.20 1.0
 */
import { chromium } from 'playwright';

const D = Number(process.argv[2] ?? 980);
const BOX = process.argv.length >= 7 ? process.argv.slice(3, 7).map(Number) : [-0.05, 0.25, 0.20, 1.0];

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async ({ D, BOX }) => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let hint = 0;

  g.stage.restart(); g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0); cam.resetTo(P.state);
  for (let i = 0; i < 120 * 400 && hint < D; i++) {
    const pos = P.state.position;
    const pr = g.track.project(pos, hint); hint = pr.distance;
    const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
    const err = wrap(Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z) - cam.yaw);
    g.input.intent.moveX = Math.sin(err); g.input.intent.moveZ = Math.cos(err);
    g.capture.step(1 / 120);
    if (['cleared', 'failed', 'results'].includes(g.stage.phase)) break;
  }

  const camObj = cam.camera;
  camObj.updateMatrixWorld(true);
  const vp = camObj.projectionMatrix.clone().multiply(camObj.matrixWorldInverse);
  const e = vp.elements;
  const cp = camObj.position;
  const [x0, y0, x1, y1] = BOX;

  // The whole scene, not just traversal. The offender last time was traversal
  // furniture, which is exactly why this one must not assume that again.
  //
  // The scene lives on the ENGINE, not on the game — `g.scene` is undefined, and
  // an earlier probe in this family reached for `g.traversal.group`, got null, and
  // reported a clean zero for a test it never ran. So this throws instead, and the
  // key list goes into the result either way.
  const scene = window.__DESCENT__.engine?.scene;
  if (!scene?.traverse) {
    throw new Error('no scene: engine keys ' + Object.keys(window.__DESCENT__.engine ?? {}).join(','));
  }
  const hits = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const gm = o.geometry;
    const pa = gm?.attributes?.position;
    if (!pa) return;
    o.updateMatrixWorld(true);
    const m = o.matrixWorld.elements;
    let inBox = 0, near = Infinity, far = 0;
    let sx = 0, sy = 0;
    const n = pa.count;
    // Every vertex, not a bounding volume: merged geometry makes bounds lie.
    for (let i = 0; i < n; i++) {
      const lx = pa.getX(i), ly = pa.getY(i), lz = pa.getZ(i);
      const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      const cw = e[3] * wx + e[7] * wy + e[11] * wz + e[15];
      if (cw <= 0.01) continue;
      const nx = (e[0] * wx + e[4] * wy + e[8] * wz + e[12]) / cw;
      const ny = (e[1] * wx + e[5] * wy + e[9] * wz + e[13]) / cw;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      inBox++;
      sx += nx; sy += ny;
      const d = Math.hypot(wx - cp.x, wy - cp.y, wz - cp.z);
      if (d < near) near = d;
      if (d > far) far = d;
    }
    if (inBox > 0) {
      hits.push({
        name: o.name || '(unnamed)',
        tag: o.userData?.tag ?? null,
        mat: o.material?.name || o.material?.type || '?',
        verts: inBox,
        of: n,
        near: +near.toFixed(2),
        far: +far.toFixed(2),
        cx: +(sx / inBox).toFixed(2),
        cy: +(sy / inBox).toFixed(2),
      });
    }
  });
  hits.sort((a, b) => a.near - b.near);
  return { d: +hint.toFixed(0), box: BOX, cam: { x: +cp.x.toFixed(1), y: +cp.y.toFixed(1), z: +cp.z.toFixed(1) }, hits: hits.slice(0, 18) };
}, { D, BOX });

console.log(JSON.stringify(out, null, 1));
await browser.close();
