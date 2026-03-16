/** Abstract cache store — swap MemoryCacheStore for Redis later */
export interface CacheStore {
  get(key: string): Promise<unknown | undefined>;
  set<T>(key: string, data: T, ttlMs: number): Promise<void>;
  invalidateByPrefix(prefix: string): Promise<void>;
  invalidateAll(): Promise<void>;
}

class MemoryCacheStore implements CacheStore {
  private store = new Map<string, { data: unknown; expiresAt: number }>();
  private sweepInterval: ReturnType<typeof setInterval>;

  constructor(sweepIntervalMs = 5 * 60 * 1000) {
    this.sweepInterval = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't keep process alive just for cache cleanup
    if (this.sweepInterval.unref) this.sweepInterval.unref();
  }

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async invalidateAll(): Promise<void> {
    this.store.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }
}

export const queryCache: CacheStore = new MemoryCacheStore();
