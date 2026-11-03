import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SearchCache } from '../src/cache.ts'
import { ThirdPartySearchProvider } from '../src/search-provider.ts'
import type { Section } from '../src/settings.ts'

// `launchEnvironmentOf` reads a service off the cordis context; unit tests use
// a bare object, so the environment layer resolves to "no ambient value".
vi.mock('@deepseek-ai/dsh-launch-environment', () => ({
  launchEnvironmentOf: () => ({ get: () => undefined }),
}))

/** A full section with the search capability enabled, overridable per test. */
function section(overrides: Partial<Section> = {}): Section {
  return {
    adapter: 'firecrawl',
    fallback: '',
    baseURL: '',
    apiKeyEnv: '',
    maxFetchesPerSession: 10,
    proxy: '',
    proxyEnabled: true,
    customProviders: [],
    maxContentChars: 100_000,
    cacheEnabled: true,
    cacheTtlSeconds: 600,
    cacheMaxEntries: 200,
    rejectPrivateTargets: true,
    toolName: 'web_fetch_url',
    fallbackChain: [],
    cooldownEnabled: true,
    quotaCooldownSeconds: 3600,
    failureCooldownSeconds: 60,
    searchEnabled: true,
    searchAdapter: 'searxng',
    searchBaseURL: 'http://127.0.0.1:8888',
    searchFallback: '',
    searchApiKeyEnv: '',
    searchAuthHeader: 'Authorization',
    searchAuthPrefix: 'Bearer ',
    searchLanguage: '',
    searchCategories: '',
    searchSafesearch: 0,
    searchTimeoutSeconds: 15,
    searchMaxResults: 10,
    ...overrides,
  } as Section
}

/** A context stub: no credentials service, no agents. */
const CTX = { get: () => undefined } as unknown as Context

function makeProvider(overrides: Partial<Section> = {}) {
  let live = section(overrides)
  const cache = new SearchCache(() => 600_000, () => 100)
  const provider = new ThirdPartySearchProvider(CTX, () => live, cache)
  return {
    provider,
    cache,
    /** Swap the live section, as a volatile edit would. */
    set: (next: Partial<Section>) => { live = section({ ...overrides, ...next }) },
  }
}

interface StubInit {
  ok?: boolean
  status?: number
  json?: unknown
  text?: string
  throwError?: Error
}

function stubFetch(init: StubInit): ReturnType<typeof vi.fn> {
  const fn = vi.fn()
  if (init.throwError !== undefined) {
    fn.mockRejectedValue(init.throwError)
  } else {
    fn.mockResolvedValue({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => init.json,
      text: async () => init.text ?? '',
    })
  }
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ThirdPartySearchProvider.available', () => {
  it('is false while search is disabled (an untouched install stays unambiguous)', () => {
    const { provider } = makeProvider({ searchEnabled: false })
    expect(provider.id).toBe('third-party')
    expect(provider.available()).toBe(false)
  })

  it('is false for an unparseable endpoint', () => {
    const { provider } = makeProvider({ searchBaseURL: 'not a url' })
    expect(provider.available()).toBe(false)
  })

  it('is false for an adapter this build does not ship', () => {
    const { provider } = makeProvider({ searchAdapter: 'nope' })
    expect(provider.available()).toBe(false)
  })

  it('is true for an enabled, valid local SearXNG endpoint', () => {
    const { provider } = makeProvider()
    expect(provider.available()).toBe(true)
  })
})

describe('ThirdPartySearchProvider.search', () => {
  it('returns the adapter result for a successful search', async () => {
    stubFetch({ json: { results: [{ url: 'https://a.com', title: 'A', content: 'x' }] } })
    const { provider } = makeProvider()
    const result = await provider.search({ query: 'deepseek harness' })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.url).toBe('https://a.com')
  })

  it('rejects an empty query without touching the network', async () => {
    const fn = stubFetch({ json: { results: [] } })
    const { provider } = makeProvider()
    await expect(provider.search({ query: '   ' })).rejects.toThrow(/搜索词为空/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('applies the section result bound when the request carries none', async () => {
    const results = Array.from({ length: 6 }, (_, index) => ({ url: `https://a.com/${index}` }))
    const fn = stubFetch({ json: { results } })
    const { provider } = makeProvider({ searchMaxResults: 2 })
    const result = await provider.search({ query: 'q' })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
    const url = new URL(String(fn.mock.calls[0]?.[0]))
    expect(url.searchParams.get('q')).toBe('q')
  })

  it('serves a repeat query from cache (one upstream request)', async () => {
    const fn = stubFetch({ json: { results: [{ url: 'https://a.com' }] } })
    const { provider } = makeProvider()
    await provider.search({ query: 'same' })
    await provider.search({ query: 'same' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not cache when the cache is disabled', async () => {
    const fn = stubFetch({ json: { results: [{ url: 'https://a.com' }] } })
    const { provider } = makeProvider({ cacheEnabled: false })
    await provider.search({ query: 'same' })
    await provider.search({ query: 'same' })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('names the supported adapters when the configured one is unknown', async () => {
    stubFetch({ json: { results: [] } })
    const { provider } = makeProvider({ searchAdapter: 'nope' })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/没有可用的搜索适配器/)
  })

  it('propagates the adapter diagnostic on a JSON-formatter 403', async () => {
    stubFetch({ ok: false, status: 403, text: 'Forbidden' })
    const { provider } = makeProvider()
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/search\.formats/)
  })
})

describe('ThirdPartySearchProvider.testSearch', () => {
  it('reports the serving adapter and the top sources', async () => {
    stubFetch({ json: { results: [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com' }] } })
    const { provider } = makeProvider()
    const result = await provider.testSearch('q')
    expect(result.ok).toBe(true)
    expect(result.servedBy).toBe('searxng')
    expect(result.count).toBe(2)
    expect(result.top[0]?.url).toBe('https://a.com')
  })

  it('folds a failure into the result instead of throwing', async () => {
    stubFetch({ throwError: new Error('ECONNREFUSED') })
    const { provider } = makeProvider()
    const result = await provider.testSearch('q')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('bypasses the cache so a test always exercises the live route', async () => {
    const fn = stubFetch({ json: { results: [{ url: 'https://a.com' }] } })
    const { provider } = makeProvider()
    await provider.testSearch('q')
    await provider.testSearch('q')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
