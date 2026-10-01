/**
 * @fileoverview Tests for the byte-budgeted LRU cache: budget accounting, eviction order,
 * oversized entries, stale entries staying readable, peeks that leave the order alone, and the
 * heap charge of a cached value.
 * @module tests/services/oeis/lru-cache.test
 */

import { describe, expect, it } from 'vitest';
import { heapCharge, LruCache } from '@/services/oeis/lru-cache.js';

const FAR = Number.MAX_SAFE_INTEGER;

describe('LruCache', () => {
  it('returns the stored entry with its size and expiry', () => {
    const cache = new LruCache<string>(100);
    cache.set('a', 'alpha', 10, 5_000);
    expect(cache.get('a')).toEqual({ value: 'alpha', bytes: 10, expiresAt: 5_000 });
  });

  it('returns undefined for an unknown key', () => {
    expect(new LruCache<string>(100).get('nope')).toBeUndefined();
  });

  it('evicts the least recently inserted entry first when the budget is exceeded', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 4, FAR);
    cache.set('b', 'b', 4, FAR);
    cache.set('c', 'c', 4, FAR);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('counts a read as use: the untouched entry is evicted instead', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 4, FAR);
    cache.set('b', 'b', 4, FAR);
    cache.get('a');
    cache.set('c', 'c', 4, FAR);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('evicts several entries to fit one large one', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 3, FAR);
    cache.set('b', 'b', 3, FAR);
    cache.set('c', 'c', 3, FAR);
    cache.set('big', 'big', 9, FAR);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('big')).toBeDefined();
  });

  it('keeps an entry that exactly fills the budget', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 10, FAR);
    expect(cache.get('a')).toBeDefined();
  });

  it('refuses an entry larger than the whole budget and leaves the others alone', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 4, FAR);
    cache.set('huge', 'huge', 11, FAR);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
  });

  it('drops the previous value of a key whose replacement is too large to store', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'old', 4, FAR);
    cache.set('a', 'new', 11, FAR);
    expect(cache.get('a')).toBeUndefined();
  });

  it('re-accounts bytes when a key is replaced instead of double counting', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'v1', 6, FAR);
    cache.set('a', 'v2', 6, FAR);
    cache.set('b', 'b', 4, FAR);
    expect(cache.get('a')?.value).toBe('v2');
    expect(cache.get('b')).toBeDefined();
  });

  it('frees the budget on delete', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 6, FAR);
    cache.delete('a');
    cache.set('b', 'b', 10, FAR);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
  });

  it('ignores a delete of an unknown key', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 6, FAR);
    cache.delete('missing');
    cache.set('b', 'b', 4, FAR);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeDefined();
  });

  it('still returns an expired entry: expiry is advisory, so callers can revalidate', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'stale', 4, 1);
    const entry = cache.get('a');
    expect(entry?.value).toBe('stale');
    expect(entry?.expiresAt).toBeLessThan(Date.now());
  });

  it('evicts a stale entry by recency, not by expiry', () => {
    const cache = new LruCache<string>(10);
    cache.set('fresh-old', 'a', 4, FAR);
    cache.set('stale-new', 'b', 4, 1);
    cache.set('c', 'c', 4, FAR);
    expect(cache.get('fresh-old')).toBeUndefined();
    expect(cache.get('stale-new')).toBeDefined();
  });

  it('peeks at an entry without counting it as use', () => {
    const cache = new LruCache<string>(10);
    cache.set('a', 'a', 4, FAR);
    cache.set('b', 'b', 4, FAR);
    expect(cache.peek('a')).toEqual({ value: 'a', bytes: 4, expiresAt: FAR });
    cache.set('c', 'c', 4, FAR);
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('b')).toBeDefined();
  });
});

describe('heapCharge', () => {
  it('charges 3 bytes per UTF-16 code unit of the JSON form', () => {
    const read = { status: 'ok', terms: [{ n: 0, value: '0' }], cut: false };
    expect(heapCharge(read)).toBe(3 * JSON.stringify(read).length);
    expect(heapCharge({ name: 'φ' })).toBe(3 * '{"name":"φ"}'.length);
    expect(heapCharge({ kind: 'missing' })).toBe(54);
  });
});
