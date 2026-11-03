/**
 * The web-fetch configuration card, browser half. Registers into the Plugins
 * page's `plugins.bundle.config` seat (keyed by this package name), so the
 * card opens from the bundle's own detail page. Values and writes ride the
 * official settings Remote through `ctx.configForms`, and the API key rides
 * the credentials Remote — the only private HTTP left is the runtime-state
 * bridge (test fetch + live chain view).
 * @module dsh-fetch-search/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the Conversation composer's SlotMap merge ('conversation.input.left').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { FetchCard, FetchSettingsSection } from './card.tsx'
import { ENTRY_ID, FetchCardController } from './card-controller.ts'
import { ProxyToggle, ProxyToggleController } from './proxy-toggle.tsx'
import { en, zh, type FetchCardLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Fetch card copy. */
    'fetch-third-party': FetchCardLocaleKey
  }
}

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'] as const

/** Register the fetch configuration card into the Plugins page's bundle seat. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('fetch-third-party', { zh, en }), 'fetch-third-party: dictionaries')

  const controller = new FetchCardController(ctx.configForms.get(ENTRY_ID), ctx)
  ctx.effect(() => () => { controller.dispose() }, 'fetch-third-party: form subscription')
  // A key can be written from somewhere else — the launching environment or
  // another surface addressing the same reference — and the settings section
  // does not change when it is, so without this the badge keeps reporting a
  // state the Host already replaced.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref: string) => { controller.refreshCredential(ref) }),
    'fetch-third-party: credential invalidations',
  )

  // Keyed by the bundle's npm package name: the Plugins page renders the entry
  // on this bundle's detail page (`view: 'page'` only).
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-fetch-search',
    locale: 'fetch-third-party',
    inject: () => controller.inject(),
  }, FetchCard))

  // The Settings panel's own page: Settings → dsh-fetch-search. Ordered
  // after every built-in section (account -10 / general 0 / models 10 /
  // plugins 15 / agent-presets 20), so third-party pages trail the roster.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-fetch-search',
    order: 100,
    label: () => ctx.locale.bind('fetch-third-party')('nav'),
    locale: 'fetch-third-party',
    inject: () => controller.inject(),
  }, FetchSettingsSection))

  // The composer tool-row quick toggle: flip the local fetch proxy without
  // opening Settings. Rides the same form as the card, so both stay in sync.
  const proxyToggle = new ProxyToggleController(ctx.configForms.get(ENTRY_ID), ctx)
  ctx.effect(() => () => { proxyToggle.dispose() }, 'fetch-third-party: proxy toggle subscription')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'fetch-proxy-toggle',
    order: 10,
    locale: 'fetch-third-party',
    inject: () => proxyToggle.inject(),
  }, ProxyToggle))
}
