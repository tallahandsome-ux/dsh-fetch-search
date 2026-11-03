/**
 * Crawl4AI adapter: speaks a self-hosted Crawl4AI Docker API server natively
 * (verified against C4AI 0.9.x), so a user-deployed container is a provider
 * with no local wrapper process.
 *
 *   POST {baseURL}/md                 Authorization: Bearer <token> (v0.9+ requires auth)
 *   Body: { "url": "<target>", "f": "fit" }
 *   → 200 JSON { url, filter, query, cache, markdown, success }
 *
 * Uses the purpose-built synchronous /md endpoint (Readability "fit" filter)
 * rather than the async /crawl/job pipeline: one call per URL,
 * LLM-friendly markdown out. The token's value lives in the credentials
 * store under the reference the section names (default CRAWL4AI_API_KEY).
 * @module dsh-fetch-search/adapters/crawl4ai
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { dispatcherFor, joinURL, type FetchAdapter, type FetchAdapterContext } from './types.ts'

/** Body size cap applied to non-2xx error bodies (they are diagnostics, not pages). */
const ERROR_BODY_CAP = 100_000

/** The Crawl4AI /md response envelope (0.9.x). */
interface Crawl4AiResponse {
  url?: unknown
  markdown?: unknown
  success?: unknown
}

/** The self-hosted Crawl4AI fetch backend. */
export const crawl4aiAdapter: FetchAdapter = {
  id: 'crawl4ai',
  label: 'Crawl4AI (self-hosted)',
  async fetch(ctx: FetchAdapterContext, request, signal): Promise<WebFetchResult> {
    const dispatcher = dispatcherFor(ctx.proxy)
    let response: Response
    try {
      response = await fetch(joinURL(ctx.baseURL, '/md'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...ctx.apiKey !== undefined && ctx.apiKey.length > 0
            ? { authorization: `Bearer ${ctx.apiKey}` }
            : {},
        },
        body: JSON.stringify({ url: request.url, f: 'fit' }),
        ...dispatcher !== undefined ? { dispatcher } : {},
        signal,
      })
    } catch (error) {
      // Network-level failure (DNS, connect, TLS, timeout): surface a clear,
      // routable error instead of leaking the raw undici exception.
      const cause = error instanceof Error ? error.message : String(error)
      throw new WebError(`Crawl4AI 服务不可达：${cause}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    // A non-2xx response is a result (status + decoded body), not an error —
    // a missing token answers 401 here and the body says how to configure it.
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        url: request.url,
        statusCode: response.status,
        body: { kind: 'text', content: text.slice(0, ERROR_BODY_CAP) },
        truncated: text.length > ERROR_BODY_CAP,
      }
    }
    const data = await response.json().catch(() => null) as Crawl4AiResponse | null
    const markdown = data !== null && typeof data.markdown === 'string' ? data.markdown : ''
    if (markdown.length === 0) {
      throw new WebError(
        'Crawl4AI 未返回 markdown（POST {baseURL}/md → {markdown}）；请检查容器日志与 API Token',
        'WEB_PROVIDER_ERROR',
      )
    }
    return {
      url: typeof data?.url === 'string' ? data.url : request.url,
      statusCode: 200,
      body: { kind: 'text', content: markdown },
      truncated: false,
    }
  },
}
