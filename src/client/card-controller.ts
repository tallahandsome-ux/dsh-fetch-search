/**
 * The fetch card's controller: bridges the Plugins page's configuration form
 * (configForms over the settings Remote) and the credentials Remote onto the
 * card, mirroring the official ui-settings-web-search page's controller.
 *
 * Configuration values and writes ride the form (host-owned, revision-fenced,
 * hot-applied through volatile HMR); the API key — never a settings field —
 * rides `remote.credentials` (describe/set/unset), refreshed on the
 * `credentials/reference-updated` event so a key written on another surface
 * (env, CLI) is reflected here too.
 *
 * Types of host-side shapes are spelled here rather than imported: a client
 * package must not depend on a host package.
 * @module dsh-fetch-search/client/card-controller
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Loader row id this plugin's patch declares (its settings namespace). */
export const ENTRY_ID = 'web-fetch-search'

/** One user-registered custom provider (client-side mirror of the host type). */
export interface CustomProvider {
  name: string
  adapter: string
  baseURL: string
  apiKeyEnv: string
}

/** The section's client-side mirror (defaults per the host schema). */
export interface SectionValues {
  adapter: string
  fallback: string
  baseURL: string
  apiKeyEnv: string
  maxFetchesPerSession: number
  proxy: string
  proxyEnabled: boolean
  customProviders: CustomProvider[]
  maxContentChars: number
  cacheEnabled: boolean
  cacheTtlSeconds: number
  cacheMaxEntries: number
  rejectPrivateTargets: boolean
  toolName: string
  fallbackChain: string[]
  cooldownEnabled: boolean
  quotaCooldownSeconds: number
  failureCooldownSeconds: number
  /** Search half (2.0): register this plugin's provider into the search registry. */
  searchEnabled: boolean
  searchAdapter: string
  searchBaseURL: string
  searchFallback: string
  searchApiKeyEnv: string
  searchAuthHeader: string
  searchAuthPrefix: string
  searchLanguage: string
  searchCategories: string
  searchSafesearch: number
  searchTimeoutSeconds: number
  searchMaxResults: number
  /** Managed SearXNG Docker container (one-click deployment). */
  searxngManaged: boolean
  searxngPort: number
}

/** Standard credential reference each built-in adapter defaults to. */
const KEY_ENV_BY_ADAPTER: Record<string, string> = {
  tavily: 'TAVILY_API_KEY',
  jina: 'JINA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}

/** Standard credential reference for a self-hosted Crawl4AI custom entry. */
const CRAWL4AI_API_KEY_ENV = 'CRAWL4AI_API_KEY'

/** The section values shown before the form's first answer arrives. */
const DEFAULT_VALUES: SectionValues = {
  adapter: 'firecrawl',
  fallback: '',
  baseURL: '',
  apiKeyEnv: '',
  maxFetchesPerSession: 10,
  proxy: '',
  proxyEnabled: true,
  customProviders: [],
  maxContentChars: 100_000,
  cacheEnabled: true,
  cacheTtlSeconds: 600,
  cacheMaxEntries: 200,
  rejectPrivateTargets: true,
  toolName: 'web_fetch_url',
  fallbackChain: [],
  cooldownEnabled: true,
  quotaCooldownSeconds: 3600,
  failureCooldownSeconds: 60,
  searchEnabled: false,
  searchAdapter: 'searxng',
  searchBaseURL: 'http://127.0.0.1:8888',
  searchFallback: '',
  searchApiKeyEnv: '',
  searchAuthHeader: 'Authorization',
  searchAuthPrefix: 'Bearer ',
  searchLanguage: '',
  searchCategories: '',
  searchSafesearch: 0,
  searchTimeoutSeconds: 20,
  searchMaxResults: 10,
  searxngManaged: false,
  searxngPort: 8888,
}

/** What the fetch card renders. */
export interface FetchCardState {
  /** 'loading' until the settings mirror answers; 'unavailable' when the Host serves no form. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the form accepts writes (false on a read-only profile document). */
  writable: boolean
  /** The section's current values (optimistic between a write and its answer). */
  values: SectionValues
  /** The credential reference the PRIMARY provider resolves to; empty = anonymous. */
  apiKeyEnv: string
  /** Whether any layer supplies a value for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether `credentials/set` can affect the reference; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the card's slot entry injects. */
export interface FetchCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useFetchCard. */
    fetchCard: FetchCardController
  }
  /** Optimistically apply one field edit and submit it to the Host form. */
  saveField: (field: keyof SectionValues, value: SectionValues[keyof SectionValues]) => Promise<boolean>
  /** Validate and replace the whole custom-provider list through the form. */
  saveCustoms: (entries: CustomProvider[]) => Promise<boolean>
  /** Store the API key through the credentials Remote. */
  writeKey: (value: string) => Promise<boolean>
  /** Remove the API key through the credentials Remote. */
  clearKey: () => Promise<boolean>
}

