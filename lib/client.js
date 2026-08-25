window.__ModuleLoader__.load({
	id: "dsh-plugin-chrome",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/ChromeTab.tsx
		/**
		* Chrome 控制面板（conversation.view 会话 Tab）。
		*
		* 左侧实时画面（screencast WebSocket 帧 → canvas），右侧标签页列表，
		* 顶部控制条（打开/关闭/刷新/新建标签/截图）+「截图历史」子视图。
		* 状态以 5s 轮询兜底、WebSocket 事件即时刷新；所有写操作走同源
		* POST API，会话 id 来自槽位 kit 的 sessionId。
		*/
		/** Host endpoints (relative — same origin as the DSH GUI). */
		const API = {
			status: (sessionId) => `/dsh-chrome/api/status?sessionId=${encodeURIComponent(sessionId)}`,
			open: "/dsh-chrome/api/open",
			close: "/dsh-chrome/api/close",
			reload: "/dsh-chrome/api/reload",
			tabs: "/dsh-chrome/api/tabs",
			screenshot: "/dsh-chrome/api/screenshot-file",
			history: (sessionId) => `/dsh-chrome/api/screenshots?sessionId=${encodeURIComponent(sessionId)}`,
			ws: (sessionId) => {
				return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/dsh-chrome/ws?sessionId=${encodeURIComponent(sessionId)}`;
			}
		};
		/** POST a JSON control message; throws with the server's error text. */
		async function post(path, body) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					const payload = await res.json();
					if (payload.error !== void 0) message = payload.error;
				} catch {}
				throw new Error(message);
			}
			return res.json();
		}
		/** Format an epoch-ms timestamp for the meta line. */
		function formatTime(epoch) {
			if (epoch === null || epoch === 0) return "—";
			return new Date(epoch).toLocaleTimeString();
		}
		/** Countdown label for the idle auto-close deadline. */
		function idleLabel(deadline, t) {
			if (deadline === null) return "";
			const seconds = Math.max(0, Math.round((deadline - Date.now()) / 1e3));
			const minutes = Math.floor(seconds / 60);
			const rest = seconds % 60;
			return ` · ${t("hint.idle")} ${minutes}:${String(rest).padStart(2, "0")}`;
		}
		/** The Chrome session tab. */
		function ChromeTab(props) {
			const { sessionId, t } = props;
			const [status, setStatus] = (0, react.useState)(null);
			const [shots, setShots] = (0, react.useState)([]);
			const [view, setView] = (0, react.useState)("live");
			const [enlarged, setEnlarged] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const canvasRef = (0, react.useRef)(null);
			const statusRef = (0, react.useRef)(null);
			statusRef.current = status;
			/** Poll status + history (WebSocket covers instant updates; this is the fallback). */
			const refresh = (0, react.useCallback)(async () => {
				try {
					const res = await fetch(API.status(String(sessionId)), { cache: "no-store" });
					if (!res.ok) throw new Error(String(res.status));
					setStatus(await res.json());
					const historyRes = await fetch(API.history(String(sessionId)), { cache: "no-store" });
					if (historyRes.ok) {
						const payload = await historyRes.json();
						setShots(payload.entries ?? []);
					}
					setError(null);
				} catch {}
			}, [sessionId]);
			(0, react.useEffect)(() => {
				refresh();
				const timer = setInterval(() => void refresh(), 5e3);
				return () => clearInterval(timer);
			}, [refresh]);
			/** Live stream: WebSocket welcome/status/event/frame handling. */
			(0, react.useEffect)(() => {
				let socket = null;
				let closed = false;
				const drawFrame = (data, width, height) => {
					const canvas = canvasRef.current;
					if (canvas === null || closed) return;
					const image = new Image();
					image.onload = () => {
						if (closed || canvasRef.current !== canvas) return;
						const scale = Math.min(1, (canvas.clientWidth || canvas.width) / Math.max(1, width));
						const targetWidth = Math.max(1, Math.round(width * scale));
						const targetHeight = Math.max(1, Math.round(height * scale));
						if (canvas.width !== targetWidth) canvas.width = targetWidth;
						if (canvas.height !== targetHeight) canvas.height = targetHeight;
						canvas.getContext("2d")?.drawImage(image, 0, 0, targetWidth, targetHeight);
					};
					image.src = `data:image/jpeg;base64,${data}`;
				};
				const connect = () => {
					if (closed) return;
					try {
						socket = new WebSocket(API.ws(String(sessionId)));
					} catch {
						return;
					}
					socket.onopen = () => {
						socket?.send(JSON.stringify({ type: "ping" }));
					};
					socket.onmessage = (event) => {
						let message;
						try {
							message = JSON.parse(String(event.data));
						} catch {
							return;
						}
						if (message.type === "welcome" || message.type === "status") setStatus(message.status);
						else if (message.type === "frame") drawFrame(message.data, message.width, message.height);
						else if (message.type === "event" && message.detail.kind === "screenshot") {
							const entry = message.detail.entry;
							setShots((current) => [entry, ...current].slice(0, 50));
						}
					};
					socket.onclose = () => {
						if (!closed) setTimeout(connect, 3e3);
					};
					socket.onerror = () => {};
				};
				connect();
				return () => {
					closed = true;
					socket?.close();
				};
			}, [sessionId]);
			/** Run one control action with busy feedback and error surfacing. */
			const runAction = (0, react.useCallback)(async (fn) => {
				setBusy(true);
				setError(null);
				try {
					await fn();
					await refresh();
				} catch (caught) {
					setError(`${t("err.action")}：${caught instanceof Error ? caught.message : String(caught)}`);
				} finally {
					setBusy(false);
				}
			}, [refresh, t]);
			const openWindow = (0, react.useCallback)(() => {
				runAction(() => post(API.open, { sessionId: String(sessionId) }));
			}, [runAction, sessionId]);
			const closeWindow = (0, react.useCallback)(() => {
				runAction(() => post(API.close, { sessionId: String(sessionId) }));
			}, [runAction, sessionId]);
			const reloadPage = (0, react.useCallback)(() => {
				runAction(() => post(API.reload, { sessionId: String(sessionId) }));
			}, [runAction, sessionId]);
			const newTab = (0, react.useCallback)(() => {
				runAction(() => post(API.tabs, {
					sessionId: String(sessionId),
					action: "new"
				}));
			}, [runAction, sessionId]);
			const selectTab = (0, react.useCallback)((index) => {
				runAction(() => post(API.tabs, {
					sessionId: String(sessionId),
					action: "select",
					index
				}));
			}, [runAction, sessionId]);
			const closeTab = (0, react.useCallback)((index) => {
				runAction(() => post(API.tabs, {
					sessionId: String(sessionId),
					action: "close",
					index
				}));
			}, [runAction, sessionId]);
			const running = status?.running === true;
			const streaming = status?.screencastActive === true;
			const currentShot = shots[0]?.name ?? null;
			const activeIndex = status?.pages.find((page) => page.selected)?.index ?? 0;
			const hint = (0, react.useMemo)(() => {
				if (!running) return t("hint.empty");
				return view === "live" ? t("hint.stream") : t("hint.shots");
			}, [
				running,
				view,
				t
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-chrome-tab",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-chrome-tab__bar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-chrome-tab__state",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dsh-chrome-tab__dot ${running ? "dsh-chrome-tab__dot--on" : "dsh-chrome-tab__dot--off"}` }),
									running ? t("state.running") : t("state.stopped"),
									busy ? ` · ${t("hint.busy")}` : ""
								]
							}),
							running ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									onClick: reloadPage,
									disabled: busy,
									children: t("action.reload")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									onClick: newTab,
									disabled: busy,
									children: t("action.newTab")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									onClick: closeWindow,
									disabled: busy,
									className: "dsh-chrome-tab__danger",
									children: t("action.close")
								})
							] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: openWindow,
								disabled: busy,
								className: "dsh-chrome-tab__primary",
								children: t("action.open")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => setView("live"),
								disabled: view === "live",
								children: t("state.streaming")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => setView("shots"),
								disabled: view === "shots",
								children: t("state.shots")
							})
						]
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-chrome-tab__error",
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-chrome-tab__hint",
						children: hint
					}),
					running && view === "live" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-chrome-tab__panel",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-chrome-tab__stage",
							children: [streaming && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-chrome-tab__badge",
								children: "LIVE"
							}), streaming ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
								ref: canvasRef,
								width: 640,
								height: 360,
								"aria-label": t("state.streaming")
							}) : currentShot !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								src: `${API.screenshot}?sessionId=${encodeURIComponent(String(sessionId))}&name=${encodeURIComponent(currentShot)}`,
								alt: "screenshot"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-chrome-tab__empty",
								children: "…"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-chrome-tab__tabs",
							children: (status?.pages ?? []).map((page) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 2
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									className: `dsh-chrome-tab__tab ${page.selected ? "dsh-chrome-tab__tab--active" : ""}`,
									onClick: () => selectTab(page.index),
									title: `${t("action.select")} [${page.index}]`,
									children: [page.index === activeIndex ? "▶ " : "", page.title || page.url || `[${page.index}]`]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsh-chrome-tab__tab",
									style: {
										flex: "0 0 auto",
										paddingLeft: 4,
										paddingRight: 4
									},
									onClick: () => closeTab(page.index),
									title: `${t("action.closeTab")} [${page.index}]`,
									children: "✕"
								})]
							}, page.index))
						})]
					}),
					running && view === "shots" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-chrome-tab__shots",
						children: [shots.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-chrome-tab__hint",
							children: "—"
						}), shots.map((shot) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							className: "dsh-chrome-tab__shot",
							onClick: () => setEnlarged(shot.name),
							title: shot.url || shot.name,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								src: `${API.screenshot}?sessionId=${encodeURIComponent(String(sessionId))}&name=${encodeURIComponent(shot.name)}`,
								alt: shot.pageTitle || shot.name,
								loading: "lazy"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: shot.pageTitle || new Date(shot.createdAt).toLocaleString() })]
						}, shot.name))]
					}),
					enlarged !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-chrome-tab__stage",
						onClick: () => setEnlarged(null),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							src: `${API.screenshot}?sessionId=${encodeURIComponent(String(sessionId))}&name=${encodeURIComponent(enlarged)}`,
							alt: enlarged
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-chrome-tab__meta",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("meta.started"),
								" ",
								formatTime(status?.startedAt ?? null)
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("meta.lastUsed"),
								" ",
								formatTime(status?.lastUsedAt ?? null),
								idleLabel(status?.idleDeadline ?? null, t)
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("meta.tabs"),
								" ",
								status?.pages.length ?? 0
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("meta.shotCount"),
								" ",
								shots.length
							] })
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Chrome 面板样式（作为字符串内联注入，style[data-plugin] 可被 HMR 追踪）。
		* 仅用 --dsw-* 语义 token 之外的少量本地变量，适配明暗主题。
		*/
		const CHROME_TAB_CSS = `
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
`;
		/** 面板文案（zh/en 字典，通过 locale 系统注入）。 */
		const zh = {
			"tab.label": "Chrome",
			"state.running": "窗口运行中",
			"state.stopped": "窗口未打开",
			"state.streaming": "实时画面",
			"state.shots": "截图历史",
			"action.open": "打开窗口",
			"action.close": "关闭窗口",
			"action.reload": "刷新页面",
			"action.newTab": "新建标签页",
			"action.select": "切换标签",
			"action.closeTab": "关闭标签",
			"hint.empty": "Chrome 窗口尚未打开。点击「打开窗口」，或让 Agent 使用 chrome_open 工具——窗口会以独立可视窗口出现，Agent 的每一步操作你都能实时看到。",
			"hint.stream": "实时画面来自 Chrome screencast（约数帧/秒）。你随时可以直接在 Chrome 窗口里手动操作，Agent 会在下一个工具调用时看到你的改动。",
			"hint.shots": "Agent 每次 chrome_screenshot 的产物都保存在这里（含标题/URL/尺寸，重启后仍在），点击缩略图放大查看。",
			"hint.idle": "空闲自动关闭",
			"hint.busy": "操作中…",
			"err.action": "操作失败",
			"meta.started": "启动于",
			"meta.lastUsed": "最近活动",
			"meta.tabs": "标签页",
			"meta.shotCount": "截图"
		};
		const en = {
			"tab.label": "Chrome",
			"state.running": "Window running",
			"state.stopped": "Window closed",
			"state.streaming": "Live view",
			"state.shots": "Screenshots",
			"action.open": "Open window",
			"action.close": "Close window",
			"action.reload": "Reload page",
			"action.newTab": "New tab",
			"action.select": "Switch tab",
			"action.closeTab": "Close tab",
			"hint.empty": "The Chrome window is not open yet. Click \"Open window\" or let the agent call the chrome_open tool — the window appears as a separate visible browser and you can watch every agent action live.",
			"hint.stream": "The live view streams from Chrome screencast (a few frames per second). You can operate the window yourself at any time; the agent sees your changes on its next tool call.",
			"hint.shots": "Every chrome_screenshot the agent takes is kept here (title/URL/size metadata survives restarts). Click a thumbnail to enlarge.",
			"hint.idle": "auto-close when idle",
			"hint.busy": "working…",
			"err.action": "action failed",
			"meta.started": "started",
			"meta.lastUsed": "last activity",
			"meta.tabs": "tabs",
			"meta.shotCount": "screenshots"
		};
		//#endregion
		//#region src/client/index.ts
		/** Locale namespace owned by this plugin. */
		const NS = "plugin-chrome";
		/** Client services this plugin reads. */
		const inject = ["slots", "locale"];
		/** Inject the stylesheet once per plugin fiber (removed on unload). */
		function injectStyles() {
			const tagId = "dsh-plugin-chrome/styles";
			if (typeof document === "undefined" || document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-chrome";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CHROME_TAB_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/**
		* Client plugin entry: register the locale dictionaries and the Chrome tab.
		* @param ctx - client plugin context (`slots`, `locale` injected).
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-plugin-chrome: dictionaries");
			ctx.effect(() => injectStyles(), "dsh-plugin-chrome: styles");
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "chrome-hub",
				order: 40,
				label: () => t("tab.label")
			}, (props) => ChromeTab({
				...props,
				t
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.en = en;
		exports.inject = inject;
		exports.zh = zh;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map