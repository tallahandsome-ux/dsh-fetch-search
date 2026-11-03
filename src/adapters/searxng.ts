/**
 * SearXNG search adapter: speaks SearXNG's JSON API
 * (`GET {baseURL}/search?q=…&format=json`, enabled by `search.formats: [json]`
 * in the instance's settings.yml) and normalizes it into the seam's shape.
 *
 * Mapping decisions:
 * - `results[].content` → `snippet` (SearXNG's engine excerpt is exactly that).
 * - `results[].publishedDate` → `publishedAt` when the engine supplies it.
 * - `answers[]` (calculator/weather style instant answers) → `content`.
 * - Entries without a URL are dropped: `WebSearchSource.url` is required and
 *   inventing one would make the seam lie.
 *
 * Failure text is deliberately diagnostic: the two failure modes that actually
 * bite a self-hosted deployment (JSON formatter disabled → 403, limiter/bot
 * detection → 429/403, every engine unresponsive → empty results) each get a
 * message that names the fix.
 * @module dsh-fetch-search/adapters/searxng
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { joinURL, dispatcherFor } from './types.ts'
import { authHeadersFor, type SearchAdapter, type SearchAdapterContext } from './search-types.ts'

/** Attribution header sent on every request. */
const USER_AGENT = 'dsh-fetch-search/2.0.0'

/** Body size cap on a non-2xx diagnostic body. */
const ERROR_BODY_CAP = 2_000

/** Default result bound when neither the request nor the section sets one. */
const FALLBACK_RESULT_BOUND = 10

/** One SearXNG `results[]` entry (only the fields this adapter reads). */
interface SearxngResult {
  url?: unknown
  title?: unknown
  content?: unknown
  publishedDate?: unknown
  engine?: unknown
}

/** The SearXNG JSON envelope (fields optional: proxies and forks vary). */
interface SearxngPayload {
  results?: unknown
  answers?: unknown
  unresponsive_engines?: unknown
}

/** Options for {@link buildSearxngURL}. */
export interface SearxngURLOptions {
  language: string
  categories: string
  safesearch: number
}

/**
 * Compose the JSON search URL. Exported for tests: the parameter set is the
 * contract with the instance, so it is asserted directly rather than through a
 * mock server.
 * @param baseURL - configured instance base (may carry a path prefix).
 * @param query - the raw query string.
 * @param options - language / category / safe-search parameters.
 * @returns the absolute request URL.
 */
export function buildSearxngURL(
  baseURL: string,
  query: string,
  options: SearxngURLOptions,
): string {
  const url = new URL(joinURL(baseURL, '/search'))
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (options.language.length > 0) url.searchParams.set('language', options.language)
  if (options.categories.length > 0) url.searchParams.set('categories', options.categories)
  url.searchParams.set('safesearch', String(options.safesearch))
  return url.href
}

/**
 * Render SearXNG's `answers[]` as provider content. Entries are either plain
 * strings or `{ answer }` objects depending on the engine and version.
 * @param answers - the payload's `answers` field.
 * @returns the joined answer text, or undefined when there is none.
 */
