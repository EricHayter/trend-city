/**
 * Pool — fixed-capacity free-list pool. Nothing in the game loop calls `new`.
 * Live objects are kept dense at the front of `items` so iteration is cache-friendly.
 */
export class Pool<T extends { alive: boolean }> {
  readonly items: T[] = [];
  /** Number of slots currently in use (always the dense prefix of `items`). */
  count = 0;
  readonly capacity: number;

  constructor(capacity: number, factory: () => T) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      const it = factory();
      it.alive = false;
      this.items.push(it);
    }
  }

  /** Returns an inactive object, or null when the pool is saturated. */
  spawn(): T | null {
    if (this.count >= this.capacity) return null;
    const it = this.items[this.count++];
    it.alive = true;
    return it;
  }

  /** Swap-remove; call from a reverse loop over [0, count). */
  release(i: number) {
    const it = this.items[i];
    it.alive = false;
    const last = --this.count;
    if (i !== last) {
      this.items[i] = this.items[last];
      this.items[last] = it;
    }
  }

  /** Sweep dead entries after an update pass that set `alive = false`. */
  compact() {
    for (let i = this.count - 1; i >= 0; i--) if (!this.items[i].alive) this.release(i);
  }

  clear() {
    for (let i = 0; i < this.count; i++) this.items[i].alive = false;
    this.count = 0;
  }
}
