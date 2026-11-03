import { describe, expect, it } from 'vitest'
import { isLoopbackURL, LocalStackManager } from '../src/local-stack.ts'
import type { Section } from '../src/settings.ts'

function config(partial: Partial<Section>): Section {
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
    ...partial,
  }
}

const CRAWL4AI = { name: 'crawl4ai', adapter: 'custom', baseURL: 'http://127.0.0.1:8787', apiKeyEnv: '' }
const CRAWL4AI_NATIVE = { name: 'crawl4ai', adapter: 'crawl4ai', baseURL: 'http://127.0.0.1:11235', apiKeyEnv: '' }

function manager(partial: Partial<Section>) {
  return new LocalStackManager(() => config(partial))
}

describe('isLoopbackURL', () => {
  it('recognizes loopback forms', () => {
    expect(isLoopbackURL('http://127.0.0.1:8787')).toBe(true)
    expect(isLoopbackURL('http://localhost:8787')).toBe(true)
    expect(isLoopbackURL('http://[::1]:8787')).toBe(true)
  })

  it('rejects public and malformed URLs', () => {
    expect(isLoopbackURL('https://r.jina.ai')).toBe(false)
    expect(isLoopbackURL('not a url')).toBe(false)
  })
})

describe('LocalStackManager.needsLocal', () => {
  it('triggers when the primary is a loopback custom provider', () => {
    expect(manager({ adapter: 'crawl4ai', customProviders: [CRAWL4AI] }).needsLocal()).toBe(true)
  })

  it('triggers when the fallback is a loopback custom provider', () => {
    expect(manager({ adapter: 'firecrawl', fallback: 'crawl4ai', customProviders: [CRAWL4AI] }).needsLocal()).toBe(true)
  })

  it('triggers when a loopback provider sits ONLY in the fallbackChain (H3)', () => {
    expect(manager({ adapter: 'tavily', fallbackChain: ['crawl4ai'], customProviders: [CRAWL4AI] }).needsLocal()).toBe(true)
  })

  it('does not trigger without a loopback custom provider', () => {
    expect(manager({ adapter: 'tavily', fallback: 'jina' }).needsLocal()).toBe(false)
    expect(manager({ adapter: 'crawl4ai' }).needsLocal()).toBe(false) // name unknown / not configured
  })
})

describe('LocalStackManager.needsContainer (native crawl4ai entries)', () => {
  it('keeps the container alive for a native crawl4ai primary (watchdog regression)', () => {
    const m = manager({ adapter: 'crawl4ai', customProviders: [CRAWL4AI_NATIVE] })
    expect(m.needsContainer()).toBe(true)
    expect(m.needsWrapper()).toBe(false) // native adapter talks to the container directly
  })

  it('keeps the container alive for a native crawl4ai fallback or chain entry', () => {
    expect(manager({ adapter: 'firecrawl', fallback: 'crawl4ai', customProviders: [CRAWL4AI_NATIVE] }).needsContainer()).toBe(true)
    expect(manager({ adapter: 'tavily', fallbackChain: ['crawl4ai'], customProviders: [CRAWL4AI_NATIVE] }).needsContainer()).toBe(true)
  })

  it('does not adopt a native entry on a non-standard port', () => {
    const other = { ...CRAWL4AI_NATIVE, baseURL: 'http://127.0.0.1:11236' }
    expect(manager({ adapter: 'crawl4ai', customProviders: [other] }).needsContainer()).toBe(false)
  })

  it('does not adopt a remote (non-loopback) crawl4ai entry', () => {
    const remote = { ...CRAWL4AI_NATIVE, baseURL: 'http://10.0.0.5:11235' }
    expect(manager({ adapter: 'crawl4ai', customProviders: [remote] }).needsContainer()).toBe(false)
  })

  it('a contract-v1 entry needs both the container and the wrapper', () => {
    const m = manager({ adapter: 'crawl4ai', customProviders: [CRAWL4AI] })
    expect(m.needsContainer()).toBe(true)
    expect(m.needsWrapper()).toBe(true)
  })
})
