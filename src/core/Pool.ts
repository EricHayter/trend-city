// Fixed-capacity object pool. Particles, projectiles, enemies, debris and damage
// pops all come from one of these, so the main loop never allocates.
export class Pool<T> {
  readonly items: T[] = [];
  activeCount = 0;
  private freeList: number[] = [];
  private activeFlags: boolean[] = [];
  private onRelease: ((item: T) => void) | null;

  constructor(capacity: number, factory: (index: number) => T, onRelease?: (item: T) => void) {
    this.onRelease = onRelease || null;
    for (let i = 0; i < capacity; i++) {
      this.items.push(factory(i));
      this.activeFlags.push(false);
      this.freeList.push(capacity - 1 - i);
    }
  }

  get capacity(): number { return this.items.length; }

  acquire(): T | null {
    const i = this.freeList.pop();
    if (i === undefined) return null;
    this.activeFlags[i] = true;
    this.activeCount++;
    (this.items[i] as any).poolIndex = i;
    return this.items[i];
  }

  release(item: T): void {
    const i = (item as any).poolIndex as number;
    if (i === undefined || !this.activeFlags[i]) return;
    this.activeFlags[i] = false;
    this.activeCount--;
    this.freeList.push(i);
    if (this.onRelease) this.onRelease(item);
  }

  isActive(index: number): boolean { return this.activeFlags[index]; }

  releaseAll(): void {
    for (let i = 0; i < this.items.length; i++) {
      if (!this.activeFlags[i]) continue;
      this.activeFlags[i] = false;
      this.freeList.push(i);
      if (this.onRelease) this.onRelease(this.items[i]);
    }
    this.activeCount = 0;
  }
}
