/**
 * _camclip.mjs — how often does the camera end up inside something?
 *
 * A frame from _motionseq.mjs showed the camera inside a piece of traversal
 * furniture mid-corner: backfaces filling the screen, character completely
 * hidden. That is a whole class of janky the numeric probes cannot see, because
 * the camera's own occlusion machinery only knows about two things — the terrain
 * heightfield via `terrain.heightAt`, and other characters as cylinders. The
 * traversal meshes are render geometry with no collider, so as far as the boom is
 * concerned a ramp is not there.
 *
 * This measures the rate rather than the anecdote. It drives the pursuit
 * controller down the whole route and, every step, tests the camera against the
 * world bounding sphere of every traversal mesh, plus against the terrain. Also
 * reports what the offender was, so the fix can be aimed.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(async () => {
  const g = window.__DESCENT__.game, P = g.player, cam = g.effects.cameraDirector;
  g.capture.takeControl();
  g.input.setScripted(false);
  g.input.update = () => {};
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // Every mesh under the traversal group, with a world bounding sphere computed
  // once. Names come off the objects so an offender can be identified.
  // `g.traversal.object` is the group. The first version of this reached for
  // `.group` and `.root`, got null, and reported a clean zero for both tests
  // while measuring neither — the keys are traversal / pickups / layout /
  // object / dispose, which is why they are printed below.
  const root = g.traversal?.object ?? null;
  const probes = [];
  const keys = Object.keys(g.traversal ?? {});
  if (root) {
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere;
      if (!bs) return;
      const c = bs.center.clone().applyMatrix4(o.matrixWorld);
      const sc = o.matrixWorld.getMaxScaleOnAxis();
      probes.push({ name: o.name || o.geometry.type || 'mesh', x: c.x, y: c.y, z: c.z, r: bs.radius * sc });
    });
  }

  g.stage.restart();
  g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0);
  cam.resetTo(P.state);

  const camObj = g.engine ? g.engine.camera : window.__DESCENT__.engine.camera;
  const DT = 1 / 120;
  let hint = 0, steps = 0, insideProp = 0, belowTerrain = 0;
  const offenders = new Map();
  const worstDepth = { prop: 0, name: null, d: 0 };
  const terrDepth = { v: 0, d: 0 };

  for (let i = 0; i < 120 * 200; i++) {
    const pos = P.state.position;
    const pr = g.track.project(pos, hint);
    hint = pr.distance;
    const ahead = g.track.sampleAtDistance(Math.min(pr.distance + 22, g.track.length - 1));
    const want = Math.atan2(ahead.position.x - pos.x, ahead.position.z - pos.z);
    const err = wrap(want - cam.yaw);
    g.input.intent.moveX = Math.sin(err);
    g.input.intent.moveZ = Math.cos(err);
    g.capture.step(DT);
    steps++;

    const c = camObj.position;
    // Terrain: the director already keeps a margin, so anything below the
    // surface at all is the margin failing, not a missing feature.
    const th = g.terrain ? g.terrain.heightAt(c.x, c.z) : null;
    if (th !== null && c.y < th) {
      belowTerrain++;
      const d = th - c.y;
      if (d > terrDepth.v) { terrDepth.v = d; terrDepth.d = pr.distance; }
    }
    // Props: bounding sphere is generous, so this over-reports slightly and a
    // zero here would be a real all-clear.
    let hit = null, deep = 0;
    for (const p of probes) {
      const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < p.r) {
        const pen = p.r - dist;
        if (pen > deep) { deep = pen; hit = p.name; }
      }
    }
    if (hit) {
      insideProp++;
      offenders.set(hit, (offenders.get(hit) ?? 0) + 1);
      if (deep > worstDepth.prop) { worstDepth.prop = deep; worstDepth.name = hit; worstDepth.d = pr.distance; }
    }
    if (['cleared', 'failed', 'results'].includes(g.stage.phase)) break;
  }

  return {
    traversalKeys: keys,
    probeCount: probes.length,
    steps,
    insideProp,
    pctInsideProp: +((insideProp / steps) * 100).toFixed(1),
    belowTerrain,
    pctBelowTerrain: +((belowTerrain / steps) * 100).toFixed(1),
    worstProp: worstDepth,
    worstTerrain: { depth: +terrDepth.v.toFixed(2), atDistance: +terrDepth.d.toFixed(0) },
    offenders: [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
