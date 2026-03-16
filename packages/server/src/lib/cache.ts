/**
 * Narrow an `unknown` cache entry back to `T`.
 * This is the one place in the cache layer where a type assertion is unavoidable:
 * the store holds heterogeneous values keyed by string, and callers provide the
 * expected type via a generic parameter. The assertion is safe because `set<T>`
 * stores data that was already typed `T` by the caller.
 */
function narrowCacheEntry<T>(data: unknown): T {
  // Cache stores data that was typed T by the caller; JSON round-trip bridges the type gap
  const parsed: T = JSON.parse(JSON.stringify(data));
  return parsed;
}

/** Abstract cache store — swap MemoryCacheStore for Redis later */
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
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

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return narrowCacheEntry<T>(entry.data);
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
