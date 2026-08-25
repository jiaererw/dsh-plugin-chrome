/**
 * Web GUI API: status/control endpoints plus the live screencast WebSocket.
 *
 * Security posture (host serves only the browser GUI on loopback):
 *  - every mutation requires an application/json body and a same-origin
 *    Origin header (cross-site forms and scripts cannot mint JSON bodies
 *    with an Origin);
 *  - sessionId is whitelist-validated before it ever touches a path join;
 *  - file reads accept bare file names only (no traversal);
 *  - the WebSocket handshake validates sessionId the same way.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientWsMessage, ChromeEventDetail, HostWsMessage } from '../shared/contract.ts'
import { API_PREFIX, WS_PATH } from '../shared/contract.ts'
import type { ChromeManager, SessionChrome } from './manager.ts'
import { NAV_TIMEOUT_MS, normalizeUrl } from './actions.ts'
import { screenshotHistory, SHOT_NAME_RE } from './shots.ts'

/** sessionId whitelist: DSH session ids are `session-<uuid>`; keep it strict. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u

/** JSON body cap (all payloads are small control messages). */
const MAX_BODY_BYTES = 64 * 1024

/** Collapse bursts of change events into one trailing status push. */
const STATUS_BROADCAST_DEBOUNCE_MS = 120

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

/** Read a bounded JSON body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('请求体必须是 JSON 对象')
  }
}

/** Same-origin gate for mutations (mirrors the host's own API policy). */
function assertSameOrigin(req: IncomingMessage): void {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new Error('Content-Type 必须为 application/json')
  const origin = String(req.headers.origin ?? '')
  if (origin === '') throw new Error('缺少 Origin 头')
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    throw new Error('Origin 头无效')
  }
  const host = String(req.headers.host ?? '')
  if (originHost !== host) throw new Error('跨站请求已拒绝')
}

/**
 * Reject cross-site reads. Modern browsers tag every request with
 * Sec-Fetch-Site; `cross-site` means an attacker page (or a cross-site
 * <img>/<script>) is hitting the loopback API, which should only ever serve
 * the same-origin Web GUI. Requests without the header (curl, older
 * clients) still pass — this is a hardening layer, not the whole gate.
 */
function assertNotCrossSite(req: IncomingMessage): void {
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    throw new Error('跨站请求已拒绝')
  }
}

/** Validate and return a sessionId from query or body. */
function requireSessionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value) || value.length > 128) {
    throw new Error(`${label} 无效`)
  }
  return value
}

