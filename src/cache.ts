/**
 * In-process caches.
 *
 * `TtlLruCache` is the generic engine: entries expire after a live TTL and the
 * store is capped by a live entry limit with least-recently-used eviction. Two
 * thin key-normalizing wrappers sit on top — `FetchCache` (one URL → one
 * WebFetchResult) and `SearchCache` (one query+parameters tuple → one
 * WebSearchResult) — so both capabilities share exactly one eviction policy.
 *
 * The fetch cache's rationale (unchanged): a repeat fetch neither hits the
 * third-party service (saving quota) nor consumes the per-session budget; the
 * cache is global across sessions while the budget stays per-session.
 * @module dsh-fetch-search/cache
 */

import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'

interface CacheEntry<T> {
  value: T
  storedAt: number
}

/**
 * TTL + LRU store over an arbitrary value type, keyed by pre-normalized
 * strings. Limits are read live from the config thunks on every operation, so
 * a settings edit applies without recreating the cache.
 */
export class TtlLruCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly ttlMs: () => number,
    private readonly maxEntries: () => number,
  ) {}

  /** Current entry count. */
  get size(): number {
    return this.map.size
  }

  /** Return a fresh entry, or undefined on miss / expiry. */
  get(key: string): T | undefined {
    const entry = this.map.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.storedAt >= this.ttlMs()) {
      this.map.delete(key)
      return undefined
    }
    // LRU: refresh recency on every hit.
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  /** Store an entry; evict the least-recently-used one when over the cap. */
  set(key: string, value: T): void {
    // 0 = no cap (unlimited); entries are only evicted under a positive cap.
    const limit = this.maxEntries()
    if (limit > 0 && this.map.size >= limit) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, storedAt: Date.now() })
  }

  /** Remove one key. */
  delete(key: string): void {
    this.map.delete(key)
  }

  /** Drop everything. */
  clear(): void {
    this.map.clear()
  }
}

/**
 * Normalize a URL into a cache key: absolute href without the fragment.
 * Returns undefined for unparseable URLs (never cached).
 */
export function normalizeURL(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

/** LRU + TTL fetch cache over {@link normalizeURL} keys. */
export class FetchCache {
  private readonly inner: TtlLruCache<WebFetchResult>

  constructor(ttlMs: () => number, maxEntries: () => number) {
    this.inner = new TtlLruCache<WebFetchResult>(ttlMs, maxEntries)
  }

  /** Current entry count. */
  get size(): number {
    return this.inner.size
  }

  /** Return a fresh cached result, or undefined on miss / expiry. */
  get(url: string): WebFetchResult | undefined {
    const key = normalizeURL(url)
    return key === undefined ? undefined : this.inner.get(key)
  }

  /** Store a result under its normalized URL. */
  set(url: string, value: WebFetchResult): void {
    const key = normalizeURL(url)
    if (key !== undefined) this.inner.set(key, value)
  }

  /** Remove one URL (or no-op for an unparseable one). */
  delete(url: string): void {
    const key = normalizeURL(url)
    if (key !== undefined) this.inner.delete(key)
  }

  /** Drop everything. */
  clear(): void {
    this.inner.clear()
  }
}

/**
 * Build the cache key for one search: every parameter that changes the result
 * set is part of it, so a language/category edit never serves a stale answer.
 * @param parts - adapter id plus the effective request parameters.
 * @returns a stable composite key.
 */
export function searchCacheKey(parts: readonly (string | number | undefined)[]): string {
  return parts.map((part) => part === undefined ? '' : String(part)).join('\u0000')
}

/** LRU + TTL search cache over {@link searchCacheKey} keys. */
export class SearchCache {
  private readonly inner: TtlLruCache<WebSearchResult>

  constructor(ttlMs: () => number, maxEntries: () => number) {
    this.inner = new TtlLruCache<WebSearchResult>(ttlMs, maxEntries)
  }

  /** Current entry count. */
  get size(): number {
    return this.inner.size
  }

  /** Return a fresh cached result, or undefined on miss / expiry. */
  get(key: string): WebSearchResult | undefined {
    return this.inner.get(key)
  }

  /** Store a result under a prebuilt key. */
  set(key: string, value: WebSearchResult): void {
    this.inner.set(key, value)
  }

  /** Drop everything. */
  clear(): void {
    this.inner.clear()
  }
}
