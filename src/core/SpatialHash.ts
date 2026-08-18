// Uniform grid over the XZ plane. The borough holds several thousand collision
// solids; a query only touches the cells near the query box, so per-frame collision
// cost stays flat no matter how large the level gets.
// query() fills a caller-owned array, so nothing is allocated per frame.
export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  private stamp = new Map<T, number>();
  private queryId = 0;
  private cellSize: number;

  constructor(cellSize = 16) { this.cellSize = cellSize; }

  private key(cx: number, cz: number): number {
    return ((cx + 32768) * 65536) + (cz + 32768);
  }

  insert(item: T, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const cs = this.cellSize;
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(item);
      }
    }
  }

  query(minX: number, minZ: number, maxX: number, maxZ: number, out: T[]): number {
    const cs = this.cellSize;
    const id = ++this.queryId;
    let n = 0;
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(this.key(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (this.stamp.get(it) === id) continue;
          this.stamp.set(it, id);
          out[n++] = it;
        }
      }
    }
    return n;
  }

  clear(): void { this.cells.clear(); this.stamp.clear(); }
  get cellCount(): number { return this.cells.size; }
}
