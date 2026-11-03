/**
 * Managed SearXNG Docker stack: one-click deployment, keep-alive, and removal
 * for users who have Docker but should not have to hand-write a compose file
 * and the instance settings.
 *
 * Mirrors `local-stack.ts` in every operational pattern — `execFile('docker')`
 * with a per-call timeout, a 20s unref'd watchdog, a 60s cooldown on repeated
 * docker attempts, `start`-then-`run` container creation, and port polling —
 * with three deliberate differences:
 *
 * - OWNED NAME: the managed container is `dsh-fetch-search-searxng`, never the
 *   generic `searxng`. A user running their own instance (compose or manual)
 *   is detected via the JSON probe and reported as an existing instance — the
 *   manager never adopts, restarts, or removes a container it did not create.
 * - TWO-TIER HEALTH: the watchdog uses the cheap port probe only; the real
 *   `/search?format=json` probe runs at provision/status time, so "something
 *   listens on the port" is never confused with "a working SearXNG answers".
 * - MANAGED CONFIG: the instance settings (json formatter on, limiter off,
 *   generated secret key) are written once into `$DSH_HOME/searxng-stack/`
 *   and mounted read-only — the two pitfalls that make hand-rolled SearXNG
 *   deployments fail are pre-solved by construction.
 * @module dsh-fetch-search/searxng-stack
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Section } from './settings.ts'

/** The managed container's owned name — never the generic `searxng`. */
export const SEARXNG_CONTAINER_NAME = 'dsh-fetch-search-searxng'
const SEARXNG_IMAGE = 'searxng/searxng:latest'
/** The image's internal listen port; the host port is published onto it. */
const CONTAINER_PORT = 8080
/** How often the watchdog re-checks the container. */
const WATCHDOG_MS = 20_000
/** Rate-limit repeated docker attempts while the container stays down. */
const DOCKER_COOLDOWN_MS = 60_000
/** `docker run` may pull the image first — minutes through a daemon proxy. */
const RUN_TIMEOUT_MS = 600_000
/** Default docker CLI timeout (start/inspect/rm are fast). */
const DEFAULT_TIMEOUT_MS = 90_000

/** Lifecycle phase the managed stack is in (surfaced on the card). */
export type SearxngPhase =
  | 'idle'
  | 'checking'
  | 'docker-missing'
  | 'port-foreign'
  | 'pulling'
  | 'starting'
  | 'running'
  | 'error'

/** What the card's deployment block renders. */
export interface SearxngStatus {
  phase: SearxngPhase
  /** Human-readable detail for the current phase (locale-independent; card maps). */
  detail: string
  containerName: string
  port: number
  /** True when a working SearXNG JSON API answers on the port (ours or the user's own). */
  existingInstance: boolean
  /** Cheap live signal: something listens on the published loopback port. */
  portUp: boolean
}

/** The docker CLI face, injectable so tests can stub every command. */
export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<string>

/** How the manager finds its managed files (overridable in tests). */
export interface SearxngStackOptions {
  /** Managed-files directory; defaults to `$DSH_HOME/searxng-stack` (or `~/.dsh/searxng-stack`). */
  dir?: string
  /** Docker CLI runner; defaults to `execFile('docker', …)`. */
  runDocker?: DockerRunner
  /** Deadline for the port wait after a container start (tests shrink this). */
  waitMs?: number
}

/** The default runner: plain execFile, stderr folded into the error. */
function defaultDocker(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()))
      else resolve(stdout.trim())
    })
  })
}

/** Managed-files directory: `$DSH_HOME/searxng-stack`, or `~/.dsh/searxng-stack`. */
export function defaultStackDir(): string {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  return path.join(home, 'searxng-stack')
}

/** Whether something is listening on 127.0.0.1:port (any HTTP response counts). */
async function isPortUp(port: number): Promise<boolean> {
  try {
    await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1200) })
    return true
  } catch {
    return false
  }
}

/** Poll until a port answers or the timeout elapses. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortUp(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return isPortUp(port)
}

/**
 * Probe whether a working SearXNG JSON API answers on the port. A real search
 * request — the cheapest way to distinguish "SearXNG with the json formatter
 * enabled" from "any other service that happens to hold the port" (a 403 here
 * is exactly the formats-not-enabled failure mode).
 */
async function jsonProbeOk(port: number): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/search?q=searxng+probe&format=json', {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as unknown
    return body !== null && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)
  } catch {
    return false
  }
}

