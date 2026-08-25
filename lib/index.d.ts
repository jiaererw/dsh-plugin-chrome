import z from "schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/config.d.ts
/** User-facing config shape. */
interface Config {
  /**
   * Absolute path to the Chrome/Edge executable. Empty means auto-detect:
   * Chrome first, then Edge, then Chromium (per platform conventions).
   */
  executablePath?: string;
  /**
   * Run the window headless. Default false — the whole point of the plugin
   * is a VISIBLE browser window the user can watch and take over.
   */
  headless?: boolean;
  /**
   * Data root. Each session gets <dataRoot>/sessions/<sessionId>/ holding
   * its isolated browser profile and screenshots. Defaults to
   * <DSH_HOME>/data/dsh-plugin-chrome.
   */
  dataRoot?: string;
  /**
   * Idle timeout in milliseconds. A Chrome window with no tool or UI
   * activity for this long closes automatically. 0 disables the timer.
   */
  idleTimeoutMs?: number;
  /** Initial window width/height in pixels; 0 = Chrome default. */
  windowWidth?: number;
  windowHeight?: number;
  /** Extra Chrome command-line flags (joined with a space). */
  extraArgs?: string;
  /**
   * Screencast frame skip: one frame is kept every N source frames.
   * Higher = less bandwidth, lower = smoother live preview.
   */
  screencastFrameSkip?: number;
  /** Screencast JPEG quality, 1-100. */
  screencastQuality?: number;
  /** Maximum characters of one snapshot result sent to the model. */
  maxSnapshotText?: number;
  /** Maximum tabs a session window may open. */
  maxTabs?: number;
}
/** Loader-validated config schema; defaults come from {@link DEFAULTS}. */
declare const Config: z<Config>;
//#endregion
//#region src/host/index.d.ts
declare const name = "dsh-plugin-chrome";
/** Services required before this plugin mounts. */
declare const inject: string[];
/**
 * Plugin entry: register tools, Web API, and the session-Chrome manager.
 * @param ctx - plugin context (`tools` injected; `webServer`/`attachments`
 *   are optional services probed lazily).
 * @param rawConfig - cordis loader config (schema defaults already applied).
 */
declare function apply(ctx: Context, rawConfig: Config): void;
//#endregion
export { Config, type Config as ConfigShape, apply, inject, name };
//# sourceMappingURL=index.d.ts.map