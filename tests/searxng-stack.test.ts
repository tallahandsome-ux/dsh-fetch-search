import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  renderManagedSettings,
  SEARXNG_CONTAINER_NAME,
  SearxngStackManager,
} from '../src/searxng-stack.ts'
import type { Section } from '../src/settings.ts'

/** A full section with the managed stack opted in, overridable per test. */
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
    searchEnabled: false,
    searchAdapter: 'searxng',
    searchBaseURL: 'http://127.0.0.1:8888',
    searchFallback: '',
    searchApiKeyEnv: '',
    searchAuthHeader: 'Authorization',
    searchAuthPrefix: 'Bearer ',
    searchLanguage: '',
    searchCategories: '',
    searchSafesearch: 0,
    searchTimeoutSeconds: 20,
    searchMaxResults: 10,
    searxngManaged: true,
    searxngPort: 8890,
    ...overrides,
  } as Section
}

const CTX = { get: () => undefined } as never

/** Scripted docker runner: args[0] decides the reply. */
function dockerScript(script: {
  version?: 'ok' | 'fail'
  inspect?: 'running' | 'stopped' | 'missing'
  failOn?: string[]
}): { runner: (args: string[], timeoutMs?: number) => Promise<string>; calls: string[][] } {
  const calls: string[][] = []
  const runner = async (args: string[], _timeoutMs?: number): Promise<string> => {
    calls.push(args)
    const head = args[0]
    if (script.failOn?.includes(head)) throw new Error('docker ' + head + ' failed')
    if (head === 'version') {
      if (script.version === 'fail') throw new Error('cannot connect to the Docker daemon')
      return '27.0.0'
    }
    if (head === 'inspect') return script.inspect ?? 'missing'
    if (head === 'rm') return SEARXNG_CONTAINER_NAME
    return ''
  }
  return { runner, calls }
}

function makeManager(overrides: Partial<Section> = {}, script?: Parameters<typeof dockerScript>[0]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'searxng-stack-test-'))
  const { runner, calls } = dockerScript(script ?? {})
  const manager = new SearxngStackManager(() => section(overrides), { dir, runDocker: runner, waitMs: 2500 })
  return { manager, calls, dir }
}

function stubFetchJson(ok: boolean): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status: ok ? 200 : 403,
    json: async () => (ok ? { results: [{ url: 'https://a.com' }] } : 'Forbidden'),
  })))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('renderManagedSettings', () => {
  it('enables the json formatter and disables the limiter', () => {
    const text = renderManagedSettings('a'.repeat(64))
    expect(text).toContain('formats:')
    expect(text).toContain('- json')
    expect(text).toContain('limiter: false')
    expect(text).toContain('secret_key: "' + 'a'.repeat(64) + '"')
  })
})

describe('SearxngStackManager.provision', () => {
  it('reports docker-missing when the daemon is unreachable', async () => {
    const { manager } = makeManager({}, { version: 'fail' })
    const status = await manager.provision()
    expect(status.phase).toBe('docker-missing')
  }, 30_000)

  it('detects an existing working instance on the port and touches nothing', async () => {
    stubFetchJson(true)
    const { manager, calls } = makeManager()
    const status = await manager.provision()
    expect(status.phase).toBe('running')
    expect(status.existingInstance).toBe(true)
    // The only docker call allowed here is the daemon presence check.
    expect(calls.filter(args => args[0] !== 'version')).toHaveLength(0)
  }, 30_000)

  it('reports port-foreign when the port serves a non-SearXNG JSON', async () => {
    stubFetchJson(false)
    const { manager, calls } = makeManager()
    const status = await manager.provision()
    expect(status.phase).toBe('port-foreign')
    expect(calls.filter(args => args[0] !== 'version')).toHaveLength(0)
  }, 30_000)

  it('creates the managed container when the port is free', async () => {
    // Port probe: down twice (initial + waitForPort first tick), then up.
    // JSON probe: ok after the port comes up.
    let portChecks = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.includes('/search?')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ url: 'https://a.com' }] }) }
      }
      portChecks += 1
      if (portChecks <= 2) throw new Error('ECONNREFUSED')
      return { ok: true, status: 200 }
    }))
    const { manager, calls } = makeManager()
    const status = await manager.provision()
    expect(status.phase).toBe('running')
    expect(status.existingInstance).toBe(false)
    const run = calls.find(args => args[0] === 'run')
    expect(run).toBeDefined()
    expect(run).toContain('--name')
    expect(run).toContain(SEARXNG_CONTAINER_NAME)
    expect(run).toContain('127.0.0.1:8890:8080')
    expect(run).toContain('--restart')
    const start = calls.find(args => args[0] === 'start')
    expect(start).toBeUndefined() // creation, not a start of an existing one
  }, 30_000)

  it('starts an existing stopped container instead of re-creating it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.includes('/search?')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) }
      }
      throw new Error('ECONNREFUSED')
    }))
    const { manager, calls } = makeManager({}, { inspect: 'false' })
    await manager.provision()
    expect(calls.find(args => args[0] === 'start')).toBeDefined()
    expect(calls.find(args => args[0] === 'run')).toBeUndefined()
  }, 30_000)

  it('writes the managed settings.yml once with a stable secret', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.includes('/search?')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) }
      }
      throw new Error('ECONNREFUSED')
    }))
    const { manager, dir } = makeManager()
    await manager.provision()
    const settingsPath = path.join(dir, 'settings.yml')
    expect(existsSync(settingsPath)).toBe(true)
    const first = readFileSync(settingsPath, 'utf8')
    expect(first).toContain('limiter: false')
    expect(first).toContain('- json')
    // A second pass keeps the same file (same secret).
    await manager.provision()
    expect(readFileSync(settingsPath, 'utf8')).toBe(first)
  }, 60_000)
})

describe('SearxngStackManager.remove', () => {
  it('removes the container and optionally purges the managed dir', async () => {
    const { manager, calls, dir } = makeManager()
    const settingsPath = path.join(dir, 'settings.yml')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(settingsPath, renderManagedSettings('b'.repeat(64)), 'utf8')
    const status = await manager.remove(false)
    expect(status.phase).toBe('idle')
    expect(calls.find(args => args[0] === 'rm')).toBeDefined()
    expect(existsSync(settingsPath)).toBe(true) // not purged
    await manager.remove(true)
    expect(existsSync(dir)).toBe(false) // purged
  }, 30_000)
})

describe('SearxngStackManager.sync', () => {
  it('does nothing while the managed stack is opted out', async () => {
    const { manager, calls } = makeManager({ searxngManaged: false })
    await manager.sync()
    expect(calls).toHaveLength(0)
  }, 30_000)

  it('keeps the container alive through sync when opted in (start path)', async () => {
    // The watchdog's port probe must fail (nothing listens) for the start path
    // to engage; the search JSON probe is never called on this path.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const { manager, calls } = makeManager({ searxngManaged: true }, { inspect: 'false' })
    await manager.sync()
    expect(calls.find(args => args[0] === 'start')).toBeDefined()
  }, 30_000)
})
