import z from "schemastery";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
//#region src/host/config.ts
/**
* Plugin configuration (schemastery schema — validated by the cordis Loader).
*
* Every deployment-varying choice is a config field, so a profile patch can
* tune it without editing source.
*/
/** Single source of truth for defaults (schema + resolver). */
const DEFAULTS = {
	executablePath: "",
	headless: false,
	dataRoot: "",
	idleTimeoutMs: 6e5,
	windowWidth: 1280,
	windowHeight: 900,
	extraArgs: "",
	screencastFrameSkip: 4,
	screencastQuality: 70,
	maxSnapshotText: 6e4,
	maxTabs: 16
};
/** Loader-validated config schema; defaults come from {@link DEFAULTS}. */
const Config = z.object({
	executablePath: z.string().default(DEFAULTS.executablePath),
	headless: z.boolean().default(DEFAULTS.headless),
	dataRoot: z.string().default(DEFAULTS.dataRoot),
	idleTimeoutMs: z.number().min(0).default(DEFAULTS.idleTimeoutMs),
	windowWidth: z.number().min(0).default(DEFAULTS.windowWidth),
	windowHeight: z.number().min(0).default(DEFAULTS.windowHeight),
	extraArgs: z.string().default(DEFAULTS.extraArgs),
	screencastFrameSkip: z.number().min(1).default(DEFAULTS.screencastFrameSkip),
	screencastQuality: z.number().min(1).max(100).default(DEFAULTS.screencastQuality),
	maxSnapshotText: z.number().min(1e3).default(DEFAULTS.maxSnapshotText),
	maxTabs: z.number().min(1).default(DEFAULTS.maxTabs)
});
/** Resolve a (possibly partial) raw config into a complete value. */
function resolveConfig(raw = {}) {
	return {
		executablePath: raw.executablePath ?? DEFAULTS.executablePath,
		headless: raw.headless ?? DEFAULTS.headless,
		dataRoot: raw.dataRoot ?? DEFAULTS.dataRoot,
		idleTimeoutMs: raw.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
		windowWidth: raw.windowWidth ?? DEFAULTS.windowWidth,
		windowHeight: raw.windowHeight ?? DEFAULTS.windowHeight,
		extraArgs: raw.extraArgs ?? DEFAULTS.extraArgs,
		screencastFrameSkip: raw.screencastFrameSkip ?? DEFAULTS.screencastFrameSkip,
		screencastQuality: raw.screencastQuality ?? DEFAULTS.screencastQuality,
		maxSnapshotText: raw.maxSnapshotText ?? DEFAULTS.maxSnapshotText,
		maxTabs: raw.maxTabs ?? DEFAULTS.maxTabs
	};
}
//#endregion
//#region src/host/browser.ts
/**
* Chrome executable discovery and puppeteer launch.
*
* We drive the user's ALREADY-INSTALLED Chrome/Edge through puppeteer-core
* (no browser download, ~zero install weight). The window is headed by
* default and gets an isolated per-session user-data-dir, so the harness's
* browser never mixes with the user's daily profile and the user can watch
* every action in a real window.
*/
/** Platform-specific candidates, ordered by preference. */
const CANDIDATES = [
	{
		name: "Google Chrome",
		paths: (() => {
			if (process.platform === "win32") return [
				join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
				join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
				join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "Application", "chrome.exe")
			];
			if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
			return [
				"/usr/bin/google-chrome",
				"/usr/bin/google-chrome-stable",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium"
			];
		})()
	},
	{
		name: "Microsoft Edge",
		paths: (() => {
			if (process.platform === "win32") return [join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"), join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")];
			if (process.platform === "darwin") return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
			return ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];
		})()
	},
	{
		name: "Chromium",
		paths: (() => {
			if (process.platform === "win32") return [join(process.env["LOCALAPPDATA"] ?? "", "Chromium", "Application", "chrome.exe")];
			if (process.platform === "darwin") return ["/Applications/Chromium.app/Contents/MacOS/Chromium"];
			return ["/usr/bin/chromium-browser"];
		})()
	}
];
/** Probe a directory that may exist but be a broken legacy path (like /snap). */
function usable(path) {
	if (path === "" || path.endsWith("\\")) return false;
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}
/**
* Locate an installed Chrome-family browser.
* @param explicit - user-configured absolute path, validated first.
* @returns the first usable executable.
* @throws when nothing is installed and no explicit path works.
*/
function findBrowser(explicit) {
	if (explicit !== "") {
		if (usable(explicit)) return {
			path: explicit,
			name: "configured browser"
		};
		throw new Error(`配置的浏览器路径不存在: ${explicit}`);
	}
	for (const candidate of CANDIDATES) for (const path of candidate.paths) if (usable(path)) return {
		path,
		name: candidate.name
	};
	throw new Error("未找到可用的 Chrome / Edge / Chromium。请安装其中之一，或在插件配置里设置 executablePath。");
}
/**
* Build the puppeteer launch options for one session window.
* @param userDataDir - isolated profile dir for this session.
* @param headless - false keeps the window visible (the plugin's point).
* @param windowWidth/Height - initial window size; 0 = Chrome default.
* @param extraArgs - additional command-line flags.
*/
function launchOptions(userDataDir, opts) {
	const args = [
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,MediaRouter",
		"--hide-crash-restore-bubble"
	];
	if (opts.windowWidth > 0 && opts.windowHeight > 0) args.push(`--window-size=${opts.windowWidth},${opts.windowHeight}`);
	if (opts.extraArgs.trim() !== "") args.push(...opts.extraArgs.trim().split(/\s+/));
	return {
		headless: opts.headless,
		defaultViewport: null,
		userDataDir,
		args,
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false
	};
}
/**
* Launch one session browser; falls back to adopting a still-running Chrome
* that owns the same user-data-dir (the previous DSH process left it behind
* when it was killed — the profile lock makes a fresh launch fail).
*
* Adoption reads the `DevToolsActivePort` file Chrome writes into the
* profile dir (the same auto-connect mechanism chrome-devtools-mcp uses)
* and connects over the localhost debugging endpoint.
* @returns the browser plus whether it was adopted (adopted instances need
*   CDP Browser.close instead of a plain close()).
* @throws with a readable message when Chrome refuses to start.
*/
async function launchBrowser(executablePath, options) {
	try {
		return {
			browser: await puppeteer.launch({
				...options,
				executablePath
			}),
			adopted: false
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (!/already running|profile is in use|DevToolsActivePort/iu.test(detail)) throw new Error(`Chrome 启动失败: ${detail}`);
		const endpoint = await readDevToolsEndpoint(options.userDataDir ?? "");
		if (endpoint === null) throw new Error(`Chrome 启动失败: ${detail}（且无法接管遗留实例——请手动关闭残留的 Chrome 窗口后重试）`);
		return {
			browser: await puppeteer.connect({
				browserURL: endpoint,
				defaultViewport: null
			}),
			adopted: true
		};
	}
}
/** Read the localhost debugging endpoint from DevToolsActivePort. */
async function readDevToolsEndpoint(userDataDir) {
	try {
		const file = join(userDataDir, "DevToolsActivePort");
		const port = (await readFile(file, "utf8")).trim().split(/\r?\n/u)[0];
		if (port === void 0 || !/^\d+$/u.test(port)) return null;
		return `http://127.0.0.1:${port}`;
	} catch {
		return null;
	}
}
/**
* Close a browser instance: CDP Browser.close kills the Chrome process even
* for adopted (connected) instances, then plain close() releases the client.
*/
async function closeBrowserHard(browser) {
	try {
		const session = await browser.target().createCDPSession();
		await session.send("Browser.close");
		await session.detach().catch(() => {});
	} catch {}
	await browser.close().catch(() => {});
}
/**
* Force the window visible. Chrome spawned by a hidden parent (a DSH host
* started with SW_HIDE — a shortcut, task scheduler, or service) inherits
* the hidden window state: the window exists, reports windowState 'normal'
* over CDP, yet the user never sees it. A minimized → normal bounds cycle
* through CDP re-shows the window on the desktop.
*/
async function forceWindowVisible(browser) {
	try {
		const session = await browser.target().createCDPSession();
		const pageTarget = (await session.send("Target.getTargets")).targetInfos.find((target) => target.type === "page" && !target.url.startsWith("chrome://") && !target.url.startsWith("devtools://"));
		if (pageTarget === void 0) return;
		const info = await session.send("Browser.getWindowForTarget", { targetId: pageTarget.targetId });
		if (info.windowId === void 0) return;
		await session.send("Browser.setWindowBounds", {
			windowId: info.windowId,
			bounds: { windowState: "minimized" }
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		await session.send("Browser.setWindowBounds", {
			windowId: info.windowId,
			bounds: { windowState: "normal" }
		});
		await session.detach().catch(() => {});
	} catch {}
}
/** Resolve the plugin data root (explicit config or <DSH_HOME>/data/dsh-plugin-chrome). */
function resolveDataRoot(explicit) {
	if (explicit !== "") return explicit;
	const dshHome = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
	return join(dshHome, "data", "dsh-plugin-chrome");
}
//#endregion
//#region src/shared/contract.ts
/**
* Shared wire contract between the host and client halves.
*
* This module is imported by BOTH build faces, so it must stay free of any
* Node or browser runtime: pure types and JSON-safe constants only. The
* tsdown faces each inline their own copy — there is no shared runtime
* identity, only a shared vocabulary.
*/
/** API prefix served by the host half. */
const API_PREFIX = "/dsh-chrome/api";
/** WebSocket upgrade path served by the host half (screencast + status). */
const WS_PATH = "/dsh-chrome/ws";
/** Screenshot storage layout under the plugin data dir. */
const SCREENSHOTS_DIR = "screenshots";
/** Data-root layout: <dataRoot>/sessions/<sessionId>/profile + screenshots. */
const SESSIONS_DIR = "sessions";
//#endregion
//#region src/host/actions.ts
/** Default navigation timeout for chrome_navigate. */
const NAV_TIMEOUT_MS = 3e4;
/** Schemes never passed to navigation (classic script-injection vectors). */
const BLOCKED_URL_SCHEMES = /^(javascript|vbscript):/iu;
/**
* Normalize a user/model-supplied URL: bare hostnames get https://, already
* schemed URLs pass through (http/https/data/about/file/…), and classic
* script-vector schemes are rejected outright.
*/
function normalizeUrl(url) {
	const trimmed = url.trim();
	if (BLOCKED_URL_SCHEMES.test(trimmed)) throw new Error(`已阻止不安全的 URL 协议：${trimmed.slice(0, 40)}`);
	return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}
/** A fresh CDP session for one page (input + DOM domains). */
async function cdpSession(page) {
	const session = await page.target().createCDPSession();
	await session.send("DOM.enable");
	return session;
}
/** Center point of an element's border box (CSS px, viewport-relative). */
async function elementCenter(session, backendNodeId) {
	await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
	const model = await session.send("DOM.getBoxModel", { backendNodeId });
	const quad = model.model?.border ?? model.model?.content;
	if (quad === void 0 || quad.length < 8) throw new Error("无法获取元素的屏幕位置（元素可能已从页面移除）。");
	let x = 0;
	let y = 0;
	for (let i = 0; i < 8; i += 2) {
		x += quad[i];
		y += quad[i + 1];
	}
	return {
		x: x / 4,
		y: y / 4
	};
}
/** Dispatch one mouse event through the CDP session. */
async function mouseEvent(session, type, x, y, opts = {}) {
	await session.send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: opts.button ?? "left",
		clickCount: opts.clickCount ?? 1,
		pointerType: "mouse"
	});
}
/** Click the element behind a uid (single or double). */
async function clickUid(page, session, backendNodeId, dblClick) {
	const { x, y } = await elementCenter(session, backendNodeId);
	const clicks = dblClick ? 2 : 1;
	await mouseEvent(session, "mouseMoved", x, y);
	for (let i = 0; i < clicks; i += 1) {
		await mouseEvent(session, "mousePressed", x, y, { clickCount: i + 1 });
		await mouseEvent(session, "mouseReleased", x, y, { clickCount: i + 1 });
	}
	await waitForQuiescence(page);
}
/** Click at raw viewport coordinates. */
async function clickAt(page, session, x, y, dblClick) {
	const clicks = dblClick ? 2 : 1;
	await mouseEvent(session, "mouseMoved", x, y);
	for (let i = 0; i < clicks; i += 1) {
		await mouseEvent(session, "mousePressed", x, y, { clickCount: i + 1 });
		await mouseEvent(session, "mouseReleased", x, y, { clickCount: i + 1 });
	}
	await waitForQuiescence(page);
}
/** Hover the element behind a uid. */
async function hoverUid(session, backendNodeId) {
	const { x, y } = await elementCenter(session, backendNodeId);
	await mouseEvent(session, "mouseMoved", x, y);
}
/**
* Fill an input-like element: click to focus, select everything, then
* insert the text (replacing the selection fires input events like a real
* user paste-into-selected flow).
*/
async function fillUid(page, session, backendNodeId, value) {
	await clickUid(page, session, backendNodeId, false);
	const modifier = process.platform === "darwin" ? "Meta" : "Control";
	await page.keyboard.down(modifier);
	await page.keyboard.press("KeyA");
	await page.keyboard.up(modifier);
	await session.send("Input.insertText", { text: value });
	await waitForQuiescence(page);
}
/** Type text at the current focus. */
async function typeText(page, text) {
	await page.keyboard.type(text, { delay: 20 });
	await waitForQuiescence(page);
}
/** Press one key (e.g. 'Enter', 'Tab', 'Escape', 'a', 'F5'). */
async function pressKey(page, key) {
	await page.keyboard.press(key);
	await waitForQuiescence(page);
}
/** Scroll the viewport by an amount, or jump to top/bottom. */
async function scrollView(page, direction, amountPx, to) {
	await page.evaluate(({ direction, amountPx, to }) => {
		if (to === "top") window.scrollTo({ top: 0 });
		else if (to === "bottom") window.scrollTo({ top: document.documentElement.scrollHeight });
		else window.scrollBy({ top: direction === "down" ? amountPx : -amountPx });
	}, {
		direction,
		amountPx,
		to
	});
	await waitForQuiescence(page);
}
/**
* Wait for the page to stop churning after an action: navigation settles
* (puppeteer's own waiters cover goto), then a page-side MutationObserver
* watches for a quiet window. Bounded — never stalls a tool call forever.
* @param page - target page.
* @param stableMs - required quiet period (default 100ms).
* @param timeoutMs - overall cap (default 1500ms).
*/
async function waitForQuiescence(page, stableMs = 100, timeoutMs = 1500) {
	try {
		await page.waitForFunction((stable) => new Promise((resolve) => {
			let timer = null;
			const observer = new MutationObserver(() => {
				if (timer !== null) clearTimeout(timer);
				timer = setTimeout(() => {
					observer.disconnect();
					resolve();
				}, stable);
			});
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true,
				attributes: true,
				characterData: true
			});
			timer = setTimeout(() => {
				observer.disconnect();
				resolve();
			}, stable);
		}), { timeout: timeoutMs }, stableMs);
	} catch {}
}
/** Wait until the page body contains the given text. */
async function waitForText(page, text, timeoutMs) {
	try {
		await page.waitForFunction((needle) => document.body !== null && document.body.innerText.includes(needle), { timeout: timeoutMs }, text);
		return true;
	} catch {
		return false;
	}
}
/** Evaluate an expression in the page (async expressions supported). */
async function evaluateExpression(page, expression) {
	const wrapped = `return (async () => {\n${expression}\n})()`;
	const fn = new Function(wrapped);
	return page.evaluate(fn);
}
/** Capture a viewport/full-page/element screenshot as a JPEG/PNG buffer. */
async function captureScreenshot(page, opts) {
	if (opts.backendNodeId !== void 0) {
		const session = await cdpSession(page);
		try {
			const model = await session.send("DOM.getBoxModel", { backendNodeId: opts.backendNodeId });
			const quad = model.model?.border ?? model.model?.content;
			if (quad === void 0 || quad.length < 8) throw new Error("无法截取该元素：它可能已从页面移除。");
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (let i = 0; i < 8; i += 2) {
				minX = Math.min(minX, quad[i]);
				maxX = Math.max(maxX, quad[i]);
				minY = Math.min(minY, quad[i + 1]);
				maxY = Math.max(maxY, quad[i + 1]);
			}
			const width = Math.max(1, Math.round(maxX - minX));
			const height = Math.max(1, Math.round(maxY - minY));
			const buf = await page.screenshot({
				type: opts.format,
				quality: opts.format === "jpeg" ? opts.quality : void 0,
				clip: {
					x: minX,
					y: minY,
					width,
					height
				}
			});
			return {
				buffer: Buffer.from(buf),
				width,
				height
			};
		} finally {
			await session.detach().catch(() => {});
		}
	}
	const size = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth || document.body?.scrollWidth || window.innerWidth,
		scrollHeight: document.documentElement.scrollHeight || document.body?.scrollHeight || window.innerHeight,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight
	}));
	const width = opts.fullPage ? Math.max(1, size.scrollWidth) : Math.max(1, size.innerWidth);
	const height = opts.fullPage ? Math.max(1, size.scrollHeight) : Math.max(1, size.innerHeight);
	const buf = await page.screenshot({
		type: opts.format,
		quality: opts.format === "jpeg" ? opts.quality : void 0,
		fullPage: opts.fullPage
	});
	return {
		buffer: Buffer.from(buf),
		width,
		height
	};
}
/** Navigate the page (goto with permissive load gate). */
async function navigate(page, url, timeoutMs) {
	await page.goto(normalizeUrl(url), {
		waitUntil: "domcontentloaded",
		timeout: timeoutMs
	});
	await waitForQuiescence(page);
}
//#endregion
//#region src/host/shots.ts
/**
* Screenshot metadata index (sidecar for the Web GUI history).
*
* Every chrome_screenshot records its full metadata (title/url/size) into a
* per-session shots.json index so the history survives restarts. Listing
* falls back to a plain directory scan for shots written by older plugin
* versions — those simply show empty metadata.
*/
/** Index file name inside a session's screenshots dir. */
const SHOT_INDEX_NAME = "shots.json";
/** Screenshot file-name whitelist (mirrors the API's). */
const SHOT_NAME_RE = /^shot-[0-9]+-[A-Za-z0-9_-]{0,64}\.(png|jpeg|jpg)$/u;
/** Max entries kept in the index (the listing caps at 50 anyway). */
const MAX_INDEX_ENTRIES = 200;
/** Read the metadata index ([] when missing or corrupt). */
function readShotIndex(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, SHOT_INDEX_NAME), "utf8"));
		if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.entries)) return parsed.entries;
	} catch {}
	return [];
}
/** Prepend one entry to the index (bounded, newest first). */
function appendShot(dir, entry) {
	const next = [entry, ...readShotIndex(dir).filter((existing) => existing.name !== entry.name)].slice(0, MAX_INDEX_ENTRIES);
	try {
		writeFileSync(join(dir, SHOT_INDEX_NAME), JSON.stringify({ entries: next }));
	} catch {}
}
/** All screenshot entries, newest first (metadata-enriched when indexed). */
function screenshotHistory(dir) {
	const indexed = new Map(readShotIndex(dir).map((entry) => [entry.name, entry]));
	const entries = [];
	try {
		for (const name of readdirSync(dir)) {
			if (!SHOT_NAME_RE.test(name)) continue;
			const info = statSync(join(dir, name));
			entries.push(indexed.get(name) ?? {
				name,
				createdAt: info.mtimeMs,
				bytes: info.size,
				width: 0,
				height: 0,
				fullPage: false,
				pageTitle: "",
				url: ""
			});
		}
	} catch {}
	return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}
