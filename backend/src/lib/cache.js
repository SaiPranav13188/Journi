// Tiny in-memory TTL cache. Good enough for a single Render instance; swap for
// Redis if the API is ever scaled horizontally.

export class TtlCache {
  constructor({ ttlMs, maxEntries = 1000 }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.store.size >= this.maxEntries) {
      // Evict the oldest entry (Map preserves insertion order).
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key) {
    this.store.delete(key);
  }

  // Returns the cached value or computes, caches and returns it. Concurrent
  // callers for the same key share one in-flight promise.
  async wrap(key, compute, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pendingKey = `__pending__${key}`;
    const pending = this.store.get(pendingKey);
    if (pending) return pending.value;

    const promise = (async () => {
      try {
        const value = await compute();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.store.delete(pendingKey);
      }
    })();
    this.store.set(pendingKey, { value: promise, expiresAt: Date.now() + 60_000 });
    return promise;
  }
}
