/**
 * @fileoverview Byte-budgeted LRU cache with per-entry expiry, for the process-wide OEIS cache.
 * @module services/oeis/lru-cache
 */

/** One cached value with its expiry instant and accounted size. */
export interface CacheEntry<V> {
  /** Serialized size charged against the byte budget. */
  bytes: number;
  /** Epoch milliseconds after which the entry is stale. */
  expiresAt: number;
  value: V;
}

/**
 * Least-recently-used cache bounded by total serialized bytes. Expiry is advisory: a stale entry
 * stays readable until evicted, so a caller can revalidate it (e.g. `If-Modified-Since`).
 */
export class LruCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Returns the entry (fresh or stale) and marks it most recently used. */
  get(key: string): CacheEntry<V> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Stores a value, evicting least-recently-used entries until the budget holds. */
  set(key: string, value: V, bytes: number, expiresAt: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, expiresAt });
    this.totalBytes += bytes;
    for (const [oldKey, oldEntry] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.entries.delete(oldKey);
      this.totalBytes -= oldEntry.bytes;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}
