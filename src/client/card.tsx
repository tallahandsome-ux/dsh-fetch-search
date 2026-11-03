/**
 * The web-fetch configuration card (browser half).
 *
 * Data layer: configuration values and writes ride the Plugins page's
 * configuration form (host-owned settings Remote, hot-applied); the API key
 * rides the credentials Remote; only the connectivity test and the live
 * fallback-chain view talk to the plugin's own runtime-state bridge
 * (`/api/fetch-third-party/{test,chain}`).
 *
 * Layout: header (collapse) → level 1 (provider + proxy + test) → level 2
 * (endpoint + cap + API key + fallback) → custom providers editor.
 * @module dsh-fetch-search/client/card
 */

import { useEffect, useState } from 'react'
// Type-only: the Plugins page's SlotMap merge ('plugins.bundle.config', for PropsRuntime).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the settings shell's SlotMap merge ('settings.section', for PropsRuntime).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FetchCardFace, FetchCardState, SectionValues } from './card-controller.ts'

/** One row of the live fallback chain. */
interface ChainRow {
  name: string
  inCooldown: boolean
  remainingSec: number
}

/** Result of the connection test. */
interface TestResult {
  ok: boolean
  servedBy: string
  statusCode?: number
  contentLength?: number
  durationMs: number
  error?: string
}

/** Result of the search test (`/search-test`). */
interface SearchTestResult {
  ok: boolean
  servedBy: string
  count: number
  top: { title?: string; url: string }[]
  durationMs: number
  error?: string
}

/** The card's editable mirror of the section values plus the key's credential state. */
interface CardView extends SectionValues {
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
}

/** Props bound by the Plugins page's bundle-configuration seat. */
export type FetchCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'fetch-third-party'>
  & InjectFace<FetchCardFace>

/** Props bound by the settings shell for this plugin's Settings section page. */
export type FetchSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'fetch-third-party'>
  & InjectFace<FetchCardFace>

/** The shared body: locale copy, the controller face, and the initial fold. */
type FetchSurfaceProps = PropsLocale<'fetch-third-party'> & InjectFace<FetchCardFace> & {
  /** Start expanded (the Settings section page) instead of collapsed (the bundle seat). */
  defaultOpen?: boolean
}

const TEST_URL = '/api/fetch-third-party/test'
const CHAIN_URL = '/api/fetch-third-party/chain'
const SEARCH_TEST_URL = '/api/fetch-third-party/search-test'

/** Search adapters this build ships (one today). */
const SEARCH_ADAPTER_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'searxng', label: 'SearXNG（自建）' },
]

/** The built-in service-provider options (custom names are appended). */
const ADAPTER_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'tavily', label: 'Tavily' },
  { id: 'jina', label: 'Jina Reader' },
  { id: 'firecrawl', label: 'Firecrawl' },
]

/** The adapter choices a custom provider row may pick. */
const CUSTOM_ADAPTER_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'custom', label: 'custom（契约 v1）' },
  { id: 'crawl4ai', label: 'crawl4ai（自建容器）' },
  { id: 'jina', label: 'jina（复用）' },
  { id: 'tavily', label: 'tavily（复用）' },
  { id: 'firecrawl', label: 'firecrawl（复用）' },
]

/**
 * Split a fallback-chain input into provider names. Accepts ASCII and full-width
 * commas (，)、顿号（、）and semicolons（；）so CJK IME input can't silently break the chain.
 */
function splitChainInput(value: string): string[] {
  return value.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
}

