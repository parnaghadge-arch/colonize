/**
 * Tiny in-process TTL cache (§60 caching).
 *
 * Used for hot, low-cardinality lookups: society records, permission sets and settings.
 * Every entry has a bounded TTL so a change in another instance becomes visible within
 * seconds, and `invalidatePrefix` lets a writer drop exactly what it changed.
 *
 * A Redis driver can be swapped in behind the same interface for multi-instance
 * deployments (CACHE_DRIVER=redis); the call sites do not change.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache {
  private readonly store = new Map<string, Entry<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly defaultTtlMs = 30_000,
    private readonly maxEntries = 5_000,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    if (this.store.size >= this.maxEntries) this.evict();
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Get-or-compute with in-flight de-duplication (prevents a cache stampede). */
  async wrap<T>(key: string, loader: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const pending = TtlCache.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        TtlCache.inFlight.delete(key);
      });
    TtlCache.inFlight.set(key, promise as Promise<unknown>);
    return promise;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
    TtlCache.inFlight.clear();
  }

  private evict(): void {
    // Drop the 10% closest to expiry.
    const entries = Array.from(this.store.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const drop = Math.max(1, Math.floor(this.maxEntries * 0.1));
    for (let i = 0; i < drop && i < entries.length; i += 1) {
      this.store.delete(entries[i]![0]);
    }
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { size: this.store.size, hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0 };
  }

  private static readonly inFlight = new Map<string, Promise<unknown>>();
}

/** Cache for society records (platform DB) — keyed by id or slug. */
export const societyCache = new TtlCache(60_000, 2_000);
/** Cache for a user's resolved permission set inside a society. */
export const permissionCache = new TtlCache(30_000, 20_000);
/** Cache for society settings namespaces. */
export const settingsCache = new TtlCache(60_000, 10_000);
/** Generic cache for computed dashboards/reports (short TTL). */
export const reportCache = new TtlCache(15_000, 1_000);

/** Invalidate everything derived from a society (used after settings/role changes). */
export function invalidateSociety(societyId: string): void {
  societyCache.invalidatePrefix(`soc:${societyId}`);
  societyCache.invalidatePrefix(`slug:`);
  permissionCache.invalidatePrefix(`perm:${societyId}`);
  settingsCache.invalidatePrefix(`set:${societyId}`);
  reportCache.invalidatePrefix(`rep:${societyId}`);
}
