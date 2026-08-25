/**
 * Per-session Chrome lifecycle: launch, operation queue, page selection,
 * idle reaping, and change broadcasting.
 *
 * One DSH session owns one visible Chrome window with an isolated profile.
 * All CDP work funnels through a per-session promise queue so agent tool
 * calls and Web UI actions never interleave mid-operation; the window
 * survives between tool calls (the "separate, long-lived browser" model)
 * until chrome_close, an idle timeout, or host shutdown reaps it.
 */
import type { Browser, CDPSession, Page } from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChromeEventDetail, ChromeStatus, PageInfo } from '../shared/contract.ts'
import { SCREENSHOTS_DIR, SESSIONS_DIR } from '../shared/contract.ts'
import type { UidEntry } from './snapshot.ts'
import { closeBrowserHard, findBrowser, forceWindowVisible, launchBrowser, launchOptions } from './browser.ts'
import { captureScreenshot, navigate, NAV_TIMEOUT_MS, normalizeUrl } from './actions.ts'
import { latestScreenshot } from './shots.ts'
import type { ResolvedConfig } from './config.ts'

/** Internal Chrome-internal pages never shown or controlled. */
const INTERNAL_URL_RE = /^(chrome|chrome-extension|devtools|edge|view-source):/iu

/** Welcome page shown in a freshly launched window (data: URL). */
function welcomePage(sessionId: string): string {
  const short = sessionId.slice(0, 8)
  const body = [
    '<title>DSH Chrome</title>',
    '<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e2e;color:#cdd6f4">',
    '<div style="text-align:center">',
    '<h1>🌐 DSH Chrome</h1>',
    `<p>会话 ${short} 的专属浏览器窗口</p>`,
    '<p style="opacity:.6">Agent 的操作会实时显示在这里</p>',
    '</div></body>',
  ]
  return `data:text/html,${body.join('')}`
}

/** Heartbeat tick: how often the stall watchdog checks for a silent stream. */
const FRAME_HEARTBEAT_MS = 2000

/** A stream is "stalled" after this long without a native frame. */
const FRAME_STALL_MS = 3000

/** One live, session-owned Chrome window. */
export class SessionChrome {
  readonly sessionId: string
  readonly dataDir: string
  readonly screenshotsDir: string
  browser: Browser
  startedAt: number
  lastUsedAt: number
  /** Tab index of the control target (pages array order). */
  selectedIndex = 0
  /** Serial queue: every operation awaits the previous one. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Counts of open operations; nonzero = busy. */
  private busyCount = 0
  private closed = false
  /** Set when the browser process exits on its own. */
  private exited = false
  /** Screencast watchers (bump lastUsedAt so the idle timer never reaps a watched window). */
  private screencastWatchers = new Set<object>()
  private screencastSeq = 0
  /** Frame push callback, wired by the API layer. */
  onFrame: ((frame: { data: string; seq: number; width: number; height: number }) => void) | null = null
  /** Status/event push callback, wired by the API layer. */
  onEvent: ((detail: ChromeEventDetail) => void) | null = null
  /** Page currently producing screencast frames (CDP session). */
  private screencastCdp: CDPSession | null = null
  /** uid → element registry of the most recent snapshot (per this session). */
  uidRegistry: Map<string, UidEntry> = new Map()
  /** Drained once close() finishes (guards double-close races). */
  private closedPromise: Promise<void> | null = null

  constructor(sessionId: string, browser: Browser, dataRoot: string, readonly config: ResolvedConfig, private readonly adopted: boolean) {
    this.sessionId = sessionId
    this.dataDir = join(dataRoot, SESSIONS_DIR, sessionId)
    this.screenshotsDir = join(this.dataDir, SCREENSHOTS_DIR)
    this.browser = browser
    this.startedAt = Date.now()
    this.lastUsedAt = Date.now()
    mkdirSync(this.screenshotsDir, { recursive: true })
    // Watch for the user closing the whole window.
    browser.on('disconnected', () => {
      this.exited = true
      this.closed = true
      this.notify({ kind: 'closed' })
    })
    // Keep the status fresh when tabs appear/disappear.
    browser.on('targetcreated', () => this.notify())
    browser.on('targetdestroyed', () => this.notify())
  }

  /** Human-readable short id for logs. */
  get shortId(): string {
    return this.sessionId.slice(0, 8)
  }

  /** Control pages (visible tabs; internal pages filtered). */
  async pages(): Promise<Page[]> {
    if (this.exited || !this.browser.connected) return []
    const all = await this.browser.pages()
    return all.filter((page) => {
      try {
        const url = page.url()
        return url === '' || !INTERNAL_URL_RE.test(url)
      } catch {
        return false
      }
    })
  }

