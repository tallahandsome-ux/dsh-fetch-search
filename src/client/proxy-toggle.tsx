/**
 * The composer's fetch-proxy quick toggle, browser half: a compact control in
 * the conversation input tool row (conversation.input.left) that flips the
 * `proxyEnabled` field of the fetch section live — turning the local VPN
 * proxy on/off for external fetch providers without opening Settings.
 *
 * The toggle rides the SAME configuration form as the settings card
 * (ctx.configForms over the plugin's entry), so a flip here and a checkbox
 * there are two views of one value: both update instantly, and the write
 * carries the same revision fence and hot-apply as any settings edit.
 * @module dsh-fetch-search/client/proxy-toggle
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Conversation composer's SlotMap merge ('conversation.input.left').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SectionValues } from './card-controller.ts'

/** What the quick toggle renders. */
export interface ProxyToggleState {
  /** 'ready' once the settings form answered; otherwise nothing to act on. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether writes are accepted (read-only profile ⇒ the control disables). */
  writable: boolean
  /** Whether the local proxy is currently applied to external providers. */
  enabled: boolean
  /** The configured proxy address; empty = nothing to toggle. */
  address: string
}

/** The registration-side face the toggle's slot entry injects. */
export interface ProxyToggleFace {
  hooks: {
    /** Toggle snapshot bound by the renderer as useProxyToggle. */
    proxyToggle: { getSnapshot(): ProxyToggleState; subscribe(fn: () => void): () => void }
  }
  /** Flip `proxyEnabled` through the settings form (hot-applies). */
  toggle: () => Promise<void>
}

type Listener = () => void

/**
 * Bridges the fetch section's form onto the quick toggle. Snapshot-store
 * shaped so the renderer binds it as the `useProxyToggle` selector hook.
 */
export class ProxyToggleController {
  private readonly listeners = new Set<Listener>()
  private snapshot: ProxyToggleState = { status: 'loading', writable: false, enabled: false, address: '' }
  private readonly unsubscribe: () => void

  /**
   * @param form - the fetch entry's configuration form (shared with the card).
   */
  constructor(
    private readonly form: ConfigForm<SectionValues>,
    private readonly ctx: ClientContext,
  ) {
    this.unsubscribe = form.subscribe(() => { this.derive() })
    this.derive()
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot = (): ProxyToggleState => this.snapshot

  /** @param listener - invoked after each snapshot change. @returns its disposer. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release the form subscription. */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  /** Build the face the toggle's slot registration injects. */
  inject(): ProxyToggleFace {
    return {
      hooks: { proxyToggle: this },
      toggle: () => this.toggle(),
    }
  }

  /** Fold the form's latest snapshot into the toggle state. */
  private derive(): void {
    const form = this.form.getSnapshot()
    if (form.status !== 'ready' || form.value === undefined) {
      this.snapshot = { ...this.snapshot, status: form.status === 'unavailable' ? 'unavailable' : 'loading', writable: form.writable }
      this.emit()
      return
    }
    this.snapshot = {
      status: 'ready',
      writable: form.writable,
      enabled: form.value.proxyEnabled === true,
      address: form.value.proxy,
    }
    this.emit()
  }

  /**
   * Flip `proxyEnabled`. Same silent retry as the card: a Loader
   * recomposition can trip the settings revision fence once; the form's
   * recovery reloads the fresh revision, so the retry absorbs the race.
   */
  async toggle(): Promise<void> {
    const next = !this.snapshot.enabled
    this.snapshot = { ...this.snapshot, enabled: next }
    this.emit()
    let accepted = await this.form.set('proxyEnabled', next)
    if (!accepted) accepted = await this.form.set('proxyEnabled', next)
    if (!accepted) this.derive()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Props bound by the slot renderer: the locale `t` and the controller face. */
export type ProxyToggleProps = PropsLocale<'fetch-third-party'> & InjectFace<ProxyToggleFace>

/** Render the composer tool-row quick toggle for the fetch proxy. */
export function ProxyToggle(props: ProxyToggleProps) {
  const { t } = props
  const state = props.useProxyToggle(snapshot => snapshot)
  const settled = state.status === 'ready' && state.address.length > 0
  const label = !settled
    ? t('proxyChipUnset')
    : state.enabled ? t('proxyChipOn') : t('proxyChipOff')
  return (
    <button
      type="button"
      disabled={!settled || !state.writable}
      aria-pressed={settled ? state.enabled : undefined}
      title={settled ? t('proxyChipHint') + ' ' + state.address : t('proxyChipUnsetHint')}
      onClick={() => { void props.toggle() }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 9px', border: '1px solid rgba(127,127,127,.45)', borderRadius: 999,
        background: 'transparent', color: 'inherit',
        fontSize: 12, lineHeight: 1.6, cursor: settled && state.writable ? 'pointer' : 'default',
        opacity: settled ? 1 : 0.55, whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
          background: !settled ? '#b0b0b0' : state.enabled ? '#2e9e5b' : '#c0c0c0',
        }}
      />
      {label}
    </button>
  )
}
