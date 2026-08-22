/**
 * _winding.mjs — are any wall plates built inside-out?
 *
 * _hullhide.mjs showed that the black column at d=980 is `wall-plate-4:hull`
 * painting ink over the whole plate, and that hiding it reveals correctly-shaded
 * rock. An inverted hull can only do that if the faces it draws are the ones
 * facing the camera, which means the plate's winding is reversed: the cel
 * material would not give that away on a closed box (you see the inside of the far
 * wall and it still looks like rock), but a BackSide hull would, exactly like this.
 *
 * The suspect is WallSet.buildGeometry. It places each closed slab with
 * `_m.makeBasis(_ax, _ay, _az)` where `_az` is the panel normal after a sign
 * match against the authored outward normal:
 *
 *     let nx = -uz, nz = ux;
 *     if (nx * ref.x + nz * ref.z < 0) { nx = -nx; nz = -nz; }
 *
 * Unflipped, (dir, up, normal) is right-handed and the determinant is +1. Flipped,
 * `_az = -(_ax x _ay)` and the triple is LEFT-handed — a negative determinant, which
 * mirrors the geometry and reverses every triangle. Whether a given plate is
 * affected therefore depends on the authored normal, which is why only some of the
 * nine are black.
 *
 * Signed volume is the exact test and it needs no camera. For a closed mesh,
 * V = (1/6) * sum over triangles of v0 . (v1 x v2), positive when wound outward.
 * It is additive over disjoint closed components, so a merged mesh of many slabs
 * answers for all of them at once — which matters here because MeshBuilder merges
 * per tag per chunk.
 *
 * Usage: node tools/capture/_winding.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => { if (!/SERVER_FORWARD_CONSOLE/.test(e.message)) console.log('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:5173/?capture=1&pr=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__DESCENT__?.game?.capture, null, { timeout: 240000 });

const out = await page.evaluate(() => {
  const scene = window.__DESCENT__.engine?.scene;
  if (!scene?.traverse) throw new Error('no scene: engine keys ' + Object.keys(window.__DESCENT__.engine ?? {}).join(','));

  const rows = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.userData?.isHull) return;
    const pa = o.geometry?.attributes?.position;
    if (!pa) return;
    const idx = o.geometry.index;
    const tris = idx ? idx.count / 3 : pa.count / 3;
    if (tris < 1 || tris > 200000) return;

    // Centre the mesh on its own centroid first. Signed volume is
    // translation-invariant only in exact arithmetic; against float32 world
    // coordinates in the thousands it is all cancellation and noise.
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < pa.count; i++) { cx += pa.getX(i); cy += pa.getY(i); cz += pa.getZ(i); }
    cx /= pa.count; cy /= pa.count; cz /= pa.count;

    let vol = 0, area = 0;
    for (let t = 0; t < tris; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3;
      const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const ax = pa.getX(a) - cx, ay = pa.getY(a) - cy, az = pa.getZ(a) - cz;
      const bx = pa.getX(b) - cx, by = pa.getY(b) - cy, bz = pa.getZ(b) - cz;
      const gx = pa.getX(c) - cx, gy = pa.getY(c) - cy, gz = pa.getZ(c) - cz;
      const nx = by * gz - bz * gy, ny = bz * gx - bx * gz, nz = bx * gy - by * gx;
      vol += ax * nx + ay * ny + az * nz;
      area += Math.hypot(nx, ny, nz);
    }
    vol /= 6;
    rows.push({ name: o.name || '(unnamed)', tris, vol: +vol.toFixed(1), area: +(area / 2).toFixed(0) });
  });

  const plates = rows.filter((r) => /^wall-plate/.test(r.name));
  const rails = rows.filter((r) => /rail/.test(r.name));
  const negative = rows.filter((r) => r.vol < 0);
  return {
    plates,
    rails: rails.slice(0, 8),
    negativeCount: negative.length,
    negative: negative.slice(0, 25),
    totalMeshes: rows.length,
  };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
