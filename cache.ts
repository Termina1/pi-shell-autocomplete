/**
 * Generic TTL cache with stampede prevention.
 * `getOrLoad()` deduplicates concurrent loads for the same key.
 */
export class Cache<K, V> {
  private store = new Map<K, { value: V; expiresAt: number }>();
  private pending = new Map<K, Promise<V>>();

  constructor(private ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }

  /**
   * Get or load a value with stampede prevention.
   * If a load is already in progress for this key, returns the existing promise.
   */
  async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Get current value (even if stale), then refresh in background.
   * Returns the stale value immediately if available.
   */
  getStaleWhileRevalidate(key: K, loader: () => Promise<V>): V | undefined {
    const entry = this.store.get(key);
    const stale = entry?.value;

    // Fire background refresh if stale or missing
    if (!entry || Date.now() > entry.expiresAt) {
      this.getOrLoad(key, loader).catch(() => {});
    }

    return stale;
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * LRU cache with configurable max size.
 * When full, evicts the oldest `evictCount` entries.
 */
export class LruCache<K, V> {
  private store = new Map<K, V>();
  private accessOrder: K[] = [];

  constructor(
    private maxSize: number,
    private evictCount: number = Math.floor(maxSize / 4),
  ) {}

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
      this.accessOrder.push(key);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.set(key, value);
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
      this.accessOrder.push(key);
      return;
    }

    if (this.store.size >= this.maxSize) {
      const toEvict = this.accessOrder.splice(0, this.evictCount);
      for (const k of toEvict) {
        this.store.delete(k);
      }
    }

    this.store.set(key, value);
    this.accessOrder.push(key);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  delete(key: K): void {
    this.store.delete(key);
    this.accessOrder = this.accessOrder.filter((k) => k !== key);
  }

  clear(): void {
    this.store.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.store.size;
  }
}