type Listener = () => void

/**
 * Bridges the `web-fetch-search` form and the credentials domain onto
 * the card. Snapshot-store shaped (getSnapshot/subscribe) so the renderer
 * binds it as the `useFetchCard` selector hook.
 */
export class FetchCardController {
  private readonly listeners = new Set<Listener>()
  private snapshot: FetchCardState
  private readonly unsubscribeForm: () => void
  private credentialRef = ''
  private refGeneration = 0

  /**
   * @param form - the entry's configuration form (values + queued writes).
   * @param ctx - the client plugin's context, whose `remote.credentials`
   * namespace answers for the key the section references.
   */
  constructor(
    private readonly form: ConfigForm<SectionValues>,
    private readonly ctx: ClientContext,
  ) {
    this.snapshot = {
      status: 'loading', writable: false, values: DEFAULT_VALUES,
      apiKeyEnv: '', apiKeyConfigured: false, apiKeyWritable: true,
    }
    this.unsubscribeForm = form.subscribe(() => { this.derive() })
    this.derive()
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot = (): FetchCardState => this.snapshot

  /** @param listener - invoked after each snapshot change. @returns its disposer. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release the form subscription. */
  dispose(): void {
    this.unsubscribeForm()
    this.listeners.clear()
  }

  /** Build the face the card's slot registration injects. */
  inject(): FetchCardFace {
    return {
      hooks: { fetchCard: this },
      saveField: (field, value) => this.saveField(field, value),
      saveCustoms: entries => this.saveCustoms(entries),
      writeKey: value => this.writeKey(value),
      clearKey: () => this.clearKey(),
    }
  }

  /** Fold the form's latest snapshot into the card state and refresh the key view on ref changes. */
  private derive(): void {
    const form = this.form.getSnapshot()
    if (form.status !== 'ready' || form.value === undefined) {
      this.snapshot = {
        ...this.snapshot,
        status: form.status === 'unavailable' ? 'unavailable' : 'loading',
        writable: form.writable,
      }
      this.emit()
      return
    }
    const values = form.value
    const ref = primaryKeyEnv(values)
    // A new reference knows nothing yet; keeping the old answer would claim
    // the key is configured under a name nobody has checked.
    const carriesAnswer = this.credentialRef === ref
    this.snapshot = {
      status: 'ready',
      writable: form.writable,
      values,
      apiKeyEnv: ref,
      apiKeyConfigured: carriesAnswer ? this.snapshot.apiKeyConfigured : false,
      apiKeyWritable: ref.length === 0 ? false : carriesAnswer ? this.snapshot.apiKeyWritable : true,
    }
    this.emit()
    if (!carriesAnswer) void this.readCredential()
  }

  /**
   * Ask the credentials domain about the reference the section currently
   * names. Responses are generation-fenced: `apiKeyEnv` can change between
   * the request and its answer, and two reads can settle out of order.
   */
  private async readCredential(): Promise<void> {
    const values = this.form.getSnapshot().value ?? DEFAULT_VALUES
    const ref = primaryKeyEnv(values)
    this.credentialRef = ref
    const generation = ++this.refGeneration
    // Empty reference = anonymous provider: no credential to describe or write.
    if (ref.length === 0) {
      this.snapshot = { ...this.snapshot, apiKeyConfigured: false, apiKeyWritable: false }
      this.emit()
      return
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (generation !== this.refGeneration || !response.ok) return
    const view = response.value[ref]
    this.snapshot = {
      ...this.snapshot,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the page guessing a refusal.
      apiKeyConfigured: view?.configured ?? false,
      apiKeyWritable: view?.writable ?? true,
    }
    this.emit()
  }

  /**
   * Re-read after the Host reports a change to a reference this page watches.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credentialRef) return
    void this.readCredential()
  }

  /**
   * Optimistically apply one field edit, then submit it through the form.
   * The form folds the authoritative answer back into the mirror; a refusal
   * re-derives from the recovered snapshot so the optimistic value cannot stick.
   *
   * A first write after a Loader recomposition can trip the settings
   * revision fence (the entry's fingerprint includes the fiber uid, so any
   * re-compose — plugin installs/refreshes on this profile — invalidates the
   * revision this page read). The refused write changed nothing, and the
   * form's recovery has already reloaded the fresh revision, so one silent
   * retry makes that race invisible instead of surfacing a save failure.
   */
  async saveField<K extends keyof SectionValues>(
    field: K,
    value: SectionValues[K],
  ): Promise<boolean> {
    this.snapshot = {
      ...this.snapshot,
      values: { ...this.snapshot.values, [field]: value },
    }
    this.emit()
    let accepted = await this.form.set(field as string, value)
    if (!accepted) accepted = await this.form.set(field as string, value)
    if (!accepted) this.derive()
    return accepted
  }

  /**
   * Validate and replace the whole custom-provider list. Client-side checks
   * mirror the host contract (kebab-case unique names, http(s) endpoints);
   * the Host re-validates against the section schema regardless.
   * @throws on an invalid or duplicated entry (the card shows the message).
   */
  async saveCustoms(entries: CustomProvider[]): Promise<boolean> {
    validateCustoms(entries)
    return await this.saveField('customProviders', entries)
  }

  /**
   * Write the key through the credentials Remote, then re-read whether the
   * Host now holds one. Refusals surface through the re-read and the thrown
   * RemoteError; the Host is the only authority on whether the key now exists.
   */
  async writeKey(value: string): Promise<boolean> {
    const ref = primaryKeyEnv(this.values())
    if (ref.length === 0) throw new Error('当前服务商无需 API Key（匿名）')
    await this.ctx.remote.credentials.set(ref, value)
    await this.readCredential()
    return this.snapshot.apiKeyConfigured
  }

  /** Remove the referenced key through the credentials Remote, then re-read. */
  async clearKey(): Promise<boolean> {
    const ref = primaryKeyEnv(this.values())
    if (ref.length === 0) throw new Error('当前服务商无需 API Key（匿名）')
    await this.ctx.remote.credentials.unset(ref)
    await this.readCredential()
    return !this.snapshot.apiKeyConfigured
  }

  /** The values currently in force (optimistic between a write and its answer). */
  private values(): SectionValues {
    return this.snapshot.values
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The credential reference the PRIMARY provider resolves to, mirroring the
 * host's resolveProvider(): a custom entry carries its own reference; the
 * primary built-in keeps the flat override, else its standard ref; an unknown
 * name falls back to the flat field. Empty = anonymous provider.
 * @param values - the section's current values.
 * @returns the reference name to address in the credentials store.
 */
function primaryKeyEnv(values: SectionValues): string {
  const custom = values.customProviders.find(provider => provider.name === values.adapter)
  if (custom !== undefined) {
    // Mirror the host: a crawl4ai entry with no explicit reference falls back
    // to its standard ref (the token is effectively mandatory in C4AI 0.9+).
    if (custom.apiKeyEnv.length === 0 && custom.adapter === 'crawl4ai') return CRAWL4AI_API_KEY_ENV
    return custom.apiKeyEnv
  }
  if (KEY_ENV_BY_ADAPTER[values.adapter] !== undefined) {
    return values.apiKeyEnv.length > 0 ? values.apiKeyEnv : KEY_ENV_BY_ADAPTER[values.adapter]
  }
  return values.apiKeyEnv
}

/** Reject an invalid custom-provider list (client-side mirror of the host rules). */
function validateCustoms(entries: CustomProvider[]): void {
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    if (typeof entry.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
      throw new Error('名称需为 kebab-case（小写字母/数字/连字符）')
    }
    if (['custom', 'tavily', 'jina', 'firecrawl'].includes(entry.name)) {
      throw new Error(`名称 "${entry.name}" 与内置服务商 id 冲突，请换个名字`)
    }
    if (seen.has(entry.name)) throw new Error(`自定义服务商名称 "${entry.name}" 重复（第 ${index + 1} 项）`)
    seen.add(entry.name)
    if (typeof entry.baseURL !== 'string' || !isHttpUrl(entry.baseURL)) {
      throw new Error(`"${entry.name}" 的接口地址需为 http(s) URL`)
    }
    const adapter = entry.adapter.length > 0 ? entry.adapter : 'custom'
    if (adapter !== 'custom' && !['crawl4ai', 'tavily', 'jina', 'firecrawl'].includes(adapter)) {
      throw new Error(`"${entry.name}" 未知适配器 "${adapter}"（可选：custom / crawl4ai / tavily / jina / firecrawl）`)
    }
  })
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
