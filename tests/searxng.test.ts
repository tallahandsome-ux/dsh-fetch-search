import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  answerText,
  buildSearxngURL,
  describeUnresponsive,
  mapSearxngResponse,
  searxngAdapter,
  searchFailureMessage,
} from '../src/adapters/searxng.ts'
import type { SearchAdapterContext } from '../src/adapters/search-types.ts'

const CTX: SearchAdapterContext = {
  baseURL: 'http://127.0.0.1:8888',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  language: '',
  categories: '',
  safesearch: 0,
}

interface StubInit {
  ok?: boolean
  status?: number
  json?: unknown
  text?: string
  throwError?: Error
}

/** Stub the global fetch with one canned response (or a thrown error). */
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

async function expectWebError(promise: Promise<WebSearchResult>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the search to reject')
}

describe('buildSearxngURL', () => {
  it('asks for JSON and always sets the query', () => {
    const url = new URL(buildSearxngURL('http://127.0.0.1:8888', 'deepseek harness', {
      language: '', categories: '', safesearch: 0,
    }))
    expect(url.pathname).toBe('/search')
    expect(url.searchParams.get('q')).toBe('deepseek harness')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('safesearch')).toBe('0')
  })

  it('omits empty optional parameters', () => {
    const url = new URL(buildSearxngURL('http://h:8888', 'q', { language: '', categories: '', safesearch: 0 }))
    expect(url.searchParams.has('language')).toBe(false)
    expect(url.searchParams.has('categories')).toBe(false)
  })

  it('forwards language, categories, and safesearch', () => {
    const url = new URL(buildSearxngURL('http://h:8888', 'q', {
      language: 'zh-CN', categories: 'general', safesearch: 2,
    }))
    expect(url.searchParams.get('language')).toBe('zh-CN')
    expect(url.searchParams.get('categories')).toBe('general')
    expect(url.searchParams.get('safesearch')).toBe('2')
  })

  it('keeps a path prefix on the configured base', () => {
    const url = new URL(buildSearxngURL('https://example.com/searx/', 'q', {
      language: '', categories: '', safesearch: 0,
    }))
    expect(url.pathname).toBe('/searx/search')
  })
})

