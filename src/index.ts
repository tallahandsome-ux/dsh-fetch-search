/**
 * dsh-fetch-search — host half.
 *
 * Registers the `third-party` fetch provider, the self-contained
 * `web_fetch_url` tool, and the runtime-state bridge routes (connectivity
 * test + live fallback chain). Configuration is expressed as volatile Config
 * fields (dsh ≥ 0.1.7): the Plugins page's bundle-configuration form edits
 * them live, and every consumer below reads them through one section
 * snapshotter, so profile edits hot-apply without a plugin restart.
 * @module dsh-fetch-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { FetchBudget } from './budget.ts'
import { FetchCache, SearchCache } from './cache.ts'
import { mountFetchBridge } from './bridge.ts'
import { LocalStackManager } from './local-stack.ts'
import { ThirdPartyFetchProvider } from './provider.ts'
import { ThirdPartySearchProvider } from './search-provider.ts'
import { SearxngStackManager } from './searxng-stack.ts'
import { resolveSection, type Config } from './settings.ts'
import { applyWebFetchUrlTool } from './tool.ts'

export const name = 'dsh-fetch-search'

// The Loader needs the schema on the entry to validate the raw row config:
// schemastery fills defaults and wraps `.volatile()` fields into Volatile
// references (what `apply` reads), so a row without a config block still
// receives fully-materialized live fields.
export { Config } from './settings.ts'
export type { Config as ConfigType, Section } from './settings.ts'

/**
 * Required services: web seam, credentials, tool registry, prompt sections.
 * `webServer` is deliberately NOT required: the runtime-state bridge mounts
 * only where a web server exists (its own ctx.inject waits lazily), so the
 * core fetch capability works in headless/CLI surfaces too.
 */
export const inject = ['web', 'credentials', 'tools', 'systemPrompt'] as const

/** Mount the provider, its tool, and its runtime-state bridge. */
export function apply(ctx: Context, config: Config): void {
  // Live section reader: volatile fields resolve at read time, so every
  // consumer (provider, budget, cache, stack) receives `current` once and
  // still sees live values after the user edits the configuration.
  const current = (): ReturnType<typeof resolveSection> => resolveSection(config)

  // Auto-manages the local wrapper (and best-effort the Crawl4AI container)
  // while a loopback custom provider is the primary or fallback.
  const stack = new LocalStackManager(current)

  // Opt-in managed SearXNG container (one-click deployment): provisioning,
  // keep-alive watchdog, and removal — mirroring the local-stack patterns.
  const searxngStack = new SearxngStackManager(current)

  const budget = new FetchBudget(() => current().maxFetchesPerSession)
  const cache = new FetchCache(
    () => current().cacheTtlSeconds * 1000,
    () => current().cacheMaxEntries,
  )
  const provider = new ThirdPartyFetchProvider(ctx, current, budget, cache)
  ctx.web.registerFetchProvider(provider)

  // Search half (opt-in): the same section's search* fields drive it, and it
  // shares the TTL/LRU policy but keeps its own store — a search result is not
  // a page body, and a cache key must include the query parameters.
  const searchCache = new SearchCache(
    () => current().cacheTtlSeconds * 1000,
    () => current().cacheMaxEntries,
  )
  const searchProvider = new ThirdPartySearchProvider(ctx, current, searchCache)

  // Register only while the capability is enabled. An install that never turns
  // search on keeps exactly one usable search provider (the bundled
  // deepseek-official one), so provider selection can never go ambiguous; and
  // toggling the switch registers/unregisters live, without a remount.
  let disposeSearch: (() => void) | undefined
  const syncSearch = (): void => {
    const enabled = current().searchEnabled
    if (enabled && disposeSearch === undefined) {
      disposeSearch = ctx.web.registerSearchProvider(searchProvider)
    } else if (!enabled && disposeSearch !== undefined) {
      disposeSearch()
      disposeSearch = undefined
    }
  }
  syncSearch()

  // The tool re-registers itself when the live `toolName` preference changes.
  applyWebFetchUrlTool(ctx, config)
  mountFetchBridge(
    ctx,
    (url) => provider.testFetch(url),
    () => provider.chainSnapshot(),
    (query) => searchProvider.testSearch(query),
    {
      status: () => searxngStack.status(),
      provision: () => searxngStack.provision(),
      remove: (purge) => searxngStack.remove(purge),
    },
  )

  // Volatile edits arrive as loader events: drive the initial stack sync, keep
  // it in step with later provider switches, register/unregister search, and
  // provision/retire the managed SearXNG container.
  // (The tool subscribes the same way inside applyWebFetchUrlTool.)
  void stack.sync()
  void searxngStack.sync()
  ctx.on('loader/volatile-update', () => { syncSearch(); void stack.sync(); void searxngStack.sync() })

  // Kill the wrapper child when the plugin unloads (dsh web shuts down). The
  // managed SearXNG container outlives the plugin on purpose (--restart
  // unless-stopped): only its watchdog dies here.
  ctx.effect(() => () => { disposeSearch?.(); disposeSearch = undefined; stack.shutdown(); searxngStack.stopWatchdogOnly() })
}
