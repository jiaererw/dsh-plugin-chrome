/**
 * The chrome_* agent tool suite.
 *
 * Every tool is session-scoped: the execution's agent session owns one
 * Chrome window, and all operations funnel through that session's serial
 * queue. Tools fail with readable Chinese messages instead of raw CDP
 * errors, so the model can self-correct (re-snapshot, re-open, re-select).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import {
  captureScreenshot, cdpSession, clickAt, clickUid, evaluateExpression, fillUid,
  hoverUid, NAV_TIMEOUT_MS, navigate, pressKey, scrollView, typeText,
  WAIT_TIMEOUT_MS, waitForText,
} from './actions.ts'
import type { ResolvedConfig } from './config.ts'
import type { ChromeManager, SessionChrome } from './manager.ts'
import { resolveUid, snapshotPage } from './snapshot.ts'
import { appendShot } from './shots.ts'
import type { ChromeStatus, PageInfo, ScreenshotEntry } from '../shared/contract.ts'

/** Dependency bundle threaded through every tool factory. */
export interface ToolDeps {
  manager: ChromeManager
  config: ResolvedConfig
  /**
   * Attach one image to the model stream (via ctx.attachments). Absent in
   * surfaces without the attachment service — the tool then reports the
   * saved file path instead of an inline image.
   */
  attachImage?: (data: Uint8Array, mediaType: 'image/png' | 'image/jpeg') => Promise<ImageAttachmentRef>
}

/** Extract the calling agent's session id (tools only run for an agent). */
function sessionIdOf(exec: ToolRunContext): string {
  const sessionId = exec.agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('chrome_* 工具只能在 Agent 会话中调用（缺少发起会话）。')
  }
  return sessionId
}

/** Resolve the session window and its control page (launching when needed). */
async function resolveTarget(manager: ChromeManager, sessionId: string): Promise<{ session: SessionChrome; pageIndex: number }> {
  const session = await manager.getOrLaunch(sessionId)
  await session.ensurePage()
  return { session, pageIndex: session.selectedIndex }
}

/** Serialize the caller's signal into a readable abort error. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('操作已取消。')
}

/** Format one page row for list output. */
function pageLine(page: PageInfo): string {
  const marker = page.selected ? '▶' : ' '
  const title = (page.title || page.url).slice(0, 60)
  return `${marker} [${page.index}] ${title} ${page.url}`
}

/** Render a status object as compact model text. */
export function formatStatus(status: ChromeStatus): string {
  if (!status.running) {
    return `Chrome 窗口未运行（会话 ${status.sessionId.slice(0, 8)}）。用 chrome_open 打开。${status.error ? `\n错误：${status.error}` : ''}`
  }
  const lines = [`Chrome 窗口运行中（会话 ${status.sessionId.slice(0, 8)}），${status.pages.length} 个标签页：`]
  for (const page of status.pages) lines.push(pageLine(page))
  if (status.lastScreenshot !== null) lines.push(`最近截图：${status.lastScreenshot}`)
  return lines.join('\n')
}

/** One-shot tool builder shared by the whole suite. */
type RegisterFn = (tool: ReturnType<typeof defineTool>) => void

/** chrome_open — open (or reuse) the session's visible Chrome window. */
function openTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_open',
    description: '打开（或复用）本会话专属的可见 Chrome 窗口，并返回当前状态。窗口是真实的、用户可以看到并手动操作的浏览器；首次调用会自动启动 Chrome（惰性启动）。可选参数 url 指定窗口打开后立即导航到的地址（缺省显示欢迎页）。窗口保持打开直到 chrome_close 或空闲超时。任何 chrome_* 工具在窗口未打开时都会自动触发打开，因此本工具主要用于显式控制生命周期或指定初始地址。',
    parameters: {
      url: { type: 'string', description: '打开后立即导航到的 URL（可省略协议，如 example.com）。缺省显示欢迎页。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'boolean', required: true, description: '窗口是否运行' },
          pages: { type: 'integer', required: true, description: '标签页数量' },
          text: { type: 'string', required: true, description: '给模型的状态摘要' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const session = await deps.manager.getOrLaunch(sessionId, args.url)
      const status = await session.status()
      return {
        running: status.running,
        pages: status.pages.length,
        text: `Chrome 窗口已打开（会话 ${sessionId.slice(0, 8)}）。\n${formatStatus(status)}`,
      }
    },
  })
}