describe('mapSearxngResponse', () => {
  it('maps results to sources, content to snippet, publishedDate to publishedAt', () => {
    const result = mapSearxngResponse({
      results: [
        { url: 'https://a.com/1', title: 'A', content: 'snippet a', publishedDate: '2026-11-02' },
        { url: 'https://a.com/2', title: '  ' },
      ],
    })
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toEqual({
      url: 'https://a.com/1', title: 'A', snippet: 'snippet a', publishedAt: '2026-11-02',
    })
    // Blank title is omitted rather than sent as whitespace.
    expect(result.sources[1]).toEqual({ url: 'https://a.com/2' })
    expect(result.truncated).toBe(false)
  })

  it('drops entries without a URL (the seam requires one)', () => {
    const result = mapSearxngResponse({ results: [{ title: 'no url', content: 'x' }, { url: '' }] })
    expect(result.sources).toHaveLength(0)
  })

  it('caps at the bound and reports truncated', () => {
    const results = Array.from({ length: 5 }, (_, index) => ({ url: `https://a.com/${index}` }))
    const result = mapSearxngResponse({ results }, 2)
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('maps answers to content', () => {
    const result = mapSearxngResponse({
      results: [{ url: 'https://a.com' }],
      answers: [{ answer: '42' }, 'plain'],
    })
    expect(result.content).toBe('42\nplain')
  })

  it('omits content when there are no answers', () => {
    const result = mapSearxngResponse({ results: [{ url: 'https://a.com' }], answers: [] })
    expect(result.content).toBeUndefined()
    expect('content' in result).toBe(false)
  })

  it('survives a malformed payload', () => {
    expect(mapSearxngResponse(null).sources).toHaveLength(0)
    expect(mapSearxngResponse({ results: 'nope' }).sources).toHaveLength(0)
  })
})

describe('answerText / describeUnresponsive', () => {
  it('reads both answer shapes', () => {
    expect(answerText([{ answer: 'a' }, 'b', { answer: '   ' }])).toBe('a\nb')
    expect(answerText('nope')).toBeUndefined()
    expect(answerText([])).toBeUndefined()
  })

  it('renders engine tuples as `engine: reason`', () => {
    expect(describeUnresponsive([['duckduckgo', 'CAPTCHA'], ['brave', 'too many requests']]))
      .toBe('duckduckgo: CAPTCHA; brave: too many requests')
    expect(describeUnresponsive(undefined)).toBe('')
    expect(describeUnresponsive([['google']])).toBe('google: failed')
  })
})

describe('searchFailureMessage', () => {
  it('names the JSON-formatter fix for 403', () => {
    expect(searchFailureMessage(403, '')).toContain('search.formats')
  })

  it('names the limiter fix for 429', () => {
    expect(searchFailureMessage(429, '')).toContain('limiter')
  })

  it('names the base-URL fix for 404', () => {
    expect(searchFailureMessage(404, '')).toContain('searchBaseURL')
  })

  it('appends a body excerpt when present', () => {
    expect(searchFailureMessage(500, 'boom')).toContain('boom')
  })
})

describe('searxngAdapter.search', () => {
  it('returns normalized sources from a successful response', async () => {
    stubFetch({
      json: {
        results: [
          { url: 'https://a.com', title: 'A', content: 'body a', engine: 'bing' },
          { url: 'https://b.com', title: 'B', content: 'body b' },
        ],
        unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
      },
    })
    const result = await searxngAdapter.search(CTX, { query: 'q', maxResults: 10 })
    expect(result.sources.map((source) => source.url)).toEqual(['https://a.com', 'https://b.com'])
    expect(result.sources[0]?.snippet).toBe('body a')
  })

  it('sends no authorization header when anonymous', async () => {
    const fn = stubFetch({ json: { results: [{ url: 'https://a.com' }] } })
    await searxngAdapter.search(CTX, { query: 'q' })
    const init = fn.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers.authorization).toBeUndefined()
  })

  it('sends the configured authentication header for a remote instance', async () => {
    const fn = stubFetch({ json: { results: [{ url: 'https://a.com' }] } })
    await searxngAdapter.search({ ...CTX, apiKey: 'secret', authPrefix: 'Bearer ' }, { query: 'q' })
    const init = fn.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer secret')
  })

  it('honours a custom header name (X-API-Key)', async () => {
    const fn = stubFetch({ json: { results: [{ url: 'https://a.com' }] } })
    await searxngAdapter.search(
      { ...CTX, apiKey: 'k', authHeader: 'X-API-Key', authPrefix: '' },
      { query: 'q' },
    )
    const init = fn.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers['X-API-Key']).toBe('k')
  })

  it('raises the JSON-formatter diagnosis on 403', async () => {
    stubFetch({ ok: false, status: 403, text: 'Forbidden' })
    const error = await expectWebError(searxngAdapter.search(CTX, { query: 'q' }))
    expect(error.message).toContain('search.formats')
  })

  it('raises a diagnostic error when every engine was unresponsive', async () => {
    stubFetch({
      json: { results: [], unresponsive_engines: [['duckduckgo', 'CAPTCHA'], ['brave', 'too many requests']] },
    })
    const error = await expectWebError(searxngAdapter.search(CTX, { query: 'q' }))
    expect(error.message).toContain('duckduckgo: CAPTCHA')
    expect(error.message).toContain('brave')
  })

  it('returns an empty result when engines answered but matched nothing', async () => {
    stubFetch({ json: { results: [], unresponsive_engines: [] } })
    const result = await searxngAdapter.search(CTX, { query: 'q' })
    expect(result.sources).toHaveLength(0)
  })

  it('explains a non-object JSON body (JSON formatter disabled)', async () => {
    stubFetch({ json: null })
    const error = await expectWebError(searxngAdapter.search(CTX, { query: 'q' }))
    expect(error.message).toContain('JSON')
  })

  it('treats a non-JSON content type as the formatter hint too', async () => {
    stubFetch({ json: undefined })
    const error = await expectWebError(searxngAdapter.search(CTX, { query: 'q' }))
    expect(error.message).toContain('JSON')
  })

  it('wraps a network failure with the endpoint in the message', async () => {
    stubFetch({ throwError: new Error('ECONNREFUSED') })
    const error = await expectWebError(searxngAdapter.search(CTX, { query: 'q' }))
    expect(error.message).toContain('127.0.0.1:8888')
    expect(error.message).toContain('ECONNREFUSED')
  })
})
