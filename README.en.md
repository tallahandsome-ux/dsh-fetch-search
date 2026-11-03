# dsh-fetch-search

中文 | [English](README.en.md)

**Web fetching + self-hosted search for DeepSeek Harness (DSH)** — lets AI fetch full web pages on its own when search snippets are not enough, and route web search through your own SearXNG instance instead of a per-call billed API.

## Introduction

This plugin adds two capabilities to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), both registered into the official `ctx.web` seam:

- **Safe web fetching**: fetching is delegated to a **third-party service you choose or host** (Tavily / Jina Reader / Firecrawl / custom contract-v1 services). The local machine never connects to the target URL directly, so there is **no SSRF attack surface**.
- **Self-hosted search (2.0+)**: the `web_search` backend becomes **your own SearXNG** instance, replacing the per-call billed official search.

Core capabilities:

- **Autonomous fetching**: the model first calls `web_search` (served by whichever search provider you configured — the official channel or your SearXNG); when snippets are not enough to answer, it automatically calls `web_fetch_url` to fetch the full page — no user prompting needed.
- **Courier model**: the target URL is fetched only by the configured third-party service; the local machine makes zero outbound connections to arbitrary URLs (no SSRF surface).
- **Multiple providers + routing**: Tavily / Jina Reader / Firecrawl / custom services (contract v1, multiple instances), with automatic fallback from the primary to the fallback provider.
- **Single API-key write point**: keys live only in the managed credentials store (0600); the card only shows "configured / not configured" and never echoes the key.
- **Per-session budget**: 10 fetches per session by default; further calls are refused with a clear message.
- **GUI settings card**: test connection / local proxy / custom provider management / clear key.
- **Auto-managed local Crawl4AI stack**: when the primary or fallback provider is a loopback custom provider, the plugin starts the container and the wrapper process automatically, with a real-time watchdog for self-healing.
- **Fetch cache**: repeated fetches of the same URL within the TTL are served from memory — no third-party quota used, no session budget consumed.
- **SSRF defense-in-depth**: targets on loopback / private / reserved addresses requested by the model are rejected before forwarding (important when a self-hosted Crawl4AI shares the local network).
- **Dynamic fallback chain**: ordered provider chain with quota/failure cooldown (exponential backoff) — failing providers degrade automatically and recover when the cooldown expires, not just a fixed primary+fallback pair.
- **Structured output**: `web_fetch_url` returns title / heading outline / links / word count / reading time alongside the body, making the evidence easier to cite and verify.

## Search (SearXNG, since 2.0)

The second capability: the `ctx.web` search provider becomes **your self-hosted SearXNG**, replacing the per-call billed official search. The model keeps the same `web_search` tool — parameters, result cards, and citation format are unchanged.

- **Registered as `third-party`**: only registered while `searchEnabled` is on, so installs that never enable it behave exactly like 1.x (no `WEB_PROVIDER_AMBIGUOUS` from a second usable provider).
- **Pin the selection**: the profile `web` row must set `searchProvider: third-party` (a patch replaces the whole row config — restate `fetchProvider` too).
- **Remote / authenticated instances**: `searchBaseURL` for the address; `searchApiKeyEnv` + `searchAuthHeader` + `searchAuthPrefix` compose the credential header (`Authorization: Bearer ...`, `X-API-Key: ...`); all three blank = anonymous (local Docker default).
- **No fetch budget**: a self-hosted instance has no marginal cost, so searches do not consume `maxFetchesPerSession`; results cache with the same TTL/LRU policy but a separate store keyed by query/language/categories/safesearch/count.
- **No SSRF pre-check on search**: the search endpoint is operator-owned (usually loopback) — `assertPublicHttpURL` would reject `127.0.0.1`; fetch targets requested by the model keep the original protection.
- **Actionable diagnostics**: 403 -> the `search.formats` json hint; 429 -> limiter hint; zero results -> `unresponsive_engines` reasons in the error.
- **20s timeout**: SearXNG engines aggregate in parallel at 3s each, but a cold instance measured 18.5s on its first query — the default sits above that.

The two SearXNG-side prerequisites (miss them and the search returns 403 / nothing): see [docs/search-searxng.md](docs/search-searxng.md).

