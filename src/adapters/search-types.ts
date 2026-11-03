/**
 * Search adapter contract: one adapter knows how to speak ONE search service's
 * native API and normalizes its response into the seam's WebSearchResult.
 *
 * Symmetric with `./types.ts` (fetch): adding a service = adding one adapter
 * module plus a `SEARCH_BASE_URL_BY_ADAPTER` row; the provider routes by the
 * configured `searchAdapter` id. Unlike fetch, an adapter's endpoint is a
 * user-chosen service (often loopback), so adapters must NOT apply the SSRF
 * pre-check — that guard belongs to model-requested fetch targets only.
 * @module dsh-fetch-search/adapters/search-types
 */

import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'

/** What a search adapter needs to reach the configured service. */
export interface SearchAdapterContext {
  /** Service base URL; the adapter appends its own operation path. */
  baseURL: string
  /** Resolved credential, present when a remote instance requires one. */
  apiKey?: string
  /** Optional HTTP proxy (per-request; no process-wide effect). */
  proxy?: string
  /** Header name carrying the credential (e.g. `Authorization`). */
  authHeader: string
  /** Prefix prepended to the credential value (e.g. `Bearer `; empty = raw). */
  authPrefix: string
  /** Service language parameter; empty = the service's own default. */
  language: string
  /** Service category filter; empty = the service's own default. */
  categories: string
  /** Safe-search level (0 off / 1 moderate / 2 strict). */
  safesearch: number
}

/** One search backend. */
export interface SearchAdapter {
  /** Stable id the settings section selects by. */
  readonly id: string
  /** Human label for the GUI card. */
  readonly label: string
  /**
   * Run one search; honor `signal` for cancellation.
   * @param ctx - resolved endpoint, credential, and default parameters.
   * @param request - the seam request (query plus optional result bound).
   * @param signal - cancellation forwarded from the seam.
   */
  search(
    ctx: SearchAdapterContext,
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult>
}

/**
 * Build the credential header, or an empty object for an anonymous service.
 * A blank key means "no authentication" — the common local-SearXNG case.
 * @param ctx - the adapter context.
 * @returns headers to merge into the outgoing request.
 */
export function authHeadersFor(ctx: SearchAdapterContext): Record<string, string> {
  if (ctx.apiKey === undefined || ctx.apiKey.length === 0) return {}
  const name = ctx.authHeader.trim().length > 0 ? ctx.authHeader.trim() : 'Authorization'
  return { [name]: `${ctx.authPrefix}${ctx.apiKey}` }
}