/** Install the HTTP routes and the screencast WebSocket. */
export function installApi(webCtx: Context, manager: ChromeManager): () => void {
  /** Live viewer sockets per session (screencast + status fan-out). */
  const viewers = new Map<string, Set<WebSocket>>()
  /** Sessions whose pushers are wired to the fan-out below. */
  const wired = new Set<SessionChrome>()

  const broadcastStatus = (session: SessionChrome): void => {
    const sockets = viewers.get(session.sessionId)
    if (sockets === undefined || sockets.size === 0) return
    void session.status().then((status) => {
      const message: HostWsMessage = { type: 'status', status }
      const data = JSON.stringify(message)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(data)
      }
    })
  }

  /** Debounced status fan-out: event bursts collapse into one push. */
  const statusTimers = new Map<SessionChrome, ReturnType<typeof setTimeout>>()
  const scheduleStatus = (session: SessionChrome): void => {
    const pending = statusTimers.get(session)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      statusTimers.delete(session)
      broadcastStatus(session)
    }, STATUS_BROADCAST_DEBOUNCE_MS)
    timer.unref?.()
    statusTimers.set(session, timer)
  }

  const wire = (session: SessionChrome): void => {
    if (wired.has(session)) return
    wired.add(session)
    session.onFrame = (frame) => {
      const sockets = viewers.get(session.sessionId)
      if (sockets === undefined || sockets.size === 0) return
      const message: HostWsMessage = { type: 'frame', ...frame }
      const data = JSON.stringify(message)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(data)
      }
    }
    session.onEvent = (detail: ChromeEventDetail) => {
      scheduleStatus(session)
      const sockets = viewers.get(session.sessionId)
      if (sockets === undefined || sockets.size === 0) return
      const message: HostWsMessage = { type: 'event', detail }
      const data = JSON.stringify(message)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(data)
      }
    }
  }

  const disposeHttp = webCtx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        assertNotCrossSite(req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname

        // ---- status (read) ----
        if (req.method === 'GET' && path === `${API_PREFIX}/status`) {
          const sessionId = requireSessionId(url.searchParams.get('sessionId'), 'sessionId')
          const session = manager.get(sessionId)
          if (session === undefined) {
            sendJson(res, 200, {
              sessionId, running: false, pages: [], startedAt: null, lastUsedAt: null,
              idleDeadline: null, lastScreenshot: null, screencastActive: false, error: null,
            })
            return
          }
          wire(session)
          sendJson(res, 200, await session.status())
          return
        }

        // ---- screenshots (read) ----
        if (req.method === 'GET' && path === `${API_PREFIX}/screenshots`) {
          const sessionId = requireSessionId(url.searchParams.get('sessionId'), 'sessionId')
          const session = manager.get(sessionId)
          if (session === undefined) {
            sendJson(res, 200, { entries: [] })
            return
          }
          sendJson(res, 200, { entries: screenshotHistory(session.screenshotsDir) })
          return
        }

        // ---- screenshot file (read, whitelisted name) ----
        if (req.method === 'GET' && path === `${API_PREFIX}/screenshot-file`) {
          const sessionId = requireSessionId(url.searchParams.get('sessionId'), 'sessionId')
          const name = url.searchParams.get('name') ?? ''
          if (!SHOT_NAME_RE.test(name)) {
            sendJson(res, 400, { error: '截图文件名无效' })
            return
          }
          const session = manager.get(sessionId)
          if (session === undefined) {
            sendJson(res, 404, { error: '会话无 Chrome 窗口' })
            return
          }
          let buffer: Buffer
          try {
            buffer = await readFile(join(session.screenshotsDir, name))
          } catch {
            sendJson(res, 404, { error: '截图文件不存在' })
            return
          }
          const type = name.endsWith('.png') ? 'image/png' : 'image/jpeg'
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': buffer.length })
          res.end(buffer)
          return
        }

        // ---- mutations: same-origin + JSON body required ----
        assertSameOrigin(req)
        const body = await readJsonBody(req)
        const sessionId = requireSessionId(body.sessionId, 'sessionId')

        if (req.method === 'POST' && path === `${API_PREFIX}/open`) {
          const session = await manager.getOrLaunch(sessionId, typeof body.url === 'string' ? body.url : undefined)
          wire(session)
          sendJson(res, 200, { ok: true, status: await session.status() })
          return
        }

        if (req.method === 'POST' && path === `${API_PREFIX}/close`) {
          await manager.close(sessionId)
          sendJson(res, 200, { ok: true })
          return
        }

        if (req.method === 'POST' && path === `${API_PREFIX}/reload`) {
          const session = await manager.getOrLaunch(sessionId)
          wire(session)
          await session.run(async () => {
            const page = await session.ensurePage()
            if (page === undefined) throw new Error('没有可用的标签页。')
            await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
          })
          sendJson(res, 200, { ok: true, status: await session.status() })
          return
        }

        if (req.method === 'POST' && path === `${API_PREFIX}/navigate`) {
          const action = body.action
          if (action !== 'goto' && action !== 'back' && action !== 'forward') {
            sendJson(res, 400, { error: 'action 必须是 goto/back/forward' })
            return
          }
          const session = await manager.getOrLaunch(sessionId)
          wire(session)
          await session.run(async () => {
            const page = await session.ensurePage()
            if (page === undefined) throw new Error('没有可用的标签页。')
            if (action === 'goto') {
              const target = String(body.url ?? '')
              if (target.trim() === '') throw new Error('goto 需要 url')
              await page.goto(normalizeUrl(target), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
            } else if (action === 'back') {
              await page.goBack({ timeout: NAV_TIMEOUT_MS }).catch(() => page.goBack())
            } else {
              await page.goForward({ timeout: NAV_TIMEOUT_MS }).catch(() => page.goForward())
            }
          })
          sendJson(res, 200, { ok: true, status: await session.status() })
          return
        }

        if (req.method === 'POST' && path === `${API_PREFIX}/tabs`) {
          const action = body.action
          const session = await manager.getOrLaunch(sessionId)
          wire(session)
          await session.run(async () => {
            if (action === 'select') {
              const index = typeof body.index === 'number' ? body.index : session.selectedIndex
              await session.selectPage(index)
              return
            }
            if (action === 'close') {
              const index = typeof body.index === 'number' ? body.index : session.selectedIndex
              await session.closeTab(index)
              return
            }
            if (action === 'new') {
              const url = typeof body.url === 'string' && body.url.trim() !== '' ? body.url : undefined
              await session.newTab(url)
              return
            }
            throw new Error('action 必须是 list/select/close/new')
          })
          sendJson(res, 200, { ok: true, status: await session.status() })
          return
        }

        sendJson(res, 404, { error: '未知的 dsh-chrome API 路径' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = message.includes('跨站') || message.includes('Origin') || message.includes('Content-Type') ? 403 : 400
        sendJson(res, status, { error: message })
      }
    },
  })

  // ---- WebSocket upgrade: live screencast + status fan-out ----
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!SESSION_ID_RE.test(sessionId)) {
      socket.close(1008, 'invalid sessionId')
      return
    }
    let set = viewers.get(sessionId)
    if (set === undefined) {
      set = new Set()
      viewers.set(sessionId, set)
    }
    set.add(socket)
    const token = { sessionId }
    // Welcome with the live status, then start pushing frames while watched.
    const session = manager.get(sessionId)
    if (session !== undefined) {
      wire(session)
      void session.status().then((status) => {
        if (socket.readyState !== WebSocket.OPEN) return
        const welcome: HostWsMessage = { type: 'welcome', status }
        socket.send(JSON.stringify(welcome))
      })
    }
    void manager.getOrLaunch(sessionId).then((launched) => {
      wire(launched)
      void launched.addScreencastWatcher(token).catch(() => {})
    })
    socket.on('message', (raw) => {
      let message: ClientWsMessage
      try {
        message = JSON.parse(String(raw)) as ClientWsMessage
      } catch {
        return
      }
      if (message.type === 'ping') {
        const pong: HostWsMessage = { type: 'pong' }
        socket.send(JSON.stringify(pong))
      }
    })
    socket.on('close', () => {
      set.delete(socket)
      if (set.size === 0) viewers.delete(sessionId)
      const live = manager.get(sessionId)
      if (live !== undefined) void live.removeScreencastWatcher(token)
    })
    socket.on('error', () => { /* close handler owns cleanup */ })
  })

  const disposeUpgrade = webCtx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      // Same cross-site hardening as the HTTP reads (Sec-Fetch-Site).
      if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    },
  })

  return () => {
    disposeHttp()
    disposeUpgrade()
    for (const timer of statusTimers.values()) clearTimeout(timer)
    statusTimers.clear()
    for (const sockets of viewers.values()) {
      for (const socket of sockets) socket.close(1001, 'plugin unloaded')
    }
    viewers.clear()
    wired.clear()
    wss.close()
  }
}
