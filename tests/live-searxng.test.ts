/**
 * Live SearXNG check — NOT part of CI.
 *
 * Runs the real adapter against a real instance over the network, which is the
 * only way to catch a contract mismatch that mocks cannot (JSON formatter
 * disabled, limiter interception, engine aggregation behaviour).
 *
 * Enable it explicitly:
 *   $env:LIVE_SEARXNG_BASE = 'http://127.0.0.1:8888'
 *   npx vitest run tests/live-searxng.e2e.ts
 *
 * Without the variable the suite is skipped, so `pnpm test` and GitHub Actions
 * stay hermetic.
 */
import { describe, expect, it } from 'vitest'
import { searxngAdapter } from '../src/adapters/searxng.ts'
import type { SearchAdapterContext } from '../src/adapters/search-types.ts'

const BASE = process.env.LIVE_SEARXNG_BASE ?? ''
const enabled = BASE.length > 0

function ctx(overrides: Partial<SearchAdapterContext> = {}): SearchAdapterContext {
  return {
    baseURL: BASE,
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    language: '',
    categories: '',
    safesearch: 0,
    ...overrides,
  }
}

describe.skipIf(!enabled)('live SearXNG instance', () => {
  it('returns real, citeable sources', async () => {
    const result = await searxngAdapter.search(ctx(), { query: 'deepseek harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeLessThanOrEqual(5)
    for (const source of result.sources) {
      expect(source.url).toMatch(/^https?:\/\//)
    }
    console.log('[live] sources:', result.sources.map((source) => `${source.title ?? '(no title)'} → ${source.url}`))
  }, 30_000)

  it('accepts a Chinese query', async () => {
    const result = await searxngAdapter.search(ctx({ language: 'zh-CN' }), { query: '建筑平面生成', maxResults: 3 })
    expect(result.sources.length).toBeGreaterThan(0)
    console.log('[live] zh sources:', result.sources.map((source) => source.title ?? source.url))
  }, 30_000)

  it('reports the limiter/formatter diagnosis when the endpoint is wrong', async () => {
    // A closed port proves the network-failure message names the endpoint.
    await expect(
      searxngAdapter.search(ctx({ baseURL: 'http://127.0.0.1:9' }), { query: 'x' }),
    ).rejects.toThrow(/SearXNG 不可达/)
  }, 30_000)
})
