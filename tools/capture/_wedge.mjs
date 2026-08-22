/**
 * _wedge.mjs — identify the structure the camera was inside at d~435.
 *
 * _motionseq.mjs frame 02 of the corner strip is a grey plate with red top edges
 * filling the screen, backfaces black, character invisible. _camoccl.mjs then
 * showed wall plates block the view for only 0.4% of a run and all of it at
 * d~1093, nowhere near this frame — so whatever this is, it is not a wall, and
 * guessing from the picture has already been wrong once.
 *
 * This reproduces the exact step and prints where everything is.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async () => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const DT = 1 / 120;
  let hint = 0;
  const drive = () => {
    const pos = P.state.position;
    const pr = g.track.project(pos, hint);
    hint = pr.distance;
    const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
    const want = Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z);
    const err = wrap(want - cam.yaw);
    g.input.intent.moveX = Math.sin(err);
    g.input.intent.moveZ = Math.cos(err);
    g.capture.step(DT);
  };

  g.stage.restart();
  g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0);
  cam.resetTo(P.state);
  while (hint < 420) drive();
  // The strip took one step for frame 0 then 24 per frame; frame 02 is 1 + 48.
  for (let i = 0; i < 49; i++) drive();

  // Which object is the wedge? Hide one class of geometry at a time and re-render
  // the same step. Whatever removal makes it go away is the answer, and this is
  // cheaper than any amount of looking at the picture — which has already
  // produced two wrong guesses.
  window.__SHOTS__ = async (shot) => {};
  window.__HIDE__ = (what) => {
    if (what === 'terrain') g.terrain.object.visible = false;
    else if (what === 'traversal') g.traversal.object.visible = false;
    else if (what === 'none') { g.terrain.object.visible = true; g.traversal.object.visible = true; }
    g.capture.render();
  };
  // NAME the offender instead of modelling it. Hiding the traversal group makes
  // the wedge go away, so one of its meshes is drawing it; the analytic
  // occlusion tests in _camoccl.mjs put ramps, walls and rails at zero here, so
  // all three models of what it might be are wrong. This hides one mesh at a
  // time and reports which removal changes the picture.
  window.__MESHES__ = () => {
    const list = [];
    g.traversal.object.traverse((o) => { if (o.isMesh) list.push(o.name || o.uuid.slice(0, 8)); });
    return list;
  };
  // Original visibility is SAVED and restored. The first version set every mesh
  // visible between tests, which un-hid whatever was legitimately culled and made
  // every frame after the first differ from the baseline for a reason that had
  // nothing to do with the mesh under test — the scores came back uniform at
  // +38 KB, which is the signature of a control that is not controlling.
  const allMeshes = [];
  g.traversal.object.traverse((o) => { if (o.isMesh) allMeshes.push(o); });
  const wasVisible = allMeshes.map((o) => o.visible);
  window.__HIDEONE__ = (idx) => {
    for (let i = 0; i < allMeshes.length; i++) allMeshes[i].visible = wasVisible[i] && i !== idx;
    g.capture.render();
  };
  window.__COUNT__ = () => allMeshes.length;
  window.__NAME__ = (i) => allMeshes[i].name || 'unnamed-' + i;

  const c = window.__DESCENT__.engine.camera.position;
  const p = P.state.position;
  const L = g.traversal.layout;
  const near = (arr, key) => arr
    .map((o, i) => ({ i, d: o.routeDistance, gap: Math.abs(o.routeDistance - hint) }))
    .sort((a, b) => a.gap - b.gap).slice(0, 3);
  const gaps = (L.gaps ?? []).filter((x) => x.to > hint - 60 && x.from < hint + 60);

  return {
    routeDistance: +hint.toFixed(1),
    mode: P.state.mode,
    speed: +P.state.groundSpeed.toFixed(1),
    player: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
    camera: { x: +c.x.toFixed(1), y: +c.y.toFixed(1), z: +c.z.toFixed(1) },
    camAbovePlayer: +(c.y - p.y).toFixed(2),
    boomLength: +Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z).toFixed(2),
    terrainAtCamera: +g.terrain.heightAt(c.x, c.z).toFixed(1),
    camAboveTerrain: +(c.y - g.terrain.heightAt(c.x, c.z)).toFixed(2),
    terrainAtPlayer: +g.terrain.heightAt(p.x, p.z).toFixed(1),
    playerAboveTerrain: +(p.y - g.terrain.heightAt(p.x, p.z)).toFixed(2),
    nearestWalls: near(L.walls),
    nearestBoosters: near(L.boosters),
    nearestRails: near(L.rails),
    gapsHere: gaps,
    counts: { walls: L.walls.length, boosters: L.boosters.length, rails: L.rails.length, gaps: (L.gaps ?? []).length },
  };
});

console.log(JSON.stringify(out, null, 2));

// Hiding meshes and comparing pixels does not work here, and the control run
// proves why: hiding one mesh changed the centre crop for all 170 of them, which
// means two renders of the SAME state already differ. Something in the pipeline
// is temporally varied — dither, jitter, an animated particle — so no pixel
// comparison between successive frames can attribute anything.
//
// So the geometry is projected instead. Every traversal vertex goes through the
// camera's own view-projection matrix; a mesh owns the middle of the frame if its
// vertices land inside the centre box AND in front of the player. That is exact,
// deterministic, and needs one frame.
const owners = await page.evaluate(() => {
  const g = window.__DESCENT__.game, P = g.player;
  const camObj = window.__DESCENT__.engine.camera;
  camObj.updateMatrixWorld(true);
  const vp = camObj.projectionMatrix.clone().multiply(camObj.matrixWorldInverse);
  const e = vp.elements;
  const cp = camObj.position;
  const pd = Math.hypot(P.state.position.x - cp.x, P.state.position.y - cp.y, P.state.position.z - cp.z);

  const out = [];
  g.traversal.object.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.visible) return;
    const pos = o.geometry.attributes.position;
    if (!pos) return;
    o.updateWorldMatrix(true, false);
    const m = o.matrixWorld.elements;
    let inBox = 0, nearest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
      const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      const cw = e[3] * wx + e[7] * wy + e[11] * wz + e[15];
      if (cw <= 0.01) continue;
      const ndcX = (e[0] * wx + e[4] * wy + e[8] * wz + e[12]) / cw;
      const ndcY = (e[1] * wx + e[5] * wy + e[9] * wz + e[13]) / cw;
      if (Math.abs(ndcX) > 0.34 || Math.abs(ndcY) > 0.34) continue;
      const d = Math.hypot(wx - cp.x, wy - cp.y, wz - cp.z);
      if (d < nearest) nearest = d;
      if (d < pd) inBox++;
    }
    if (inBox > 0) out.push({ name: o.name || 'unnamed', vertsInFront: inBox, nearest: +nearest.toFixed(2) });
  });
  out.sort((a, b) => a.nearest - b.nearest);
  return { playerDistance: +pd.toFixed(2), meshes: out.slice(0, 10) };
});
console.log(JSON.stringify(owners, null, 2));

// Same step, three renders.
for (const what of ['none', 'terrain', 'traversal']) {
  await page.evaluate((w) => window.__HIDE__(w), what);
  await page.evaluate((w) => { if (w !== 'none') return; }, what);
  await page.screenshot({ path: `tools/capture/_out/_wedge-${what}.png` });
  await page.evaluate(() => window.__HIDE__('none'));
}
console.log('wrote _wedge-none / _wedge-terrain / _wedge-traversal');
await browser.close();
