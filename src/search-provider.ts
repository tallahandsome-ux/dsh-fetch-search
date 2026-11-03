/**
 * The `third-party` WebSearchProvider: routes one query to the configured
 * search adapter (today: SearXNG) with an optional fallback adapter, reusing
 * the fetch side's dynamic fallback chain, cooldown policy, and TTL+LRU cache.
 *
 * Deliberate differences from the fetch provider:
 * - No budget accounting. The budget exists to cap third-party quota spend; a
 *   self-hosted SearXNG has no marginal cost, so charging searches against the
 *   fetch allowance would only cripple the cheap capability.
 * - No SSRF pre-check. The endpoint here is chosen by the operator (usually a
 *   loopback container); `assertPublicHttpURL` would reject exactly the
 *   intended target. Model-chosen URLs are still guarded on the fetch path.
 *
 * @module dsh-fetch-search/search-provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { searchCacheKey, type SearchCache } from './cache.ts'
import { classifyFailure, FallbackRouter, type ChainRow } from './fallback.ts'
import { isLoopbackURL } from './local-stack.ts'
import { searxngAdapter } from './adapters/searxng.ts'
import type { SearchAdapter, SearchAdapterContext } from './adapters/search-types.ts'
import { resolveSearchProvider, type Section } from './settings.ts'

/**
 * Search adapters this build ships. One file per service under `adapters/`,
 * one row here — the same extension point shape as the fetch roster.
 */
const SEARCH_ADAPTERS: Record<string, SearchAdapter> = {
  searxng: searxngAdapter,
}

/** Outcome of one search attempt including which adapter served it. */
export interface SearchOutcome {
  result: WebSearchResult
  /** The search adapter id that served the request. */
  servedBy: string
}

/** Result of a config test (`testSearch`): bypasses cache, reports a diagnosis. */
export interface TestSearchResult {
  ok: boolean
  servedBy: string
  /** Number of sources returned. */
  count: number
  /** First few sources, for the card's confirmation strip. */
  top: { title?: string; url: string }[]
  durationMs: number
  error?: string
}

/**
 * The search provider registered into `ctx.web` as `third-party`.
 * The model-facing `web_search` tool reaches it through `ctx.web.search()`, so
 * this plugin contributes no tool of its own for search.
 */
export class ThirdPartySearchProvider implements WebSearchProvider {
  readonly id = 'third-party'

  private router: FallbackRouter | null = null
  private routerKey = ''

  constructor(
    private readonly ctx: Context,
    private readonly config: () => Section,
    private readonly cache: SearchCache,
  ) {}

  /**
   * Cheap local usability check (no network): the capability is on, the
   * endpoint parses as http(s), and the configured adapter is one this build
   * ships. Unavailability is the normal state for an install that never
   * enabled search, which keeps provider selection unambiguous.
   */
  available(): boolean {
    const section = this.config()
    if (!section.searchEnabled) return false
    return isHttpURL(section.searchBaseURL) && SEARCH_ADAPTERS[section.searchAdapter] !== undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const section = this.config()
    const query = request.query.trim()
    if (query.length === 0) {
      throw new WebError('搜索词为空', 'WEB_PROVIDER_ERROR')
    }
    const bound = request.maxResults ?? section.searchMaxResults
    const key = searchCacheKey([
      section.searchAdapter,
      query,
      section.searchLanguage,
      section.searchCategories,
      section.searchSafesearch,
      bound,
    ])
    if (section.cacheEnabled) {
      const hit = this.cache.get(key)
      if (hit !== undefined) return hit
    }
    const { result } = await this.attemptWithChain(section, { ...request, query, maxResults: bound }, signal, true)
    if (section.cacheEnabled && result.sources.length > 0) this.cache.set(key, result)
    return result
  }

