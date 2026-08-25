/**
 * Page-level operations behind the chrome_* tools: coordinate input through
 * CDP, keyboard through puppeteer, navigation, waiting, and screenshots.
 *
 * Clicking targets backend node ids (from the a11y snapshot) directly:
 * scroll-into-view → border box center → Input.dispatchMouseEvent, which is
 * exactly the CDP path chrome-devtools-mcp's click_at uses and avoids
 * fragile CSS selectors entirely.
 */
import type { CDPSession, KeyInput, Page } from 'puppeteer-core'

/** Default navigation timeout for chrome_navigate. */
export const NAV_TIMEOUT_MS = 30000

/** Default wait timeout for chrome_wait. */
export const WAIT_TIMEOUT_MS = 15000

/** Schemes never passed to navigation (classic script-injection vectors). */
const BLOCKED_URL_SCHEMES = /^(javascript|vbscript):/iu

/**
 * Normalize a user/model-supplied URL: bare hostnames get https://, already
 * schemed URLs pass through (http/https/data/about/file/…), and classic
 * script-vector schemes are rejected outright.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (BLOCKED_URL_SCHEMES.test(trimmed)) {
    throw new Error(`已阻止不安全的 URL 协议：${trimmed.slice(0, 40)}`)
  }
  return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** A fresh CDP session for one page (input + DOM domains). */
export async function cdpSession(page: Page): Promise<CDPSession> {
  const session = await page.target().createCDPSession()
  await session.send('DOM.enable')
  return session
}

/** Center point of an element's border box (CSS px, viewport-relative). */
export async function elementCenter(session: CDPSession, backendNodeId: number): Promise<{ x: number; y: number }> {
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const model = await session.send('DOM.getBoxModel', { backendNodeId })
  const quad = model.model?.border ?? model.model?.content
  if (quad === undefined || quad.length < 8) {
    throw new Error('无法获取元素的屏幕位置（元素可能已从页面移除）。')
  }
  let x = 0
  let y = 0
  for (let i = 0; i < 8; i += 2) {
    x += quad[i]
    y += quad[i + 1]
  }
  return { x: x / 4, y: y / 4 }
}

/** Dispatch one mouse event through the CDP session. */
export async function mouseEvent(session: CDPSession, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: number, y: number, opts: {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
} = {}): Promise<void> {
  await session.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: opts.button ?? 'left',
    clickCount: opts.clickCount ?? 1,
    pointerType: 'mouse',
  })
}

/** Click the element behind a uid (single or double). */
export async function clickUid(page: Page, session: CDPSession, backendNodeId: number, dblClick: boolean): Promise<void> {
  const { x, y } = await elementCenter(session, backendNodeId)
  const clicks = dblClick ? 2 : 1
  await mouseEvent(session, 'mouseMoved', x, y)
  for (let i = 0; i < clicks; i += 1) {
    await mouseEvent(session, 'mousePressed', x, y, { clickCount: i + 1 })
    await mouseEvent(session, 'mouseReleased', x, y, { clickCount: i + 1 })
  }
  await waitForQuiescence(page)
}

/** Click at raw viewport coordinates. */
export async function clickAt(page: Page, session: CDPSession, x: number, y: number, dblClick: boolean): Promise<void> {
  const clicks = dblClick ? 2 : 1
  await mouseEvent(session, 'mouseMoved', x, y)
  for (let i = 0; i < clicks; i += 1) {
    await mouseEvent(session, 'mousePressed', x, y, { clickCount: i + 1 })
    await mouseEvent(session, 'mouseReleased', x, y, { clickCount: i + 1 })
  }
  await waitForQuiescence(page)
}

/** Hover the element behind a uid. */
export async function hoverUid(session: CDPSession, backendNodeId: number): Promise<void> {
  const { x, y } = await elementCenter(session, backendNodeId)
  await mouseEvent(session, 'mouseMoved', x, y)
}

/**
 * Fill an input-like element: click to focus, select everything, then
 * insert the text (replacing the selection fires input events like a real
 * user paste-into-selected flow).
 */
export async function fillUid(page: Page, session: CDPSession, backendNodeId: number, value: string): Promise<void> {
  await clickUid(page, session, backendNodeId, false)
  // Select-all modifier differs per platform: Meta on macOS, Control elsewhere.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  await page.keyboard.press('KeyA')
  await page.keyboard.up(modifier)
  await session.send('Input.insertText', { text: value })
  await waitForQuiescence(page)
}

/** Type text at the current focus. */
export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 20 })
  await waitForQuiescence(page)
}

