/**
 * Chrome 面板样式（作为字符串内联注入，style[data-plugin] 可被 HMR 追踪）。
 * 仅用 --dsw-* 语义 token 之外的少量本地变量，适配明暗主题。
 */
export const CHROME_TAB_CSS = `
.dsh-chrome-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  font-family: inherit;
  color: var(--dsw-text-primary, #1f2328);
}
.dsh-chrome-tab__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsh-chrome-tab__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--dsw-fill-secondary, rgba(127,127,127,.12));
}
.dsh-chrome-tab__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #999;
}
.dsh-chrome-tab__dot--on { background: #2ea043; box-shadow: 0 0 6px rgba(46,160,67,.8); }
.dsh-chrome-tab__dot--off { background: #999; }
.dsh-chrome-tab button {
  appearance: none;
  border: 1px solid var(--dsw-border, rgba(127,127,127,.35));
  background: var(--dsw-fill-secondary, rgba(127,127,127,.08));
  color: inherit;
  font-size: 13px;
  padding: 5px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.dsh-chrome-tab button:hover:not(:disabled) { background: var(--dsw-fill-hover, rgba(127,127,127,.2)); }
.dsh-chrome-tab button:disabled { opacity: .45; cursor: default; }
.dsh-chrome-tab button.dsh-chrome-tab__primary {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
}
.dsh-chrome-tab button.dsh-chrome-tab__danger { color: #da3633; border-color: rgba(218,54,51,.5); }
.dsh-chrome-tab__error {
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(218,54,51,.12);
  border: 1px solid rgba(218,54,51,.4);
  color: #da3633;
  font-size: 13px;
  white-space: pre-wrap;
}
.dsh-chrome-tab__hint {
  font-size: 12px;
  opacity: .65;
  line-height: 1.6;
}
.dsh-chrome-tab__panel {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-height: 260px;
}
.dsh-chrome-tab__stage {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--dsw-border, rgba(127,127,127,.25));
  border-radius: 10px;
  background: #0d1117;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dsh-chrome-tab__stage canvas {
  display: block;
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
}
.dsh-chrome-tab__stage img {
  display: block;
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
}
.dsh-chrome-tab__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8b949e;
  font-size: 13px;
  text-align: center;
  padding: 16px;
}
.dsh-chrome-tab__badge {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(31,111,235,.85);
  color: #fff;
}
.dsh-chrome-tab__tabs {
  flex: 0 0 240px;
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid var(--dsw-border, rgba(127,127,127,.25));
  border-radius: 10px;
  padding: 4px;
}
.dsh-chrome-tab__tab {
  display: block;
  width: 100%;
  text-align: left;
  border: none !important;
  background: transparent !important;
  padding: 6px 8px !important;
  border-radius: 6px !important;
  font-size: 12px !important;
  line-height: 1.4;
  word-break: break-all;
}
.dsh-chrome-tab__tab--active { background: var(--dsw-fill-hover, rgba(31,111,235,.18)) !important; }
.dsh-chrome-tab__shots {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-chrome-tab__shot {
  border: 1px solid var(--dsw-border, rgba(127,127,127,.25));
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  width: 120px;
  background: transparent;
  padding: 0 !important;
}
.dsh-chrome-tab__shot img { width: 120px; height: 75px; object-fit: cover; display: block; }
.dsh-chrome-tab__shot div {
  font-size: 10px;
  padding: 3px 6px;
  opacity: .7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-chrome-tab__meta { font-size: 12px; opacity: .7; display: flex; gap: 12px; flex-wrap: wrap; }
`

/** 面板文案（zh/en 字典，通过 locale 系统注入）。 */
export const zh = {
  'tab.label': 'Chrome',
  'state.running': '窗口运行中',
  'state.stopped': '窗口未打开',
  'state.streaming': '实时画面',
  'state.shots': '截图历史',
  'action.open': '打开窗口',
  'action.close': '关闭窗口',
  'action.reload': '刷新页面',
  'action.newTab': '新建标签页',
  'action.select': '切换标签',
  'action.closeTab': '关闭标签',
  'hint.empty': 'Chrome 窗口尚未打开。点击「打开窗口」，或让 Agent 使用 chrome_open 工具——窗口会以独立可视窗口出现，Agent 的每一步操作你都能实时看到。',
  'hint.stream': '实时画面来自 Chrome screencast（约数帧/秒）。你随时可以直接在 Chrome 窗口里手动操作，Agent 会在下一个工具调用时看到你的改动。',
  'hint.shots': 'Agent 每次 chrome_screenshot 的产物都保存在这里（含标题/URL/尺寸，重启后仍在），点击缩略图放大查看。',
  'hint.idle': '空闲自动关闭',
  'hint.busy': '操作中…',
  'err.action': '操作失败',
  'meta.started': '启动于',
  'meta.lastUsed': '最近活动',
  'meta.tabs': '标签页',
  'meta.shotCount': '截图',
}

export const en = {
  'tab.label': 'Chrome',
  'state.running': 'Window running',
  'state.stopped': 'Window closed',
  'state.streaming': 'Live view',
  'state.shots': 'Screenshots',
  'action.open': 'Open window',
  'action.close': 'Close window',
  'action.reload': 'Reload page',
  'action.newTab': 'New tab',
  'action.select': 'Switch tab',
  'action.closeTab': 'Close tab',
  'hint.empty': 'The Chrome window is not open yet. Click "Open window" or let the agent call the chrome_open tool — the window appears as a separate visible browser and you can watch every agent action live.',
  'hint.stream': 'The live view streams from Chrome screencast (a few frames per second). You can operate the window yourself at any time; the agent sees your changes on its next tool call.',
  'hint.shots': 'Every chrome_screenshot the agent takes is kept here (title/URL/size metadata survives restarts). Click a thumbnail to enlarge.',
  'hint.idle': 'auto-close when idle',
  'hint.busy': 'working…',
  'err.action': 'action failed',
  'meta.started': 'started',
  'meta.lastUsed': 'last activity',
  'meta.tabs': 'tabs',
  'meta.shotCount': 'screenshots',
}