  /** The current control target, or undefined when no usable tab exists. */
  async selected(): Promise<Page | undefined> {
    const pages = await this.pages()
    if (pages.length === 0) return undefined
    return pages[Math.min(this.selectedIndex, pages.length - 1)]
  }

  /**
   * The control target, opening a fresh tab when the window has none
   * usable (e.g. the user closed every web page, leaving chrome:// tabs).
   * Every chrome_* operation funnels through this so a bare window never
   * dead-ends.
   */
  async ensurePage(): Promise<Page> {
    const existing = await this.selected()
    if (existing !== undefined) return existing
    const fresh = await this.browser.newPage()
    // selectedIndex indexes the FILTERED pages list everywhere; find the
    // fresh tab there (about:blank always passes the filter).
    const filtered = await this.pages()
    const idx = filtered.indexOf(fresh)
    this.selectedIndex = idx >= 0 ? idx : filtered.length - 1
    await fresh.bringToFront().catch(() => {})
    return fresh
  }

  /** Open a new tab (optionally navigating it) and select it. */
  async newTab(url?: string): Promise<Page> {
    const page = await this.browser.newPage()
    if (url !== undefined && url.trim() !== '') {
      try {
        await navigate(page, url, NAV_TIMEOUT_MS)
      } catch (error) {
        await page.close().catch(() => {})
        throw error
      }
    }
    const filtered = await this.pages()
    const idx = filtered.indexOf(page)
    this.selectedIndex = idx >= 0 ? idx : filtered.length - 1
    await page.bringToFront().catch(() => {})
    this.notify({ kind: 'page-selected', index: this.selectedIndex })
    return page
  }

  /** Close a tab by (filtered) index; re-selects a neighbor when needed. */
  async closeTab(index: number): Promise<void> {
    const pages = await this.pages()
    if (index < 0 || index >= pages.length) {
      throw new Error(`标签页序号 ${index} 不存在（当前共 ${pages.length} 个）。`)
    }
    const wasSelected = index === this.selectedIndex
    await pages[index].close().catch(() => {})
    this.notify({ kind: 'page-removed', index })
    if (wasSelected) {
      this.selectedIndex = Math.max(0, Math.min(index, (await this.pages()).length - 1))
      await this.selectPage(this.selectedIndex)
    }
  }

  /**
   * Select a tab by zero-based pages-array index (clamped).
   *
   * NOT queued itself: every call site already runs inside {@link run} —
   * wrapping it again would deadlock the serial queue (a queued op waiting
   * on an op queued behind it).
   */
  async selectPage(index: number): Promise<Page | undefined> {
    const pages = await this.pages()
    if (pages.length === 0) return undefined
    const clamped = Math.max(0, Math.min(index, pages.length - 1))
    this.selectedIndex = clamped
    await pages[clamped].bringToFront().catch(() => {})
    this.notify({ kind: 'page-selected', index: clamped })
    return pages[clamped]
  }

  /** Run one operation on the serial queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`Chrome 窗口已关闭（会话 ${this.shortId}）。请先调用 chrome_open 重新打开。`))
    const next = this.queue.then(async () => {
      this.busyCount += 1
      try {
        const result = await fn()
        this.touch()
        return result
      } finally {
        this.busyCount -= 1
      }
    })
    // The queue survives one rejected operation: chain a recovery no-op.
    this.queue = next.catch(() => {})
    return next
  }

  /** Record activity (defeats the idle timer). */
  touch(): void {
    this.lastUsedAt = Date.now()
  }

  isBusy(): boolean {
    return this.busyCount > 0
  }

  /** Live status snapshot for the Web UI and tools. */
  async status(): Promise<ChromeStatus> {
    const pages: PageInfo[] = []
    if (this.closed || this.exited) {
      return {
        sessionId: this.sessionId, running: false, pages, startedAt: this.startedAt,
        lastUsedAt: this.lastUsedAt, idleDeadline: null, lastScreenshot: null,
        screencastActive: false, error: this.exited ? '浏览器进程已退出' : null,
      }
    }
    // The filtered list is the one index contract the whole plugin shares:
    // internal chrome:// pages are never shown or controlled, and every
    // index (status, tools, API) counts within this list.
    const live = await this.pages()
    for (let index = 0; index < live.length; index += 1) {
      const page = live[index]
      let url = ''
      let title = ''
      try {
        url = page.url()
        title = await page.title()
      } catch {
        // A tab mid-teardown answers neither; report it as inert.
      }
      pages.push({ index, url, title, active: index === this.selectedIndex, selected: index === this.selectedIndex })
    }
    return {
      sessionId: this.sessionId,
      running: true,
      pages,
      startedAt: this.startedAt,
      lastUsedAt: this.lastUsedAt,
      idleDeadline: this.idleDeadlineMs(this.config.idleTimeoutMs),
      lastScreenshot: latestScreenshot(this.screenshotsDir),
      screencastActive: this.screencastWatchers.size > 0,
      error: null,
    }
  }