  /**
   * Test the configured search routing without touching the cache and without
   * consuming anything. Used by the card's 「测试搜索」 button.
   * @param query - the query to run.
   * @returns the outcome; failures are folded into the result rather than thrown.
   */
  async testSearch(query: string): Promise<TestSearchResult> {
    const section = this.config()
    const started = Date.now()
    const trimmed = query.trim().length > 0 ? query.trim() : 'searxng test'
    try {
      const bound = section.searchMaxResults
      const { result, servedBy } = await this.attemptWithChain(
        section,
        { query: trimmed, maxResults: bound },
        undefined,
        false,
      )
      return {
        ok: result.sources.length > 0,
        servedBy,
        count: result.sources.length,
        top: result.sources.slice(0, 3).map((source) => ({
          ...source.title !== undefined ? { title: source.title } : {},
          url: source.url,
        })),
        durationMs: Date.now() - started,
      }
    } catch (error) {
      return {
        ok: false,
        servedBy: section.searchAdapter,
        count: 0,
        top: [],
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Run the fallback chain for one query. Each failure cools its adapter down
   * so the next one is tried; a success resets the counter.
   * @param persist - record cooldown state (false for the card's test run).
   */
  private async attemptWithChain(
    section: Section,
    request: WebSearchRequest,
    signal: AbortSignal | undefined,
    persist: boolean,
  ): Promise<SearchOutcome> {
    const router = this.chainRouter(section)
    const tried = new Set<string>()
    const failures: string[] = []
    let attempted = 0
    let lastError: unknown = null
    for (;;) {
      const name = router.next(tried)
      if (name === undefined) break
      tried.add(name)
      const resolved = resolveSearchProvider(section, name)
      const adapter = resolved === undefined ? undefined : SEARCH_ADAPTERS[resolved.adapter]
      if (resolved === undefined || adapter === undefined) continue // unknown adapter: skip
      attempted += 1
      const deadline = this.deadline(section.searchTimeoutSeconds, signal)
      let result: WebSearchResult
      try {
        result = await adapter.search(
          await this.adapterContext(section, resolved.baseURL, resolved.apiKeyEnv),
          request,
          deadline.signal,
        )
      } catch (error) {
        failures.push(`${name} 失败`)
        lastError = error
        if (persist) router.recordFailure(name, classifyFailure(error))
        continue
      } finally {
        deadline.dispose()
      }
      if (persist) router.recordSuccess(name)
      return { result, servedBy: name }
    }
    // A chain naming only adapters this build does not ship is a configuration
    // error, not a runtime failure: say so, and name what IS supported.
    if (attempted === 0) {
      const configured = this.effectiveChain(section)
      const known = Object.keys(SEARCH_ADAPTERS).join(', ')
      throw new WebError(
        `没有可用的搜索适配器（配置：${configured.length > 0 ? configured.join(', ') : '空'}；本构建支持：${known}）`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const detail = `尝试了 ${[...tried].join(' → ')}：${lastError instanceof Error ? lastError.message : '全部失败'}`
    throw new WebError(`搜索失败（${detail}）`, 'WEB_PROVIDER_ERROR', lastError !== null && lastError !== undefined ? { cause: lastError } : undefined)
  }

  /** The chain used for routing: explicit primary + optional fallback. */
  private effectiveChain(section: Section): string[] {
    const names = [section.searchAdapter, section.searchFallback]
      .flatMap((entry) => entry.split(/[,，、;；\s]+/))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    return [...new Set(names)]
  }

  /** The router for the current chain; rebuilt only when the chain changes. */
  private chainRouter(section: Section): FallbackRouter {
    const chain = this.effectiveChain(section)
    const key = chain.join(',')
    if (this.router === null || key !== this.routerKey) {
      this.router = new FallbackRouter(chain, () => {
        const live = this.config()
        return {
          enabled: live.cooldownEnabled,
          quotaSeconds: live.quotaCooldownSeconds,
          failureSeconds: live.failureCooldownSeconds,
        }
      })
      this.routerKey = key
    }
    return this.router
  }

  /** Live chain order + cooldown state, for the settings card. */
  chainSnapshot(): ChainRow[] {
    return this.chainRouter(this.config()).snapshot()
  }

  /** Build one adapter's call context from the live section. */
  private async adapterContext(
    section: Section,
    baseURL: string,
    apiKeyEnv: string,
  ): Promise<SearchAdapterContext> {
    const apiKey = await this.resolveKey(apiKeyEnv)
    return {
      baseURL,
      ...apiKey !== undefined ? { apiKey } : {},
      // A loopback instance is reached directly: a proxy cannot dial 127.0.0.1
      // on the host and would break the local deployment.
      proxy: section.proxyEnabled && section.proxy.length > 0 && !isLoopbackURL(baseURL)
        ? section.proxy
        : undefined,
      authHeader: section.searchAuthHeader,
      authPrefix: section.searchAuthPrefix,
      language: section.searchLanguage,
      categories: section.searchCategories,
      safesearch: section.searchSafesearch,
    }
  }

  /**
   * Compose the per-request deadline: the section's timeout, plus the seam's
   * cancellation. Distinguishes its own timeout so the adapter's abort reads as
   * a timeout rather than a user cancellation.
   */
  private deadline(seconds: number, signal: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController()
    const timeoutMs = Math.max(1, seconds) * 1000
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`搜索超时（${seconds}s）`, 'TimeoutError'))
    }, timeoutMs)
    const onAbort = (): void => { controller.abort(signal?.reason) }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      },
    }
  }

  /**
   * Resolve one credential reference: credentials domain first, environment
   * fallback. Kept local (not shared with the fetch provider) so that adding
   * search cannot regress the fetch path's resolution order.
   */
  private async resolveKey(envName: string): Promise<string | undefined> {
    if (envName.length === 0) return undefined
    const ref = credentialRef(envName)
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined) return resolved.value
    }
    const ambient = launchEnvironmentOf(this.ctx).get(envName)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/** True when a string parses as an absolute http(s) URL (a local config check). */
export function isHttpURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