export function answerText(answers: unknown): string | undefined {
  if (!Array.isArray(answers)) return undefined
  const parts: string[] = []
  for (const entry of answers) {
    if (typeof entry === 'string' && entry.trim().length > 0) parts.push(entry.trim())
    else if (entry !== null && typeof entry === 'object') {
      const value = (entry as { answer?: unknown }).answer
      if (typeof value === 'string' && value.trim().length > 0) parts.push(value.trim())
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Render SearXNG's `unresponsive_engines[]` as a one-line diagnosis
 * (`engine: reason`, entries are `[name, reason]` tuples).
 * @param unresponsive - the payload's `unresponsive_engines` field.
 * @returns the joined diagnosis, or an empty string when every engine answered.
 */
export function describeUnresponsive(unresponsive: unknown): string {
  if (!Array.isArray(unresponsive)) return ''
  const parts: string[] = []
  for (const entry of unresponsive) {
    if (Array.isArray(entry)) {
      const [engine, reason] = entry as [unknown, unknown]
      if (engine !== undefined) parts.push(`${String(engine)}: ${String(reason ?? 'failed')}`)
    } else if (typeof entry === 'string' && entry.length > 0) {
      parts.push(entry)
    }
  }
  return parts.join('; ')
}

/**
 * Map a SearXNG JSON payload to the seam's normalized result.
 * @param payload - the parsed response body.
 * @param bound - result cap to enforce locally; undefined = no local cap.
 * @returns the normalized result, with `truncated` set only when this mapping
 *   actually dropped sources to honor `bound`.
 */
export function mapSearxngResponse(payload: SearxngPayload | null, bound?: number): WebSearchResult {
  const rawResults = Array.isArray(payload?.results) ? payload?.results as SearxngResult[] : []
  const sources: WebSearchSource[] = []
  for (const entry of rawResults) {
    if (entry === null || typeof entry !== 'object') continue
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (url.length === 0) continue
    const title = typeof entry.title === 'string' && entry.title.trim().length > 0
      ? entry.title.trim()
      : undefined
    const snippet = typeof entry.content === 'string' && entry.content.trim().length > 0
      ? entry.content.trim()
      : undefined
    const publishedAt = typeof entry.publishedDate === 'string' && entry.publishedDate.trim().length > 0
      ? entry.publishedDate.trim()
      : undefined
    sources.push({
      url,
      ...title !== undefined ? { title } : {},
      ...snippet !== undefined ? { snippet } : {},
      ...publishedAt !== undefined ? { publishedAt } : {},
    })
  }
  const capped = bound !== undefined && bound >= 0 && sources.length > bound
    ? sources.slice(0, bound)
    : sources
  const content = answerText(payload?.answers)
  return {
    ...content !== undefined ? { content } : {},
    sources: capped,
    truncated: capped.length < sources.length,
  }
}

/** The SearXNG-backed search backend. */
export const searxngAdapter: SearchAdapter = {
  id: 'searxng',
  label: 'SearXNG (self-hosted)',
  async search(
    ctx: SearchAdapterContext,
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const url = buildSearxngURL(ctx.baseURL, request.query, {
      language: ctx.language,
      categories: ctx.categories,
      safesearch: ctx.safesearch,
    })
    const dispatcher = dispatcherFor(ctx.proxy)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...authHeadersFor(ctx),
        },
        ...dispatcher !== undefined ? { dispatcher } : {},
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      const cause = error instanceof Error ? error.message : String(error)
      throw new WebError(
        `SearXNG 不可达（${ctx.baseURL}）：${cause}。请确认容器在运行、端口正确、代理未误伤 loopback`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    if (!response.ok) {
      const status = response.status
      const detail = (await response.text().catch(() => '')).slice(0, ERROR_BODY_CAP)
      throw new WebError(searchFailureMessage(status, detail), 'WEB_PROVIDER_ERROR')
    }

    let payload: SearxngPayload | null
    try {
      const parsed: unknown = await response.json()
      // A proxy or a misconfigured instance can answer with `null` or a bare
      // primitive while still claiming application/json; treat that exactly
      // like a non-JSON body instead of returning a silently empty result.
      if (parsed === null || typeof parsed !== 'object') {
        throw new SyntaxError('response body is not a JSON object')
      }
      payload = parsed as SearxngPayload
    } catch (error) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        'SearXNG 返回了非 JSON 响应：实例大概率未开启 JSON 输出（settings.yml 的 search.formats 需包含 json）',
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    const bound = request.maxResults ?? FALLBACK_RESULT_BOUND
    const result = mapSearxngResponse(payload, bound)
    if (result.sources.length === 0) {
      const unresponsive = describeUnresponsive(payload?.unresponsive_engines)
      if (unresponsive.length > 0) {
        // Zero sources plus dead engines is a provider failure, not an empty
        // answer: surfacing the engine reasons turns "no results" into a fix.
        throw new WebError(
          `SearXNG 所有引擎均未返回结果（${unresponsive}）。可检查：引擎被 CAPTCHA/429、代理出口受限、或实例出站被墙`,
          'WEB_PROVIDER_ERROR',
        )
      }
    }
    return result
  },
}

/**
 * Build the diagnostic message for a non-2xx SearXNG response.
 * @param status - the HTTP status.
 * @param detail - a capped body excerpt (may be empty).
 * @returns the message naming the likely fix.
 */
export function searchFailureMessage(status: number, detail: string): string {
  const tail = detail.trim().length > 0 ? `；响应：${detail.trim()}` : ''
  if (status === 403) {
    return `SearXNG 拒绝请求（HTTP 403）：通常是 settings.yml 的 search.formats 未包含 json（未开启时 format=json 一律 403），或 limiter/botdetection 拦截了程序化请求${tail}`
  }
  if (status === 429) {
    return `SearXNG 限流（HTTP 429）：实例开启了 limiter，请在 settings.yml 关闭 limiter 或把本机 IP 加入 botdetection 白名单${tail}`
  }
  if (status === 404) {
    return `SearXNG 端点不存在（HTTP 404）：请核对 searchBaseURL 是否指向实例根路径${tail}`
  }
  return `SearXNG 返回 HTTP ${status}${tail}`
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
