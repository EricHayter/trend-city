/**
 * _camoccl.mjs — does traversal furniture get between the camera and the player?
 *
 * A frame from _motionseq.mjs showed the camera inside a large plate mid-corner:
 * a flat surface filling the screen, its backfaces black, the character not
 * visible at all. The camera's occlusion machinery knows about exactly two
 * things — the terrain heightfield through `terrain.heightAt`, and other
 * characters as cylinders — so traversal furniture is invisible to it.
 *
 * The first attempt at measuring this tested the camera against each traversal
 * MESH's bounding sphere and reported 88.4% of steps inside something, with a
 * worst penetration of 128 metres. That number is nonsense and the reason is
 * worth keeping: the rail meshes are MERGED, so one mesh holds every marker on
 * the mountain and its bounding sphere is the mountain. Per-mesh bounds cannot
 * answer this question at all.
 *
 * `Layout` can. It holds the per-INSTANCE placement of everything: walls as a
 * polyline plus a height, rails as a cage polyline plus a radius, boosters as a
 * point plus a radius. So this tests the segment from the character's head to the
 * camera against each wall plate as a vertical quad, and against each rail
 * segment as a capsule. A hit on that segment is the real defect — it means the
 * geometry is between the viewer and the thing they are steering.
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
  const L = g.traversal.layout;

  // Flatten the walls into plates once: each is a vertical quad from a to b,
  // rising `height` from the terrain under each end.
  const plates = [];
  for (let w = 0; w < L.walls.length; w++) {
    const n = L.walls[w].nodes;
    for (let i = 0; i + 1 < n.length; i++) {
      plates.push({
        w, ax: n[i].x, ay: n[i].y, az: n[i].z,
        bx: n[i + 1].x, by: n[i + 1].y, bz: n[i + 1].z,
        h: L.walls[w].height,
        d: L.walls[w].routeDistance,
      });
    }
  }
  // Booster BODIES. The ramp is the one that matters and the one the first
  // version of this probe never tested: `BoosterField` builds it as
  // `wedgeGeometry(radius * 1.7, rampLength, tan(power) * rampLength)`, which for
  // the layout's radius of 4.2 and lip angle of 0.42 rad is a solid 7.1 m wide,
  // 10 m long and 4.5 m tall. The camera boom is 7.4 m. Those numbers cannot
  // coexist, and _wedge.mjs confirmed by elimination that hiding the traversal
  // group is what makes the offending frame go away.
  //
  // Modelled as an upright cylinder around the body rather than an oriented box:
  // the question is whether the camera can see past it, and for that a slightly
  // generous convex hull is the safe direction to be wrong in.
  const bodies = [];
  for (let i = 0; i < L.boosters.length; i++) {
    const b = L.boosters[i];
    // kinds: 0..3, and only the ramp and the spring have real bulk. Sized off the
    // spec so a retune of the layout moves this with it.
    const isRamp = b.kind === 3 || b.kind === 'ramp';
    const r = isRamp ? Math.max(b.radius * 0.85, 5.0) : b.radius * 0.5;
    const h = isRamp ? 4.6 : 1.2;
    bodies.push({ i, x: b.position.x, y: b.position.y, z: b.position.z, r, h, d: b.routeDistance, ramp: isRamp });
  }

  // Rails as capsules, radius padded to the visual tube.
  const tubes = [];
  for (let r = 0; r < L.rails.length; r++) {
    const c = L.rails[r].cage;
    for (let i = 0; i + 1 < c.length; i++) {
      tubes.push({ r, a: c[i], b: c[i + 1], rad: L.rails[r].radius + 0.2, d: L.rails[r].routeDistance });
    }
  }

  // Segment (p,q) against a vertical quad. Solved in the horizontal plane first,
  // then the height of the crossing point is checked against the plate's span.
  function hitsPlate(px, py, pz, qx, qy, qz, pl) {
    const rx = qx - px, rz = qz - pz;
    const sx = pl.bx - pl.ax, sz = pl.bz - pl.az;
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) return false;
    const t = ((pl.ax - px) * sz - (pl.az - pz) * sx) / den;
    const u = ((pl.ax - px) * rz - (pl.az - pz) * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return false;
    const y = py + (qy - py) * t;
    const baseY = pl.ay + (pl.by - pl.ay) * u;
    return y >= baseY - 0.2 && y <= baseY + pl.h;
  }

  // Squared distance between two segments, for the capsule test.
  function segSegDist2(p1, p2, q1, q2) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
    const ex = q2.x - q1.x, ey = q2.y - q1.y, ez = q2.z - q1.z;
    const fx = p1.x - q1.x, fy = p1.y - q1.y, fz = p1.z - q1.z;
    const a = dx * dx + dy * dy + dz * dz, b = dx * ex + dy * ey + dz * ez;
    const c = ex * ex + ey * ey + ez * ez;
    const d = dx * fx + dy * fy + dz * fz, e = ex * fx + ey * fy + ez * fz;
    const den = a * c - b * b;
    let s = den > 1e-9 ? Math.min(1, Math.max(0, (b * e - c * d) / den)) : 0;
    let t = Math.min(1, Math.max(0, (a * e - b * d) / (c || 1e-9)));
    s = den > 1e-9 ? s : 0;
    const cx = fx + dx * s - ex * t, cy = fy + dy * s - ey * t, cz = fz + dz * s - ez * t;
    return cx * cx + cy * cy + cz * cz;
  }

  // Segment against an upright cylinder: solve in the horizontal plane, then
  // check the crossing height against the cylinder's span.
  function hitsCyl(px, py, pz, qx, qy, qz, b) {
    const dx = qx - px, dz = qz - pz;
    const fx = px - b.x, fz = pz - b.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-9) return false;
    const bq = 2 * (fx * dx + fz * dz);
    const cq = fx * fx + fz * fz - b.r * b.r;
    const disc = bq * bq - 4 * a * cq;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, (-bq - sq) / (2 * a));
    const t1 = Math.min(1, (-bq + sq) / (2 * a));
    if (t0 > t1) return false;
    const ym = py + (qy - py) * ((t0 + t1) * 0.5);
    return ym >= b.y - 0.3 && ym <= b.y + b.h;
  }

  g.stage.restart();
  g.stage.forceRunning();
  const s0 = g.track.sampleAtDistance(0);
  P.reset({ x: s0.position.x, y: s0.position.y, z: s0.position.z }, Math.atan2(s0.tangent.x, s0.tangent.z));
  P.state.velocity.set(0, 0, 0);
  cam.resetTo(P.state);

  const camObj = window.__DESCENT__.engine.camera;
  const DT = 1 / 120;
  let hint = 0, steps = 0, wallBlocked = 0, railBlocked = 0, bodyBlocked = 0, rampBlocked = 0;
  const spots = [];

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
    const hx = pos.x, hy = pos.y + 1.2, hz = pos.z;   // head height
    // Only the furniture near this stretch of route can matter, so the lists are
    // filtered by route distance rather than walked in full 14688 times.
    let wb = false, rb = false, bb = false, rampHit = false;
    for (const pl of plates) {
      if (Math.abs(pl.d - pr.distance) > 90) continue;
      if (hitsPlate(hx, hy, hz, c.x, c.y, c.z, pl)) { wb = true; break; }
    }
    for (const tb of tubes) {
      if (Math.abs(tb.d - pr.distance) > 90) continue;
      const d2 = segSegDist2({ x: hx, y: hy, z: hz }, c, tb.a, tb.b);
      if (d2 < tb.rad * tb.rad) { rb = true; break; }
    }
    for (const b of bodies) {
      if (Math.abs(b.d - pr.distance) > 90) continue;
      if (hitsCyl(hx, hy, hz, c.x, c.y, c.z, b)) { bb = true; if (b.ramp) rampHit = true; break; }
    }
    if (bb) bodyBlocked++;
    if (rampHit) rampBlocked++;
    if (wb) wallBlocked++;
    if (rb) railBlocked++;
    if (wb && spots.length < 12 && (spots.length === 0 || pr.distance - spots[spots.length - 1][0] > 25)) {
      spots.push([+pr.distance.toFixed(0), P.state.mode, +P.state.groundSpeed.toFixed(1)]);
    }
    if (['cleared', 'failed', 'results'].includes(g.stage.phase)) break;
  }

  return {
    plates: plates.length, tubes: tubes.length, bodies: bodies.length,
    ramps: bodies.filter((b) => b.ramp).length,
    boosterKinds: [...new Set(L.boosters.map((b) => b.kind))],
    steps,
    wallBlocked, pctWall: +((wallBlocked / steps) * 100).toFixed(1),
    railBlocked, pctRail: +((railBlocked / steps) * 100).toFixed(1),
    bodyBlocked, pctBody: +((bodyBlocked / steps) * 100).toFixed(1),
    rampBlocked, pctRamp: +((rampBlocked / steps) * 100).toFixed(1),
    wallSpots: spots,
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
