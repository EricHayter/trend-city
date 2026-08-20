/**
 * _railprobe — does a rail actually mount, and does a wall actually run?
 *
 * The autorun census only ever sees `grounded` and `airborne`, so `Grinding` and
 * `WallRun` are affordances nothing has been observed entering. This does not
 * try to steer into one; it places the character exactly on each rail's grind
 * line (and each wall's face) with a speed above the mount floor, steps, and
 * reports the mode. That isolates "can the mount fire at all" from "can the
 * autopilot find it", which are different bugs with different fixes.
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://127.0.0.1:5173/?capture=1';
const STEPS = Number(process.env.STEPS ?? 60);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 180000 });

const out = await page.evaluate(async (STEPS) => {
  const g = window.__DESCENT__.game;
  g.capture.takeControl();
  const layout = g.traversal.layout;
  const P = g.player;

  const setVel = (v) => { P.state.velocity.set(v.x, v.y, v.z); };
  const yawOf = (t) => Math.atan2(t.x, t.z);

  // Spark's 74 through the documented conversion (`SPARK_UNIT_METRES = 9.81/36`).
  // Derived rather than restated, so if the conversion moves this is wrong in an
  // obvious way rather than a silent one — which is the bug this codebase keeps
  // finding.
  const top = (74 * 9.81) / 36;

  // `moveZ` is resolved against the character's `facing`, not the camera, so
  // this means "forward along the rail" for every trial. See `applyScripted`.
  g.scriptedInput = {
    moveX: 0, moveZ: 1, cameraYaw: 0,
    jump: false, jumpHeld: false, dash: false, crouch: false,
    attack: false, boost: false, dive: false,
  };

  function trial(pos, tangent, up, lift, speedFrac, steps) {
    const yaw = yawOf(tangent);
    P.reset({ x: pos.x, y: pos.y + lift, z: pos.z }, yaw);
    const s = top * speedFrac;
    setVel({ x: tangent.x * s, y: 0, z: tangent.z * s });
    const modes = {};
    let mounted = null;
    for (let i = 0; i < steps; i++) {
      g.capture.step(1 / 120);
      const m = P.state.mode;
      modes[m] = (modes[m] ?? 0) + 1;
      if ((m === 'grinding' || m === 'wall-run') && !mounted) {
        mounted = { mode: m, step: i, railIndex: P.state.railIndex, speed: +P.state.speed.toFixed(2) };
      }
    }
    return { modes, mounted, endMode: P.state.mode, endSpeed: +P.state.speed.toFixed(2) };
  }

  const rails = [];
  for (let i = 0; i < layout.rails.length; i++) {
    const r = layout.rails[i];
    const n = r.cage.length;
    if (n < 2) { rails.push({ i, err: 'cage<2' }); continue; }
    const a = r.cage[Math.max(0, Math.floor(n * 0.25))];
    const b = r.cage[Math.min(n - 1, Math.floor(n * 0.25) + 1)];
    const t = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const L = Math.hypot(t.x, t.y, t.z) || 1;
    t.x /= L; t.y /= L; t.z /= L;
    // On the line, and again dropping onto it from 2.5 m up. The second case is
    // the one `probeTraversal`'s airborne-asks-the-wall-first ordering could
    // regress: a rail beside a wall plate is approached IN THE AIR, which is
    // exactly when the wall now gets asked first.
    const res = trial(a, t, r.ups[0], 0.0, 0.9, STEPS);
    const air = trial(a, t, r.ups[0], 2.5, 0.9, STEPS);
    rails.push({ i, kind: r.kind, d: Math.round(r.routeDistance), ...res, airMounted: air.mounted });
  }

  // Two placement mistakes each cost a round of false failures here, and both
  // are worth stating so a third version does not repeat them.
  //
  // ONE: a wall run cannot be entered from the ground. `probeTraversal`'s
  // `canWall` requires `Airborne` or `Dashing`, so a character set down on the
  // face while grounded measures that gate and nothing else. This got 0/12.
  //
  // TWO: the plate's nodes sit at `baseY - 0.6`, and `baseY` is the MINIMUM
  // ground under the plate — so on a descent the ground in FRONT of the face is
  // 1.5 to 6.7 m above the node, and a start placed relative to the node is a
  // start placed inside the mountain. The terrain resolve then shoves the
  // character up through the band and out of the top before it ever crosses the
  // face. This got 3/12, and read exactly like a wall bug.
  //
  // So: sample the ground at the arrival point and start above THAT, clamped
  // into the panel's own band, off the face, moving into it and along it, and
  // already airborne. A real player arrives this way — off a jump, from ground
  // level, which is what `buried` measures.
  //
  // THREE, and this one is the reason the count read 3/12 for two rounds:
  // `StageDirector._routeDistance` is MONOTONIC (`if (proj.distance > this.
  // _routeDistance)`), and `WallSet.update` culls every panel further than
  // `WALL_TUNING.activeRange` — 300 m — from it. A probe that teleports
  // BACKWARD therefore leaves the window parked where the last trial ended, and
  // `WallSet.probe` skips the plate before it looks at a single gate. Rail
  // trials run first and finish at d=1910, so every wall inside d<1610 was
  // being culled rather than missed. `stage.restart()` puts the window back at
  // zero; trials then run in ascending route order, which monotonic allows.
  const walls = [];
  for (let i = 0; i < layout.walls.length; i++) {
    const w = layout.walls[i];
    const n = w.nodes.length;
    if (n < 2) { walls.push({ i, err: 'nodes<2' }); continue; }
    const k = Math.max(0, Math.floor(n * 0.3));
    const a = w.nodes[k];
    const b = w.nodes[Math.min(n - 1, k + 1)];
    const nm = w.normals[k];
    const t = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const L = Math.hypot(t.x, t.y, t.z) || 1;
    t.x /= L; t.y /= L; t.z /= L;

    // WALL_CONTACT is 0.76 m, so 1.3 m out is approaching rather than already
    // inside.
    const sx = a.x + nm.x * 1.3;
    const sz = a.z + nm.z * 1.3;
    // Band is [baseY + 0.6, baseY + height - 0.3] per WALL_TUNING. The node is
    // baseY - 0.6, so the band in node-relative terms is [1.2, height + 0.3].
    const bandLo = a.y + 1.2;
    const bandHi = a.y + w.height + 0.3;
    const ground = g.terrain.heightAt(sx, sz);
    // Airborne at the top of a short hop from the ground here, and inside the
    // band with a metre of margin at each end.
    const sy = Math.min(Math.max(ground + 1.2, bandLo + 1.0), bandHi - 1.0);
    const yaw = Math.atan2(t.x, t.z);
    // Unpark the monotonic route window before teleporting backward. See above.
    g.stage.restart();
    g.stage.forceRunning();
    P.reset({ x: sx, y: sy, z: sz }, yaw);
    P.state.velocity.set(
      t.x * top * 0.8 - nm.x * 6.0,
      1.0,
      t.z * top * 0.8 - nm.z * 6.0,
    );
    P.state.mode = 'airborne';
    P.state.airTime = 0.15;

    const modes = {};
    let mounted = null;
    for (let step = 0; step < STEPS; step++) {
      g.capture.step(1 / 120);
      const m = P.state.mode;
      modes[m] = (modes[m] ?? 0) + 1;
      if (m === 'wall-run' && !mounted) {
        mounted = { step, speed: +P.state.speed.toFixed(2), wallId: P.state.wallId };
      }
    }
    walls.push({
      i, chimney: w.chimney, d: Math.round(w.routeDistance),
      modes, mounted, endMode: P.state.mode,
      // Diagnostics, so a miss says which gate it missed.
      baseY: +a.y.toFixed(1), height: +w.height.toFixed(1),
      startY: +sy.toFixed(1), groundY: +ground.toFixed(1),
      endY: +P.state.position.y.toFixed(1),
      // Which affordance won instead. `probeTraversal` tries rails BEFORE walls
      // and returns on a mount, so a rail inside the plate's approach takes it.
      stoleBy: P.state.railIndex >= 0 ? `rail${P.state.railIndex}` : null,
      prompt: P.state.prompt ?? null,
    });
  }

  return { top, rails, walls };
}, STEPS);

const mounted = out.rails.filter((r) => r.mounted).length;
const airMounted = out.rails.filter((r) => r.airMounted).length;
const wallran = out.walls.filter((w) => w.mounted).length;
console.log(`top speed used: ${out.top}`);
console.log(`RAILS  ${mounted}/${out.rails.length} mounted on the line, ${airMounted}/${out.rails.length} dropping in from 2.5 m`);
for (const r of out.rails) {
  const m = r.mounted ? `GRIND@step${r.mounted.step} idx${r.mounted.railIndex} spd${r.mounted.speed}` : `-- ${JSON.stringify(r.modes)}`;
  console.log(`  rail ${String(r.i).padStart(2)} ${String(r.kind).padEnd(9)} d=${String(r.d).padStart(4)}  ${m}`);
}
console.log(`WALLS  ${wallran}/${out.walls.length} ran`);
for (const w of out.walls) {
  const m = w.mounted
    ? `WALLRUN@step${w.mounted.step} spd${w.mounted.speed} id${w.mounted.wallId}`
    : `-- ${JSON.stringify(w.modes)} stolenBy=${w.stoleBy} base=${w.baseY} h=${w.height} grd=${w.groundY} start=${w.startY} end=${w.endY}`;
  console.log(`  wall ${String(w.i).padStart(2)} ${w.chimney ? 'chimney' : 'plain  '} d=${String(w.d).padStart(4)}  ${m}`);
}
await browser.close();
