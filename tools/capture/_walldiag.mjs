/**
 * _walldiag — which gate in `WallSet.probe` is rejecting the 9 plates that will
 * not mount?
 *
 * `_railprobe` gets 3 of 12 after the plate-height fix, and `_wallsite` shows
 * all 12 now carry 8-12 m of runnable band, so the vertical gate is no longer
 * the answer. This calls `walls.probe` directly on the same segment the physics
 * would, step by step, and also reports the signed distance from the character
 * to the nearest face segment — so a miss says WHICH condition failed rather
 * than just that one did.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const rows = await page.evaluate(() => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const L = g.traversal.layout;
  const W = g.traversal.traversal.walls;
  const P = g.player;
  const top = (74 * 9.81) / 36;

  g.scriptedInput = {
    moveX: 0, moveZ: 1, cameraYaw: 0,
    jump: false, jumpHeld: false, dash: false, crouch: false,
    attack: false, boost: false, dive: false,
  };

  const out = [];
  // Two placements, because they disagree and the disagreement IS the finding:
  // `node` starts at a fixed height above the plate's node, which on a descent
  // is usually BELOW the ground in front of the face; `ground` starts a short
  // hop above that ground, which is where a real player arrives from.
  const PLACEMENTS = ['node', 'ground'];
  for (const placement of PLACEMENTS)
  for (let i = 0; i < L.walls.length; i++) {
    const w = L.walls[i];
    const k = Math.max(0, Math.floor(w.nodes.length * 0.3));
    const a = w.nodes[k], nm = w.normals[k];
    const b = w.nodes[Math.min(w.nodes.length - 1, k + 1)];
    const t = { x: b.x - a.x, z: b.z - a.z };
    const Lt = Math.hypot(t.x, t.z) || 1; t.x /= Lt; t.z /= Lt;

    const sx = a.x + nm.x * 1.3;
    const sz = a.z + nm.z * 1.3;
    const ground = g.terrain.heightAt(sx, sz);
    const sy = placement === 'node'
      ? a.y + 4.0
      : Math.min(Math.max(ground + 1.2, a.y + 2.2), a.y + w.height - 0.7);

    const yaw = Math.atan2(t.x, t.z);
    P.reset({ x: sx, y: sy, z: sz }, yaw);
    P.state.velocity.set(t.x * top * 0.8 - nm.x * 6.0, 1.0, t.z * top * 0.8 - nm.z * 6.0);
    P.state.mode = 'airborne';
    P.state.airTime = 0.15;

    const trace = [];
    let hit = null, mounted = false;
    for (let step = 0; step < 90 && !mounted; step++) {
      const p0 = { x: P.state.position.x, y: P.state.position.y, z: P.state.position.z };
      // Signed distance from the character to this plate's face plane at node k.
      const d = (p0.x - a.x) * nm.x + (p0.z - a.z) * nm.z;
      const vh = Math.hypot(P.state.velocity.x, P.state.velocity.z);
      // What the physics would ask, on the physics' own segment.
      const to = {
        x: p0.x + P.state.velocity.x / 120,
        y: p0.y + P.state.velocity.y / 120,
        z: p0.z + P.state.velocity.z / 120,
      };
      const r = W.probe(p0, to, P.state.velocity, -1);
      if (r && !hit) hit = { step, id: r.id, normalY: +r.normal.y.toFixed(3) };
      if (step % 10 === 0) {
        trace.push(`s${step} d=${d.toFixed(2)} dy=${(p0.y - a.y).toFixed(1)} vh=${vh.toFixed(1)} vin=${(-(P.state.velocity.x * nm.x + P.state.velocity.z * nm.z)).toFixed(1)} ${P.state.mode}${r ? ' HIT' : ''}`);
      }
      g.capture.step(1 / 120);
      if (P.state.mode === 'wall-run') mounted = true;
    }
    out.push({ placement, i, chimney: w.chimney, d: Math.round(w.routeDistance), mounted, hit, trace, sy: +sy.toFixed(1), ground: +ground.toFixed(1) });
  }
  return out;
});

let last = null;
for (const r of rows) {
  if (r.placement !== last) {
    last = r.placement;
    const set = rows.filter((x) => x.placement === last);
    console.log(`\n=== placement: ${last} — ${set.filter((x) => x.mounted).length}/${set.length} mounted ===`);
  }
  console.log(`wall ${String(r.i).padStart(2)} ${r.chimney ? 'chimney' : 'plain  '} d=${String(r.d).padStart(4)} start=${r.sy} grd=${r.ground} mounted=${r.mounted} probeHit=${r.hit ? JSON.stringify(r.hit) : 'NEVER'}`);
  if (!r.mounted) for (const t of r.trace) console.log('        ' + t);
}
await browser.close();
