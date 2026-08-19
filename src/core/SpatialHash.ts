/**
 * SpatialHash — uniform grid broadphase over the XZ plane.
 *
 * Built once per stage from static colliders and queried every frame by the
 * player motor and every enemy. Storage is flat typed arrays: one pass fills a
 * per-cell count, a prefix sum turns it into offsets, a second pass writes ids.
 * No per-query allocation, no Map lookups in the hot path.
 */
export class SpatialHash {
  readonly cell: number;
  private minX = 0; private minZ = 0;
  private nx = 1; private nz = 1;
  private starts: Int32Array = new Int32Array(1);
  private ids: Int32Array = new Int32Array(0);
  /** Scratch output buffer reused by every query. */
  readonly out = new Int32Array(16384);
  outCount = 0;
  private stamp = new Int32Array(0);
  private stampVal = 0;

  constructor(cell = 12) { this.cell = cell; }

  /**
   * @param boxes flat [minx,miny,minz,maxx,maxy,maxz] * n
   */
  build(boxes: Float32Array, n: number) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      if (boxes[o] < minX) minX = boxes[o];
      if (boxes[o + 2] < minZ) minZ = boxes[o + 2];
      if (boxes[o + 3] > maxX) maxX = boxes[o + 3];
      if (boxes[o + 5] > maxZ) maxZ = boxes[o + 5];
    }
    if (n === 0) { minX = minZ = 0; maxX = maxZ = 1; }
    this.minX = minX - this.cell; this.minZ = minZ - this.cell;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 2);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / this.cell) + 2);

    const cells = this.nx * this.nz;
    const counts = new Int32Array(cells + 1);
    if (this.stamp.length < n) this.stamp = new Int32Array(n);

    // pass 1 — count
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const x0 = this.cx(boxes[o]), x1 = this.cx(boxes[o + 3]);
      const z0 = this.cz(boxes[o + 2]), z1 = this.cz(boxes[o + 5]);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * this.nx + x + 1]++;
    }
    // prefix sum
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.starts = counts;
    this.ids = new Int32Array(counts[cells]);
    const cursor = new Int32Array(cells);
    // pass 2 — scatter
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const x0 = this.cx(boxes[o]), x1 = this.cx(boxes[o + 3]);
      const z0 = this.cz(boxes[o + 2]), z1 = this.cz(boxes[o + 5]);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const c = z * this.nx + x;
        this.ids[counts[c] + cursor[c]++] = i;
      }
    }
  }

  private cx(v: number) {
    const i = Math.floor((v - this.minX) / this.cell);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }
  private cz(v: number) {
    const i = Math.floor((v - this.minZ) / this.cell);
    return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i;
  }

  /** Fills `out` with unique collider ids overlapping the XZ rect. Returns the count. */
  query(x0: number, z0: number, x1: number, z1: number): number {
    const cx0 = this.cx(x0), cx1 = this.cx(x1), cz0 = this.cz(z0), cz1 = this.cz(z1);
    this.stampVal++;
    let n = 0;
    const cap = this.out.length;
    for (let z = cz0; z <= cz1; z++) {
      const row = z * this.nx;
      for (let x = cx0; x <= cx1; x++) {
        const c = row + x;
        const s = this.starts[c], e = this.starts[c + 1];
        for (let i = s; i < e; i++) {
          const id = this.ids[i];
          if (this.stamp[id] === this.stampVal) continue;
          this.stamp[id] = this.stampVal;
          if (n < cap) this.out[n++] = id;
        }
      }
    }
    this.outCount = n;
    return n;
  }

  /** Convenience: query a sphere's XZ footprint. */
  queryPoint(x: number, z: number, r: number) { return this.query(x - r, z - r, x + r, z + r); }
}
