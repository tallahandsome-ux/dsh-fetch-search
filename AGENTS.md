# AGENTS.md — for AI agents working in dsh-fetch-search

## Project

A DeepSeek Harness (dsh) plugin giving models **safe web fetching** and, since 2.0, **self-hosted search**: page retrieval is delegated to user-configured third-party services (Tavily / Jina Reader / Firecrawl / custom contract-v1 services), and search runs through the user's own SearXNG instance, so the local machine never connects to the target URL directly (no SSRF surface) and search costs no per-call vendor fee. It also ships a per-session budget, an in-process LRU+TTL cache (fetch and search), SSRF defense-in-depth on fetch targets, a dynamic fallback chain with cooldown, structured fetch output, a GUI settings card, and an auto-managed local Crawl4AI stack with a watchdog.

## Repository

- Repo: `https://github.com/tallahandsome-ux/dsh-fetch-search` (public, MIT)
- Branch: `main` (tags mark releases, e.g. `v1.0.0`)
- Docs: `docs/contract.md` (custom-service contract v1), `docs/custom-crawler-research.md` (crawler selection), `docs/ssrf-hardening.md` (SSRF checklist for direct-connect second-dev)

## Commands (repo root)

```bash
pnpm build       # tsdown → lib/index.js (Host) + lib/client.js (browser card)
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
```

## Target platform (dsh ≥ 0.2.0-rc.0, incl. 0.2.1-alpha.2 and DSH Desktop's bundled 0.2.0-rc.2)

