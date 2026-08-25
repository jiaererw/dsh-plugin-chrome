/**
 * Chrome 控制面板（conversation.view 会话 Tab）。
 *
 * 左侧实时画面（screencast WebSocket 帧 → canvas），右侧标签页列表，
 * 顶部控制条（打开/关闭/刷新/新建标签/截图）+「截图历史」子视图。
 * 状态以 5s 轮询兜底、WebSocket 事件即时刷新；所有写操作走同源
 * POST API，会话 id 来自槽位 kit 的 sessionId。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChromeStatus, HostWsMessage, ScreenshotEntry } from '../shared/contract.ts'

/** Host endpoints (relative — same origin as the DSH GUI). */
const API = {
  status: (sessionId: string): string => `/dsh-chrome/api/status?sessionId=${encodeURIComponent(sessionId)}`,
  open: '/dsh-chrome/api/open',
  close: '/dsh-chrome/api/close',
  reload: '/dsh-chrome/api/reload',
  tabs: '/dsh-chrome/api/tabs',
  screenshot: '/dsh-chrome/api/screenshot-file',
  history: (sessionId: string): string => `/dsh-chrome/api/screenshots?sessionId=${encodeURIComponent(sessionId)}`,
  ws: (sessionId: string): string => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/dsh-chrome/ws?sessionId=${encodeURIComponent(sessionId)}`
  },
}

/** One panel sub-view. */
type View = 'live' | 'shots'

/** Locale-bound props (the plugin's own namespace). */
export interface ChromeTabProps {
  t: Translate
}

/** POST a JSON control message; throws with the server's error text. */
async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const payload = (await res.json()) as { error?: string }
      if (payload.error !== undefined) message = payload.error
    } catch { /* non-JSON error body: keep the status line */ }
    throw new Error(message)
  }
  return res.json() as Promise<unknown>
}

/** Format an epoch-ms timestamp for the meta line. */
function formatTime(epoch: number | null): string {
  if (epoch === null || epoch === 0) return '—'
  return new Date(epoch).toLocaleTimeString()
}

/** Countdown label for the idle auto-close deadline. */
function idleLabel(deadline: number | null, t: Translate): string {
  if (deadline === null) return ''
  const seconds = Math.max(0, Math.round((deadline - Date.now()) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return ` · ${t('hint.idle')} ${minutes}:${String(rest).padStart(2, '0')}`
}

/** The Chrome session tab. */
export function ChromeTab(props: ConvViewProps & ChromeTabProps): JSX.Element {
  const { sessionId, t } = props
  const [status, setStatus] = useState<ChromeStatus | null>(null)
  const [shots, setShots] = useState<ScreenshotEntry[]>([])
  const [view, setView] = useState<View>('live')
  const [enlarged, setEnlarged] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const statusRef = useRef<ChromeStatus | null>(null)
  statusRef.current = status

  /** Poll status + history (WebSocket covers instant updates; this is the fallback). */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(API.status(String(sessionId)), { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      setStatus((await res.json()) as ChromeStatus)
      const historyRes = await fetch(API.history(String(sessionId)), { cache: 'no-store' })
      if (historyRes.ok) {
        const payload = (await historyRes.json()) as { entries?: ScreenshotEntry[] }
        setShots(payload.entries ?? [])
      }
      setError(null)
    } catch {
      // Keep the last good snapshot; the hint line already explains absence.
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  /** Live stream: WebSocket welcome/status/event/frame handling. */
  useEffect(() => {
    let socket: WebSocket | null = null
    let closed = false
    const drawFrame = (data: string, width: number, height: number): void => {
      const canvas = canvasRef.current
      if (canvas === null || closed) return
      const image = new Image()
      image.onload = () => {
        if (closed || canvasRef.current !== canvas) return
        const scale = Math.min(1, (canvas.clientWidth || canvas.width) / Math.max(1, width))
        const targetWidth = Math.max(1, Math.round(width * scale))
        const targetHeight = Math.max(1, Math.round(height * scale))
        // Resizing resets the bitmap and flickers; only resize on change.
        if (canvas.width !== targetWidth) canvas.width = targetWidth
        if (canvas.height !== targetHeight) canvas.height = targetHeight
        const context = canvas.getContext('2d')
        context?.drawImage(image, 0, 0, targetWidth, targetHeight)
      }
      image.src = `data:image/jpeg;base64,${data}`
    }
    const connect = (): void => {
      if (closed) return
      try {
        socket = new WebSocket(API.ws(String(sessionId)))
      } catch {
        return // some browsers throw on bad URLs; polling keeps working
      }
      socket.onopen = () => {
        const ping: { type: 'ping' } = { type: 'ping' }
        socket?.send(JSON.stringify(ping))
      }
      socket.onmessage = (event) => {
        let message: HostWsMessage
        try {
          message = JSON.parse(String(event.data)) as HostWsMessage
        } catch {
          return
        }
        if (message.type === 'welcome' || message.type === 'status') setStatus(message.status)
        else if (message.type === 'frame') drawFrame(message.data, message.width, message.height)
        else if (message.type === 'event' && message.detail.kind === 'screenshot') {
          const entry = message.detail.entry
          setShots((current) => [entry, ...current].slice(0, 50))
        }
      }
      socket.onclose = () => {
        if (!closed) setTimeout(connect, 3000)
      }
      socket.onerror = () => { /* onclose follows; reconnect there */ }
    }
    connect()
    return () => {
      closed = true
      socket?.close()
    }
  }, [sessionId])

  /** Run one control action with busy feedback and error surfacing. */
  const runAction = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (caught) {
      setError(`${t('err.action')}：${caught instanceof Error ? caught.message : String(caught)}`)
    } finally {
      setBusy(false)
    }
  }, [refresh, t])

  const openWindow = useCallback(() => {
    void runAction(() => post(API.open, { sessionId: String(sessionId) }))
  }, [runAction, sessionId])
  const closeWindow = useCallback(() => {
    void runAction(() => post(API.close, { sessionId: String(sessionId) }))
  }, [runAction, sessionId])
  const reloadPage = useCallback(() => {
    void runAction(() => post(API.reload, { sessionId: String(sessionId) }))
  }, [runAction, sessionId])
  const newTab = useCallback(() => {
    void runAction(() => post(API.tabs, { sessionId: String(sessionId), action: 'new' }))
  }, [runAction, sessionId])
  const selectTab = useCallback((index: number) => {
    void runAction(() => post(API.tabs, { sessionId: String(sessionId), action: 'select', index }))
  }, [runAction, sessionId])
  const closeTab = useCallback((index: number) => {
    void runAction(() => post(API.tabs, { sessionId: String(sessionId), action: 'close', index }))
  }, [runAction, sessionId])

  const running = status?.running === true
  const streaming = status?.screencastActive === true
  const currentShot = shots[0]?.name ?? null
  const activeIndex = status?.pages.find((page) => page.selected)?.index ?? 0

  const hint = useMemo(() => {
    if (!running) return t('hint.empty')
    return view === 'live' ? t('hint.stream') : t('hint.shots')
  }, [running, view, t])

  return (
    <div className="dsh-chrome-tab">
      <div className="dsh-chrome-tab__bar">
        <span className="dsh-chrome-tab__state">
          <span className={`dsh-chrome-tab__dot ${running ? 'dsh-chrome-tab__dot--on' : 'dsh-chrome-tab__dot--off'}`} />
          {running ? t('state.running') : t('state.stopped')}
          {busy ? ` · ${t('hint.busy')}` : ''}
        </span>
        {running
          ? <>
              <button onClick={reloadPage} disabled={busy}>{t('action.reload')}</button>
              <button onClick={newTab} disabled={busy}>{t('action.newTab')}</button>
              <button onClick={closeWindow} disabled={busy} className="dsh-chrome-tab__danger">{t('action.close')}</button>
            </>
          : <button onClick={openWindow} disabled={busy} className="dsh-chrome-tab__primary">{t('action.open')}</button>}
        <button onClick={() => setView('live')} disabled={view === 'live'}>{t('state.streaming')}</button>
        <button onClick={() => setView('shots')} disabled={view === 'shots'}>{t('state.shots')}</button>
      </div>

      {error !== null && <div className="dsh-chrome-tab__error">{error}</div>}
      <div className="dsh-chrome-tab__hint">{hint}</div>

      {running && view === 'live' && (
        <div className="dsh-chrome-tab__panel">
          <div className="dsh-chrome-tab__stage">
            {streaming && <span className="dsh-chrome-tab__badge">LIVE</span>}
            {streaming
              ? <canvas ref={canvasRef} width={640} height={360} aria-label={t('state.streaming')} />
              : (currentShot !== null
                  ? <img src={`${API.screenshot}?sessionId=${encodeURIComponent(String(sessionId))}&name=${encodeURIComponent(currentShot)}`} alt="screenshot" />
                  : <div className="dsh-chrome-tab__empty">…</div>)}
          </div>
          <div className="dsh-chrome-tab__tabs">
            {(status?.pages ?? []).map((page) => (
              <div key={page.index} style={{ display: 'flex', gap: 2 }}>
                <button
                  className={`dsh-chrome-tab__tab ${page.selected ? 'dsh-chrome-tab__tab--active' : ''}`}
                  onClick={() => selectTab(page.index)}
                  title={`${t('action.select')} [${page.index}]`}
                >
                  {page.index === activeIndex ? '▶ ' : ''}{page.title || page.url || `[${page.index}]`}
                </button>
                <button
                  className="dsh-chrome-tab__tab"
                  style={{ flex: '0 0 auto', paddingLeft: 4, paddingRight: 4 }}
                  onClick={() => closeTab(page.index)}
                  title={`${t('action.closeTab')} [${page.index}]`}
                >✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {running && view === 'shots' && (
        <div className="dsh-chrome-tab__shots">
          {shots.length === 0 && <div className="dsh-chrome-tab__hint">—</div>}
          {shots.map((shot) => (
            <button key={shot.name} className="dsh-chrome-tab__shot" onClick={() => setEnlarged(shot.name)} title={shot.url || shot.name}>
              <img src={`${API.screenshot}?sessionId=${encodeURIComponent(String(sessionId))}&name=${encodeURIComponent(shot.name)}`} alt={shot.pageTitle || shot.name} loading="lazy" />
              <div>{shot.pageTitle || new Date(shot.createdAt).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}

      {enlarged !== null && (
        <div className="dsh-chrome-tab__stage" onClick={() => setEnlarged(null)}>
          <img src={`${API.screenshot}?sessionId=${encodeURIComponent(String(sessionId))}&name=${encodeURIComponent(enlarged)}`} alt={enlarged} />
        </div>
      )}

      <div className="dsh-chrome-tab__meta">
        <span>{t('meta.started')} {formatTime(status?.startedAt ?? null)}</span>
        <span>{t('meta.lastUsed')} {formatTime(status?.lastUsedAt ?? null)}{idleLabel(status?.idleDeadline ?? null, t)}</span>
        <span>{t('meta.tabs')} {status?.pages.length ?? 0}</span>
        <span>{t('meta.shotCount')} {shots.length}</span>
      </div>
    </div>
  )
}
