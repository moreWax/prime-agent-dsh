export interface PoolEntry {
  readonly key: string;
  lastUsedAt: number;
  idleTtlMs: number;
  activeUses: number;
}

/** Concurrent creation, acquisition accounting, and busy-safe TTL/LRU policy. */
export class BusyLruPool<T extends PoolEntry> {
  private readonly entries = new Map<string, T>();
  private readonly creations = new Map<string, Promise<T>>();

  constructor(
    private readonly dispose: (entry: T) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(key: string, maximum: number, create: () => Promise<T>): Promise<T> {
    let pending = this.creations.get(key);
    let ownsCreation = false;
    if (!pending) {
      const existing = this.entries.get(key);
      if (existing) {
        existing.activeUses++;
        existing.lastUsedAt = this.now();
        return existing;
      }
      ownsCreation = true;
      pending = this.createAndInsert(key, maximum, create);
      this.creations.set(key, pending);
      void pending.finally(() => this.creations.delete(key)).catch(() => undefined);
    }
    const entry = await pending;
    if (!ownsCreation) entry.activeUses++;
    entry.lastUsedAt = this.now();
    return entry;
  }

  touch(entry: T): void {
    entry.lastUsedAt = this.now();
  }

  release(entry: T): void {
    if (entry.activeUses > 0) entry.activeUses--;
    entry.lastUsedAt = this.now();
  }

  async remove(entry: T, force = false): Promise<boolean> {
    if (!force && entry.activeUses > 0) return false;
    if (this.entries.get(entry.key) !== entry) return false;
    this.entries.delete(entry.key);
    await this.dispose(entry);
    return true;
  }

  async sweepExpired(): Promise<void> {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.activeUses === 0 && entry.lastUsedAt + entry.idleTtlMs < now) {
        await this.remove(entry);
      }
    }
  }

  values(): IterableIterator<T> { return this.entries.values(); }
  get size(): number { return this.entries.size; }

  private async createAndInsert(key: string, maximum: number, create: () => Promise<T>): Promise<T> {
    const entry = await create();
    if (entry.key !== key) throw new Error(`pool factory returned wrong key: ${entry.key}`);
    // Reserve the creator's acquisition before publishing. A different key's
    // concurrent insertion must not evict this entry in the promise wake-up gap.
    entry.activeUses++;
    while (this.entries.size >= maximum) {
      const lru = [...this.entries.values()]
        .filter((candidate) => candidate.activeUses === 0)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!lru) break; // all entries are busy; temporary overflow is safer
      await this.remove(lru);
    }
    this.entries.set(key, entry);
    return entry;
  }
}