/** chrome_status — report window/tab state. */
function statusTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_status',
    description: '查询本会话 Chrome 窗口的状态：是否运行、标签页列表（序号/标题/URL/当前选中）、启动与最近活动时间、最近截图。用于确认窗口状态、恢复上下文（例如不确定上次操作后页面处于哪个标签）或检查空闲关闭倒计时。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          running: { type: 'boolean', required: true, description: '窗口是否运行' },
          text: { type: 'string', required: true, description: '给模型的状态摘要' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const session = deps.manager.get(sessionId)
      const status = session !== undefined ? await session.status() : { sessionId, running: false, pages: [], startedAt: null, lastUsedAt: null, idleDeadline: null, lastScreenshot: null, screencastActive: false, error: null }
      return { running: status.running, text: formatStatus(status) }
    },
  })
}

/** chrome_close — close the session window. */
function closeTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_close',
    description: '关闭本会话的 Chrome 窗口（含所有标签页）。用户手动关窗后也无需再调用。关闭后再次调用任何 chrome_* 工具都会重新打开一个新窗口。适合在浏览器任务完成、需要释放资源或用户要求结束时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      await deps.manager.close(sessionId)
      return { text: `Chrome 窗口已关闭（会话 ${sessionId.slice(0, 8)}）。` }
    },
  })
}