  // -- screencast ----------------------------------------------------------

  /** Subscribe a Web UI viewer to the live frame stream. */
  async addScreencastWatcher(token: object): Promise<void> {
    const first = this.screencastWatchers.size === 0
    this.screencastWatchers.add(token)
    this.touch()
    if (!first) return
    await this.run(async () => {
      if (this.exited || this.screencastCdp !== null) return
      const page = await this.selected()
      if (page === undefined) return
      let cdp: CDPSession | null = null
      try {
        cdp = await page.target().createCDPSession()
        cdp.on('Page.screencastFrame', (frame: { sessionId: number; data: string; metadata: { deviceWidth: number; deviceHeight: number } }) => {
          const width = frame.metadata.deviceWidth ?? 0
          const height = frame.metadata.deviceHeight ?? 0
          this.screencastSeq += 1
          this.lastFrameAt = Date.now()
          this.onFrame?.({ data: frame.data, seq: this.screencastSeq, width, height })
          // Acknowledge so Chrome keeps sending.
          cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
        })
        await cdp.send('Page.enable')
        await cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: this.config.screencastQuality,
          everyNthFrame: this.config.screencastFrameSkip,
        })
        this.screencastCdp = cdp
        this.notify({ kind: 'screencast-changed', active: true })
        // Chrome only emits screencast frames while the compositor repaints
        // (static or occluded pages go silent). The fallback heartbeat
        // force-captures one JPEG whenever the stream stalls, so the Web UI
        // live view never freezes on an idle page.
        this.startFrameHeartbeat()
      } catch (error) {
        await cdp?.detach().catch(() => {})
        this.screencastWatchers.delete(token)
        throw new Error(`启动实时画面流失败（该 Chrome 版本可能不支持 screencast）：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** Unsubscribe one viewer; the stream stops when the last leaves. */
  async removeScreencastWatcher(token: object): Promise<void> {
    const wasWatching = this.screencastWatchers.delete(token)
    if (!wasWatching || this.screencastWatchers.size > 0) return
    this.stopFrameHeartbeat()
    await this.run(async () => {
      const cdp = this.screencastCdp
      this.screencastCdp = null
      if (cdp === null) return
      try {
        await cdp.send('Page.stopScreencast')
      } catch {
        // Best-effort: the page may already be gone.
      }
      await cdp.detach().catch(() => {})
      this.notify({ kind: 'screencast-changed', active: false })
    })
  }

  hasScreencastWatchers(): boolean {
    return this.screencastWatchers.size > 0
  }

  /** Timestamp of the last real screencast frame (heartbeat decision input). */
  private lastFrameAt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Force one capture when the stream stalls for {@link FRAME_STALL_MS}.
   * The capture itself repaints the page, which usually restarts the native
   * frame flow too.
   */
  private startFrameHeartbeat(): void {
    this.lastFrameAt = Date.now()
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatCapture()
    }, FRAME_HEARTBEAT_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopFrameHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async heartbeatCapture(): Promise<void> {
    if (this.hasScreencastWatchers() === false || this.exited) return
    if (Date.now() - this.lastFrameAt < FRAME_STALL_MS) return
    const page = await this.selected()
    if (page === undefined) return
    try {
      const { buffer, width, height } = await captureScreenshot(page, { fullPage: false, format: 'jpeg', quality: 55 })
      this.screencastSeq += 1
      this.lastFrameAt = Date.now()
      this.onFrame?.({ data: buffer.toString('base64'), seq: this.screencastSeq, width, height })
    } catch {
      // A mid-navigation capture fails; the next tick retries.
    }
  }

  /** Push one state/event notice through the API layer. */
  notify(detail?: ChromeEventDetail): void {
    if (detail !== undefined) this.onEvent?.(detail)
  }

  /** Close the window (idempotent; joins the in-flight queue first). */
  async close(): Promise<void> {
    if (this.closedPromise !== null) return this.closedPromise
    this.closedPromise = this.run(async () => {
      this.closed = true
      this.exited = true
      this.stopFrameHeartbeat()
      if (this.browser.connected) {
        // Adopted instances need a hard CDP Browser.close (browser.close()
        // on a connected browser only disconnects the client and would
        // leave the Chrome process behind).
        if (this.adopted) await closeBrowserHard(this.browser)
        else await this.browser.close().catch(() => {})
      }
      this.notify({ kind: 'closed' })
    }).catch(() => {})
    return this.closedPromise
  }

  /** Recheck whether the idle deadline passed (manager-side policy). */
  idleDeadlineMs(idleTimeoutMs: number): number | null {
    if (idleTimeoutMs <= 0 || this.hasScreencastWatchers()) return null
    return this.lastUsedAt + idleTimeoutMs
  }
}

/** Manager owning every session window and the shared launch policy. */
export class ChromeManager {
  private sessions = new Map<string, SessionChrome>()
  /** In-flight launches (single-flight per session: concurrent chrome_open dedupes). */
  private launching = new Map<string, Promise<SessionChrome>>()
  private executable: { path: string; name: string } | null = null
  private readonly idleTimer: ReturnType<typeof setInterval>

  constructor(readonly config: ResolvedConfig, private readonly dataRoot: string) {
    // Reap idle windows every 30 seconds.
    this.idleTimer = setInterval(() => this.reapIdle(), 30000)
    this.idleTimer.unref?.()
  }

  /** Shared executable discovery (cached). */
  private resolveExecutable(): { path: string; name: string } {
    this.executable ??= findBrowser(this.config.executablePath)
    return this.executable
  }

  /** Get a live session window, or undefined. */
  get(sessionId: string): SessionChrome | undefined {
    return this.sessions.get(sessionId)
  }

  /** Get or launch the session window (single-flight per session). */
  async getOrLaunch(sessionId: string, url?: string): Promise<SessionChrome> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      existing.touch()
      return existing
    }
    const inFlight = this.launching.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const launch = this.doLaunch(sessionId, url).finally(() => {
      this.launching.delete(sessionId)
    })
    this.launching.set(sessionId, launch)
    return launch
  }

  /** Launch body (owns failure cleanup). */
  private async doLaunch(sessionId: string, url?: string): Promise<SessionChrome> {
    const exec = this.resolveExecutable()
    const profileDir = join(this.dataRoot, SESSIONS_DIR, sessionId, 'profile')
    const { browser, adopted } = await launchBrowser(exec.path, launchOptions(profileDir, {
      headless: this.config.headless,
      windowWidth: this.config.windowWidth,
      windowHeight: this.config.windowHeight,
      extraArgs: this.config.extraArgs,
    }))
    const session = new SessionChrome(sessionId, browser, this.dataRoot, this.config, adopted)
    this.sessions.set(sessionId, session)
    try {
      // The whole point of the plugin is a VISIBLE window: a DSH host that
      // itself started hidden (task scheduler / hidden shortcut) passes the
      // hidden state down to Chrome. Force the window onto the desktop.
      await forceWindowVisible(browser)
      // Navigate the default tab to the requested URL (or a welcome page).
      // Adopted windows keep whatever tabs the previous host left behind;
      // a bare new launch gets the welcome page. User/model URLs go through
      // normalizeUrl (https:// defaulting, dangerous-scheme rejection).
      if (!adopted) {
        const page = (await browser.pages())[0]
        if (page !== undefined) {
          const target = url !== undefined ? normalizeUrl(url) : welcomePage(sessionId)
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        }
      } else if (url !== undefined) {
        await session.ensurePage().then((page) => page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 15000 })).catch(() => {})
      }
      session.notify({ kind: 'opened' })
      return session
    } catch (error) {
      await session.close()
      this.sessions.delete(sessionId)
      throw error
    }
  }

  /** Close one session window (no-op when absent). */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    await session.close()
    this.sessions.delete(sessionId)
  }

  /** Close every window (host shutdown / plugin unload). */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(all.map((session) => session.close()))
  }

  /** Iterate all live sessions (API/status use). */
  all(): SessionChrome[] {
    return [...this.sessions.values()]
  }

  /** Idle-timeout reaper (interval-driven). */
  private reapIdle(): void {
    if (this.config.idleTimeoutMs <= 0) return
    const now = Date.now()
    for (const [sessionId, session] of this.sessions) {
      const deadline = session.idleDeadlineMs(this.config.idleTimeoutMs)
      if (deadline !== null && deadline <= now && !session.isBusy()) {
        void this.close(sessionId)
      }
    }
  }

  /** Stop the idle timer (plugin disposal). */
  dispose(): void {
    clearInterval(this.idleTimer)
  }
}
