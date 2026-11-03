/**
 * Settings schema for the third-party fetch provider.
 *
 * The API key itself is NOT a section field: it lives only in the managed
 * credentials store, addressed by `apiKeyEnv`. The section holds the routing
 * (primary adapter + fallback), the endpoint, and the per-session budget cap.
 *
 * Since dsh 0.1.7 the section is expressed as volatile Config fields: the
 * Plugins page's bundle-configuration form edits them live (persisted into
 * the profile patch through the settings service, hot-applied via volatile
 * HMR), and `apply` reads them through `Volatile` references — no
 * settings-section registration is involved anymore.
 * @module dsh-fetch-search/settings
 */

import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// The vendored Loader dispatches this after committing volatile config values
// into the running fiber without a remount (declared by @deepseek-ai's
// cordis-plugin-loader, which third-party packages do not depend on).
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * The Loader row id this plugin's patch declares. It doubles as the settings
 * namespace the Plugins page's configuration form addresses, and must stay in
 * sync with `cordis.patch.yml`.
 */
export const NAMESPACE = 'web-fetch-search'

/**
 * Built-in provider the section defaults to. Firecrawl is the default:
 * its `/v2/scrape` works even without a key (rate-limited), so a fresh
 * install fetches out of the box; the user picks their own default in the
 * card anyway.
 */
export const DEFAULT_ADAPTER = 'firecrawl'
/**
 * Fallback provider tried when the primary fails. Empty by default: the user
 * chooses their own fallback in the card (e.g. Jina, Tavily, a custom one).
 */
export const DEFAULT_FALLBACK = ''
/** Tavily API base; `/extract` is appended by the adapter. */
export const DEFAULT_BASE_URL = 'https://api.tavily.com'
/** Default endpoint of a self-hosted Crawl4AI Docker API server. */
export const DEFAULT_CRAWL4AI_BASE_URL = 'http://127.0.0.1:11235'
/** Default per-session fetch budget. */
export const DEFAULT_MAX_FETCHES = 10
/** Default cache TTL (seconds) for a fetched URL. */
export const DEFAULT_CACHE_TTL_SECONDS = 600
/** Default cache entry cap before LRU eviction. */
export const DEFAULT_CACHE_MAX_ENTRIES = 200
/** Default cap on one fetched body's characters (contract v1 bound; 0 = no cap). */
export const DEFAULT_MAX_CONTENT_CHARS = 100_000
/** Default model-facing tool name. */
export const DEFAULT_TOOL_NAME = 'web_fetch_url'
/** Default cooldown (seconds) after a provider quota-exhaustion. */
export const DEFAULT_QUOTA_COOLDOWN_SECONDS = 3600
/** Default base cooldown (seconds) for ordinary failures. */
export const DEFAULT_FAILURE_COOLDOWN_SECONDS = 60

/** Search is opt-in: an untouched install keeps exactly the v1 fetch behaviour. */
export const DEFAULT_SEARCH_ENABLED = false
/** Search adapter driving `ThirdPartySearchProvider`; `searxng` is the built-in. */
export const DEFAULT_SEARCH_ADAPTER = 'searxng'
/** Default SearXNG endpoint: the local Docker deployment bound to loopback. */
export const DEFAULT_SEARCH_BASE_URL = 'http://127.0.0.1:8888'
/** Fallback search adapter; empty = the primary only. */
export const DEFAULT_SEARCH_FALLBACK = ''
/** Header name carrying a remote instance's credential (empty key = anonymous). */
export const DEFAULT_SEARCH_AUTH_HEADER = 'Authorization'
/** Prefix prepended to the resolved credential (e.g. `Bearer ` / `Basic ` / empty). */
export const DEFAULT_SEARCH_AUTH_PREFIX = 'Bearer '
/** SearXNG `language` parameter; empty = the instance's own default. */
export const DEFAULT_SEARCH_LANGUAGE = ''
/** SearXNG `categories` parameter; empty = the instance's own default. */
export const DEFAULT_SEARCH_CATEGORIES = ''
/** SearXNG `safesearch` level: 0 off / 1 moderate / 2 strict. */
export const DEFAULT_SEARCH_SAFESEARCH = 0
/**
 * Client-side deadline for one aggregated search. SearXNG gives each engine 3s
 * and aggregates in parallel, but a cold instance (first query after a restart,
 * or right after a proxy reflow) measured 18.5s on a real deployment here — so
 * the default sits above that rather than at the "warm" 3–5s figure.
 */
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 20
/** Result count requested when the seam's request carries no `maxResults`. */
export const DEFAULT_SEARCH_MAX_RESULTS = 10