- Configuration uses the **volatile Config** mechanism (dsh ≥ 0.1.7): every schema field is `.volatile()`, the Plugins page's bundle-configuration form (`plugins.bundle.config`, keyed by this package name) edits them through the official settings Remote, and `apply` reads them via `Volatile` references (`config.field.get()`), re-read on `loader/volatile-update`.
- The card mounts in TWO seats over one controller: the Settings panel's own page (`settings.section`, id `web-fetch-search`, order 100 — expanded by default) and the bundle's Plugins-page detail seat (`plugins.bundle.config` — collapsed). The display name is 「网页抓取与搜索」 / 'Web Fetch & Search' (locale `meta.title` + card `nav`/`title`; changed from the package name at the user's request on 2026-11-03, after the plugin gained the search half).
- **Identity rename (2026-11-03, user request)**: package `dsh-fetch-search`, row id / settings namespace `web-fetch-search`, GitHub repo `tallahandsome-ux/dsh-fetch-search` (renamed via the API the same day; GitHub redirects the old URL). The bridge route prefix stays `/api/fetch-third-party` (invisible; deliberately not migrated), as does the locale namespace key `fetch-third-party`. Renaming the package or row id again means migrating the profile together with it: dependency key + `dsh.profile.bundles` entry in the profile's `package.json`, and the config row id in the profile's `cordis.patch.yml`.
- The entry MUST `export { Config }` — the Loader validates the raw row config against it, fills defaults, and wraps volatile fields; without the export the plugin receives `undefined` config and crashes.
- The API key rides the **credentials Remote** (`ctx.remote.credentials.set/unset/describe` + the `credentials/reference-updated` event); the browser half mirrors this through `ctx.configForms.get('web-fetch-search')`.
- The only private HTTP routes left are runtime state: `POST /api/fetch-third-party/test` and `GET /api/fetch-third-party/chain`. The old config/key/custom bridge routes and the apiproxy-allowlist workaround are obsolete (apiproxy was removed in dsh 0.1.2).
- `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-client-runtime` no longer exist as runtime imports; client types come from cordis (`Context as ClientContext`) plus type-only merges (`dsh-client-ui-settings/client`, `dsh-client-ui-plugin-manager/client`, `dsh-client-ui-renderer/client`, `dsh-api-remotes/client`).

## Layout

- `src/index.ts` — plugin entry: wires provider / tool / bridge / local-stack; re-exports `Config`; subscribes volatile updates
- `src/provider.ts` — `ThirdPartyFetchProvider`: routing chain, budget, cache, SSRF pre-check
- `src/search-provider.ts` — `ThirdPartySearchProvider` (registered as `third-party` in the SEARCH registry, which is a separate map from fetch): chain + search cache, no budget, no SSRF pre-check, per-request timeout
- `src/settings.ts` — the volatile config schema + `Section` snapshot type + provider-resolution helpers (`resolveProvider` for fetch, `resolveSearchProvider` for search; single source of truth for config fields)
- `src/bridge.ts` — runtime-state bridge routes `/api/fetch-third-party/{test,search-test,chain}`
- `src/tool.ts` — the `web_fetch_url` model tool (configurable name, conflict fallback, hot re-registration). Search needs NO tool: the official `web_search` reaches the provider through `ctx.web.search()`.
- `src/fallback.ts` — dynamic fallback chain (quota/failure cooldown, exponential backoff); shared by fetch and search
- `src/cache.ts` — generic `TtlLruCache<T>` plus key-normalizing `FetchCache` (by URL) and `SearchCache` (by query+parameters)
- `src/ssrf.ts` — SSRF utilities (exported; used by the FETCH provider pre-check only — never on the search endpoint)
- `src/structure.ts` — structured output extraction (title/headings/links/stats)
- `src/local-stack.ts` — self-healing local stack, two levels: the container watchdog (needsContainer) keeps the Crawl4AI container alive for BOTH native `crawl4ai` entries at loopback:11235 AND contract-v1 `custom` entries, re-checked every 20s (docker attempts back off 60s); the wrapper (needsWrapper) spawns only for contract-v1 entries. Remote or non-standard-port crawl4ai entries are not adopted.
- `src/adapters/` — tavily / jina / firecrawl / crawl4ai (native `/md`, self-hosted) / custom (contract v1)
- `src/client/index.ts` — browser half: locale + `settings.section` page + `plugins.bundle.config` seat + credentials event bridge
- `src/client/card-controller.ts` — form (`configForms`) + credentials Remote bridge onto the card; one silent retry per field write (a Loader recomposition bumps the settings revision fence — fingerprint includes the fiber uid — and the form's recovery reloads the fresh revision, so the retry absorbs the race)
- `src/client/card.tsx` — the configuration card UI (`FetchSurface` shared body; `FetchSettingsSection` settings-page wrapper, expanded; `FetchCard` bundle-seat wrapper, collapsed)
- `locale/{en,zh}.json` + `icon.svg` — display metadata for the Plugins page (title/description/icon)
- `tests/` — vitest unit tests

## Non-negotiables (do not break)

- **Courier model**: the plugin must never fetch the target URL from the local process; retrieval goes only through a configured third-party service or the local Crawl4AI stack.
- **Search endpoint is operator-owned**: `searchBaseURL` is user-configured (usually a loopback container), so it must NEVER go through `assertPublicHttpURL` — that guard applies to model-requested fetch targets only. Do not reuse the fetch SSRF pre-check on the search path.
- **Search registration is gated**: register the search provider only while `searchEnabled` is true, and unregister on toggle. Registering unconditionally would leave two usable search providers whenever the bundled `deepseek-official` one is configured, turning every search into `WEB_PROVIDER_AMBIGUOUS`. Selection is pinned in the profile's `web` row (`searchProvider: third-party`), which replaces the whole row config — always restate `fetchProvider` alongside it.
- **Secrets**: API keys live ONLY in the user credentials store (`~/.dsh/.credentials.yaml`), keyed by env-reference name; never commit keys/tokens/personal paths. Verify scripts read keys from env/argv only.
- **Config additions**: a new setting must touch `src/settings.ts` (volatile interface + `Section` shape + schema with `.volatile()`), the card controller's `SectionValues` mirror if the card shows it, card/locales if there is UI, and a test. (There is no `DEFAULT_CONFIG` anymore — schema defaults are the source.)
- **Peer ranges**: `@deepseek-ai/dsh-*` peers must cover every runtime the plugin targets (currently `>=0.2.0-rc.0 <0.2.2`); cordis/schemastery use OR-ranges so both the final (4.0.4/3.18.4) and alpha (4.0.5-alpha.1/3.18.5-alpha.1) lines satisfy them under default semver.
- **Tool output compatibility**: `web_fetch_url` output schema keeps `url` / `statusCode` / `content` required; new fields are optional additions.
- **CI**: GitHub Actions runs typecheck + test on every push; keep it green.

## Verifying a change

1. `pnpm typecheck && pnpm test && pnpm build`
   - `pnpm test` is hermetic (the live SearXNG suite skips without an env var). To exercise the real instance: `$env:LIVE_SEARXNG_BASE='http://127.0.0.1:8888'; npx vitest run tests/live-searxng.test.ts`.
2. Reinstall into the profile so the `file:` copy refreshes (same version = "Already up to date"): `dsh plugin --profile web remove dsh-fetch-search && dsh plugin --profile web add file:<abs path>`. A `link:` install needs no reinstall — the built `lib/` is live after a DSH restart.
3. GUI checks: Settings → dsh-fetch-search (dedicated page, expanded card) and the Plugins-panel bundle detail page — both render the same controller; `POST /api/fetch-third-party/test`; `POST /api/fetch-third-party/search-test` (body `{"query":"…"}`); `GET /api/fetch-third-party/chain` shows the live fallback chain; edits in either card hot-apply (the chain view follows without restart).
4. Search needs a DSH restart after the `web` row is pinned (a patch row is read at boot; only volatile field values hot-apply).

## Machine-specific facts (do NOT commit these)

- The local working copy path, the git proxy address, the GitHub credential storage, and the plugin install location are machine-specific — keep them out of the repository.
- If you need them, the operator can provide them; this file stays portable.