/** chrome_navigate — goto/back/forward/reload the control page. */
function navigateTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_navigate',
    description: '控制当前标签页导航：goto 打开新地址（可省略协议，自动补 https://）、back/forward 历史前进后退、reload 刷新。goto 会等待页面加载（默认 30 秒超时）后返回当前标签页状态。导航后如需定位页面元素，先调用 chrome_snapshot。',
    parameters: {
      action: {
        type: 'string',
        enum: ['goto', 'back', 'forward', 'reload'],
        required: true,
        description: '导航动作：goto=打开 url；back=后退；forward=前进；reload=刷新当前页',
      },
      url: { type: 'string', description: 'action=goto 时的目标地址（可省略协议，如 example.com）' },
      timeout: { type: 'integer', description: 'goto 超时毫秒数（默认 30000）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: '导航后当前 URL' },
          title: { type: 'string', required: true, description: '导航后页面标题' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已导航到：${value.title || '(无标题)'} ${value.url}` }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session, pageIndex } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const timeout = args.timeout ?? NAV_TIMEOUT_MS
        if (args.action === 'goto') {
          const url = args.url ?? ''
          if (url.trim() === '') throw new Error('action=goto 时必须提供 url。')
          await navigate(page, url, timeout)
        } else if (args.action === 'back') {
          await page.goBack({ timeout }).catch(() => page.goBack())
        } else if (args.action === 'forward') {
          await page.goForward({ timeout }).catch(() => page.goForward())
        } else {
          await page.reload({ waitUntil: 'domcontentloaded', timeout })
        }
        const title = await page.title().catch(() => '')
        session.notify({ kind: 'navigated', index: pageIndex, url: page.url(), title })
        return { url: page.url(), title }
      })
    },
  })
}

/** chrome_tabs — list/new/close/select tabs. */
function tabsTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_tabs',
    description: '管理 Chrome 窗口的标签页：list 列出全部标签页（序号/标题/URL/当前选中标记）；new 新建标签页（可选 url）；close 关闭指定序号标签页（关掉控制页后自动切到相邻标签）；select 切换当前控制的标签页。chrome_snapshot/chrome_screenshot 等操作都作用于"当前选中"的标签页，多标签场景请先 select 再操作。',
    parameters: {
      action: { type: 'string', enum: ['list', 'new', 'close', 'select'], required: true, description: '操作类型' },
      index: { type: 'integer', description: 'close/select 时的标签页序号（list 输出中的 [N]；缺省=当前选中）' },
      url: { type: 'string', description: 'action=new 时新标签页的初始地址（缺省为空白页）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        if (args.action === 'list') {
          const status = await session.status()
          return { text: formatStatus(status) }
        }
        if (args.action === 'new') {
          if ((await session.pages()).length >= deps.config.maxTabs) {
            throw new Error(`标签页数量已达上限 ${deps.config.maxTabs}，请先关闭不用的标签页。`)
          }
          await session.newTab(args.url !== undefined && args.url !== '' ? args.url : undefined)
          return { text: `已新建标签页 [${session.selectedIndex}]。` }
        }
        const index = args.index ?? session.selectedIndex
        if (args.action === 'select') {
          await session.selectPage(index)
          const page = await session.selected()
          return { text: `已切换到标签页 [${index}]：${page !== undefined ? await page.title().catch(() => '') : ''}` }
        }
        // close
        await session.closeTab(index)
        return { text: `已关闭标签页 [${index}]。` }
      })
    },
  })
}

/** chrome_snapshot — a11y tree with element uids. */
function snapshotTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_snapshot',
    description: '获取当前标签页的页面快照（无障碍树文本视图）。输出带缩进的元素树，每行形如 `[uid] role "名称"`，uid 是后续 chrome_click / chrome_fill / chrome_hover / chrome_screenshot(elementUid) 定位元素的句柄。快照远小于原始 HTML，只包含可见且有语义的内容。页面变化后 uid 可能失效，操作报"未知元素"时请重新快照。verbose=true 输出包含无语义节点的完整树（更大，调试时用）。',
    parameters: {
      verbose: { type: 'boolean', description: 'true=包含无语义节点（完整调试视图）；缺省=false 仅输出有名称/值的内容节点' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '快照文本' }, truncated: { type: 'boolean', required: true, description: '是否因长度上限截断' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session, pageIndex } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const result = await snapshotPage(page, pageIndex, { verbose: args.verbose === true, maxText: deps.config.maxSnapshotText })
        session.uidRegistry = result.uids
        return { text: result.text, truncated: result.truncated }
      })
    },
  })
}

/** chrome_screenshot — capture page/element screenshot. */
function screenshotTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_screenshot',
    description: '对当前标签页截图（视口、整页或指定元素）。截图保存到会话截图目录并自动显示在 Web GUI 的 Chrome 面板；模型同时获得图片内容（可直接看图）与文件路径。fullPage=true 截取整页（长页面会很高，慎用）；elementUid 截取某个元素（uid 来自 chrome_snapshot）；format 默认 png（jpeg 更小但无透明）。',
    parameters: {
      fullPage: { type: 'boolean', description: 'true=整页截图；缺省=false 只截视口' },
      elementUid: { type: 'string', description: '只截取该元素（uid 来自 chrome_snapshot）' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式（默认 png）' },
      quality: { type: 'integer', description: 'jpeg 质量 1-100（默认 85）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: '截图保存的绝对路径' },
          name: { type: 'string', required: true, description: '截图文件名' },
          width: { type: 'integer', required: true, description: '像素宽度' },
          height: { type: 'integer', required: true, description: '像素高度' },
          bytes: { type: 'integer', required: true, description: '文件字节数' },
          mediaType: { type: 'string', required: true, description: '图片 MIME 类型' },
          pageTitle: { type: 'string', required: true, description: '截图时页面标题' },
          url: { type: 'string', required: true, description: '截图时页面 URL' },
          attachment: {
            type: 'object',
            additionalProperties: false,
            description: '模型图片引用（内部字段，attachment 服务可用时存在）',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const attachment = value.attachment as ImageAttachmentRef | undefined
        const text = `截图已保存：${value.path}（${value.width}x${value.height}，${Math.round(value.bytes / 1024)}KB）`
        if (attachment !== undefined && typeof attachment.attachmentId === 'string') {
          return [{ type: 'image', attachment }, { type: 'text', text }]
        }
        return [{ type: 'text', text }]
      },
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session, pageIndex } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const format = args.format ?? 'png'
        let backendNodeId: number | undefined
        if (args.elementUid !== undefined && args.elementUid !== '') {
          backendNodeId = resolveUid(session.uidRegistry, args.elementUid, pageIndex)
        }
        const { buffer, width, height } = await captureScreenshot(page, {
          fullPage: args.fullPage === true && backendNodeId === undefined,
          format,
          quality: args.quality ?? 85,
          backendNodeId,
        })
        const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
        const name = `shot-${Date.now()}-${sessionId.slice(0, 8)}.${format}`
        const path = join(session.screenshotsDir, name)
        writeFileSync(path, buffer)
        const title = await page.title().catch(() => '')
        const url = page.url()
        const entry: ScreenshotEntry = {
          name, createdAt: Date.now(), bytes: buffer.length, width, height,
          fullPage: args.fullPage === true, pageTitle: title, url,
        }
        // Persist metadata so the Web GUI history survives restarts.
        appendShot(session.screenshotsDir, entry)
        let attachment: ImageAttachmentRef | undefined
        if (deps.attachImage !== undefined) {
          try {
            attachment = await deps.attachImage(new Uint8Array(buffer), mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png')
          } catch {
            attachment = undefined // attachment service rejected it; the file path still works
          }
        }
        session.notify({ kind: 'screenshot', entry })
        return {
          path, name, width, height, bytes: buffer.length, mediaType,
          pageTitle: title, url,
          attachment: attachment ?? undefined,
        }
      })
    },
  })
}

/** chrome_click — click the element behind a uid. */
function clickTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_click',
    description: '点击快照中的一个元素（uid 来自 chrome_snapshot）。点击前自动滚动到元素可见位置，点击后等待页面稳定。dblClick=true 双击。页面变化后 uid 失效（报"未知元素"）时请重新 chrome_snapshot。对复选框/单选按钮/下拉框等元素同样适用（真实点击）。',
    parameters: {
      uid: { type: 'string', required: true, description: '元素 uid（来自 chrome_snapshot 的 [uid] 行）' },
      dblClick: { type: 'boolean', description: 'true=双击；缺省单击' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session, pageIndex } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const backendNodeId = resolveUid(session.uidRegistry, args.uid, pageIndex)
        const cdp = await cdpSession(page)
        try {
          await clickUid(page, cdp, backendNodeId, args.dblClick === true)
        } finally {
          await cdp.detach().catch(() => {})
        }
        return { text: `已点击元素 ${args.uid}。页面可能已跳转或更新，建议需要时重新 chrome_snapshot。` }
      })
    },
  })
}

/** chrome_click_at — coordinate click. */
function clickAtTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_click_at',
    description: '在视口坐标 (x, y) 处点击（像素，原点=视口左上角）。用于点击快照中无法用 uid 定位的内容（如 canvas 图形、视频播放器），坐标通常来自 chrome_screenshot 图片观察。',
    parameters: {
      x: { type: 'integer', required: true, description: 'X 坐标（视口像素）' },
      y: { type: 'integer', required: true, description: 'Y 坐标（视口像素）' },
      dblClick: { type: 'boolean', description: 'true=双击；缺省单击' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const cdp = await cdpSession(page)
        try {
          await clickAt(page, cdp, args.x, args.y, args.dblClick === true)
        } finally {
          await cdp.detach().catch(() => {})
        }
        return { text: `已在视口坐标 (${args.x}, ${args.y}) 处点击。` }
      })
    },
  })
}

/** chrome_fill — fill an input-like element. */
function fillTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_fill',
    description: '向输入类元素填入文本：点击聚焦、全选现有内容、用输入事件替换为 value（与真实用户输入一致，会触发页面响应）。适用于文本框/搜索框/文本域/可编辑区域；复选框和单选按钮请用 chrome_click，文件上传/复杂组件请用 chrome_click 打开交互后继续。uid 来自 chrome_snapshot。',
    parameters: {
      uid: { type: 'string', required: true, description: '输入元素 uid（来自 chrome_snapshot）' },
      value: { type: 'string', required: true, description: '要填入的完整文本（会替换元素现有内容）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session, pageIndex } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const backendNodeId = resolveUid(session.uidRegistry, args.uid, pageIndex)
        const cdp = await cdpSession(page)
        try {
          await fillUid(page, cdp, backendNodeId, args.value)
        } finally {
          await cdp.detach().catch(() => {})
        }
        return { text: `已向元素 ${args.uid} 填入 ${args.value.length} 个字符。` }
      })
    },
  })
}

/** chrome_type — keyboard typing at focus. */
function typeTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_type',
    description: '在页面当前焦点处逐键输入文本（触发 keydown/keypress/input 事件）。先点击输入框获得焦点后使用；比 chrome_fill 更接近真实打字（适合搜索建议、快捷键响应等需要逐键事件的场景）。',
    parameters: {
      text: { type: 'string', required: true, description: '要逐键输入的文本' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        await typeText(page, args.text)
        return { text: `已输入 ${args.text.length} 个字符。` }
      })
    },
  })
}

/** chrome_press_key — single key press. */
function pressKeyTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_press_key',
    description: '按下单个按键或组合键（如 Enter、Escape、Tab、ArrowDown、PageDown、F5）。用于提交表单（Enter）、关闭弹窗（Escape）、下拉选择（ArrowDown+Enter）等。',
    parameters: {
      key: { type: 'string', required: true, description: '按键名：Enter/Escape/Tab/Backspace/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/PageUp/PageDown/Home/End/F5 或单个字符（如 a、1）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        await pressKey(page, args.key)
        return { text: `已按下 ${args.key}。` }
      })
    },
  })
}

/** chrome_hover — hover an element. */
function hoverTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_hover',
    description: '将鼠标悬停到快照元素上（uid 来自 chrome_snapshot），触发 hover 状态（下拉菜单、工具提示等）。',
    parameters: {
      uid: { type: 'string', required: true, description: '元素 uid（来自 chrome_snapshot）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session, pageIndex } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const backendNodeId = resolveUid(session.uidRegistry, args.uid, pageIndex)
        const cdp = await cdpSession(page)
        try {
          await hoverUid(cdp, backendNodeId)
        } finally {
          await cdp.detach().catch(() => {})
        }
        return { text: `已悬停在元素 ${args.uid} 上。` }
      })
    },
  })
}

/** chrome_scroll — viewport scrolling. */
function scrollTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_scroll',
    description: '滚动当前视口：direction=down 向下 / up 向上滚动 amount 像素（缺省滚动一屏高度）；to=top/bottom 直接滚到页首/页尾。滚动后如需继续定位元素请重新 chrome_snapshot。',
    parameters: {
      direction: { type: 'string', enum: ['down', 'up'], description: '滚动方向（默认 down）' },
      amount: { type: 'integer', description: '滚动像素数（缺省=一屏高度）' },
      to: { type: 'string', enum: ['top', 'bottom'], description: '直接滚到 top 页首 / bottom 页尾（优先于 direction）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const direction = args.direction ?? 'down'
        const viewport = page.viewport()
        const amount = args.amount ?? (viewport !== null ? Math.round(viewport.height * 0.8) : 600)
        await scrollView(page, direction, amount, args.to)
        return { text: args.to === 'top' ? '已滚到页首。' : args.to === 'bottom' ? '已滚到页尾。' : `已${direction === 'down' ? '向下' : '向上'}滚动 ${amount} 像素。` }
      })
    },
  })
}

/** chrome_evaluate — run JS in the page. */
function evaluateTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_evaluate',
    description: '在当前标签页执行 JavaScript 表达式并返回结果。expression 是函数体（支持 await），返回值会被 JSON 序列化。用于读取页面数据（document.title、localStorage、元素属性）、调用页面内函数或实现快照覆盖不到的精确操作。安全提示：该工具与 shell 同权限，不要执行不可信代码。',
    parameters: {
      expression: { type: 'string', required: true, description: 'JS 函数体，例如 return document.title；支持 async/await；return 的值即工具结果' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '给模型的结果说明（含序列化后的值）' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const value = await evaluateExpression(page, args.expression)
        let rendered: string
        try {
          rendered = JSON.stringify(value)
        } catch {
          rendered = String(value)
        }
        if (rendered === undefined) rendered = 'undefined'
        return { text: rendered.length > 8000 ? `${rendered.slice(0, 8000)}\n…（结果已截断）` : rendered }
      })
    },
  })
}

/** chrome_wait — wait for text to appear. */
function waitTool(deps: ToolDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'chrome_wait',
    description: '等待当前标签页正文出现指定文本（例如加载指示结束、AJAX 结果返回、弹窗出现）。text 为空时只等待页面稳定。默认超时 15 秒；超时不报错，返回 found=false 由调用方决定重试还是放弃。',
    parameters: {
      text: { type: 'string', description: '等待出现的文本（页面正文子串匹配）；缺省=只等待页面稳定' },
      timeout: { type: 'integer', description: '超时毫秒数（默认 15000）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: '超时前文本是否出现' },
          text: { type: 'string', required: true, description: '给模型的结果说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const sessionId = sessionIdOf(exec)
      const { session } = await resolveTarget(deps.manager, sessionId)
      return session.run(async () => {
        const page = await session.selected()
        if (page === undefined) throw new Error('没有可用的标签页。')
        const timeout = args.timeout ?? WAIT_TIMEOUT_MS
        if (args.text === undefined || args.text === '') {
          await page.waitForNetworkIdle({ timeout, idleTime: 500 }).catch(() => {})
          return { found: true, text: '页面已稳定。' }
        }
        const found = await waitForText(page, args.text, timeout)
        return { found, text: found ? `文本已出现：${args.text.slice(0, 60)}` : `等待超时（${timeout}ms），文本未出现：${args.text.slice(0, 60)}` }
      })
    },
  })
}

/** Register the full tool suite. */
export function registerTools(ctx: Context, deps: ToolDeps): () => void {
  const disposers: Array<() => void> = []
  const register: RegisterFn = (tool) => {
    disposers.push(ctx.tools.register(tool))
  }
  register(openTool(deps))
  register(statusTool(deps))
  register(closeTool(deps))
  register(navigateTool(deps))
  register(tabsTool(deps))
  register(snapshotTool(deps))
  register(screenshotTool(deps))
  register(clickTool(deps))
  register(clickAtTool(deps))
  register(fillTool(deps))
  register(typeTool(deps))
  register(pressKeyTool(deps))
  register(hoverTool(deps))
  register(scrollTool(deps))
  register(evaluateTool(deps))
  register(waitTool(deps))
  return () => {
    for (const dispose of disposers) dispose()
  }
}