/** Standard credential reference each built-in adapter defaults to (card-side mirror). */
const KEY_ENV_BY_ADAPTER: Record<string, string> = {
  tavily: 'TAVILY_API_KEY',
  jina: 'JINA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}

/** Standard credential reference for a self-hosted Crawl4AI custom entry. */
const CRAWL4AI_API_KEY_ENV = 'CRAWL4AI_API_KEY'

/** Default endpoint of a self-hosted Crawl4AI Docker API server. */
const CRAWL4AI_DEFAULT_BASE_URL = 'http://127.0.0.1:11235'

/** Standard endpoint each built-in adapter defaults to (card-side mirror). */
const BASE_URL_BY_ADAPTER: Record<string, string> = {
  tavily: 'https://api.tavily.com',
  jina: 'https://r.jina.ai',
  firecrawl: 'https://api.firecrawl.dev',
}

/** Fold the controller snapshot into the card's editable view. */
function viewOf(state: FetchCardState): CardView {
  return {
    ...state.values,
    apiKeyConfigured: state.apiKeyConfigured,
    apiKeyWritable: state.apiKeyWritable,
  }
}

/** Render the fetch configuration card on the bundle's Plugins-page seat (collapsed by default). */
export function FetchCard(props: FetchCardProps) {
  return <FetchSurface {...props} />
}

/** Render the fetch configuration page inside Settings → dsh-fetch-search (expanded by default). */
export function FetchSettingsSection(props: FetchSettingsSectionProps) {
  return <FetchSurface {...props} defaultOpen />
}

/** Render the fetch configuration surface. */
function FetchSurface(props: FetchSurfaceProps) {
  const { t } = props
  const state = props.useFetchCard(snapshot => snapshot)
  const [view, setView] = useState<CardView | null>(() => state.status === 'ready' ? viewOf(state) : null)
  const [keyInput, setKeyInput] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  // Collapsed on the Plugins-page bundle seat (a rarely-used advanced
  // section users expand on demand); expanded on the Settings page (the user
  // navigated here on purpose). Level 2 stays expanded so one click reveals
  // the primary provider + endpoint + cap + key + fallback controls together.
  const [open, setOpen] = useState(props.defaultOpen === true)
  const [l2Open, setL2Open] = useState(true)
  const [testUrl, setTestUrl] = useState('https://example.com')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [customsOpen, setCustomsOpen] = useState(false)
  const [customs, setCustoms] = useState(state.values.customProviders)
  const [chainRows, setChainRows] = useState<ChainRow[]>([])
  const [searchOpen, setSearchOpen] = useState(true)
  const [searchQuery, setSearchQuery] = useState('searxng test')
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchTestResult | null>(null)

  // The Host form pushes authoritative values after every write (and after
  // edits made on other surfaces); re-mirror them into the local editable
  // view. In-flight local edits are re-applied on blur, so this reset cannot
  // lose typed input — it shows the same characters the write carried.
  useEffect(() => {
    if (state.status !== 'ready') return
    setView(viewOf(state))
    setCustoms(state.values.customProviders)
  }, [state])

  // The effective credential reference shown under the key control.
  const apiKeyEnv = state.status === 'ready' ? state.apiKeyEnv : ''

  const loadChain = async (): Promise<void> => {
    try {
      const res = await fetch(CHAIN_URL)
      if (res.ok) {
        const body = await res.json() as { chain: ChainRow[] }
        setChainRows(body.chain ?? [])
      }
    } catch {
      // keep the last known chain
    }
  }

  useEffect(() => { void loadChain() }, [])

  const saveField = async (field: keyof SectionValues, value: SectionValues[keyof SectionValues]): Promise<void> => {
    setSaving(true)
    setMessage('')
    const ok = await props.saveField(field, value)
    setMessage(ok ? t('saveSuccess') : t('saveFailed'))
    setSaving(false)
  }

  const saveKey = async (value: string): Promise<void> => {
    setSaving(true)
    setMessage('')
    try {
      await props.writeKey(value)
      setKeyInput('')
      setMessage(t('saveSuccess'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setSaving(true)
    setMessage('')
    try {
      await props.clearKey()
      setKeyInput('')
      setMessage(t('saveSuccess'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(TEST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: testUrl }),
      })
      if (res.ok) {
        setTestResult(await res.json() as TestResult)
      } else {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setTestResult({ ok: false, servedBy: '', durationMs: 0, error: body?.error ?? res.status.toString() })
      }
    } catch (error) {
      setTestResult({ ok: false, servedBy: '', durationMs: 0, error: String(error) })
    } finally {
      setTesting(false)
    }
  }

  const runSearchTest = async (): Promise<void> => {
    setSearching(true)
    setSearchResult(null)
    try {
      const res = await fetch(SEARCH_TEST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      })
      if (res.ok) {
        setSearchResult(await res.json() as SearchTestResult)
      } else {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setSearchResult({ ok: false, servedBy: '', count: 0, top: [], durationMs: 0, error: body?.error ?? res.status.toString() })
      }
    } catch (error) {
      setSearchResult({ ok: false, servedBy: '', count: 0, top: [], durationMs: 0, error: String(error) })
    } finally {
      setSearching(false)
    }
  }

  const saveCustoms = async (): Promise<void> => {
    setSaving(true)
    setMessage('')
    try {
      const ok = await props.saveCustoms(customs)
      setMessage(ok ? t('saveSuccess') : t('saveFailed'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (state.status === 'unavailable') {
    return <p style={{ padding: '12px 16px', color: '#888' }}>{t('unavailable')}</p>
  }
  if (view === null) {
    return <p style={{ padding: '12px 16px', color: '#888' }}>{t('loading')}</p>
  }

  const disabled = !state.writable || saving

  const updateCustom = (index: number, patch: Partial<typeof customs[number]>): void => {
    setCustoms(prev => prev.map((entry, i) => i === index ? { ...entry, ...patch } : entry))
  }

  const addCustom = (): void => {
    setCustoms(prev => [
      ...prev,
      { name: `custom-${prev.length + 1}`, adapter: 'custom', baseURL: '', apiKeyEnv: '' },
    ])
  }

  const removeCustom = (index: number): void => {
    setCustoms(prev => prev.filter((_, i) => i !== index))
  }

  const providerOptions = [
    ...ADAPTER_OPTIONS,
    ...view.customProviders.map(entry => ({ id: entry.name, label: entry.name })),
  ]

  /** Whether the primary provider is a user-registered custom one (vs a built-in id). */
  const isCustomPrimary = !ADAPTER_OPTIONS.some(option => option.id === view.adapter)

  /** The custom entry backing the primary (when isCustomPrimary), for endpoint edits. */
  const customEntry = view.customProviders.find(entry => entry.name === view.adapter)

  /** The endpoint shown in the 接口地址 field: the effective one (empty flat = stock default). */
  const displayBaseURL = isCustomPrimary
    ? (customEntry?.baseURL ?? '')
    : (view.baseURL.length > 0 ? view.baseURL : BASE_URL_BY_ADAPTER[view.adapter] ?? '')

  /** Save the 接口地址 field: custom primaries update their own entry, built-ins the flat baseURL. */
  const saveBaseURL = async (value: string): Promise<void> => {
    if (!isCustomPrimary) return saveField('baseURL', value)
    const entry = view.customProviders.find(provider => provider.name === view.adapter)
    if (entry === undefined) return
    setSaving(true)
    setMessage('')
    try {
      const next = customs.map(provider => provider.name === entry.name ? { ...provider, baseURL: value } : provider)
      setCustoms(next)
      const ok = await props.saveCustoms(next)
      setMessage(ok ? t('saveSuccess') : t('saveFailed'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const styles = {
    wrap: { padding: '12px 16px', display: 'grid', gap: '10px', maxWidth: 560 } as const,
    header: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0,
      border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
    } as const,
    title: { margin: 0, fontSize: 15, fontWeight: 600, flex: 1 } as const,
    chevron: { fontSize: 11, color: '#888' } as const,
    keyBadge: { fontSize: 12, padding: '2px 8px', borderRadius: 10, color: '#fff' } as const,
    desc: { margin: 0, fontSize: 13, color: '#888' } as const,
    section: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0,
      border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
      borderTop: '1px solid #eee', paddingTop: 10,
    } as const,
    sectionLabel: { margin: 0, fontSize: 12, fontWeight: 600, color: '#444', flex: 1 } as const,
    sectionBody: { display: 'grid', gap: '10px' } as const,
    field: { display: 'grid', gap: 4 } as const,
    label: { fontSize: 12, color: '#666' } as const,
    hint: { margin: 0, fontSize: 11, color: '#999' } as const,
    input: { padding: '6px 8px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 } as const,
    button: { padding: '6px 14px', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', background: '#4f6ef7', color: '#fff' } as const,
    buttonGhost: { padding: '4px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 12, cursor: 'pointer', background: '#fff', color: '#555' } as const,
    row: { display: 'grid', gap: 6, padding: 8, border: '1px solid #eee', borderRadius: 8 } as const,
    rowHeader: { display: 'flex', alignItems: 'center', gap: 8 } as const,
    inline: { flex: 1 } as const,
    msg: { margin: 0, fontSize: 12, color: '#888' } as const,
    testOk: { margin: 0, fontSize: 12, color: '#2e9e5b' } as const,
    testFail: { margin: 0, fontSize: 12, color: '#c0392b' } as const,
    warn: { margin: 0, fontSize: 11, color: '#b58900' } as const,
    info: { margin: 0, fontSize: 11, color: '#888', lineHeight: 1.5 } as const,
  }

  return (
    <div style={styles.wrap}>
      <button style={styles.header} onClick={() => setOpen(prev => !prev)} aria-expanded={open}>
        <h3 style={styles.title}>{t('title')}</h3>
        <span
          style={{
            ...styles.keyBadge,
            background: view.apiKeyConfigured ? '#2e9e5b' : '#b0b0b0',
          }}
        >
          {view.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
        </span>
        <span style={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          <p style={styles.desc}>{t('description')}</p>

          {/* ── 第一级：服务商 + 代理 + 测试 ── */}
          <button style={styles.section} aria-expanded="true">
            <span style={styles.sectionLabel}>{t('level1')}</span>
          </button>
          <div style={styles.sectionBody}>
            <label style={styles.field}>
              <span style={styles.label}>{t('defaultProvider')}</span>
              <select
                style={styles.input}
                value={view.adapter}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.value
                  void saveField('adapter', next)
                  // Built-ins auto-align key ref + endpoint; custom names
                  // carry their own from the custom table.
                  const keyEnv = KEY_ENV_BY_ADAPTER[next]
                  if (keyEnv !== undefined && view.apiKeyEnv !== keyEnv && !isCustomName(next, view.customProviders)) {
                    void saveField('apiKeyEnv', keyEnv)
                  }
                  // Align the flat endpoint to the new built-in's default when the
                  // current value is auto-managed (empty / a stock default) — this also
                  // covers custom→built-in, where the flat field still holds a stale
                  // default from the previous built-in.
                  const nextDefault = BASE_URL_BY_ADAPTER[next]
                  if (nextDefault !== undefined) {
                    const wasCustom = !ADAPTER_OPTIONS.some(option => option.id === view.adapter)
                    const stockDefaults = Object.values(BASE_URL_BY_ADAPTER)
                    if (wasCustom || view.baseURL.length === 0 || stockDefaults.includes(view.baseURL)) {
                      void saveField('baseURL', nextDefault)
                    }
                  }
                }}
              >
                {providerOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <p style={styles.hint}>{t('adapterHint')}</p>
            </label>

            <label style={styles.field}>
              <span style={styles.label}>{t('proxy')}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  style={{ ...styles.input, flex: 1 }}
                  value={view.proxy}
                  disabled={disabled || !view.proxyEnabled}
                  placeholder="http://127.0.0.1:27822"
                  onChange={(event) => setView(prev => prev ? { ...prev, proxy: event.target.value } : prev)}
                  onBlur={(event) => void saveField('proxy', event.target.value)}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#555', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={view.proxyEnabled}
                    disabled={disabled}
                    onChange={(event) => void saveField('proxyEnabled', event.target.checked)}
                  />
                  {t('proxyEnable')}
                </label>
              </div>
              <p style={styles.hint}>
                {view.proxyEnabled ? t('proxyHint') : t('proxyOffHint')}
              </p>
            </label>

            {/* 测试连接 */}
            <div style={styles.field}>
              <span style={styles.label}>{t('testUrl')}</span>
              <input
                style={styles.input}
                value={testUrl}
                disabled={testing}
                onChange={(event) => setTestUrl(event.target.value)}
              />
              <button
                style={styles.button}
                disabled={disabled || testing}
                onClick={() => void runTest()}
              >
                {testing ? t('testing') : t('testRun')}
              </button>
              <p style={styles.warn}>{t('testQuotaWarn')}</p>
              {testResult !== null && (
                testResult.ok
                  ? (
                    <p style={styles.testOk}>
                      {t('testOk')} · {testResult.servedBy} · {testResult.durationMs}ms · {testResult.contentLength} chars
                    </p>
                  )
                  : (
                    <p style={styles.testFail}>
                      {t('testFail')}：{testResult.error ?? `HTTP ${testResult.statusCode}`}
                    </p>
                  )
              )}
            </div>
          </div>

          {/* ── 第二级：接口地址 + 上限 + API Key + 兜底 ── */}
          <button style={styles.section} onClick={() => setL2Open(prev => !prev)} aria-expanded={l2Open}>
            <span style={styles.sectionLabel}>{t('level2')}</span>
            <span style={styles.chevron}>{l2Open ? '▾' : '▸'}</span>
          </button>
          {l2Open && (
            <div style={styles.sectionBody}>
              <label style={styles.field}>
                <span style={styles.label}>{t('baseUrl')}</span>
                <input
                  style={styles.input}
                  value={displayBaseURL}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.target.value
                    if (isCustomPrimary) {
                      setView(prev => prev ? {
                        ...prev,
                        customProviders: prev.customProviders.map(provider =>
                          provider.name === view.adapter ? { ...provider, baseURL: value } : provider),
                      } : prev)
                    } else {
                      setView(prev => prev ? { ...prev, baseURL: value } : prev)
                    }
                  }}
                  onBlur={(event) => void saveBaseURL(event.target.value)}
                />
                <p style={styles.hint}>{isCustomPrimary ? t('customEndpointHint') : t('baseUrlHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('maxFetches')}</span>
                <input
                  style={styles.input}
                  type="number"
                  min={1}
                  value={view.maxFetchesPerSession}
                  disabled={disabled}
                  onChange={(event) => setView(prev => prev ? { ...prev, maxFetchesPerSession: Number(event.target.value) } : prev)}
                  onBlur={(event) => void saveField('maxFetchesPerSession', Number(event.target.value))}
                />
                <p style={styles.hint}>{t('maxFetchesHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('maxContent')}</span>
                <input
                  style={styles.input}
                  type="number"
                  min={0}
                  value={view.maxContentChars}
                  disabled={disabled}
                  onChange={(event) => setView(prev => prev ? { ...prev, maxContentChars: Number(event.target.value) } : prev)}
                  onBlur={(event) => void saveField('maxContentChars', Number(event.target.value))}
                />
                <p style={styles.hint}>{t('maxContentHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('cacheSection')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#555', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={view.cacheEnabled}
                      disabled={disabled}
                      onChange={(event) => void saveField('cacheEnabled', event.target.checked)}
                    />
                    {t('cacheEnable')}
                  </label>
                  <input
                    style={{ ...styles.input, width: 90 }}
                    type="number"
                    min={0}
                    value={view.cacheTtlSeconds}
                    disabled={disabled || !view.cacheEnabled}
                    onChange={(event) => setView(prev => prev ? { ...prev, cacheTtlSeconds: Number(event.target.value) } : prev)}
                    onBlur={(event) => void saveField('cacheTtlSeconds', Number(event.target.value))}
                  />
                  <span style={{ fontSize: 12, color: '#666' }}>{t('cacheSeconds')}</span>
                </div>
                <p style={styles.hint}>{t('cacheHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('rejectPrivate')}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#555' }}>
                  <input
                    type="checkbox"
                    checked={view.rejectPrivateTargets}
                    disabled={disabled}
                    onChange={(event) => void saveField('rejectPrivateTargets', event.target.checked)}
                  />
                  {t('rejectPrivateEnable')}
                </label>
                <p style={styles.hint}>{t('rejectPrivateHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('chainSection')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#555', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={view.cooldownEnabled}
                      disabled={disabled}
                      onChange={(event) => { void saveField('cooldownEnabled', event.target.checked); void loadChain() }}
                    />
                    {t('chainCooldown')}
                  </label>
                  <input
                    style={{ ...styles.input, width: 90 }}
                    type="number"
                    min={0}
                    value={view.quotaCooldownSeconds}
                    disabled={disabled || !view.cooldownEnabled}
                    onChange={(event) => setView(prev => prev ? { ...prev, quotaCooldownSeconds: Number(event.target.value) } : prev)}
                    onBlur={(event) => { void saveField('quotaCooldownSeconds', Number(event.target.value)); void loadChain() }}
                  />
                  <span style={{ fontSize: 12, color: '#666' }}>{t('chainQuotaSeconds')}</span>
                </div>
                <input
                  style={styles.input}
                  value={(view.fallbackChain ?? []).join(',')}
                  placeholder="crawl4ai, web-tools, tavily, ...（逗号分隔，全角逗号也行）"
                  disabled={disabled}
                  onChange={(event) => setView(prev => prev ? { ...prev, fallbackChain: splitChainInput(event.target.value) } : prev)}
                  onBlur={(event) => { void saveField('fallbackChain', splitChainInput(event.target.value)); void loadChain() }}
                />
                <p style={styles.hint}>{t('chainHint')}</p>
                {chainRows.length > 0 && (
                  <div style={{ fontSize: 12, color: '#666', lineHeight: 1.6 }}>
                    {chainRows.map(row => (
                      <div key={row.name}>{row.inCooldown ? `${row.name}（冷却中 ${row.remainingSec}s）` : row.name}</div>
                    ))}
                  </div>
                )}
              </label>
              <label style={styles.field}>
                <span style={styles.label}>{t('apiKey')}</span>
                <input
                  style={styles.input}
                  type="password"
                  value={keyInput}
                  disabled={!view.apiKeyWritable || saving}
                  placeholder={view.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset')}
                  onChange={(event) => setKeyInput(event.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    style={styles.button}
                    disabled={!view.apiKeyWritable || saving || keyInput.length === 0}
                    onClick={() => void saveKey(keyInput)}
                  >
                    {t('save')}
                  </button>
                  {view.apiKeyConfigured && (
                    <button
                      style={styles.buttonGhost}
                      disabled={!view.apiKeyWritable || saving}
                      onClick={() => void clearKey()}
                    >
                      {t('clear')}
                    </button>
                  )}
                </div>
                <p style={styles.hint}>
                  {t('keyRefHint')} {apiKeyEnv} · {t('apiKeyHint')}
                </p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('fallbackProvider')}</span>
                <select
                  style={styles.input}
                  value={view.fallback}
                  disabled={disabled}
                  onChange={(event) => void saveField('fallback', event.target.value)}
                >
                  <option value="">{t('fallbackNone')}</option>
                  {providerOptions.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <p style={styles.hint}>{t('fallbackSuffix')}</p>
              </label>
            </div>
          )}

          {/* ── 自定义服务商 ── */}
          <button style={styles.section} onClick={() => setCustomsOpen(prev => !prev)} aria-expanded={customsOpen}>
            <span style={styles.sectionLabel}>{t('customSection')}</span>
            <span style={styles.chevron}>{customsOpen ? '▾' : '▸'}</span>
          </button>
          {customsOpen && (
            <div style={styles.sectionBody}>
              <p style={styles.info}>{t('customConditions')}</p>

              {customs.map((entry, index) => (
                <div key={index} style={styles.row}>
                  <div style={styles.rowHeader}>
                    <span style={{ ...styles.label, width: 44 }}>{t('customName')}</span>
                    <input
                      style={{ ...styles.input, ...styles.inline }}
                      value={entry.name}
                      disabled={disabled}
                      onChange={(event) => updateCustom(index, { name: event.target.value })}
                    />
                    <button style={styles.buttonGhost} disabled={disabled} onClick={() => removeCustom(index)}>
                      {t('customDelete')}
                    </button>
                  </div>
                  <div style={styles.rowHeader}>
                    <span style={{ ...styles.label, width: 44 }}>{t('customType')}</span>
                    <select
                      style={{ ...styles.input, ...styles.inline }}
                      value={entry.adapter}
                      disabled={disabled}
                      onChange={(event) => {
                        const adapter = event.target.value
                        // A fresh crawl4ai row starts from the Docker API
                        // server's default published port; anything else keeps
                        // the user's endpoint as typed.
                        updateCustom(index, adapter === 'crawl4ai' && entry.baseURL.length === 0
                          ? { adapter, baseURL: CRAWL4AI_DEFAULT_BASE_URL }
                          : { adapter })
                      }}
                    >
                      {CUSTOM_ADAPTER_OPTIONS.map(option => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div style={styles.rowHeader}>
                    <span style={{ ...styles.label, width: 44 }}>{t('baseUrl')}</span>
                    <input
                      style={{ ...styles.input, ...styles.inline }}
                      value={entry.baseURL}
                      disabled={disabled}
                      placeholder="http://127.0.0.1:8787"
                      onChange={(event) => updateCustom(index, { baseURL: event.target.value })}
                    />
                  </div>
                  <div style={styles.rowHeader}>
                    <span style={{ ...styles.label, width: 44 }}>{t('customKeyRef')}</span>
                    <input
                      style={{ ...styles.input, ...styles.inline }}
                      value={entry.apiKeyEnv}
                      disabled={disabled}
                      placeholder="MY_N8N_KEY（留空=该适配器默认）"
                      onChange={(event) => updateCustom(index, { apiKeyEnv: event.target.value })}
                    />
                  </div>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8 }}>
                <button style={styles.buttonGhost} disabled={disabled} onClick={addCustom}>
                  {t('customAdd')}
                </button>
                <button style={styles.button} disabled={disabled} onClick={() => void saveCustoms()}>
                  {t('customSave')}
                </button>
              </div>
            </div>
          )}

          {/* ── 搜索（SearXNG） ── */}
          <button style={styles.section} onClick={() => setSearchOpen(prev => !prev)} aria-expanded={searchOpen}>
            <span style={styles.sectionLabel}>{t('searchSection')}</span>
            <span style={styles.chevron}>{searchOpen ? '▾' : '▸'}</span>
          </button>
          {searchOpen && (
            <div style={styles.sectionBody}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={view.searchEnabled}
                  disabled={disabled}
                  onChange={(event) => void saveField('searchEnabled', event.target.checked)}
                />
                <span style={styles.label}>{t('searchEnable')}</span>
              </div>
              <p style={styles.hint}>{t('searchEnableHint')}</p>
              <p style={styles.warn}>{t('searchPinHint')}</p>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchAdapter')}</span>
                <select
                  style={styles.input}
                  value={view.searchAdapter}
                  disabled={disabled}
                  onChange={(event) => void saveField('searchAdapter', event.target.value)}
                >
                  {SEARCH_ADAPTER_OPTIONS.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchBaseUrl')}</span>
                <input
                  style={styles.input}
                  value={view.searchBaseURL}
                  disabled={disabled}
                  placeholder="http://127.0.0.1:8888"
                  onChange={(event) => setView(prev => prev ? { ...prev, searchBaseURL: event.target.value } : prev)}
                  onBlur={(event) => void saveField('searchBaseURL', event.target.value)}
                />
                <p style={styles.hint}>{t('searchBaseUrlHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchLanguage')}</span>
                <input
                  style={styles.input}
                  value={view.searchLanguage}
                  disabled={disabled}
                  placeholder="zh-CN"
                  onChange={(event) => setView(prev => prev ? { ...prev, searchLanguage: event.target.value } : prev)}
                  onBlur={(event) => void saveField('searchLanguage', event.target.value)}
                />
                <p style={styles.hint}>{t('searchLanguageHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchCategories')}</span>
                <input
                  style={styles.input}
                  value={view.searchCategories}
                  disabled={disabled}
                  placeholder="general"
                  onChange={(event) => setView(prev => prev ? { ...prev, searchCategories: event.target.value } : prev)}
                  onBlur={(event) => void saveField('searchCategories', event.target.value)}
                />
                <p style={styles.hint}>{t('searchCategoriesHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchSafesearch')}</span>
                <input
                  style={styles.input}
                  type="number"
                  min={0}
                  max={2}
                  value={view.searchSafesearch}
                  disabled={disabled}
                  onBlur={(event) => void saveField('searchSafesearch', Number(event.target.value))}
                />
                <p style={styles.hint}>{t('searchSafesearchHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchTimeout')}</span>
                <input
                  style={styles.input}
                  type="number"
                  min={1}
                  value={view.searchTimeoutSeconds}
                  disabled={disabled}
                  onBlur={(event) => void saveField('searchTimeoutSeconds', Number(event.target.value))}
                />
                <p style={styles.hint}>{t('searchTimeoutHint')}</p>
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchMaxResults')}</span>
                <input
                  style={styles.input}
                  type="number"
                  min={1}
                  value={view.searchMaxResults}
                  disabled={disabled}
                  onBlur={(event) => void saveField('searchMaxResults', Number(event.target.value))}
                />
              </label>

              <label style={styles.field}>
                <span style={styles.label}>{t('searchKeyRef')}</span>
                <input
                  style={styles.input}
                  value={view.searchApiKeyEnv}
                  disabled={disabled}
                  placeholder="SEARXNG_AUTH_KEY（留空=匿名）"
                  onChange={(event) => setView(prev => prev ? { ...prev, searchApiKeyEnv: event.target.value } : prev)}
                  onBlur={(event) => void saveField('searchApiKeyEnv', event.target.value)}
                />
              </label>

              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ ...styles.field, flex: 1 }}>
                  <span style={styles.label}>{t('searchAuthHeader')}</span>
                  <input
                    style={styles.input}
                    value={view.searchAuthHeader}
                    disabled={disabled}
                    onChange={(event) => setView(prev => prev ? { ...prev, searchAuthHeader: event.target.value } : prev)}
                    onBlur={(event) => void saveField('searchAuthHeader', event.target.value)}
                  />
                </label>
                <label style={{ ...styles.field, flex: 1 }}>
                  <span style={styles.label}>{t('searchAuthPrefix')}</span>
                  <input
                    style={styles.input}
                    value={view.searchAuthPrefix}
                    disabled={disabled}
                    onChange={(event) => setView(prev => prev ? { ...prev, searchAuthPrefix: event.target.value } : prev)}
                    onBlur={(event) => void saveField('searchAuthPrefix', event.target.value)}
                  />
                </label>
              </div>
              <p style={styles.hint}>{t('searchAuthHint')}</p>

              {/* 测试搜索 */}
              <div style={styles.field}>
                <span style={styles.label}>{t('searchTestQuery')}</span>
                <input
                  style={styles.input}
                  value={searchQuery}
                  disabled={searching}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <button
                  style={styles.button}
                  disabled={disabled || searching}
                  onClick={() => void runSearchTest()}
                >
                  {searching ? t('searchTesting') : t('searchTestRun')}
                </button>
                <p style={styles.hint}>{t('searchTestHint')}</p>
                {searchResult !== null && (
                  <div style={{ fontSize: 12, lineHeight: 1.7, color: searchResult.ok ? '#1a7f37' : '#b42318' }}>
                    <div>
                      {searchResult.ok
                        ? `${t('searchResultOk')} ${searchResult.servedBy} · ${searchResult.count} · ${searchResult.durationMs}ms`
                        : `${t('searchResultFail')} · ${searchResult.durationMs}ms`}
                    </div>
                    {searchResult.error !== undefined && <div>{searchResult.error}</div>}
                    {searchResult.top.map(source => (
                      <div key={source.url} style={{ color: '#444' }}>
                        · {source.title ?? source.url}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {message !== '' && <p style={styles.msg}>{message}</p>}
        </>
      )}
    </div>
  )
}

/** Whether a provider name names one of the user's custom entries. */
function isCustomName(name: string, customs: ReadonlyArray<{ name: string }>): boolean {
  return customs.some(entry => entry.name === name)
}
