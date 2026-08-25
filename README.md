# dsh-plugin-chrome

> A DeepSeek Harness browser visualization plugin: opens a **real, visible Chrome window** per session, lets the agent drive the browser through the `chrome_*` tool suite, and streams the **live view** into a Chrome tab in the Web GUI — take over manually at any time.

| | |
|---|---|
| ![browsing](assets/screenshot-1-bing.jpg) | ![douyin](assets/screenshot-2-douyin.jpg) |

[![GitHub stars](https://img.shields.io/github/stars/jiaererw/dsh-plugin-chrome?style=flat-square)](https://github.com/jiaererw/dsh-plugin-chrome/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

[中文文档](README.zh.md)

## Contents

- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## Features

- **A visible window per session**: every DSH session gets its own Chrome window (a real window, not headless). Watch every agent action as it happens; the window uses an isolated user-data-dir, so it never mixes with your daily browser.
- **Live view**: the Chrome tab in the Web GUI streams the window through Chrome screencast (smooth while pages are active). A screenshot heartbeat keeps idle pages from freezing — a forced frame about every 2 seconds once the stream has been silent for 3 seconds.
- **Complete agent tool suite** (16 tools): `chrome_open` / `chrome_status` / `chrome_close` / `chrome_navigate` / `chrome_tabs` / `chrome_snapshot` / `chrome_screenshot` / `chrome_click` / `chrome_click_at` / `chrome_fill` / `chrome_type` / `chrome_press_key` / `chrome_hover` / `chrome_scroll` / `chrome_evaluate` / `chrome_wait`. `chrome_tabs` covers list / new / close / select, and snapshots, screenshots and clicks always act on the selected tab.
- **Accessibility-tree snapshots**: `chrome_snapshot` returns a compact a11y tree with stable element uids; clicks and fills target uids directly — far lighter than DOM dumps and robust against fragile selectors.
- **Dual-channel screenshots**: `chrome_screenshot` sends the image into the model context (as an image block) AND saves it to the session's screenshot history shown in the panel — history entries keep title/URL/size metadata across restarts. (Running a text-only model? See the FAQ.)
- **Security-minded**: CDP never exposes a fixed port; the Web API rejects cross-site requests (Sec-Fetch-Site) and whitelist-validates sessionId; browser data is isolated per session.
- **Resource governance**: idle windows auto-close (default 10 min, configurable), `chrome_close` closes explicitly, and plugin unload / host shutdown closes every window it opened.

## Install

> Prerequisites: DeepSeek Harness (DSH) installed, and Chrome or Edge on the machine.

```sh
# Option 1: install from GitHub (recommended)
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:jiaererw/dsh-plugin-chrome

# Option 2: local path (development)
npx -p @deepseek-ai/dsh dsh plugin --profile web add D:/harness/dsh-plugin-chrome
```

Restart DSH after installing — a **Chrome** tab appears at the top of every conversation.

> If your profile's `cordis.patch.yml` still carries an old manual mount line for `dsh-plugin-chrome` (from local development), remove it before installing through the CLI to avoid double-mounting.

## Usage

### For the agent (tools)

The agent gets the `chrome_*` suite automatically. Just ask it:

> Open Chrome, go to https://example.com, take a screenshot, then click the "Login" button and fill in the username.

The agent will: `chrome_open` → `chrome_navigate` → `chrome_screenshot` (sees the image) → `chrome_snapshot` (gets uids) → `chrome_click` / `chrome_fill`.

### For you (visualization)

1. Open the **Chrome** tab at the top of the conversation:
   - **Live view**: continuously shows the window. Native screencast frames flow while the page changes; a heartbeat fallback force-captures idle pages (about one frame every 2 seconds) so the picture never freezes.
   - **Tab management**: create, switch or close tabs from the side list, in sync with the real window.
   - **Manual takeover**: click around in the Chrome window yourself at any time — the agent sees your changes on its next tool call.
2. **Screenshot history**: every `chrome_screenshot` is stored in the panel; click a thumbnail to enlarge.

### Window lifecycle & resilience

- **Lazy start**: Chrome launches only on the first `chrome_*` call (or the panel's Open button).
- **Orphan adoption**: if DSH died and left a Chrome behind (profile locked), the plugin reconnects through `DevToolsActivePort` and takes the window over instead of failing (the same autoConnect idea as chrome-devtools-mcp).
- **Idle reaping**: a window idle past `idleTimeoutMs` (default 10 min) closes automatically — never while a Web UI viewer is watching.
- **Auto tab recovery**: every operation makes sure a usable tab exists, so a window full of `chrome://` internal pages never dead-ends.

## Configuration

Override the plugin row in the profile's `cordis.patch.yml` (config is replaced wholesale):

```yaml
- id: dsh-plugin-chrome
  config:
    headless: false            # keep false — a visible window is the point
    executablePath: ''         # empty auto-detects Chrome/Edge; or set an absolute path
    idleTimeoutMs: 600000      # idle auto-close (0 disables)
    windowWidth: 1280
    windowHeight: 900
    screencastFrameSkip: 4     # live-view frame decimation (1 = smoothest)
    screencastQuality: 70      # JPEG quality 1-100
    maxSnapshotText: 60000     # max chars per snapshot
    maxTabs: 16
    extraArgs: ''              # extra Chrome launch flags
```

Data directory (browser profiles & screenshots): `~/.dsh/data/dsh-plugin-chrome/sessions/<sessionId>/` (override with `dataRoot`).

## FAQ

- **The Chrome tab shows nothing**: check the window is running (status dot at the top); the first launch takes a few seconds. Idle pages get a forced frame about every 2 seconds via the heartbeat (after 3 seconds without a real frame); activity raises the frame rate automatically.
- **Agent says "unknown uid"**: the page changed — have it re-run `chrome_snapshot`.
- **I closed the window myself**: the panel shows "window closed"; any next `chrome_*` call or the Open button relaunches it.
- **Login state**: each session uses an isolated profile, so logins don't carry over from your daily browser — that's by design. To log in somewhere, let the agent complete the login (it persists for the session).
- **Chrome stays open after DSH is killed**: the orphan window is adopted on the next session call (or close it by hand); a clean DSH shutdown closes its windows.
- **Screenshots stop a text-only model from responding**: `chrome_screenshot` delivers the picture as an image block into the conversation history. If the session's model does not accept images, every following turn is rejected with `UNSUPPORTED_CONTENT: does not accept image input` and the session no longer responds — retrying doesn't help. Use a vision-capable model for sessions that screenshot, or avoid `chrome_screenshot` there.
- **Install blocked by pnpm (strict-dep-builds)**: add `dsh-plugin-chrome: true` to `allowBuilds` in the profile's `pnpm-workspace.yaml` and retry the install.

## Development

```sh
npm install
npm run typecheck   # host + client programs
npm test            # vitest unit tests
npm run test:e2e    # real-Chrome end-to-end smoke (pops a visible window)
npm run build       # lib/index.js + lib/index.d.ts (host), lib/client.js + lib/client.d.ts (client bundle)
npm run watch       # continuous build; client changes hot-reload, host changes need a DSH restart
```

Architecture: the host half (cordis plugin) drives the local Chrome through puppeteer-core, registers the `chrome_*` tools and the `/dsh-chrome/*` HTTP/WS API; the client half (browser bundle) registers the Chrome tab on `conversation.view` and consumes the API and the frame stream. The picture = native Chrome screencast (active pages) + screenshot heartbeat (idle fallback). The control layer borrows proven designs from [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (CDP control, a11y snapshots with uid lookup, wait discipline, autoConnect adoption) and [mcp-chrome](https://github.com/hangwin/mcp-chrome) (screenshot compression, CDP coordinate input, session refcounting).

## License

MIT
