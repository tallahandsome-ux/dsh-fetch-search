import { describe, expect, it } from 'vitest'
import {
  BASE_URL_BY_ADAPTER, DEFAULT_MAX_CONTENT_CHARS, KEY_ENV_BY_ADAPTER,
  resolveBaseURL, resolveKeyEnv, resolveProvider,
  type Section,
} from '../src/settings.ts'

function config(overrides: Partial<Section> = {}): Section {
  return {
    adapter: 'firecrawl',
    fallback: '',
    baseURL: '',
    apiKeyEnv: '',
    maxFetchesPerSession: 10,
    proxy: '',
    proxyEnabled: true,
    customProviders: [],
    maxContentChars: DEFAULT_MAX_CONTENT_CHARS,
    ...overrides,
  }
}

describe('DEFAULT_MAX_CONTENT_CHARS', () => {
  it('is the documented contract-v1 bound', () => {
    expect(DEFAULT_MAX_CONTENT_CHARS).toBe(100_000)
  })
})

describe('resolveBaseURL', () => {
  it('falls back to the adapter stock default when baseURL is empty (B1 regression)', () => {
    expect(resolveBaseURL(config({ adapter: 'firecrawl', baseURL: '' }))).toBe('https://api.firecrawl.dev')
    expect(resolveBaseURL(config({ adapter: 'jina', baseURL: '' }))).toBe('https://r.jina.ai')
    expect(resolveBaseURL(config({ adapter: 'tavily', baseURL: '' }))).toBe('https://api.tavily.com')
  })

  it('uses the flat baseURL override for the primary adapter', () => {
    const cfg = config({ adapter: 'firecrawl', baseURL: 'http://self-hosted:8080' })
    expect(resolveBaseURL(cfg)).toBe('http://self-hosted:8080')
  })

  it('ignores the flat override for a non-primary adapter', () => {
    const cfg = config({ adapter: 'firecrawl', baseURL: 'http://self-hosted:8080' })
    expect(resolveBaseURL(cfg, 'jina')).toBe('https://r.jina.ai')
  })
})

describe('resolveProvider', () => {
  it('resolves a built-in adapter with its stock facts', () => {
    const cfg = config({ adapter: 'jina', baseURL: '' })
    expect(resolveProvider(cfg, 'jina')).toEqual({
      adapter: 'jina',
      baseURL: 'https://r.jina.ai',
      apiKeyEnv: 'JINA_API_KEY',
    })
  })

  it('resolves a custom provider from its own table row', () => {
    const cfg = config({
      adapter: 'crawl4ai',
      customProviders: [{ name: 'crawl4ai', adapter: 'custom', baseURL: 'http://127.0.0.1:8787', apiKeyEnv: '' }],
    })
    expect(resolveProvider(cfg, 'crawl4ai')).toEqual({
      adapter: 'custom',
      baseURL: 'http://127.0.0.1:8787',
      apiKeyEnv: '',
    })
  })

  it('returns undefined for an unknown provider', () => {
    expect(resolveProvider(config(), 'does-not-exist')).toBeUndefined()
  })
})

describe('resolveKeyEnv', () => {
  it('uses the adapter standard reference for built-ins', () => {
    expect(resolveKeyEnv(config({ adapter: 'firecrawl', apiKeyEnv: '' }))).toBe('FIRECRAWL_API_KEY')
    expect(resolveKeyEnv(config({ adapter: 'jina', apiKeyEnv: '' }))).toBe('JINA_API_KEY')
  })

  it('prefers the explicit primary override', () => {
    const cfg = config({ adapter: 'tavily', apiKeyEnv: 'MY_CUSTOM_REF' })
    expect(resolveKeyEnv(cfg)).toBe('MY_CUSTOM_REF')
  })
})

describe('crawl4ai provider resolution', () => {
  it('falls back to the standard ref for a crawl4ai custom entry with no explicit one', () => {
    const cfg = config({
      adapter: 'my-crawler',
      customProviders: [{ name: 'my-crawler', adapter: 'crawl4ai', baseURL: 'http://127.0.0.1:11235', apiKeyEnv: '' }],
    })
    expect(resolveProvider(cfg, 'my-crawler')?.apiKeyEnv).toBe('CRAWL4AI_API_KEY')
  })

  it('keeps an explicit reference and empty-means-anonymous for jina-reuse entries', () => {
    const cfg = config({
      adapter: 'my-jina',
      customProviders: [
        { name: 'my-jina', adapter: 'jina', baseURL: 'http://127.0.0.1:3000', apiKeyEnv: '' },
        { name: 'my-crawler-2', adapter: 'crawl4ai', baseURL: 'http://127.0.0.1:11236', apiKeyEnv: 'C4AI_TOKEN_2' },
      ],
    })
    expect(resolveProvider(cfg, 'my-jina')?.apiKeyEnv).toBe('')
    expect(resolveProvider(cfg, 'my-crawler-2')?.apiKeyEnv).toBe('C4AI_TOKEN_2')
  })
})