/** Press one key (e.g. 'Enter', 'Tab', 'Escape', 'a', 'F5'). */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key as KeyInput)
  await waitForQuiescence(page)
}

/** Scroll the viewport by an amount, or jump to top/bottom. */
export async function scrollView(page: Page, direction: 'up' | 'down', amountPx: number, to: 'top' | 'bottom' | undefined): Promise<void> {
  await page.evaluate(({ direction, amountPx, to }) => {
    if (to === 'top') window.scrollTo({ top: 0 })
    else if (to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight })
    else window.scrollBy({ top: direction === 'down' ? amountPx : -amountPx })
  }, { direction, amountPx, to })
  await waitForQuiescence(page)
}

/**
 * Wait for the page to stop churning after an action: navigation settles
 * (puppeteer's own waiters cover goto), then a page-side MutationObserver
 * watches for a quiet window. Bounded — never stalls a tool call forever.
 * @param page - target page.
 * @param stableMs - required quiet period (default 100ms).
 * @param timeoutMs - overall cap (default 1500ms).
 */
export async function waitForQuiescence(page: Page, stableMs = 100, timeoutMs = 1500): Promise<void> {
  try {
    await page.waitForFunction(
      (stable) => new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const observer = new MutationObserver(() => {
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            observer.disconnect()
            resolve()
          }, stable)
        })
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
        timer = setTimeout(() => {
          observer.disconnect()
          resolve()
        }, stable)
      }),
      { timeout: timeoutMs },
      stableMs,
    )
  } catch {
    // Timeout is fine: the page is simply busy; navigation waiters already
    // covered the load, this is only a soft stabilization hint.
  }
}

/** Wait until the page body contains the given text. */
export async function waitForText(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (needle) => document.body !== null && document.body.innerText.includes(needle),
      { timeout: timeoutMs },
      text,
    )
    return true
  } catch {
    return false
  }
}

/** Evaluate an expression in the page (async expressions supported). */
export async function evaluateExpression(page: Page, expression: string): Promise<unknown> {
  const wrapped = `return (async () => {\n${expression}\n})()`
  const fn = new Function(wrapped) as () => Promise<unknown>
  return page.evaluate(fn)
}

/** Capture a viewport/full-page/element screenshot as a JPEG/PNG buffer. */
export async function captureScreenshot(page: Page, opts: {
  fullPage: boolean
  format: 'jpeg' | 'png'
  quality?: number
  backendNodeId?: number
}): Promise<{ buffer: Buffer; width: number; height: number }> {
  if (opts.backendNodeId !== undefined) {
    const session = await cdpSession(page)
    try {
      const model = await session.send('DOM.getBoxModel', { backendNodeId: opts.backendNodeId })
      const quad = model.model?.border ?? model.model?.content
      if (quad === undefined || quad.length < 8) {
        throw new Error('无法截取该元素：它可能已从页面移除。')
      }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < 8; i += 2) {
        minX = Math.min(minX, quad[i])
        maxX = Math.max(maxX, quad[i])
        minY = Math.min(minY, quad[i + 1])
        maxY = Math.max(maxY, quad[i + 1])
      }
      const width = Math.max(1, Math.round(maxX - minX))
      const height = Math.max(1, Math.round(maxY - minY))
      const buf = await page.screenshot({
        type: opts.format,
        quality: opts.format === 'jpeg' ? opts.quality : undefined,
        clip: { x: minX, y: minY, width, height },
      })
      return { buffer: Buffer.from(buf), width, height }
    } finally {
      await session.detach().catch(() => {})
    }
  }
  // Element-free captures: measure the viewport or the full document first,
  // then capture. Measurement must not scroll (screenshot re-scrolls itself).
  // With defaultViewport: null, page.viewport() is null, so the viewport
  // size must come from the page itself (window.innerWidth/Height).
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth || document.body?.scrollWidth || window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight || document.body?.scrollHeight || window.innerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }))
  const width = opts.fullPage ? Math.max(1, size.scrollWidth) : Math.max(1, size.innerWidth)
  const height = opts.fullPage ? Math.max(1, size.scrollHeight) : Math.max(1, size.innerHeight)
  const buf = await page.screenshot({
    type: opts.format,
    quality: opts.format === 'jpeg' ? opts.quality : undefined,
    fullPage: opts.fullPage,
  })
  return { buffer: Buffer.from(buf), width, height }
}

/** Navigate the page (goto with permissive load gate). */
export async function navigate(page: Page, url: string, timeoutMs: number): Promise<void> {
  await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  await waitForQuiescence(page)
}