## How it works

```
User question
  → model calls web_search
    → ctx.web.search → configured search provider (this plugin's third-party / SearXNG, or the official deepseek-official)
      → snippets enough? → yes → answer directly
      → no → model autonomously calls web_fetch_url({ url })
        → ctx.web.fetch / this plugin's third-party provider
          → third-party service (Tavily / Jina / Firecrawl / custom) fetches the target page
          → returns the content → model answers from the full text
```

## Directory layout

```
fetch/
├── package.json        # dsh.bundle + dsh.client manifest
├── cordis.patch.yml    # patch layer
├── docs/               # contract v1 / self-hosted crawler research
├── scripts/            # verification scripts + contract-v1 wrapper + launch scripts
├── tests/              # vitest unit tests
└── src/                # source (Host + Client halves)
```

## Installing into DeepSeek Harness

Prerequisites: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) and pnpm.

> **Compatibility**: v1.1.0+ targets the volatile-config era of dsh — requires **dsh ≥ 0.2.0-rc.0 and < 0.2.2** (verified against 0.2.0-rc.2, 0.2.1-alpha.2 and 0.2.1-rc.3). For dsh 0.1.x use v1.0.0. **Configuration entry**: Settings → **Web Fetch & Search** (a dedicated settings page, card expanded by default; `settings.section` slot); the same card also stays on the bundle's detail page in the Plugins panel. Every field saves instantly and hot-applies via volatile HMR. DSH Desktop users: the `desktop` profile is managed exclusively by the Electron app — install from inside it (Plugins panel → Add plugin → local `file:` path).

### Method 1: git install (recommended)

```powershell
dsh plugin --profile web add https://github.com/tallahandsome-ux/dsh-fetch-third-party.git
```

> **pnpm v11 first-install note**: pnpm v11 blocks build scripts of git dependencies by default; the first run may fail with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. The error prints the exact key to allow; add it to the profile `pnpm-workspace.yaml` and re-run, e.g.:
>
> ```yaml
> # %USERPROFILE%\.dsh\profiles\web\pnpm-workspace.yaml
> allowBuilds:
>   "dsh-fetch-search@git+https://github.com/tallahandsome-ux/dsh-fetch-third-party.git#<commit>": true
> ```

After installing, **restart `dsh web`**; the bundle appears in the Plugins panel under Installed plugins as "Web Fetch & Search".

### Method 2: local build then install

For when you already have a local copy (e.g. a `git clone` you want to modify).

**Key point: `file:` must point to the full absolute path of the clone directory — the folder that directly contains `package.json`.** Not the repo name, not a file, not the parent directory.

```powershell
git clone https://github.com/tallahandsome-ux/dsh-fetch-third-party.git
cd dsh-fetch-search
pnpm install
pnpm build
dsh plugin --profile web add file:D:\your-folder\dsh-fetch-search
```

Replace `D:\your-folder\dsh-fetch-search` with the **actual directory you cloned to**. For example, if you cloned into `D:\plugins`:

```powershell
dsh plugin --profile web add file:D:\plugins\dsh-fetch-search
```

How to tell it is correct: the path should directly contain `package.json`, `src/`, `tsdown.config.ts`, `scripts/`, etc.; if `Test-Path` passes and `package.json` is visible, it is correct. A wrong path (missing directory, or pointing at a file) makes `dsh plugin add` fail or install nothing.

> If you previously installed an old version, restart `dsh web` after installing; if the card does not refresh, run `pnpm install` in the profile directory (`%USERPROFILE%\.dsh\profiles\web`) and restart again.

### Verifying the install