/**
 * Standard credential reference per adapter. The section's `apiKeyEnv` is
 * empty by default; the provider falls back to this table so switching the
 * adapter needs no manual key-reference editing. The GUI card sets
 * `apiKeyEnv` explicitly on adapter switch.
 */
export const KEY_ENV_BY_ADAPTER: Record<string, string> = {
  tavily: 'TAVILY_API_KEY',
  jina: 'JINA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}

/**
 * Standard credential reference for self-hosted Crawl4AI custom entries.
 * Kept OUT of {@link KEY_ENV_BY_ADAPTER}: the tables double as the built-in
 * provider roster, and a custom entry named `crawl4ai` (the bundled
 * wrapper-stack convention) must keep resolving through its own table row.
 */
export const CRAWL4AI_API_KEY_ENV = 'CRAWL4AI_API_KEY'

/**
 * Standard endpoint per adapter, in the same fallback pattern as the key
 * reference: an empty section `baseURL` resolves to the adapter's default.
 * The GUI card rewrites `baseURL` when an adapter switch leaves a stale
 * default from the previous adapter.
 */
export const BASE_URL_BY_ADAPTER: Record<string, string> = {
  tavily: DEFAULT_BASE_URL,
  jina: 'https://r.jina.ai',
  firecrawl: 'https://api.firecrawl.dev',
}

/**
 * Search adapters this build ships. Same shape as the fetch roster: the id is
 * what `searchAdapter` / `searchFallback` name and what the adapter registry
 * keys on. Adding a service = one file under `src/adapters/` plus a row here.
 */
export const SEARCH_BASE_URL_BY_ADAPTER: Record<string, string> = {
  searxng: DEFAULT_SEARCH_BASE_URL,
}

/**
 * Standard credential reference per search adapter. SearXNG is anonymous, so
 * the built-in starts at `''`; a remote instance behind an authenticating
 * reverse proxy sets `searchApiKeyEnv` explicitly.
 */
export const SEARCH_KEY_ENV_BY_ADAPTER: Record<string, string> = {
  searxng: '',
}

/** The resolved call facts for one search provider name. */
export interface ResolvedSearchProvider {
  /** The adapter driving this provider. */
  adapter: string
  /** The endpoint to call. */
  baseURL: string
  /** The credential reference to resolve (empty = anonymous). */
  apiKeyEnv: string
}

/**
 * Resolve one search provider name into its call facts. The PRIMARY adapter
 * honours the section's explicit `searchBaseURL` / `searchApiKeyEnv`; a
 * fallback adapter uses its own stock endpoint so a custom address never
 * leaks across providers.
 * @param section - the resolved section.
 * @param name - the provider name to resolve; defaults to the primary.
 * @returns the call facts, or undefined for an unknown search adapter.
 */
export function resolveSearchProvider(
  section: Section,
  name: string = section.searchAdapter,
): ResolvedSearchProvider | undefined {
  const stock = SEARCH_BASE_URL_BY_ADAPTER[name]
  if (stock === undefined) return undefined
  const isPrimary = name === section.searchAdapter
  return {
    adapter: name,
    baseURL: isPrimary && section.searchBaseURL.length > 0 ? section.searchBaseURL : stock,
    apiKeyEnv: isPrimary ? section.searchApiKeyEnv : SEARCH_KEY_ENV_BY_ADAPTER[name] ?? '',
  }
}

/**
 * Resolve the effective endpoint for one adapter: the section's explicit
 * `baseURL` wins for the PRIMARY adapter; a fallback (or any other adapter)
 * always uses its own stock default, since the custom endpoint belongs to the
 * provider the user configured.
 * @param section - the resolved section.
 * @param adapter - the adapter to resolve for; defaults to the section's primary.
 * @returns the endpoint to call.
 */
export function resolveBaseURL(section: Section, adapter: string = section.adapter): string {
  if (adapter === section.adapter && section.baseURL.length > 0) return section.baseURL
  return BASE_URL_BY_ADAPTER[adapter] ?? DEFAULT_BASE_URL
}

/**
 * Resolve the effective credential reference for one adapter: the section's
 * explicit `apiKeyEnv` wins for the PRIMARY adapter; a fallback uses its own
 * standard ref.
 * @param section - the resolved section.
 * @param adapter - the adapter to resolve for; defaults to the section's primary.
 * @returns the reference name to address in the credentials store.
 */
export function resolveKeyEnv(section: Section, adapter: string = section.adapter): string {
  if (adapter === section.adapter && section.apiKeyEnv.length > 0) return section.apiKeyEnv
  return KEY_ENV_BY_ADAPTER[adapter] ?? 'TAVILY_API_KEY'
}

/** One user-registered custom provider instance. */
export interface CustomProvider {
  /** Unique kebab-case name; the primary/fallback fields reference it. */
  name: string
  /** Which adapter drives it: 'custom' (contract v1) or a built-in id. */
  adapter: string
  /** The custom endpoint. */
  baseURL: string
  /** Credential reference; empty = that adapter's standard ref (e.g. Jina anonymous). */
  apiKeyEnv: string
}

/** Schema for one custom provider entry. */
export const CustomProviderSchema = z.object({
  name: z.string(),
  adapter: z.string().default('custom'),
  baseURL: z.string(),
  apiKeyEnv: z.string().default(''),
})

/** The resolved call facts for one provider NAME (built-in or custom). */
export interface ResolvedProvider {
  /** The adapter driving this provider. */
  adapter: string
  /** The endpoint to call. */
  baseURL: string
  /** The credential reference to resolve. */
  apiKeyEnv: string
}

/**
 * Resolve one provider NAME (a built-in id like `jina`, or a custom entry's
 * name) into its call facts. The PRIMARY built-in keeps the section's flat
 * `baseURL`/`apiKeyEnv` overrides; any other built-in uses its stock defaults;
 * a custom entry uses its own table row.
 * @param section - the resolved section.
 * @param name - the provider name to resolve.
 * @returns the call facts, or undefined for an unknown provider.
 */
export function resolveProvider(section: Section, name: string): ResolvedProvider | undefined {
  if (BASE_URL_BY_ADAPTER[name] !== undefined || KEY_ENV_BY_ADAPTER[name] !== undefined) {
    const isPrimary = name === section.adapter
    return {
      adapter: name,
      baseURL: isPrimary ? resolveBaseURL(section, name) : BASE_URL_BY_ADAPTER[name] ?? DEFAULT_BASE_URL,
      apiKeyEnv: isPrimary ? resolveKeyEnv(section, name) : KEY_ENV_BY_ADAPTER[name] ?? 'TAVILY_API_KEY',
    }
  }
  const entry = section.customProviders.find(provider => provider.name === name)
  if (entry !== undefined) {
    return {
      adapter: entry.adapter || 'custom',
      baseURL: entry.baseURL,
      // Crawl4AI 0.9+ requires an API token, so an empty reference on a
      // crawl4ai entry means its standard ref rather than anonymous (the
      // jina-reuse pattern keeps '' = anonymous, which is a real mode there).
      apiKeyEnv: entry.apiKeyEnv.length > 0
        ? entry.apiKeyEnv
        : entry.adapter === 'crawl4ai' ? CRAWL4AI_API_KEY_ENV : entry.apiKeyEnv,
    }
  }
  return undefined
}

/**
 * The live section as `apply` receives it: every editable field is a
 * `Volatile` reference whose `.get()` reads the value currently in force
 * (profile patch + live edits), so consumers see changes without a plugin
 * restart. `loader/volatile-update` signals when to re-read.
 */
export interface Config {
  /** Primary provider (built-in id or custom name) performing the fetch. */
  adapter: Volatile<string>
  /** Fallback provider tried when the primary fails; empty = none. */
  fallback: Volatile<string>
  /** The primary built-in service base URL override. */
  baseURL: Volatile<string>
  /** Credential reference for the primary built-in; empty = its standard ref. */
  apiKeyEnv: Volatile<string>
  /** Per-session fetch budget cap. */
  maxFetchesPerSession: Volatile<number>
  /** Optional HTTP proxy (e.g. http://127.0.0.1:27822) for networks that block the service. */
  proxy: Volatile<string>
  /** Whether the proxy is applied; the address is kept even when disabled. */
  proxyEnabled: Volatile<boolean>
  /** User-registered custom provider instances (multi-custom coexistence). */
  customProviders: Volatile<CustomProvider[]>
  /** Max characters of one fetched body passed to the model; 0 = no cap. */
  maxContentChars: Volatile<number>
  /** Serve repeated fetches of the same URL from an in-process cache. */
  cacheEnabled: Volatile<boolean>
  /** Cache TTL in seconds for a fetched URL. */
  cacheTtlSeconds: Volatile<number>
  /** Maximum cache entries before LRU eviction. */
  cacheMaxEntries: Volatile<number>
  /** Reject model-requested targets on private/reserved addresses (defense-in-depth). */
  rejectPrivateTargets: Volatile<boolean>
  /** Tool name preference: 'web_fetch_url' | 'web_fetch' | 'auto'. */
  toolName: Volatile<string>
  /** Ordered fallback chain (provider names); empty = derive from adapter+fallback. */
  fallbackChain: Volatile<string[]>
  /** Enable dynamic cooldown-based fallback. */
  cooldownEnabled: Volatile<boolean>
  /** Cooldown (seconds) when a provider's quota is exhausted. */
  quotaCooldownSeconds: Volatile<number>
  /** Base cooldown (seconds) for ordinary failures (exponential backoff). */
  failureCooldownSeconds: Volatile<number>
  /** Register this plugin's search provider into `ctx.web` (default off). */
  searchEnabled: Volatile<boolean>
  /** Primary search adapter (built-in id; today `searxng`). */
  searchAdapter: Volatile<string>
  /** The primary search service base URL (local Docker or a remote instance). */
  searchBaseURL: Volatile<string>
  /** Fallback search adapter tried when the primary fails; empty = none. */
  searchFallback: Volatile<string>
  /** Credential reference for a remote/authenticated instance; empty = anonymous. */
  searchApiKeyEnv: Volatile<string>
  /** Header name carrying that credential (e.g. `Authorization`, `X-API-Key`). */
  searchAuthHeader: Volatile<string>
  /** Prefix prepended to the credential value (e.g. `Bearer `). */
  searchAuthPrefix: Volatile<string>
  /** SearXNG `language` parameter; empty = the instance's default. */
  searchLanguage: Volatile<string>
  /** SearXNG `categories` parameter; empty = the instance's default. */
  searchCategories: Volatile<string>
  /** SearXNG `safesearch` level: 0 off / 1 moderate / 2 strict. */
  searchSafesearch: Volatile<number>
  /** Client-side deadline for one aggregated search, in seconds. */
  searchTimeoutSeconds: Volatile<number>
  /** Result count requested when the seam's request carries no `maxResults`. */
  searchMaxResults: Volatile<number>
}

/** One instant's resolved section shape: the plain values every consumer uses. */
export interface SectionShape {
  /** Primary provider (built-in id or custom name) performing the fetch. */
  adapter: string
  /** Fallback provider tried when the primary fails; default Jina (keyless). */
  fallback: string
  /** The primary built-in service base URL override. */
  baseURL: string
  /** Credential reference for the primary built-in; empty = its standard ref. */
  apiKeyEnv: string
  /** Per-session fetch budget cap. */
  maxFetchesPerSession: number
  /** Optional HTTP proxy (e.g. http://127.0.0.1:27822) for networks that block the service. */
  proxy: string
  /** Whether the proxy is applied; the address is kept even when disabled. */
  proxyEnabled: boolean
  /** User-registered custom provider instances (multi-custom coexistence). */
  customProviders: CustomProvider[]
  /** Max characters of one fetched body passed to the model; 0 = no cap. */
  maxContentChars: number
  /** Serve repeated fetches of the same URL from an in-process cache. */
  cacheEnabled: boolean
  /** Cache TTL in seconds for a fetched URL. */
  cacheTtlSeconds: number
  /** Maximum cache entries before LRU eviction. */
  cacheMaxEntries: number
  /** Reject model-requested targets on private/reserved addresses (defense-in-depth). */
  rejectPrivateTargets: boolean
  /** Tool name preference: 'web_fetch_url' | 'web_fetch' | 'auto'. */
  toolName: string
  /** Ordered fallback chain (provider names); empty = derive from adapter+fallback. */
  fallbackChain: string[]
  /** Enable dynamic cooldown-based fallback. */
  cooldownEnabled: boolean
  /** Cooldown (seconds) when a provider's quota is exhausted. */
  quotaCooldownSeconds: number
  /** Base cooldown (seconds) for ordinary failures (exponential backoff). */
  failureCooldownSeconds: number
  /** Register this plugin's search provider into `ctx.web` (default off). */
  searchEnabled: boolean
  /** Primary search adapter (built-in id; today `searxng`). */
  searchAdapter: string
  /** The primary search service base URL (local Docker or a remote instance). */
  searchBaseURL: string
  /** Fallback search adapter tried when the primary fails; empty = none. */
  searchFallback: string
  /** Credential reference for a remote/authenticated instance; empty = anonymous. */
  searchApiKeyEnv: string
  /** Header name carrying that credential (e.g. `Authorization`, `X-API-Key`). */
  searchAuthHeader: string
  /** Prefix prepended to the credential value (e.g. `Bearer `). */
  searchAuthPrefix: string
  /** SearXNG `language` parameter; empty = the instance's default. */
  searchLanguage: string
  /** SearXNG `categories` parameter; empty = the instance's default. */
  searchCategories: string
  /** SearXNG `safesearch` level: 0 off / 1 moderate / 2 strict. */
  searchSafesearch: number
  /** Client-side deadline for one aggregated search, in seconds. */
  searchTimeoutSeconds: number
  /** Result count requested when the seam's request carries no `maxResults`. */
  searchMaxResults: number
}

/**
 * One instant's resolved section: a deep-readonly snapshot, because every
 * field of a volatile Config resolves through `Volatile.get()` whose currency
 * is `VolatileSnapshot<T>`. Consumers read; they never mutate.
 */
export type Section = VolatileSnapshot<SectionShape>

/**
 * Capture one consistent snapshot of the live section. Read this when
 * starting an operation (a fetch, a stack sync) so the operation carries one
 * revision's values even if the user edits mid-flight.
 * @param config - the live volatile section.
 * @returns the resolved plain values.
 */
export function resolveSection(config: Config): Section {
  return {
    adapter: config.adapter.get(),
    fallback: config.fallback.get(),
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    maxFetchesPerSession: config.maxFetchesPerSession.get(),
    proxy: config.proxy.get(),
    proxyEnabled: config.proxyEnabled.get(),
    customProviders: config.customProviders.get(),
    maxContentChars: config.maxContentChars.get(),
    cacheEnabled: config.cacheEnabled.get(),
    cacheTtlSeconds: config.cacheTtlSeconds.get(),
    cacheMaxEntries: config.cacheMaxEntries.get(),
    rejectPrivateTargets: config.rejectPrivateTargets.get(),
    toolName: config.toolName.get(),
    fallbackChain: config.fallbackChain.get(),
    cooldownEnabled: config.cooldownEnabled.get(),
    quotaCooldownSeconds: config.quotaCooldownSeconds.get(),
    failureCooldownSeconds: config.failureCooldownSeconds.get(),
    searchEnabled: config.searchEnabled.get(),
    searchAdapter: config.searchAdapter.get(),
    searchBaseURL: config.searchBaseURL.get(),
    searchFallback: config.searchFallback.get(),
    searchApiKeyEnv: config.searchApiKeyEnv.get(),
    searchAuthHeader: config.searchAuthHeader.get(),
    searchAuthPrefix: config.searchAuthPrefix.get(),
    searchLanguage: config.searchLanguage.get(),
    searchCategories: config.searchCategories.get(),
    searchSafesearch: config.searchSafesearch.get(),
    searchTimeoutSeconds: config.searchTimeoutSeconds.get(),
    searchMaxResults: config.searchMaxResults.get(),
  }
}

/**
 * The section schema: non-secret wiring only (the key lives in credentials).
 * Every field is `.volatile()` so it projects into the Plugins page's
 * bundle-configuration form and edits hot-apply through volatile HMR.
 * `adapter`/`fallback` stay open strings: the provider's adapter registry
 * rejects an unknown id at fetch time (`WEB_PROVIDER_ERROR`).
 */
export const Config = z.object({
  adapter: z.string().default(DEFAULT_ADAPTER).volatile(),
  fallback: z.string().default(DEFAULT_FALLBACK).volatile(),
  // Empty = the adapter's stock default (resolveBaseURL falls back); a non-empty
  // override only ever comes from the card or persisted settings.
  baseURL: z.string().default('').volatile(),
  apiKeyEnv: z.string().default('').volatile(),
  maxFetchesPerSession: z.natural().default(DEFAULT_MAX_FETCHES).volatile(),
  proxy: z.string().default('').volatile(),
  proxyEnabled: z.boolean().default(true).volatile(),
  customProviders: z.array(CustomProviderSchema).default([]).volatile(),
  maxContentChars: z.natural().default(DEFAULT_MAX_CONTENT_CHARS).volatile(),
  cacheEnabled: z.boolean().default(true).volatile(),
  cacheTtlSeconds: z.natural().default(DEFAULT_CACHE_TTL_SECONDS).volatile(),
  cacheMaxEntries: z.natural().default(DEFAULT_CACHE_MAX_ENTRIES).volatile(),
  rejectPrivateTargets: z.boolean().default(true).volatile(),
  toolName: z.string().default(DEFAULT_TOOL_NAME).volatile(),
  fallbackChain: z.array(z.string()).default([]).volatile(),
  cooldownEnabled: z.boolean().default(true).volatile(),
  quotaCooldownSeconds: z.natural().default(DEFAULT_QUOTA_COOLDOWN_SECONDS).volatile(),
  failureCooldownSeconds: z.natural().default(DEFAULT_FAILURE_COOLDOWN_SECONDS).volatile(),
  searchEnabled: z.boolean().default(DEFAULT_SEARCH_ENABLED).volatile(),
  searchAdapter: z.string().default(DEFAULT_SEARCH_ADAPTER).volatile(),
  searchBaseURL: z.string().default(DEFAULT_SEARCH_BASE_URL).volatile(),
  searchFallback: z.string().default(DEFAULT_SEARCH_FALLBACK).volatile(),
  searchApiKeyEnv: z.string().default('').volatile(),
  searchAuthHeader: z.string().default(DEFAULT_SEARCH_AUTH_HEADER).volatile(),
  searchAuthPrefix: z.string().default(DEFAULT_SEARCH_AUTH_PREFIX).volatile(),
  searchLanguage: z.string().default(DEFAULT_SEARCH_LANGUAGE).volatile(),
  searchCategories: z.string().default(DEFAULT_SEARCH_CATEGORIES).volatile(),
  searchSafesearch: z.natural().max(2).default(DEFAULT_SEARCH_SAFESEARCH).volatile(),
  searchTimeoutSeconds: z.natural().default(DEFAULT_SEARCH_TIMEOUT_SECONDS).volatile(),
  searchMaxResults: z.natural().default(DEFAULT_SEARCH_MAX_RESULTS).volatile(),
})