/** Render the managed settings.yml (json formatter on, limiter off, fixed secret). */
export function renderManagedSettings(secretKey: string): string {
  return [
    'use_default_settings: true',
    '',
    'server:',
    '  # generated by dsh-fetch-search (managed SearXNG stack) — do not regenerate:',
    '  # the key keeps existing browser sessions and contact rows stable',
    '  secret_key: "' + secretKey + '"',
    '  limiter: false',
    '  image_proxy: false',
    '',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n')
}

/** The stack manager: provision / keep-alive / remove for the owned container. */
export class SearxngStackManager {
  private readonly dir: string
  private readonly runDocker: DockerRunner
  private timer: ReturnType<typeof setInterval> | null = null
  private syncing = false
  private active = false
  private lastDockerAttempt = 0
  private phase: SearxngPhase = 'idle'
  private phaseDetail = ''
  private existingInstance = false

  constructor(
    private readonly config: () => Section,
    options: SearxngStackOptions = {},
  ) {
    this.dir = options.dir ?? defaultStackDir()
    this.runDocker = options.runDocker ?? defaultDocker
    this.waitMs = options.waitMs ?? 120_000
  }

  private readonly waitMs: number

  /** The trigger: the user opted into the managed deployment. */
  needsStack(config: Section = this.config()): boolean {
    return config.searxngManaged
  }

  /** Cheap live signal for the card: is anything on the published port now. */
  async status(): Promise<SearxngStatus> {
    const port = this.config().searxngPort
    const portUp = await isPortUp(port)
    return {
      phase: this.phase,
      detail: this.phaseDetail,
      containerName: SEARXNG_CONTAINER_NAME,
      port,
      existingInstance: this.existingInstance && portUp,
      portUp,
    }
  }

  /** Start the watchdog while the stack is wanted; stop it when not. */
  async sync(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      if (this.needsStack()) {
        this.active = true
        await this.ensureRunning().catch((error) => {
          this.phase = 'error'
          this.phaseDetail = error instanceof Error ? error.message : String(error)
          console.warn('[dsh-fetch-search] SearXNG stack ensure failed:', this.phaseDetail)
        })
        this.armWatchdog()
      } else {
        this.active = false
        this.stopWatchdog()
      }
    } finally {
      this.syncing = false
    }
  }

  /**
   * Full provisioning pass (the card's 一键部署): docker present? port free or
   * already serving a working instance? managed settings written? container
   * created/started? Each step updates the phase the card polls.
   */
  async provision(): Promise<SearxngStatus> {
    const section = this.config()
    const port = section.searxngPort
    this.existingInstance = false
    this.phase = 'checking'
    this.phaseDetail = ''

    // Docker present at all? (a missing daemon is the most common state)
    try {
      await this.runDocker(['version', '--format', '{{.Server.Version}}'])
    } catch (error) {
      this.phase = 'docker-missing'
      this.phaseDetail = error instanceof Error ? error.message : String(error)
      return await this.status()
    }

    // Port already serving a working SearXNG? → report it and touch nothing.
    if (await isPortUp(port)) {
      if (await jsonProbeOk(port)) {
        this.existingInstance = true
        this.phase = 'running'
        this.phaseDetail = 'an existing working SearXNG answers on this port'
        return await this.status()
      }
      this.phase = 'port-foreign'
      this.phaseDetail = 'the port is held by a service whose JSON API does not answer like SearXNG'
      return await this.status()
    }

    // Managed settings: write once, then reuse (the secret must stay stable).
    this.phase = 'starting'
    const settingsPath = this.writeManagedSettings()

    // Container: start if present, create (with image pull) if not.
    this.phase = 'pulling'
    let state = ''
    try {
      state = await this.runDocker([
        'inspect', '-f', '{{.State.Running}}', SEARXNG_CONTAINER_NAME,
      ]).catch(() => '')
      if (state === 'true') {
        this.phase = 'starting'
      } else if (state === 'false') {
        this.phase = 'starting'
        await this.runDocker(['start', SEARXNG_CONTAINER_NAME])
      } else {
        // Missing: create. First run pulls the image (minutes behind a proxy).
        const settingsHostPath = settingsPath.replace(/\\/g, '/')
        await this.runDocker([
          'run', '-d',
          '--name', SEARXNG_CONTAINER_NAME,
          '-p', '127.0.0.1:' + port + ':' + CONTAINER_PORT,
          '-v', settingsHostPath + ':/etc/searxng/settings.yml:ro',
          '--restart', 'unless-stopped',
          SEARXNG_IMAGE,
        ], RUN_TIMEOUT_MS)
      }
    } catch (error) {
      this.phase = 'error'
      this.phaseDetail = error instanceof Error ? error.message : String(error)
      return await this.status()
    }

    this.phase = 'starting'
    if (!await waitForPort(port, this.waitMs)) {
      this.phase = 'error'
      this.phaseDetail = 'the container did not answer on the port within the deadline'
      return await this.status()
    }
    if (!await jsonProbeOk(port)) {
      this.phase = 'error'
      this.phaseDetail = 'the container answered but the JSON API probe failed (unexpected image state)'
      return await this.status()
    }
    this.phase = 'running'
    this.phaseDetail = 'managed container is running'
    this.armWatchdog()
    return await this.status()
  }

  /** Remove the owned container; `purge` also deletes the managed-files directory. */
  async remove(purge: boolean): Promise<SearxngStatus> {
    this.stopWatchdog()
    this.active = false
    await this.runDocker(['rm', '-f', SEARXNG_CONTAINER_NAME]).catch(() => {
      /* missing container: removal already achieved */
    })
    if (purge) {
      rmSync(this.dir, { recursive: true, force: true })
    }
    this.phase = 'idle'
    this.phaseDetail = purge ? 'container removed and managed files deleted' : 'container removed'
    this.existingInstance = false
    return await this.status()
  }

  /** Write the managed settings.yml once (an existing file keeps its secret). */
  private writeManagedSettings(): string {
    mkdirSync(this.dir, { recursive: true })
    const settingsPath = path.join(this.dir, 'settings.yml')
    if (existsSync(settingsPath)) return settingsPath
    let secret = randomBytes(32).toString('hex')
    try {
      // A previous file that survived a non-purged removal keeps its secret,
      // so browser sessions and contact rows stay stable across re-provision.
      const previous = readFileSync(settingsPath, 'utf8')
      const match = previous.match(/secret_key:\s*"([0-9a-f]{32,})"/)
      if (match) secret = match[1]
    } catch { /* no previous file */ }
    writeFileSync(settingsPath, renderManagedSettings(secret), 'utf8')
    return settingsPath
  }

  /** Start the periodic keep-alive once (cleared in stopWatchdog). */
  private armWatchdog(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.checkStack() }, WATCHDOG_MS)
    // Do not keep the host process alive just for the watchdog.
    this.timer.unref()
  }

  private stopWatchdog(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Plugin-unload hook: stop the watchdog but leave the container running —
   * it carries `--restart unless-stopped`, so Docker itself keeps it alive
   * across DSH restarts; only the in-process keep-alive dies here.
   */
  stopWatchdogOnly(): void {
    this.active = false
    this.stopWatchdog()
  }

  /**
   * Keep-alive ensure (sync + watchdog path): cheap port check, then start or
   * create. Deliberately NO json probe and NO docker-missing pre-check — the
   * full diagnostic pass is `provision()`; this path only cares that the
   * managed container answers on its port.
   */
  private async ensureRunning(): Promise<void> {
    const port = this.config().searxngPort
    if (await isPortUp(port)) {
      this.lastDockerAttempt = 0
      return
    }
    const now = Date.now()
    if (now - this.lastDockerAttempt < DOCKER_COOLDOWN_MS) return
    this.lastDockerAttempt = now
    let state = ''
    try {
      state = await this.runDocker([
        'inspect', '-f', '{{.State.Running}}', SEARXNG_CONTAINER_NAME,
      ]).catch(() => '')
      if (state === 'true') {
        await this.runDocker(['start', SEARXNG_CONTAINER_NAME])
      } else if (state === 'false') {
        await this.runDocker(['start', SEARXNG_CONTAINER_NAME])
      } else {
        const settingsPath = this.writeManagedSettings().replace(/\\/g, '/')
        await this.runDocker([
          'run', '-d',
          '--name', SEARXNG_CONTAINER_NAME,
          '-p', '127.0.0.1:' + port + ':' + CONTAINER_PORT,
          '-v', settingsPath + ':/etc/searxng/settings.yml:ro',
          '--restart', 'unless-stopped',
          SEARXNG_IMAGE,
        ], RUN_TIMEOUT_MS)
      }
    } catch (error) {
      this.phase = 'error'
      this.phaseDetail = error instanceof Error ? error.message : String(error)
      return
    }
    await waitForPort(port, this.waitMs)
  }

  /**
   * Keep-alive tick: rate-limited ensure; the port probe lives inside
   * {@link ensureRunning} (no probe search, no image pull — those belong to
   * the explicit provisioning pass).
   */
  private async checkStack(): Promise<void> {
    if (!this.active || this.syncing) return
    if (!this.needsStack()) {
      this.stopWatchdog()
      this.active = false
      return
    }
    await this.ensureRunning()
  }
}