1. Restart `dsh web` and hard-refresh the browser (Ctrl+F5).
2. Settings → **Web Fetch & Search**: the dedicated page opens with the card expanded (the same card also lives on the bundle's detail page in the Plugins panel).
3. Pick a provider (e.g. Jina Reader, keyless) and click "Test connection" — it should succeed.
4. Start a new session; the model can fetch full pages via the `web_fetch_url` tool.
5. (Optional) enable the "Search (SearXNG)" section, pin the profile `web` row as it instructs, and use "Test search" to verify the self-hosted search route.

## API Key Security (required reading)

This plugin handles API keys under two hard constraints:

1. **Keys are never read back in plaintext**: a key lives only in the DSH-managed
   vault `~/.dsh/.credentials.yaml` (written with mode `0600`, readable by the
   current user only). The only read in code is to build the
   `Authorization: Bearer <key>` header when a request goes out — no bridge
   endpoint, GUI card, log line, or error message ever returns the key value;
   the settings card only shows a `configured / not configured` boolean
   (`apiKeyConfigured`) and never echoes the key itself.

2. **If a key must ever be displayed, it must be masked**: any future feature
   (debug output, diagnostics panel, test echo) that shows a key **must not
   print it in full** — mask it to a few leading/trailing characters plus
   `***` (e.g. `tvly-dev-4y0S…FUb3C35`). A full key appearing in any log,
   error, or response body is treated as a defect (bug).

Additional recommendations:

- Do not put keys in `.env` files or config files that get committed, and do
  not paste keys into chat transcripts — once a key appears in a conversation,
  treat it as compromised.
- If a key is suspected of leaking (logs, chats, screenshots), **rotate it
  immediately** at the provider console (issue a new key, revoke the old one).
- (Optional, stricter) tighten the vault file ACL:
  `icacls "C:\Users\<you>\.dsh\.credentials.yaml" /inheritance:r /grant:r "%USERNAME%:(F)"`
  — a dsh process running as the same user is unaffected.

## Usage

### Switching providers

Settings → **Web Fetch & Search**, or the Plugins-panel detail page → the **Web Fetch & Search** card:

1. **Provider** dropdown: `Tavily` / `Jina Reader` / `Firecrawl` / custom providers
2. **API Key**: written to the managed credentials store (0600), only shows "configured / not configured"; Jina may be left blank (anonymous works), Tavily / Firecrawl recommended
3. **Endpoint**: auto-switches to the provider default (editable)
4. **Fetch cap per session**: 10 by default; further fetches are refused in that session
5. **Local proxy**: see next section

### Proxy configuration (when the network is blocked)

Some network environments block direct connections to third-party services (e.g. `r.jina.ai` DNS-poisoned); a local HTTP proxy is needed. Enter your proxy address in the "Local proxy" field (**example port — use your actual local proxy port**):

```
http://127.0.0.1:27822
```

- Takes effect **per request** (undici `ProxyAgent` dispatcher), without affecting other traffic
- Blank = direct connection

### Fetch cache and target safety

- **Fetch cache** (card level-2): toggle + TTL (seconds). Repeated fetches of the same URL within the TTL are served from memory — no third-party quota, no budget. Enabled by default, 600s TTL.
- **Content cap** (card level-2 "Max content chars"): max characters of one fetched body; longer content is truncated and marked. 0 = no cap (default 100,000, the contract-v1 bound).
- **Reject private targets** (card level-2): refuse loopback / private / reserved targets before forwarding, preventing the model from reaching internal resources. Enabled by default.
- **Tool name** (config `toolName`, not in the card): `web_fetch_url` (default) / `web_fetch` / `auto`. Choosing the official name `web_fetch` auto-falls-back to `web_fetch_url` if it is taken.
- **Fallback chain** (card level-2): comma-separated ordered provider names (empty = adapter + fallback). Failing or quota-exhausted providers cool down (quota 3600s / normal 60s with exponential backoff) and recover automatically; the live order and cooldown state are shown below.
- **Structured output**: `web_fetch_url` returns `{ url, statusCode, content, title?, headings[], links[], wordCount, readingTimeSec }`.
### Self-hosted fetch tool (Crawl4AI, zero API key)

When you do not want to depend on commercial providers, self-host **Crawl4AI** (Docker) as a **custom provider** — no API key needed, still "courier mode". Since v1.3.0 there are two integration paths; the **native `crawl4ai` adapter is recommended** (it speaks Crawl4AI 0.9+'s `/md` protocol directly — no wrapper process). See the [Chinese README](README.md#自建抓取工具crawl4ai) for the full guide including the container watchdog; the wrapper path below remains as the contract-v1 fallback.

**Auto-managed (built in, no commands)**: after `dsh web` starts, whenever the primary or fallback provider is a loopback custom provider (e.g. `crawl4ai` → `http://127.0.0.1:8787`), the plugin automatically starts the wrapper process and best-effort ensures the Crawl4AI container is running. Requirements: **Docker Desktop is running** (set it to start on login) and the image is pulled.

Manual fallback / first image pull:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-crawl4ai.ps1
```

Register in the card: **Custom providers** → name `crawl4ai` / type `custom (contract v1)` / endpoint `http://127.0.0.1:8787` → save → select it in the "Default provider" dropdown.

> Contract v1 spec: [docs/contract.md](docs/contract.md); selection and verification: [docs/custom-crawler-research.md](docs/custom-crawler-research.md).

### Verification scripts

```powershell
node scripts/verify-tavily.mjs            # requires TAVILY_API_KEY
node scripts/verify-jina.mjs              # anonymous OK; pass a key as argv or set JINA_API_KEY
node scripts/verify-firecrawl.mjs         # requires FIRECRAWL_API_KEY
```

## Development and building

```bash
git clone https://github.com/tallahandsome-ux/dsh-fetch-third-party.git
cd dsh-fetch-search
pnpm install        # build tools + type deps (@deepseek-ai/* declared as peer/dev, from npm)
pnpm build          # tsdown dual output → lib/index.js (Host) + lib/client.js (browser card)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest (settings / budget / adapters / searxng / search-provider; the live SearXNG suite is env-gated and skipped in CI)
```

- **Runtime**: `@deepseek-ai/*` is provided by the dsh host (resolved from the profile node_modules after install); the build keeps them external, and the only real runtime dependency of the plugin is `undici`.
- **Local dev**: after changing `src/`, run `pnpm build` to rebuild `lib/`, then restart `dsh web`.

## Project boundaries and third-party attribution

### Original to this plugin (MIT)

- `dsh-fetch-search` itself: fetch/search provider registration, primary+fallback routing, per-session budget, settings bridge, GUI card, contract-v1 custom adapter, local-stack auto management (`local-stack` + watchdog), SearXNG search adapter
- **Fetch contract v1**: the integration standard for custom fetch services (see [docs/contract.md](docs/contract.md))

### Third-party projects used

| Project | Purpose | License |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (@deepseek-ai/dsh-*) | Host platform: cordis plugin system, settings / credentials / tools / web services | MIT |
| [undici](https://github.com/nodejs/undici) | Node HTTP client (per-request proxy) | MIT |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Optional: self-hosted fetch stack (deployed by the user via Docker, integrated through a contract-v1 wrapper) | Apache-2.0 |
| [SearXNG](https://github.com/searxng/searxng) | Optional: self-hosted search instance (deployed by the user via Docker; the plugin only calls its JSON API, never bundles it) | AGPL-3.0 |
| [Jina Reader](https://github.com/jina-ai/reader) | Jina provider (public API or self-hosted) | Apache-2.0 |
| Tavily / Firecrawl | Third-party SaaS fetch services (the plugin only calls their public APIs, never bundles them) | their service terms |
| react / tsdown / typescript / vitest | build and test toolchain | MIT-family |

### Boundaries

- **The plugin never bundles or embeds any third-party crawler engine.** Crawl4AI, Jina Reader, etc. are deployed by the user on demand; the plugin integrates them via contract v1 or by reusing a built-in adapter, and the target URL is fetched only by the configured third-party service.
- **API keys live only in the managed credentials store** — never in code / config / docs; the plugin reads them per request and the card never echoes them.
- **Keys are independent of the install method**: however you install (git / local / npm), the plugin only reads keys from the local credentials store (`%USERPROFILE%\.dsh\.credentials.yaml`, 0600) by reference name — the repo, code, and docs contain no secrets, and cloning from GitHub carries or leaks nothing.
- The **only outbound surface of the local machine** is the configured third-party endpoints and the self-hosted search instance (the cost of the courier model; the trust boundary is yours to choose).
- Self-hosted Crawl4AI has its own SSRF protection, complementing the "never connect directly" safety premise of this plugin.

## License

MIT License — see [LICENSE](LICENSE)
