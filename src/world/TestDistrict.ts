/**
 * TestDistrict — a hand-authored borough block used to validate the Kit and the
 * cel pipeline against captured frames before the procedural assembler exists.
 * Every call here is a call the generated modules will make, so whatever looks
 * wrong in this district is wrong in the whole game.
 */
import * as THREE from 'three';
import { Kit } from './Kit';
import { SF } from './Types';
import type { Rng } from '../core/Rng';
import { C } from '../render/Palette';

const IDENT = new THREE.Matrix4();

export function buildTestDistrict(kit: Kit, root: THREE.Object3D, rng: Rng) {
  const b = kit.biome;

  // ── the elevated highway: one deck sample every 8 m, S-curve + rolling grade
  const SEG = 8, N = 68;
  const pts = new Float32Array(N * 3);
  const hw = new Float32Array(N);
  const roll = new Float32Array(N);
  let x = 0;
  const curveA = rng.range(0.0016, 0.0026);
  for (let i = 0; i < N; i++) {
    const z = -40 + i * SEG;
    // two out-of-phase sines: reads as a designed sweep, not noise
    const c = Math.sin(z * curveA * 1.7) * 46 + Math.sin(z * curveA * 0.55 + 1.3) * 26;
    x = c;
    const y = 8 + Math.sin(z * 0.0042 + 0.4) * 5.5 + Math.sin(z * 0.011) * 1.6;
    pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z;
    hw[i] = 11 + Math.sin(z * 0.006) * 2.2;
  }
  // bank into the curvature, computed from the finished centreline
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 1), c = Math.min(N - 1, i + 1);
    const dx0 = pts[i * 3] - pts[a * 3], dz0 = pts[i * 3 + 2] - pts[a * 3 + 2];
    const dx1 = pts[c * 3] - pts[i * 3], dz1 = pts[c * 3 + 2] - pts[i * 3 + 2];
    const h0 = Math.atan2(dx0, dz0), h1 = Math.atan2(dx1, dz1);
    let d = h1 - h0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    roll[i] = THREE.MathUtils.clamp(d * 3.2, -0.34, 0.34);
  }

  kit.begin('highway', 'straight', IDENT);
  kit.deck(pts, N, hw, 1.5, {
    cls: 'concrete', tex: 'concrete', tint: b.tints.deck, uvScale: 7,
    flags: SF.SOLID, sideFlags: SF.SOLID, wsegs: 4, inkWidth: 2.6,
  });

  // ── barriers: low walls with an emissive strip, hugging both deck edges
  for (const s of [-1, 1] as const) {
    for (let i = 0; i < N - 1; i++) {
      const rx = pts[(i + 1) * 3] - pts[i * 3], rz = pts[(i + 1) * 3 + 2] - pts[i * 3 + 2];
      const l = Math.hypot(rx, rz) || 1;
      const nx = -rz / l * s, nz = rx / l * s;
      const x0 = pts[i * 3] + nx * hw[i], z0 = pts[i * 3 + 2] + nz * hw[i];
      const x1 = pts[(i + 1) * 3] + nx * hw[i + 1], z1 = pts[(i + 1) * 3 + 2] + nz * hw[i + 1];
      const y0 = pts[i * 3 + 1];
      kit.wall(x0, z0, x1, z1, y0, 1.15, 0.55, {
        cls: 'metal', tex: 'metal', tint: b.tints.metal, sideFlags: SF.SOLID, inkWidth: 2.0,
      });
      // light strip: unlit emissive so it blooms without lighting the wall
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      kit.pushTRS(mx, y0 + 1.22, mz, yaw);
      kit.box(0, 0, 0, 0.28, 0.1, l * 0.86, {
        cls: 'emissive', unlit: true, color: i % 7 === 0 ? C.hot : b.tints.trim, ink: false, collide: false,
      });
      kit.pop();
    }
  }

  // ── city blocks either side, laid out on a grid with cross-streets so the
  // silhouette reads as a designed skyline instead of scattered boxes
  const blockRng = rng.fork('blocks');
  const pick = blockRng.bag([26, 34, 44, 58, 74, 96, 128]);
  for (let i = 2; i < N - 2; i += 2) {
    const z = pts[i * 3 + 2];
    if (Math.floor(z / 96) % 4 === 0) continue;            // deliberate cross-street gaps
    const rx = pts[(i + 1) * 3] - pts[i * 3], rz = pts[(i + 1) * 3 + 2] - pts[i * 3 + 2];
    const l = Math.hypot(rx, rz) || 1;
    for (const s of [-1, 1] as const) {
      const nx = -rz / l * s, nz = rx / l * s;
      const rowCount = 3;
      for (let r = 0; r < rowCount; r++) {
        if (blockRng.bool(r === 0 ? 0.30 : 0.55)) continue;
        const off = hw[i] + 16 + r * 30 + blockRng.range(-3, 3);
        const bx = pts[i * 3] + nx * off, bz = pts[i * 3 + 2] + nz * off;
        const hgt = pick() * (r === 0 ? 0.55 : 1) * blockRng.range(0.85, 1.2);
        const w = blockRng.range(14, 24), d = blockRng.range(14, 26);
        const baseY = -34;
        const yaw = Math.atan2(nx, nz) + blockRng.range(-0.1, 0.1);
        kit.pushTRS(bx, baseY + hgt / 2, bz, yaw);
        kit.box(0, 0, 0, w, hgt, d, {
          cls: 'concrete', tex: 'facade', seed: blockRng.nextInt(1, 900),
          uvScale: 13, flags: SF.SOLID, inkWidth: 2.9,
        });
        // roof cap + a mast, so the skyline has punctuation
        kit.box(0, hgt / 2 + 0.7, 0, w * 0.92, 1.4, d * 0.92, {
          cls: 'metal', tex: 'metal', tint: b.tints.dark, uvScale: 3, inkWidth: 2.2,
        });
        if (blockRng.bool(0.45)) {
          kit.cyl(blockRng.range(-w * 0.2, w * 0.2), hgt / 2 + 1.4, blockRng.range(-d * 0.2, d * 0.2),
            0.32, 0.14, blockRng.range(6, 16), 6,
            { cls: 'metal', tex: 'metal', tint: b.tints.metal, collide: false, inkWidth: 1.6 });
        }
        if (blockRng.bool(0.35)) {
          const sw = blockRng.range(5, 11), sh = sw * 0.34;
          kit.panel(
            w / 2 + 0.3, hgt / 2 - 6, -sw / 2, w / 2 + 0.3, hgt / 2 - 6 - sh, -sw / 2,
            w / 2 + 0.3, hgt / 2 - 6 - sh, sw / 2, w / 2 + 0.3, hgt / 2 - 6, sw / 2,
            { cls: 'emissive', unlit: true, tex: 'grid', tint: blockRng.pick(b.accents), div: 4, uvScale: 2.2 },
          );
        }
        kit.pop();
      }
    }
  }

  // ── a wall-run face: a long slab beside the deck, angled slightly inward
  {
    const i = 30;
    const rx = pts[(i + 1) * 3] - pts[i * 3], rz = pts[(i + 1) * 3 + 2] - pts[i * 3 + 2];
    const l = Math.hypot(rx, rz) || 1;
    const nx = -rz / l, nz = rx / l;
    const x0 = pts[i * 3] + nx * (hw[i] + 2.4), z0 = pts[i * 3 + 2] + nz * (hw[i] + 2.4);
    const j = i + 10;
    const x1 = pts[j * 3] + nx * (hw[j] + 2.4), z1 = pts[j * 3 + 2] + nz * (hw[j] + 2.4);
    kit.wall(x0, z0, x1, z1, pts[i * 3 + 1] - 2, 16, 1.8, {
      cls: 'metal', tex: 'metal', tint: b.tints.metal, uvScale: 5,
      sideFlags: SF.SOLID | SF.WALLRUN, inkWidth: 2.8,
    });
  }

  // ── service pipes slung under the deck: reads as infrastructure, adds depth
  {
    const pp = new Float32Array(N * 3);
    for (const off of [-7.5, -2.5, 3.5, 8]) {
      for (let i = 0; i < N; i++) {
        const a = Math.max(0, i - 1), c = Math.min(N - 1, i + 1);
        const dx = pts[c * 3] - pts[a * 3], dz = pts[c * 3 + 2] - pts[a * 3 + 2];
        const l = Math.hypot(dx, dz) || 1;
        pp[i * 3] = pts[i * 3] + (-dz / l) * off;
        pp[i * 3 + 1] = pts[i * 3 + 1] - 2.6 - Math.abs(off) * 0.06;
        pp[i * 3 + 2] = pts[i * 3 + 2] + (dx / l) * off;
      }
      kit.tube(pp, N, 0.42 + Math.abs(off) * 0.02, 8, {
        cls: 'rust', tex: 'metal', tint: b.tints.dark, uvScale: 2.6,
        collide: false, inkWidth: 1.8,
      });
    }
  }

  // ── a grind rail arcing above the road, entering and exiting the deck
  {
    const RN = 26;
    const rp: { x: number; y: number; z: number }[] = [];
    for (let k = 0; k < RN; k++) {
      const t = k / (RN - 1);
      const i = Math.round((12 + t * 34));
      const idx = Math.min(N - 1, i);
      const a = Math.max(0, idx - 1), c = Math.min(N - 1, idx + 1);
      const dx = pts[c * 3] - pts[a * 3], dz = pts[c * 3 + 2] - pts[a * 3 + 2];
      const l = Math.hypot(dx, dz) || 1;
      const side = Math.sin(t * Math.PI * 1.5) * 7.5;
      rp.push({
        x: pts[idx * 3] + (-dz / l) * side,
        y: pts[idx * 3 + 1] + 1.1 + Math.sin(t * Math.PI) * 11,
        z: pts[idx * 3 + 2] + (dx / l) * side,
      });
    }
    const rf = new Float32Array(RN * 3);
    for (let k = 0; k < RN; k++) { rf[k * 3] = rp[k].x; rf[k * 3 + 1] = rp[k].y; rf[k * 3 + 2] = rp[k].z; }
    kit.tube(rf, RN, 0.22, 6, {
      cls: 'emissive', unlit: true, color: C.volt, collide: false, ink: true, inkWidth: 1.5,
    });
    // support struts every few samples so the rail is attached to something
    for (let k = 2; k < RN - 2; k += 5) {
      const iy = pts[Math.min(N - 1, Math.round(12 + (k / (RN - 1)) * 34)) * 3 + 1];
      kit.cyl(rp[k].x, iy + 0.7, rp[k].z, 0.16, 0.16, Math.max(0.4, rp[k].y - iy - 0.7), 6,
        { cls: 'metal', tex: 'metal', tint: b.tints.metal, collide: false, inkWidth: 1.4 });
    }
    kit.rail({ points: rp, radius: 1.7, boost: 0.22, style: 'rail', color: C.volt, launch: { power: 1.25, up: 0.5 } });
  }

  // ── launch ramp on the deck
  {
    const i = 50;
    const yaw = Math.atan2(pts[(i + 1) * 3] - pts[i * 3], pts[(i + 1) * 3 + 2] - pts[i * 3 + 2]);
    kit.pushTRS(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], yaw);
    const RP = new Float32Array(7 * 3);
    for (let k = 0; k < 7; k++) {
      const t = k / 6;
      RP[k * 3] = 0; RP[k * 3 + 1] = t * t * 5.2; RP[k * 3 + 2] = t * 22;
    }
    kit.deck(RP, 7, 6.5, 1.0, {
      cls: 'metal', tex: 'hazard', tint: C.gold, uvScale: 3,
      flags: SF.SOLID | SF.BOOST, wsegs: 2, inkWidth: 2.4,
    });
    kit.pop();
  }

  // ── distant landmarks: three enormous towers well off the route, for scale
  {
    const lr = rng.fork('landmark');
    const spots: Array<[number, number, number, number]> = [
      [-330, 620, 300, 74], [420, 900, 240, 96], [-160, 1350, 420, 130],
    ];
    for (const [lx, lz, hgt, rad] of spots) {
      kit.cyl(lx, -60, lz, rad, rad * 0.62, hgt, 14, {
        cls: 'concrete', tex: 'facade', seed: lr.nextInt(1, 900), uvScale: 26,
        collide: false, inkWidth: 3.4,
      });
      kit.cyl(lx, -60 + hgt, lz, rad * 0.7, rad * 0.18, hgt * 0.22, 12, {
        cls: 'metal', tex: 'metal', tint: b.tints.dark, uvScale: 8, collide: false, inkWidth: 3.0,
      });
      for (let k = 0; k < 5; k++) {
        kit.cyl(lx, -60 + hgt * (0.24 + k * 0.15), lz, rad * 1.14, rad * 1.14, 2.2, 14, {
          cls: 'emissive', unlit: true, color: lr.pick(b.accents), collide: false, ink: false,
        });
      }
    }
  }

  // ── the void floor: far below, dark, so falling reads as falling
  // Unlit and very dark on purpose: this is meant to read as an abyss with a
  // faint machine grid in it, not as a lit surface. Anything brighter and the
  // bottom of the frame competes with the playable geometry.
  kit.box(0, -132, 400, 2600, 6, 2600, {
    cls: 'digital', tex: 'grid', tint: '#1a2c48', color: '#2b2545', div: 24, uvScale: 64,
    emissive: '#2f5f8c', emissiveIntensity: 0.20, unlit: true,
    flags: SF.SOLID | SF.DEATH, ink: false,
  });

  const built = kit.end();
  root.add(built.group);
}
