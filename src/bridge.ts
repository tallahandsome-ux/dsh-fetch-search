/**
 * Runtime-state bridge: host HTTP routes for the two card needs that are NOT
 * configuration and therefore have no official Remote — running a real test
 * fetch through the live routing, and reading the live fallback-chain
 * cooldown state.
 *
 * Configuration itself no longer crosses this bridge: since dsh 0.1.2 the
 * settings Remote serves every registered namespace (the old apiproxy
 * allowlist is gone), and the Plugins page's bundle-configuration form
 * reads/writes this plugin's volatile fields through it. The API key rides
 * the credentials Remote the same way. The server binds loopback by default
 * and these handlers re-check the peer address.
 * @module dsh-fetch-search/bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge from the host webserver package.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { TestFetchResult } from './provider.ts'
import type { TestSearchResult } from './search-provider.ts'
import type { ChainRow } from './fallback.ts'

/** Route prefix for this plugin's runtime-state bridge. */
const BRIDGE_PREFIX = '/api/fetch-third-party'

/** Loopback peer addresses the bridge accepts (IPv4, IPv6, and mapped forms). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Max request body the bridge accepts (guard against runaway local payloads). */
const MAX_BODY_BYTES = 1024 * 1024

/** Mount the runtime-state bridge routes (test fetch, test search, live chain view). */
export function mountFetchBridge(
  ctx: Context,
  test: (url: string) => Promise<TestFetchResult>,
  chain: () => ChainRow[],
  searchTest: (query: string) => Promise<TestSearchResult>,
): void {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposers = [
        sctx.webServer.register({
          kind: 'exact',
          path: `${BRIDGE_PREFIX}/test`,
          handler: (req, res) => void handleTest(test, req, res),
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: `${BRIDGE_PREFIX}/search-test`,
          handler: (req, res) => void handleSearchTest(searchTest, req, res),
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: `${BRIDGE_PREFIX}/chain`,
          handler: (req, res) => void handleChain(chain, req, res),
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-fetch-search: runtime-state bridge')
  })
}

/** POST `{ url? }` runs a real fetch through the routing (consumes provider API quota). */
async function handleTest(
  test: (url: string) => Promise<TestFetchResult>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!loopbackPeer(req)) return sendJson(res, 403, { error: 'loopback-only' })
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
  const body = await readJsonOr400(req, res)
  if (body === null) return
  const { url: raw } = body as { url?: unknown }
  const url = typeof raw === 'string' && raw.length > 0 ? raw : 'https://example.com'
  if (!isHttpUrl(url)) {
    return sendJson(res, 400, { error: 'invalid test URL' })
  }
  try {
    return sendJson(res, 200, await test(url))
  } catch (error) {
    return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** POST `{ query? }` runs a real search through the routing (no cache, no budget). */
async function handleSearchTest(
  searchTest: (query: string) => Promise<TestSearchResult>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!loopbackPeer(req)) return sendJson(res, 403, { error: 'loopback-only' })
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
  const body = await readJsonOr400(req, res)
  if (body === null) return
  const { query: raw } = body as { query?: unknown }
  const query = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'searxng test'
  try {
    return sendJson(res, 200, await searchTest(query))
  } catch (error) {
    return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** GET the live fallback chain order + cooldown state. */
async function handleChain(
  chain: () => ChainRow[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!loopbackPeer(req)) return sendJson(res, 403, { error: 'loopback-only' })
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
  return sendJson(res, 200, { chain: chain() })
}

/** Whether a string is an absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Reject requests whose peer is not loopback (defense in depth on top of the bind). */
function loopbackPeer(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? '')
}

/** Drain the request body and parse JSON; rejects on oversized or malformed input. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/** Parse the request body, answering 400 when it is missing, malformed, or too large. */
async function readJsonOr400(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  try {
    return await readJson(req)
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return null
  }
}

/** Write one JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
