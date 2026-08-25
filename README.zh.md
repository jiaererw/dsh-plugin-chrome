# dsh-plugin-chrome

> DeepSeek Harness 浏览器可视化插件：为每个会话打开一个**真实可见的 Chrome 窗口**，Agent 通过 `chrome_*` 工具集操作浏览器，你在 Web GUI 的「Chrome」标签页里**实时观看画面流**，随时可以手动接管。

| | |
|---|---|
| ![browsing](assets/screenshot-1-bing.jpg) | ![douyin](assets/screenshot-2-douyin.jpg) |

[![GitHub stars](https://img.shields.io/github/stars/jiaererw/dsh-plugin-chrome?style=flat-square)](https://github.com/jiaererw/dsh-plugin-chrome/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

[English](README.md)

## 目录

- [特性](#特性)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [常见问题](#常见问题)
- [开发](#开发)
- [License](#license)

## 特性

- **独立可见窗口**：每个 DSH 会话拥有一个独立 Chrome 窗口（真实窗口、非 headless），用户在旁边就能看到 Agent 的每一步操作；窗口使用隔离的 user-data-dir，与你的日常浏览器互不干扰。
- **实时画面流**：Web GUI「Chrome」标签页通过 Chrome screencast 实时显示页面画面（页面活跃时秒级流畅）；页面静止时由心跳兜底强制截帧（约 2 秒一帧：3 秒无真实帧即触发），画面不会冻结。
- **完整的 Agent 工具集**（16 个工具）：`chrome_open` / `chrome_status` / `chrome_close` / `chrome_navigate` / `chrome_tabs` / `chrome_snapshot` / `chrome_screenshot` / `chrome_click` / `chrome_click_at` / `chrome_fill` / `chrome_type` / `chrome_press_key` / `chrome_hover` / `chrome_scroll` / `chrome_evaluate` / `chrome_wait`。其中 `chrome_tabs` 支持 list / new / close / select；快照、截图与点击始终作用于「当前选中」的标签页。
- **无障碍树快照**：`chrome_snapshot` 输出紧凑的 a11y 树 + 稳定元素 uid，点击/填充直接按 uid 定位，比裸 DOM 省 token、抗脆弱选择器。
- **截图双通道**：`chrome_screenshot` 的图片既进模型上下文（图片块），也保存到会话截图目录并展示在面板里；历史记录带标题/URL/尺寸元数据，重启后仍在。（会话用纯文本模型？请看常见问题。）
- **安全设计**：CDP 不暴露固定端口；Web API 拒绝跨站请求（Sec-Fetch-Site）+ sessionId 白名单校验；浏览器数据按会话隔离。
- **资源治理**：空闲自动关闭（默认 10 分钟，可配置），`chrome_close` 显式关闭，插件卸载/宿主退出时全部收尾。

## 安装

> 前置：已安装 DeepSeek Harness（DSH），本机装有 Chrome 或 Edge。

```sh
# 方式一：从 GitHub 安装（推荐）
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:jiaererw/dsh-plugin-chrome

# 方式二：本地路径（开发调试）
npx -p @deepseek-ai/dsh dsh plugin --profile web add D:/harness/dsh-plugin-chrome
```

安装后**重启 DSH**，Web GUI 的会话顶部会出现「Chrome」标签页。

> 若你的 profile 的 `cordis.patch.yml` 里还留着早期本地开发时手动挂载的 `dsh-plugin-chrome` 行，请先删掉再走 CLI 安装，避免双挂载（两个 host 半、两个 Chrome 管理器）。

## 使用

### 给 Agent 用（工具）

安装后 Agent 自动获得 `chrome_*` 工具集。直接对 Agent 说：

> 打开 Chrome，访问 https://example.com，截个图，然后点页面里的「登录」按钮并填写用户名。

Agent 会：`chrome_open` → `chrome_navigate` → `chrome_screenshot`（看图）→ `chrome_snapshot`（拿 uid）→ `chrome_click` / `chrome_fill`。

### 给你看（可视化）

1. 打开会话顶部的「Chrome」标签页：
   - **实时画面**：Live 视图持续显示 Chrome 窗口画面。页面有活动时走 Chrome 原生 screencast 帧流（秒级流畅）；页面静止时由心跳兜底强制截帧（约 2 秒一帧），画面不会冻结。
   - **标签页管理**：右侧列表新建/切换/关闭标签页，与窗口同步。
   - **手动接管**：你随时可以在 Chrome 窗口里自己点几下——Agent 的下一次工具调用会看到你的改动。
2. **截图历史**：每次 `chrome_screenshot` 的产物都在「截图历史」里，点击缩略图放大。

### 窗口生命周期与容错

- **惰性启动**：首次调用任意 `chrome_*` 工具（或点击面板「打开窗口」）时才拉起 Chrome。
- **接管遗留实例**：若 DSH 进程异常退出留下了孤儿 Chrome（profile 被锁），插件下次启动会通过 `DevToolsActivePort` 自动连接并接管该窗口（借鉴 chrome-devtools-mcp 的 autoConnect 机制），而不是报错。
- **空闲回收**：窗口空闲超过 `idleTimeoutMs`（默认 10 分钟）自动关闭；有 Web UI 观看实时画面时不回收。
- **无可用标签页时自动补页**：所有操作都会先确保存在一个可用的普通标签页，避免「窗口开着但全是 chrome:// 内部页」时的死锁。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件行配置（整段 config 替换）：

```yaml
- id: dsh-plugin-chrome
  config:
    headless: false            # 保持 false：可见窗口是本插件的核心
    executablePath: ''         # 留空自动探测 Chrome/Edge；也可指定绝对路径
    idleTimeoutMs: 600000      # 空闲自动关闭（0=禁用）
    windowWidth: 1280
    windowHeight: 900
    screencastFrameSkip: 4     # 实时画面抽帧（1=最流畅）
    screencastQuality: 70      # JPEG 质量 1-100
    maxSnapshotText: 60000     # 单次快照最大字符数
    maxTabs: 16
    extraArgs: ''              # 追加的 Chrome 启动参数
```

数据目录（浏览器配置与截图）：`~/.dsh/data/dsh-plugin-chrome/sessions/<sessionId>/`（可用 `dataRoot` 覆盖）。

## 常见问题

- **点开 Chrome 标签页没画面**：确认窗口已运行（面板顶部状态点）；首次打开可能需数秒启动 Chrome。静止页面由心跳兜底刷新（约 2 秒一帧，3 秒无真实帧即触发），有内容变化时帧率自动提升。
- **Agent 报"未知元素 uid"**：页面已变化，让它重新 `chrome_snapshot`。
- **窗口被我自己关了**：面板状态会显示"窗口未打开"，下次任意 `chrome_*` 工具调用或点击「打开窗口」即可重启。
- **登录态问题**：每个会话的浏览器是独立 profile，登录态不复用日常浏览器；这是隔离设计，如需登录某网站请让 Agent 完成一次登录（session 期间保持）。
- **杀 DSH 后 Chrome 还开着**：孤儿窗口会在下次会话调用时被自动接管，或手动关闭即可；正常关闭 DSH（插件卸载）会连带关闭窗口。
- **截图后纯文本模型不再回复**：`chrome_screenshot` 会把图片作为图片块写入会话历史。如果当前会话的模型不支持图片输入，之后每一轮请求都会以 `UNSUPPORTED_CONTENT: does not accept image input` 被整体拒绝，会话不再响应，重试无效。请给会截图的会话使用支持视觉的模型，或避免在其中调用 `chrome_screenshot`。
- **安装被 pnpm strict-dep-builds 拦截**：在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 中加入 `dsh-plugin-chrome: true` 后重试安装。

## 开发

```sh
npm install
npm run typecheck   # host + client 两个 program
npm test            # vitest 单测
npm run test:e2e    # 真实 Chrome 端到端冒烟（会弹出可见窗口）
npm run build       # lib/index.js + lib/index.d.ts（host）、lib/client.js + lib/client.d.ts（client bundle）
npm run watch       # 开发时持续构建；client 变更经 HMR 热更，host 变更需重启 DSH
```

架构：host 半（cordis 插件）用 puppeteer-core 驱动本机 Chrome，注册 `chrome_*` 工具与 `/dsh-chrome/*` HTTP/WS API；client 半（浏览器 bundle）注册 `conversation.view` 的「Chrome」标签页，消费 API 与帧流。画面流 = Chrome 原生 screencast（活动页）+ 截图心跳（静止页兜底）。控制层借鉴 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)（CDP 控制、a11y 快照+uid 反查、等待机制、autoConnect 接管）与 [mcp-chrome](https://github.com/hangwin/mcp-chrome)（截图压缩、CDP 坐标输入、会话引用计数）的成熟设计。

## License

MIT
