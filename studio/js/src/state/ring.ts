// Bounded ring buffer for the build log (default 2,000 lines).
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private start = 0;
  private count = 0;
  /** Entries overwritten since the last clear. */
  evicted = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number { return this.count; }

  push(value: T): void {
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = value;
      this.count += 1;
    } else {
      this.items[this.start] = value;
      this.start = (this.start + 1) % this.capacity;
      this.evicted += 1;
    }
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.capacity);
    this.start = 0;
    this.count = 0;
    this.evicted = 0;
  }

  /** Oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }

  /** Newest `n` entries, oldest first. */
  tail(n: number): T[] {
    const take = Math.max(0, Math.min(n, this.count));
    const out: T[] = [];
    for (let i = this.count - take; i < this.count; i += 1) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }
}