/** Name of the most recent screenshot (index-first, scan fallback). */
function latestScreenshot(dir) {
	const indexed = readShotIndex(dir);
	if (indexed.length > 0) return indexed[0]?.name ?? null;
	return screenshotHistory(dir)[0]?.name ?? null;
}
//#endregion
//#region src/host/manager.ts
/** Internal Chrome-internal pages never shown or controlled. */
const INTERNAL_URL_RE = /^(chrome|chrome-extension|devtools|edge|view-source):/iu;
/** Welcome page shown in a freshly launched window (data: URL). */
function welcomePage(sessionId) {
	return `data:text/html,${[
		"<title>DSH Chrome</title>",
		"<body style=\"font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e2e;color:#cdd6f4\">",
		"<div style=\"text-align:center\">",
		"<h1>🌐 DSH Chrome</h1>",
		`<p>会话 ${sessionId.slice(0, 8)} 的专属浏览器窗口</p>`,
		"<p style=\"opacity:.6\">Agent 的操作会实时显示在这里</p>",
		"</div></body>"
	].join("")}`;
}
/** Heartbeat tick: how often the stall watchdog checks for a silent stream. */
const FRAME_HEARTBEAT_MS = 2e3;
/** A stream is "stalled" after this long without a native frame. */
const FRAME_STALL_MS = 3e3;
/** One live, session-owned Chrome window. */
var SessionChrome = class {
	config;
	adopted;
	sessionId;
	dataDir;
	screenshotsDir;
	browser;
	startedAt;
	lastUsedAt;
	/** Tab index of the control target (pages array order). */
	selectedIndex = 0;
	/** Serial queue: every operation awaits the previous one. */
	queue = Promise.resolve();
	/** Counts of open operations; nonzero = busy. */
	busyCount = 0;
	closed = false;
	/** Set when the browser process exits on its own. */
	exited = false;
	/** Screencast watchers (bump lastUsedAt so the idle timer never reaps a watched window). */
	screencastWatchers = /* @__PURE__ */ new Set();
	screencastSeq = 0;
	/** Frame push callback, wired by the API layer. */
	onFrame = null;
	/** Status/event push callback, wired by the API layer. */
	onEvent = null;
	/** Page currently producing screencast frames (CDP session). */
	screencastCdp = null;
	/** uid → element registry of the most recent snapshot (per this session). */
	uidRegistry = /* @__PURE__ */ new Map();
	/** Drained once close() finishes (guards double-close races). */
	closedPromise = null;
	constructor(sessionId, browser, dataRoot, config, adopted) {
		this.config = config;
		this.adopted = adopted;
		this.sessionId = sessionId;
		this.dataDir = join(dataRoot, SESSIONS_DIR, sessionId);
		this.screenshotsDir = join(this.dataDir, SCREENSHOTS_DIR);
		this.browser = browser;
		this.startedAt = Date.now();
		this.lastUsedAt = Date.now();
		mkdirSync(this.screenshotsDir, { recursive: true });
		browser.on("disconnected", () => {
			this.exited = true;
			this.closed = true;
			this.notify({ kind: "closed" });
		});
		browser.on("targetcreated", () => this.notify());
		browser.on("targetdestroyed", () => this.notify());
	}
	/** Human-readable short id for logs. */
	get shortId() {
		return this.sessionId.slice(0, 8);
	}
	/** Control pages (visible tabs; internal pages filtered). */
	async pages() {
		if (this.exited || !this.browser.connected) return [];
		return (await this.browser.pages()).filter((page) => {
			try {
				const url = page.url();
				return url === "" || !INTERNAL_URL_RE.test(url);
			} catch {
				return false;
			}
		});
	}
	/** The current control target, or undefined when no usable tab exists. */
	async selected() {
		const pages = await this.pages();
		if (pages.length === 0) return void 0;
		return pages[Math.min(this.selectedIndex, pages.length - 1)];
	}
	/**
	* The control target, opening a fresh tab when the window has none
	* usable (e.g. the user closed every web page, leaving chrome:// tabs).
	* Every chrome_* operation funnels through this so a bare window never
	* dead-ends.
	*/
	async ensurePage() {
		const existing = await this.selected();
		if (existing !== void 0) return existing;
		const fresh = await this.browser.newPage();
		const filtered = await this.pages();
		const idx = filtered.indexOf(fresh);
		this.selectedIndex = idx >= 0 ? idx : filtered.length - 1;
		await fresh.bringToFront().catch(() => {});
		return fresh;
	}
	/** Open a new tab (optionally navigating it) and select it. */
	async newTab(url) {
		const page = await this.browser.newPage();
		if (url !== void 0 && url.trim() !== "") try {
			await navigate(page, url, NAV_TIMEOUT_MS);
		} catch (error) {
			await page.close().catch(() => {});
			throw error;
		}
		const filtered = await this.pages();
		const idx = filtered.indexOf(page);
		this.selectedIndex = idx >= 0 ? idx : filtered.length - 1;
		await page.bringToFront().catch(() => {});
		this.notify({
			kind: "page-selected",
			index: this.selectedIndex
		});
		return page;
	}
	/** Close a tab by (filtered) index; re-selects a neighbor when needed. */
	async closeTab(index) {
		const pages = await this.pages();
		if (index < 0 || index >= pages.length) throw new Error(`标签页序号 ${index} 不存在（当前共 ${pages.length} 个）。`);
		const wasSelected = index === this.selectedIndex;
		await pages[index].close().catch(() => {});
		this.notify({
			kind: "page-removed",
			index
		});
		if (wasSelected) {
			this.selectedIndex = Math.max(0, Math.min(index, (await this.pages()).length - 1));
			await this.selectPage(this.selectedIndex);
		}
	}
	/**
	* Select a tab by zero-based pages-array index (clamped).
	*
	* NOT queued itself: every call site already runs inside {@link run} —
	* wrapping it again would deadlock the serial queue (a queued op waiting
	* on an op queued behind it).
	*/
	async selectPage(index) {
		const pages = await this.pages();
		if (pages.length === 0) return void 0;
		const clamped = Math.max(0, Math.min(index, pages.length - 1));
		this.selectedIndex = clamped;
		await pages[clamped].bringToFront().catch(() => {});
		this.notify({
			kind: "page-selected",
			index: clamped
		});
		return pages[clamped];
	}
	/** Run one operation on the serial queue. */
	run(fn) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error(`Chrome 窗口已关闭（会话 ${this.shortId}）。请先调用 chrome_open 重新打开。`));
		const next = this.queue.then(async () => {
			this.busyCount += 1;
			try {
				const result = await fn();
				this.touch();
				return result;
			} finally {
				this.busyCount -= 1;
			}
		});
		this.queue = next.catch(() => {});
		return next;
	}
	/** Record activity (defeats the idle timer). */
	touch() {
		this.lastUsedAt = Date.now();
	}
	isBusy() {
		return this.busyCount > 0;
	}
	/** Live status snapshot for the Web UI and tools. */
	async status() {
		const pages = [];
		if (this.closed || this.exited) return {
			sessionId: this.sessionId,
			running: false,
			pages,
			startedAt: this.startedAt,
			lastUsedAt: this.lastUsedAt,
			idleDeadline: null,
			lastScreenshot: null,
			screencastActive: false,
			error: this.exited ? "浏览器进程已退出" : null
		};
		const live = await this.pages();
		for (let index = 0; index < live.length; index += 1) {
			const page = live[index];
			let url = "";
			let title = "";
			try {
				url = page.url();
				title = await page.title();
			} catch {}
			pages.push({
				index,
				url,
				title,
				active: index === this.selectedIndex,
				selected: index === this.selectedIndex
			});
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
			error: null
		};
	}
	/** Subscribe a Web UI viewer to the live frame stream. */
	async addScreencastWatcher(token) {
		const first = this.screencastWatchers.size === 0;
		this.screencastWatchers.add(token);
		this.touch();
		if (!first) return;
		await this.run(async () => {
			if (this.exited || this.screencastCdp !== null) return;
			const page = await this.selected();
			if (page === void 0) return;
			let cdp = null;
			try {
				cdp = await page.target().createCDPSession();
				cdp.on("Page.screencastFrame", (frame) => {
					const width = frame.metadata.deviceWidth ?? 0;
					const height = frame.metadata.deviceHeight ?? 0;
					this.screencastSeq += 1;
					this.lastFrameAt = Date.now();
					this.onFrame?.({
						data: frame.data,
						seq: this.screencastSeq,
						width,
						height
					});
					cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
				});
				await cdp.send("Page.enable");
				await cdp.send("Page.startScreencast", {
					format: "jpeg",
					quality: this.config.screencastQuality,
					everyNthFrame: this.config.screencastFrameSkip
				});
				this.screencastCdp = cdp;
				this.notify({
					kind: "screencast-changed",
					active: true
				});
				this.startFrameHeartbeat();
			} catch (error) {
				await cdp?.detach().catch(() => {});
				this.screencastWatchers.delete(token);
				throw new Error(`启动实时画面流失败（该 Chrome 版本可能不支持 screencast）：${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}
	/** Unsubscribe one viewer; the stream stops when the last leaves. */
	async removeScreencastWatcher(token) {
		if (!this.screencastWatchers.delete(token) || this.screencastWatchers.size > 0) return;
		this.stopFrameHeartbeat();
		await this.run(async () => {
			const cdp = this.screencastCdp;
			this.screencastCdp = null;
			if (cdp === null) return;
			try {
				await cdp.send("Page.stopScreencast");
			} catch {}
			await cdp.detach().catch(() => {});
			this.notify({
				kind: "screencast-changed",
				active: false
			});
		});
	}
	hasScreencastWatchers() {
		return this.screencastWatchers.size > 0;
	}
	/** Timestamp of the last real screencast frame (heartbeat decision input). */
	lastFrameAt = 0;
	heartbeatTimer = null;
	/**
	* Force one capture when the stream stalls for {@link FRAME_STALL_MS}.
	* The capture itself repaints the page, which usually restarts the native
	* frame flow too.
	*/
	startFrameHeartbeat() {
		this.lastFrameAt = Date.now();
		if (this.heartbeatTimer !== null) return;
		this.heartbeatTimer = setInterval(() => {
			this.heartbeatCapture();
		}, FRAME_HEARTBEAT_MS);
		this.heartbeatTimer.unref?.();
	}
	stopFrameHeartbeat() {
		if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}
	async heartbeatCapture() {
		if (this.hasScreencastWatchers() === false || this.exited) return;
		if (Date.now() - this.lastFrameAt < FRAME_STALL_MS) return;
		const page = await this.selected();
		if (page === void 0) return;
		try {
			const { buffer, width, height } = await captureScreenshot(page, {
				fullPage: false,
				format: "jpeg",
				quality: 55
			});
			this.screencastSeq += 1;
			this.lastFrameAt = Date.now();
			this.onFrame?.({
				data: buffer.toString("base64"),
				seq: this.screencastSeq,
				width,
				height
			});
		} catch {}
	}
	/** Push one state/event notice through the API layer. */
	notify(detail) {
		if (detail !== void 0) this.onEvent?.(detail);
	}
	/** Close the window (idempotent; joins the in-flight queue first). */
	async close() {
		if (this.closedPromise !== null) return this.closedPromise;
		this.closedPromise = this.run(async () => {
			this.closed = true;
			this.exited = true;
			this.stopFrameHeartbeat();
			if (this.browser.connected) {
				if (this.adopted) await closeBrowserHard(this.browser);
				else await this.browser.close().catch(() => {});
			}
			this.notify({ kind: "closed" });
		}).catch(() => {});
		return this.closedPromise;
	}
	/** Recheck whether the idle deadline passed (manager-side policy). */
	idleDeadlineMs(idleTimeoutMs) {
		if (idleTimeoutMs <= 0 || this.hasScreencastWatchers()) return null;
		return this.lastUsedAt + idleTimeoutMs;
	}
};
/** Manager owning every session window and the shared launch policy. */
var ChromeManager = class {
	config;
	dataRoot;
	sessions = /* @__PURE__ */ new Map();
	/** In-flight launches (single-flight per session: concurrent chrome_open dedupes). */
	launching = /* @__PURE__ */ new Map();
	executable = null;
	idleTimer;
	constructor(config, dataRoot) {
		this.config = config;
		this.dataRoot = dataRoot;
		this.idleTimer = setInterval(() => this.reapIdle(), 3e4);
		this.idleTimer.unref?.();
	}
	/** Shared executable discovery (cached). */
	resolveExecutable() {
		this.executable ??= findBrowser(this.config.executablePath);
		return this.executable;
	}
	/** Get a live session window, or undefined. */
	get(sessionId) {
		return this.sessions.get(sessionId);
	}
	/** Get or launch the session window (single-flight per session). */
	async getOrLaunch(sessionId, url) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			existing.touch();
			return existing;
		}
		const inFlight = this.launching.get(sessionId);
		if (inFlight !== void 0) return inFlight;
		const launch = this.doLaunch(sessionId, url).finally(() => {
			this.launching.delete(sessionId);
		});
		this.launching.set(sessionId, launch);
		return launch;
	}
	/** Launch body (owns failure cleanup). */
	async doLaunch(sessionId, url) {
		const exec = this.resolveExecutable();
		const profileDir = join(this.dataRoot, SESSIONS_DIR, sessionId, "profile");
		const { browser, adopted } = await launchBrowser(exec.path, launchOptions(profileDir, {
			headless: this.config.headless,
			windowWidth: this.config.windowWidth,
			windowHeight: this.config.windowHeight,
			extraArgs: this.config.extraArgs
		}));
		const session = new SessionChrome(sessionId, browser, this.dataRoot, this.config, adopted);
		this.sessions.set(sessionId, session);
		try {
			await forceWindowVisible(browser);
			if (!adopted) {
				const page = (await browser.pages())[0];
				if (page !== void 0) {
					const target = url !== void 0 ? normalizeUrl(url) : welcomePage(sessionId);
					await page.goto(target, {
						waitUntil: "domcontentloaded",
						timeout: 15e3
					}).catch(() => {});
				}
			} else if (url !== void 0) await session.ensurePage().then((page) => page.goto(normalizeUrl(url), {
				waitUntil: "domcontentloaded",
				timeout: 15e3
			})).catch(() => {});
			session.notify({ kind: "opened" });
			return session;
		} catch (error) {
			await session.close();
			this.sessions.delete(sessionId);
			throw error;
		}
	}
	/** Close one session window (no-op when absent). */
	async close(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === void 0) return;
		await session.close();
		this.sessions.delete(sessionId);
	}
	/** Close every window (host shutdown / plugin unload). */
	async closeAll() {
		const all = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.allSettled(all.map((session) => session.close()));
	}
	/** Iterate all live sessions (API/status use). */
	all() {
		return [...this.sessions.values()];
	}
	/** Idle-timeout reaper (interval-driven). */
	reapIdle() {
		if (this.config.idleTimeoutMs <= 0) return;
		const now = Date.now();
		for (const [sessionId, session] of this.sessions) {
			const deadline = session.idleDeadlineMs(this.config.idleTimeoutMs);
			if (deadline !== null && deadline <= now && !session.isBusy()) this.close(sessionId);
		}
	}
	/** Stop the idle timer (plugin disposal). */
	dispose() {
		clearInterval(this.idleTimer);
	}
};
//#endregion
//#region src/host/snapshot.ts
/** Textual value of an AX value field (form fields, links, headings). */
function axValueText(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value !== void 0 && value !== null && typeof value === "object" && "value" in value) {
		const inner = value.value;
		return typeof inner === "string" || typeof inner === "number" ? String(inner) : "";
	}
	return "";
}
/** Compact name for the tree line; quoted when it contains spaces. */
function displayName(name) {
	if (name === "") return "";
	return /[\s"]/u.test(name) ? `"${name}"` : name;
}
/**
* Build the tree from the flat AX node list and walk it into text lines,
* minting uids along the way.
*/
function buildTree(nodes) {
	const byId = /* @__PURE__ */ new Map();
	for (const node of nodes) byId.set(node.nodeId, {
		...node,
		children: []
	});
	for (const node of byId.values()) for (const childId of node.childIds ?? []) {
		const child = byId.get(childId);
		if (child !== void 0) node.children.push(child);
	}
	return byId;
}
/** True when the node carries nothing a user or model would care about. */
function isUninteresting(node) {
	const name = axValueText(node.name).trim();
	const value = axValueText(node.value);
	const role = node.role?.value ?? "";
	return name === "" && value === "" && (role === "generic" || role === "unknown");
}
/** Walk one subtree (depth-first), emitting lines and uids. */
function walkTree(roots, pageIndex, depth, interestingOnly, uids, lines, counter) {
	for (const node of roots) {
		if (node.ignored) {
			walkTree(node.children, pageIndex, depth, interestingOnly, uids, lines, counter);
			continue;
		}
		const uninteresting = isUninteresting(node);
		if (interestingOnly && uninteresting) {
			walkTree(node.children, pageIndex, depth, interestingOnly, uids, lines, counter);
			continue;
		}
		counter.value += 1;
		const uid = `${pageIndex}_${counter.value}`;
		if (node.backendDOMNodeId !== void 0) uids.set(uid, {
			backendNodeId: node.backendDOMNodeId,
			pageIndex
		});
		const indent = "  ".repeat(depth);
		const role = node.role?.value ?? "unknown";
		const name = axValueText(node.name).trim();
		const value = axValueText(node.value);
		const label = [displayName(name), value !== "" ? displayName(value) : ""].filter((part) => part !== "").join(" ");
		const roleSuffix = name === "" && value === "" ? ` <${role}>` : "";
		lines.push(`${indent}[${uid}] ${role}${roleSuffix}${label !== "" ? ` ${label}` : ""}`);
		walkTree(node.children, pageIndex, depth + 1, interestingOnly, uids, lines, counter);
	}
}
/**
* Capture the current page's a11y snapshot.
* @param page - the control target.
* @param pageIndex - tab index (uid prefix, keeps multi-tab uids distinct).
* @param options - verbose keeps uninteresting nodes; maxText truncates the
*   model-facing result (the uid registry always stays complete).
*/
async function snapshotPage(page, pageIndex, options) {
	const session = await page.target().createCDPSession();
	let nodes;
	try {
		await session.send("Accessibility.enable");
		nodes = (await session.send("Accessibility.getFullAXTree")).nodes;
	} finally {
		await session.detach().catch(() => {});
	}
	const byId = buildTree(nodes);
	const roots = nodes.filter((node) => node.parentId === void 0 || !byId.has(node.parentId)).map((node) => byId.get(node.nodeId)).filter((node) => node !== void 0);
	const uids = /* @__PURE__ */ new Map();
	const lines = [];
	walkTree(roots, pageIndex, 0, !options.verbose, uids, lines, { value: 0 });
	let text = lines.join("\n");
	let truncated = false;
	if (text.length > options.maxText) {
		text = `${text.slice(0, options.maxText)}\n… (快照已截断：共 ${lines.length} 行。可先用 chrome_evaluate 精确定位，或改用非 verbose 快照)`;
		truncated = true;
	}
	if (text === "") text = "(页面无可访问性内容 — 可能是空白页或尚未加载完成)";
	return {
		text,
		uids,
		truncated
	};
}
/**
* Resolve a uid into a backend node id using the most recent snapshot
* registry of the session.
* @throws when the uid is unknown (stale snapshot) or points to another tab.
*/
function resolveUid(registry, uid, pageIndex) {
	const entry = registry.get(uid);
	if (entry === void 0) throw new Error(`未知元素 uid "${uid}"：页面可能已变化，请先重新执行 chrome_snapshot 获取最新 uid。`);
	if (entry.pageIndex !== pageIndex) throw new Error(`元素 uid "${uid}" 属于标签页 ${entry.pageIndex}，当前控制的是标签页 ${pageIndex}。请先 chrome_tabs select 切换，或重新快照。`);
	return entry.backendNodeId;
}
//#endregion
//#region src/host/tools.ts
/**
* The chrome_* agent tool suite.
*
* Every tool is session-scoped: the execution's agent session owns one
* Chrome window, and all operations funnel through that session's serial
* queue. Tools fail with readable Chinese messages instead of raw CDP
* errors, so the model can self-correct (re-snapshot, re-open, re-select).
*/
/** Extract the calling agent's session id (tools only run for an agent). */
function sessionIdOf(exec) {
	const sessionId = exec.agent?.session?.id;
	if (typeof sessionId !== "string" || sessionId === "") throw new Error("chrome_* 工具只能在 Agent 会话中调用（缺少发起会话）。");
	return sessionId;
}
/** Resolve the session window and its control page (launching when needed). */
async function resolveTarget(manager, sessionId) {
	const session = await manager.getOrLaunch(sessionId);
	await session.ensurePage();
	return {
		session,
		pageIndex: session.selectedIndex
	};
}
/** Serialize the caller's signal into a readable abort error. */
function throwIfAborted(signal) {
	if (signal.aborted) throw new Error("操作已取消。");
}
/** Format one page row for list output. */
function pageLine(page) {
	const marker = page.selected ? "▶" : " ";
	const title = (page.title || page.url).slice(0, 60);
	return `${marker} [${page.index}] ${title} ${page.url}`;
}
/** Render a status object as compact model text. */
function formatStatus(status) {
	if (!status.running) return `Chrome 窗口未运行（会话 ${status.sessionId.slice(0, 8)}）。用 chrome_open 打开。${status.error ? `\n错误：${status.error}` : ""}`;
	const lines = [`Chrome 窗口运行中（会话 ${status.sessionId.slice(0, 8)}），${status.pages.length} 个标签页：`];
	for (const page of status.pages) lines.push(pageLine(page));
	if (status.lastScreenshot !== null) lines.push(`最近截图：${status.lastScreenshot}`);
	return lines.join("\n");
}
/** chrome_open — open (or reuse) the session's visible Chrome window. */
function openTool(deps) {
	return defineTool({
		name: "chrome_open",
		description: "打开（或复用）本会话专属的可见 Chrome 窗口，并返回当前状态。窗口是真实的、用户可以看到并手动操作的浏览器；首次调用会自动启动 Chrome（惰性启动）。可选参数 url 指定窗口打开后立即导航到的地址（缺省显示欢迎页）。窗口保持打开直到 chrome_close 或空闲超时。任何 chrome_* 工具在窗口未打开时都会自动触发打开，因此本工具主要用于显式控制生命周期或指定初始地址。",
		parameters: { url: {
			type: "string",
			description: "打开后立即导航到的 URL（可省略协议，如 example.com）。缺省显示欢迎页。"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					running: {
						type: "boolean",
						required: true,
						description: "窗口是否运行"
					},
					pages: {
						type: "integer",
						required: true,
						description: "标签页数量"
					},
					text: {
						type: "string",
						required: true,
						description: "给模型的状态摘要"
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const status = await (await deps.manager.getOrLaunch(sessionId, args.url)).status();
			return {
				running: status.running,
				pages: status.pages.length,
				text: `Chrome 窗口已打开（会话 ${sessionId.slice(0, 8)}）。\n${formatStatus(status)}`
			};
		}
	});
}
/** chrome_status — report window/tab state. */
function statusTool(deps) {
	return defineTool({
		name: "chrome_status",
		description: "查询本会话 Chrome 窗口的状态：是否运行、标签页列表（序号/标题/URL/当前选中）、启动与最近活动时间、最近截图。用于确认窗口状态、恢复上下文（例如不确定上次操作后页面处于哪个标签）或检查空闲关闭倒计时。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					running: {
						type: "boolean",
						required: true,
						description: "窗口是否运行"
					},
					text: {
						type: "string",
						required: true,
						description: "给模型的状态摘要"
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (_args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const session = deps.manager.get(sessionId);
			const status = session !== void 0 ? await session.status() : {
				sessionId,
				running: false,
				pages: [],
				startedAt: null,
				lastUsedAt: null,
				idleDeadline: null,
				lastScreenshot: null,
				screencastActive: false,
				error: null
			};
			return {
				running: status.running,
				text: formatStatus(status)
			};
		}
	});
}
/** chrome_close — close the session window. */
function closeTool(deps) {
	return defineTool({
		name: "chrome_close",
		description: "关闭本会话的 Chrome 窗口（含所有标签页）。用户手动关窗后也无需再调用。关闭后再次调用任何 chrome_* 工具都会重新打开一个新窗口。适合在浏览器任务完成、需要释放资源或用户要求结束时调用。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (_args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			await deps.manager.close(sessionId);
			return { text: `Chrome 窗口已关闭（会话 ${sessionId.slice(0, 8)}）。` };
		}
	});
}
/** chrome_navigate — goto/back/forward/reload the control page. */
function navigateTool(deps) {
	return defineTool({
		name: "chrome_navigate",
		description: "控制当前标签页导航：goto 打开新地址（可省略协议，自动补 https://）、back/forward 历史前进后退、reload 刷新。goto 会等待页面加载（默认 30 秒超时）后返回当前标签页状态。导航后如需定位页面元素，先调用 chrome_snapshot。",
		parameters: {
			action: {
				type: "string",
				enum: [
					"goto",
					"back",
					"forward",
					"reload"
				],
				required: true,
				description: "导航动作：goto=打开 url；back=后退；forward=前进；reload=刷新当前页"
			},
			url: {
				type: "string",
				description: "action=goto 时的目标地址（可省略协议，如 example.com）"
			},
			timeout: {
				type: "integer",
				description: "goto 超时毫秒数（默认 30000）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: {
						type: "string",
						required: true,
						description: "导航后当前 URL"
					},
					title: {
						type: "string",
						required: true,
						description: "导航后页面标题"
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `已导航到：${value.title || "(无标题)"} ${value.url}`
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session, pageIndex } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const timeout = args.timeout ?? 3e4;
				if (args.action === "goto") {
					const url = args.url ?? "";
					if (url.trim() === "") throw new Error("action=goto 时必须提供 url。");
					await navigate(page, url, timeout);
				} else if (args.action === "back") await page.goBack({ timeout }).catch(() => page.goBack());
				else if (args.action === "forward") await page.goForward({ timeout }).catch(() => page.goForward());
				else await page.reload({
					waitUntil: "domcontentloaded",
					timeout
				});
				const title = await page.title().catch(() => "");
				session.notify({
					kind: "navigated",
					index: pageIndex,
					url: page.url(),
					title
				});
				return {
					url: page.url(),
					title
				};
			});
		}
	});
}
/** chrome_tabs — list/new/close/select tabs. */
function tabsTool(deps) {
	return defineTool({
		name: "chrome_tabs",
		description: "管理 Chrome 窗口的标签页：list 列出全部标签页（序号/标题/URL/当前选中标记）；new 新建标签页（可选 url）；close 关闭指定序号标签页（关掉控制页后自动切到相邻标签）；select 切换当前控制的标签页。chrome_snapshot/chrome_screenshot 等操作都作用于\"当前选中\"的标签页，多标签场景请先 select 再操作。",
		parameters: {
			action: {
				type: "string",
				enum: [
					"list",
					"new",
					"close",
					"select"
				],
				required: true,
				description: "操作类型"
			},
			index: {
				type: "integer",
				description: "close/select 时的标签页序号（list 输出中的 [N]；缺省=当前选中）"
			},
			url: {
				type: "string",
				description: "action=new 时新标签页的初始地址（缺省为空白页）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				if (args.action === "list") return { text: formatStatus(await session.status()) };
				if (args.action === "new") {
					if ((await session.pages()).length >= deps.config.maxTabs) throw new Error(`标签页数量已达上限 ${deps.config.maxTabs}，请先关闭不用的标签页。`);
					await session.newTab(args.url !== void 0 && args.url !== "" ? args.url : void 0);
					return { text: `已新建标签页 [${session.selectedIndex}]。` };
				}
				const index = args.index ?? session.selectedIndex;
				if (args.action === "select") {
					await session.selectPage(index);
					const page = await session.selected();
					return { text: `已切换到标签页 [${index}]：${page !== void 0 ? await page.title().catch(() => "") : ""}` };
				}
				await session.closeTab(index);
				return { text: `已关闭标签页 [${index}]。` };
			});
		}
	});
}
/** chrome_snapshot — a11y tree with element uids. */
function snapshotTool(deps) {
	return defineTool({
		name: "chrome_snapshot",
		description: "获取当前标签页的页面快照（无障碍树文本视图）。输出带缩进的元素树，每行形如 `[uid] role \"名称\"`，uid 是后续 chrome_click / chrome_fill / chrome_hover / chrome_screenshot(elementUid) 定位元素的句柄。快照远小于原始 HTML，只包含可见且有语义的内容。页面变化后 uid 可能失效，操作报\"未知元素\"时请重新快照。verbose=true 输出包含无语义节点的完整树（更大，调试时用）。",
		parameters: { verbose: {
			type: "boolean",
			description: "true=包含无语义节点（完整调试视图）；缺省=false 仅输出有名称/值的内容节点"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true,
						description: "快照文本"
					},
					truncated: {
						type: "boolean",
						required: true,
						description: "是否因长度上限截断"
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session, pageIndex } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const result = await snapshotPage(page, pageIndex, {
					verbose: args.verbose === true,
					maxText: deps.config.maxSnapshotText
				});
				session.uidRegistry = result.uids;
				return {
					text: result.text,
					truncated: result.truncated
				};
			});
		}
	});
}
/** chrome_screenshot — capture page/element screenshot. */
function screenshotTool(deps) {
	return defineTool({
		name: "chrome_screenshot",
		description: "对当前标签页截图（视口、整页或指定元素）。截图保存到会话截图目录并自动显示在 Web GUI 的 Chrome 面板；模型同时获得图片内容（可直接看图）与文件路径。fullPage=true 截取整页（长页面会很高，慎用）；elementUid 截取某个元素（uid 来自 chrome_snapshot）；format 默认 png（jpeg 更小但无透明）。",
		parameters: {
			fullPage: {
				type: "boolean",
				description: "true=整页截图；缺省=false 只截视口"
			},
			elementUid: {
				type: "string",
				description: "只截取该元素（uid 来自 chrome_snapshot）"
			},
			format: {
				type: "string",
				enum: ["png", "jpeg"],
				description: "图片格式（默认 png）"
			},
			quality: {
				type: "integer",
				description: "jpeg 质量 1-100（默认 85）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true,
						description: "截图保存的绝对路径"
					},
					name: {
						type: "string",
						required: true,
						description: "截图文件名"
					},
					width: {
						type: "integer",
						required: true,
						description: "像素宽度"
					},
					height: {
						type: "integer",
						required: true,
						description: "像素高度"
					},
					bytes: {
						type: "integer",
						required: true,
						description: "文件字节数"
					},
					mediaType: {
						type: "string",
						required: true,
						description: "图片 MIME 类型"
					},
					pageTitle: {
						type: "string",
						required: true,
						description: "截图时页面标题"
					},
					url: {
						type: "string",
						required: true,
						description: "截图时页面 URL"
					},
					attachment: {
						type: "object",
						additionalProperties: false,
						description: "模型图片引用（内部字段，attachment 服务可用时存在）",
						properties: {
							attachmentId: {
								type: "string",
								required: true
							},
							mediaType: {
								type: "string",
								required: true
							},
							bytes: {
								type: "integer",
								required: true
							},
							width: {
								type: "integer",
								required: true
							},
							height: {
								type: "integer",
								required: true
							},
							name: { type: "string" }
						}
					}
				}
			},
			render: (_args, value) => {
				const attachment = value.attachment;
				const text = `截图已保存：${value.path}（${value.width}x${value.height}，${Math.round(value.bytes / 1024)}KB）`;
				if (attachment !== void 0 && typeof attachment.attachmentId === "string") return [{
					type: "image",
					attachment
				}, {
					type: "text",
					text
				}];
				return [{
					type: "text",
					text
				}];
			}
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session, pageIndex } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const format = args.format ?? "png";
				let backendNodeId;
				if (args.elementUid !== void 0 && args.elementUid !== "") backendNodeId = resolveUid(session.uidRegistry, args.elementUid, pageIndex);
				const { buffer, width, height } = await captureScreenshot(page, {
					fullPage: args.fullPage === true && backendNodeId === void 0,
					format,
					quality: args.quality ?? 85,
					backendNodeId
				});
				const mediaType = format === "jpeg" ? "image/jpeg" : "image/png";
				const name = `shot-${Date.now()}-${sessionId.slice(0, 8)}.${format}`;
				const path = join(session.screenshotsDir, name);
				writeFileSync(path, buffer);
				const title = await page.title().catch(() => "");
				const url = page.url();
				const entry = {
					name,
					createdAt: Date.now(),
					bytes: buffer.length,
					width,
					height,
					fullPage: args.fullPage === true,
					pageTitle: title,
					url
				};
				appendShot(session.screenshotsDir, entry);
				let attachment;
				if (deps.attachImage !== void 0) try {
					attachment = await deps.attachImage(new Uint8Array(buffer), mediaType === "image/jpeg" ? "image/jpeg" : "image/png");
				} catch {
					attachment = void 0;
				}
				session.notify({
					kind: "screenshot",
					entry
				});
				return {
					path,
					name,
					width,
					height,
					bytes: buffer.length,
					mediaType,
					pageTitle: title,
					url,
					attachment: attachment ?? void 0
				};
			});
		}
	});
}
/** chrome_click — click the element behind a uid. */
function clickTool(deps) {
	return defineTool({
		name: "chrome_click",
		description: "点击快照中的一个元素（uid 来自 chrome_snapshot）。点击前自动滚动到元素可见位置，点击后等待页面稳定。dblClick=true 双击。页面变化后 uid 失效（报\"未知元素\"）时请重新 chrome_snapshot。对复选框/单选按钮/下拉框等元素同样适用（真实点击）。",
		parameters: {
			uid: {
				type: "string",
				required: true,
				description: "元素 uid（来自 chrome_snapshot 的 [uid] 行）"
			},
			dblClick: {
				type: "boolean",
				description: "true=双击；缺省单击"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session, pageIndex } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const backendNodeId = resolveUid(session.uidRegistry, args.uid, pageIndex);
				const cdp = await cdpSession(page);
				try {
					await clickUid(page, cdp, backendNodeId, args.dblClick === true);
				} finally {
					await cdp.detach().catch(() => {});
				}
				return { text: `已点击元素 ${args.uid}。页面可能已跳转或更新，建议需要时重新 chrome_snapshot。` };
			});
		}
	});
}
/** chrome_click_at — coordinate click. */
function clickAtTool(deps) {
	return defineTool({
		name: "chrome_click_at",
		description: "在视口坐标 (x, y) 处点击（像素，原点=视口左上角）。用于点击快照中无法用 uid 定位的内容（如 canvas 图形、视频播放器），坐标通常来自 chrome_screenshot 图片观察。",
		parameters: {
			x: {
				type: "integer",
				required: true,
				description: "X 坐标（视口像素）"
			},
			y: {
				type: "integer",
				required: true,
				description: "Y 坐标（视口像素）"
			},
			dblClick: {
				type: "boolean",
				description: "true=双击；缺省单击"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const cdp = await cdpSession(page);
				try {
					await clickAt(page, cdp, args.x, args.y, args.dblClick === true);
				} finally {
					await cdp.detach().catch(() => {});
				}
				return { text: `已在视口坐标 (${args.x}, ${args.y}) 处点击。` };
			});
		}
	});
}
/** chrome_fill — fill an input-like element. */
function fillTool(deps) {
	return defineTool({
		name: "chrome_fill",
		description: "向输入类元素填入文本：点击聚焦、全选现有内容、用输入事件替换为 value（与真实用户输入一致，会触发页面响应）。适用于文本框/搜索框/文本域/可编辑区域；复选框和单选按钮请用 chrome_click，文件上传/复杂组件请用 chrome_click 打开交互后继续。uid 来自 chrome_snapshot。",
		parameters: {
			uid: {
				type: "string",
				required: true,
				description: "输入元素 uid（来自 chrome_snapshot）"
			},
			value: {
				type: "string",
				required: true,
				description: "要填入的完整文本（会替换元素现有内容）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session, pageIndex } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const backendNodeId = resolveUid(session.uidRegistry, args.uid, pageIndex);
				const cdp = await cdpSession(page);
				try {
					await fillUid(page, cdp, backendNodeId, args.value);
				} finally {
					await cdp.detach().catch(() => {});
				}
				return { text: `已向元素 ${args.uid} 填入 ${args.value.length} 个字符。` };
			});
		}
	});
}
/** chrome_type — keyboard typing at focus. */
function typeTool(deps) {
	return defineTool({
		name: "chrome_type",
		description: "在页面当前焦点处逐键输入文本（触发 keydown/keypress/input 事件）。先点击输入框获得焦点后使用；比 chrome_fill 更接近真实打字（适合搜索建议、快捷键响应等需要逐键事件的场景）。",
		parameters: { text: {
			type: "string",
			required: true,
			description: "要逐键输入的文本"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				await typeText(page, args.text);
				return { text: `已输入 ${args.text.length} 个字符。` };
			});
		}
	});
}
/** chrome_press_key — single key press. */
function pressKeyTool(deps) {
	return defineTool({
		name: "chrome_press_key",
		description: "按下单个按键或组合键（如 Enter、Escape、Tab、ArrowDown、PageDown、F5）。用于提交表单（Enter）、关闭弹窗（Escape）、下拉选择（ArrowDown+Enter）等。",
		parameters: { key: {
			type: "string",
			required: true,
			description: "按键名：Enter/Escape/Tab/Backspace/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/PageUp/PageDown/Home/End/F5 或单个字符（如 a、1）"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				await pressKey(page, args.key);
				return { text: `已按下 ${args.key}。` };
			});
		}
	});
}
/** chrome_hover — hover an element. */
function hoverTool(deps) {
	return defineTool({
		name: "chrome_hover",
		description: "将鼠标悬停到快照元素上（uid 来自 chrome_snapshot），触发 hover 状态（下拉菜单、工具提示等）。",
		parameters: { uid: {
			type: "string",
			required: true,
			description: "元素 uid（来自 chrome_snapshot）"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session, pageIndex } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const backendNodeId = resolveUid(session.uidRegistry, args.uid, pageIndex);
				const cdp = await cdpSession(page);
				try {
					await hoverUid(cdp, backendNodeId);
				} finally {
					await cdp.detach().catch(() => {});
				}
				return { text: `已悬停在元素 ${args.uid} 上。` };
			});
		}
	});
}
/** chrome_scroll — viewport scrolling. */
function scrollTool(deps) {
	return defineTool({
		name: "chrome_scroll",
		description: "滚动当前视口：direction=down 向下 / up 向上滚动 amount 像素（缺省滚动一屏高度）；to=top/bottom 直接滚到页首/页尾。滚动后如需继续定位元素请重新 chrome_snapshot。",
		parameters: {
			direction: {
				type: "string",
				enum: ["down", "up"],
				description: "滚动方向（默认 down）"
			},
			amount: {
				type: "integer",
				description: "滚动像素数（缺省=一屏高度）"
			},
			to: {
				type: "string",
				enum: ["top", "bottom"],
				description: "直接滚到 top 页首 / bottom 页尾（优先于 direction）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const direction = args.direction ?? "down";
				const viewport = page.viewport();
				const amount = args.amount ?? (viewport !== null ? Math.round(viewport.height * .8) : 600);
				await scrollView(page, direction, amount, args.to);
				return { text: args.to === "top" ? "已滚到页首。" : args.to === "bottom" ? "已滚到页尾。" : `已${direction === "down" ? "向下" : "向上"}滚动 ${amount} 像素。` };
			});
		}
	});
}
/** chrome_evaluate — run JS in the page. */
function evaluateTool(deps) {
	return defineTool({
		name: "chrome_evaluate",
		description: "在当前标签页执行 JavaScript 表达式并返回结果。expression 是函数体（支持 await），返回值会被 JSON 序列化。用于读取页面数据（document.title、localStorage、元素属性）、调用页面内函数或实现快照覆盖不到的精确操作。安全提示：该工具与 shell 同权限，不要执行不可信代码。",
		parameters: { expression: {
			type: "string",
			required: true,
			description: "JS 函数体，例如 return document.title；支持 async/await；return 的值即工具结果"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true,
					description: "给模型的结果说明（含序列化后的值）"
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const value = await evaluateExpression(page, args.expression);
				let rendered;
				try {
					rendered = JSON.stringify(value);
				} catch {
					rendered = String(value);
				}
				if (rendered === void 0) rendered = "undefined";
				return { text: rendered.length > 8e3 ? `${rendered.slice(0, 8e3)}\n…（结果已截断）` : rendered };
			});
		}
	});
}
/** chrome_wait — wait for text to appear. */
function waitTool(deps) {
	return defineTool({
		name: "chrome_wait",
		description: "等待当前标签页正文出现指定文本（例如加载指示结束、AJAX 结果返回、弹窗出现）。text 为空时只等待页面稳定。默认超时 15 秒；超时不报错，返回 found=false 由调用方决定重试还是放弃。",
		parameters: {
			text: {
				type: "string",
				description: "等待出现的文本（页面正文子串匹配）；缺省=只等待页面稳定"
			},
			timeout: {
				type: "integer",
				description: "超时毫秒数（默认 15000）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					found: {
						type: "boolean",
						required: true,
						description: "超时前文本是否出现"
					},
					text: {
						type: "string",
						required: true,
						description: "给模型的结果说明"
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		execute: async (args, exec) => {
			throwIfAborted(exec.signal);
			const sessionId = sessionIdOf(exec);
			const { session } = await resolveTarget(deps.manager, sessionId);
			return session.run(async () => {
				const page = await session.selected();
				if (page === void 0) throw new Error("没有可用的标签页。");
				const timeout = args.timeout ?? 15e3;
				if (args.text === void 0 || args.text === "") {
					await page.waitForNetworkIdle({
						timeout,
						idleTime: 500
					}).catch(() => {});
					return {
						found: true,
						text: "页面已稳定。"
					};
				}
				const found = await waitForText(page, args.text, timeout);
				return {
					found,
					text: found ? `文本已出现：${args.text.slice(0, 60)}` : `等待超时（${timeout}ms），文本未出现：${args.text.slice(0, 60)}`
				};
			});
		}
	});
}
/** Register the full tool suite. */
function registerTools(ctx, deps) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
	};
	register(openTool(deps));
	register(statusTool(deps));
	register(closeTool(deps));
	register(navigateTool(deps));
	register(tabsTool(deps));
	register(snapshotTool(deps));
	register(screenshotTool(deps));
	register(clickTool(deps));
	register(clickAtTool(deps));
	register(fillTool(deps));
	register(typeTool(deps));
	register(pressKeyTool(deps));
	register(hoverTool(deps));
	register(scrollTool(deps));
	register(evaluateTool(deps));
	register(waitTool(deps));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion
//#region src/host/api.ts
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
/** sessionId whitelist: DSH session ids are `session-<uuid>`; keep it strict. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
/** JSON body cap (all payloads are small control messages). */
const MAX_BODY_BYTES = 65536;
/** Collapse bursts of change events into one trailing status push. */
const STATUS_BROADCAST_DEBOUNCE_MS = 120;
function sendJson(res, status, body) {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(data)
	});
	res.end(data);
}
/** Read a bounded JSON body. */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad shape");
		return parsed;
	} catch {
		throw new Error("请求体必须是 JSON 对象");
	}
}
/** Same-origin gate for mutations (mirrors the host's own API policy). */
function assertSameOrigin(req) {
	if (String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("Content-Type 必须为 application/json");
	const origin = String(req.headers.origin ?? "");
	if (origin === "") throw new Error("缺少 Origin 头");
	let originHost = "";
	try {
		originHost = new URL(origin).host;
	} catch {
		throw new Error("Origin 头无效");
	}
	const host = String(req.headers.host ?? "");
	if (originHost !== host) throw new Error("跨站请求已拒绝");
}
/**
* Reject cross-site reads. Modern browsers tag every request with
* Sec-Fetch-Site; `cross-site` means an attacker page (or a cross-site
* <img>/<script>) is hitting the loopback API, which should only ever serve
* the same-origin Web GUI. Requests without the header (curl, older
* clients) still pass — this is a hardening layer, not the whole gate.
*/
function assertNotCrossSite(req) {
	if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") throw new Error("跨站请求已拒绝");
}
/** Validate and return a sessionId from query or body. */
function requireSessionId(value, label) {
	if (typeof value !== "string" || !SESSION_ID_RE.test(value) || value.length > 128) throw new Error(`${label} 无效`);
	return value;
}
/** Install the HTTP routes and the screencast WebSocket. */
function installApi(webCtx, manager) {
	/** Live viewer sockets per session (screencast + status fan-out). */
	const viewers = /* @__PURE__ */ new Map();
	/** Sessions whose pushers are wired to the fan-out below. */
	const wired = /* @__PURE__ */ new Set();
	const broadcastStatus = (session) => {
		const sockets = viewers.get(session.sessionId);
		if (sockets === void 0 || sockets.size === 0) return;
		session.status().then((status) => {
			const data = JSON.stringify({
				type: "status",
				status
			});
			for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
		});
	};
	/** Debounced status fan-out: event bursts collapse into one push. */
	const statusTimers = /* @__PURE__ */ new Map();
	const scheduleStatus = (session) => {
		const pending = statusTimers.get(session);
		if (pending !== void 0) clearTimeout(pending);
		const timer = setTimeout(() => {
			statusTimers.delete(session);
			broadcastStatus(session);
		}, STATUS_BROADCAST_DEBOUNCE_MS);
		timer.unref?.();
		statusTimers.set(session, timer);
	};
	const wire = (session) => {
		if (wired.has(session)) return;
		wired.add(session);
		session.onFrame = (frame) => {
			const sockets = viewers.get(session.sessionId);
			if (sockets === void 0 || sockets.size === 0) return;
			const message = {
				type: "frame",
				...frame
			};
			const data = JSON.stringify(message);
			for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
		};
		session.onEvent = (detail) => {
			scheduleStatus(session);
			const sockets = viewers.get(session.sessionId);
			if (sockets === void 0 || sockets.size === 0) return;
			const data = JSON.stringify({
				type: "event",
				detail
			});
			for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
		};
	};
	const disposeHttp = webCtx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			try {
				assertNotCrossSite(req);
				const url = new URL(req.url ?? "/", "http://localhost");
				const path = url.pathname;
				if (req.method === "GET" && path === `/dsh-chrome/api/status`) {
					const sessionId = requireSessionId(url.searchParams.get("sessionId"), "sessionId");
					const session = manager.get(sessionId);
					if (session === void 0) {
						sendJson(res, 200, {
							sessionId,
							running: false,
							pages: [],
							startedAt: null,
							lastUsedAt: null,
							idleDeadline: null,
							lastScreenshot: null,
							screencastActive: false,
							error: null
						});
						return;
					}
					wire(session);
					sendJson(res, 200, await session.status());
					return;
				}
				if (req.method === "GET" && path === `/dsh-chrome/api/screenshots`) {
					const sessionId = requireSessionId(url.searchParams.get("sessionId"), "sessionId");
					const session = manager.get(sessionId);
					if (session === void 0) {
						sendJson(res, 200, { entries: [] });
						return;
					}
					sendJson(res, 200, { entries: screenshotHistory(session.screenshotsDir) });
					return;
				}
				if (req.method === "GET" && path === `/dsh-chrome/api/screenshot-file`) {
					const sessionId = requireSessionId(url.searchParams.get("sessionId"), "sessionId");
					const name = url.searchParams.get("name") ?? "";
					if (!SHOT_NAME_RE.test(name)) {
						sendJson(res, 400, { error: "截图文件名无效" });
						return;
					}
					const session = manager.get(sessionId);
					if (session === void 0) {
						sendJson(res, 404, { error: "会话无 Chrome 窗口" });
						return;
					}
					let buffer;
					try {
						buffer = await readFile(join(session.screenshotsDir, name));
					} catch {
						sendJson(res, 404, { error: "截图文件不存在" });
						return;
					}
					const type = name.endsWith(".png") ? "image/png" : "image/jpeg";
					res.writeHead(200, {
						"Content-Type": type,
						"Cache-Control": "no-cache",
						"Content-Length": buffer.length
					});
					res.end(buffer);
					return;
				}
				assertSameOrigin(req);
				const body = await readJsonBody(req);
				const sessionId = requireSessionId(body.sessionId, "sessionId");
				if (req.method === "POST" && path === `/dsh-chrome/api/open`) {
					const session = await manager.getOrLaunch(sessionId, typeof body.url === "string" ? body.url : void 0);
					wire(session);
					sendJson(res, 200, {
						ok: true,
						status: await session.status()
					});
					return;
				}
				if (req.method === "POST" && path === `/dsh-chrome/api/close`) {
					await manager.close(sessionId);
					sendJson(res, 200, { ok: true });
					return;
				}
				if (req.method === "POST" && path === `/dsh-chrome/api/reload`) {
					const session = await manager.getOrLaunch(sessionId);
					wire(session);
					await session.run(async () => {
						const page = await session.ensurePage();
						if (page === void 0) throw new Error("没有可用的标签页。");
						await page.reload({
							waitUntil: "domcontentloaded",
							timeout: NAV_TIMEOUT_MS
						});
					});
					sendJson(res, 200, {
						ok: true,
						status: await session.status()
					});
					return;
				}
				if (req.method === "POST" && path === `/dsh-chrome/api/navigate`) {
					const action = body.action;
					if (action !== "goto" && action !== "back" && action !== "forward") {
						sendJson(res, 400, { error: "action 必须是 goto/back/forward" });
						return;
					}
					const session = await manager.getOrLaunch(sessionId);
					wire(session);
					await session.run(async () => {
						const page = await session.ensurePage();
						if (page === void 0) throw new Error("没有可用的标签页。");
						if (action === "goto") {
							const target = String(body.url ?? "");
							if (target.trim() === "") throw new Error("goto 需要 url");
							await page.goto(normalizeUrl(target), {
								waitUntil: "domcontentloaded",
								timeout: NAV_TIMEOUT_MS
							});
						} else if (action === "back") await page.goBack({ timeout: NAV_TIMEOUT_MS }).catch(() => page.goBack());
						else await page.goForward({ timeout: NAV_TIMEOUT_MS }).catch(() => page.goForward());
					});
					sendJson(res, 200, {
						ok: true,
						status: await session.status()
					});
					return;
				}
				if (req.method === "POST" && path === `/dsh-chrome/api/tabs`) {
					const action = body.action;
					const session = await manager.getOrLaunch(sessionId);
					wire(session);
					await session.run(async () => {
						if (action === "select") {
							const index = typeof body.index === "number" ? body.index : session.selectedIndex;
							await session.selectPage(index);
							return;
						}
						if (action === "close") {
							const index = typeof body.index === "number" ? body.index : session.selectedIndex;
							await session.closeTab(index);
							return;
						}
						if (action === "new") {
							const url = typeof body.url === "string" && body.url.trim() !== "" ? body.url : void 0;
							await session.newTab(url);
							return;
						}
						throw new Error("action 必须是 list/select/close/new");
					});
					sendJson(res, 200, {
						ok: true,
						status: await session.status()
					});
					return;
				}
				sendJson(res, 404, { error: "未知的 dsh-chrome API 路径" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(res, message.includes("跨站") || message.includes("Origin") || message.includes("Content-Type") ? 403 : 400, { error: message });
			}
		}
	});
	const wss = new WebSocketServer({ noServer: true });
	wss.on("connection", (socket, req) => {
		const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
		if (!SESSION_ID_RE.test(sessionId)) {
			socket.close(1008, "invalid sessionId");
			return;
		}
		let set = viewers.get(sessionId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			viewers.set(sessionId, set);
		}
		set.add(socket);
		const token = { sessionId };
		const session = manager.get(sessionId);
		if (session !== void 0) {
			wire(session);
			session.status().then((status) => {
				if (socket.readyState !== WebSocket.OPEN) return;
				const welcome = {
					type: "welcome",
					status
				};
				socket.send(JSON.stringify(welcome));
			});
		}
		manager.getOrLaunch(sessionId).then((launched) => {
			wire(launched);
			launched.addScreencastWatcher(token).catch(() => {});
		});
		socket.on("message", (raw) => {
			let message;
			try {
				message = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
		});
		socket.on("close", () => {
			set.delete(socket);
			if (set.size === 0) viewers.delete(sessionId);
			const live = manager.get(sessionId);
			if (live !== void 0) live.removeScreencastWatcher(token);
		});
		socket.on("error", () => {});
	});
	const disposeUpgrade = webCtx.webServer.registerUpgrade({
		path: WS_PATH,
		handler: (req, socket, head) => {
			if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") {
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		}
	});
	return () => {
		disposeHttp();
		disposeUpgrade();
		for (const timer of statusTimers.values()) clearTimeout(timer);
		statusTimers.clear();
		for (const sockets of viewers.values()) for (const socket of sockets) socket.close(1001, "plugin unloaded");
		viewers.clear();
		wired.clear();
		wss.close();
	};
}
//#endregion
//#region src/host/index.ts
const name = "dsh-plugin-chrome";
/** Services required before this plugin mounts. */
const inject = ["tools"];
/**
* Plugin entry: register tools, Web API, and the session-Chrome manager.
* @param ctx - plugin context (`tools` injected; `webServer`/`attachments`
*   are optional services probed lazily).
* @param rawConfig - cordis loader config (schema defaults already applied).
*/
function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	const manager = new ChromeManager(config, resolveDataRoot(config.dataRoot));
	const deps = {
		manager,
		config,
		attachImage: async (data, mediaType) => {
			const attachments = ctx.get("attachments");
			if (attachments === void 0) throw new Error("attachment service unavailable");
			return attachments.saveImage({
				data,
				mediaType
			});
		}
	};
	ctx.effect(() => registerTools(ctx, deps), "dsh-plugin-chrome: tools");
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => installApi(webCtx, manager), "dsh-plugin-chrome: web api");
	});
	ctx.effect(() => () => {
		manager.dispose();
		manager.closeAll();
	}, "dsh-plugin-chrome: chrome manager");
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map