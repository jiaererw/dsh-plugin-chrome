/**
 * Plugin configuration (schemastery schema — validated by the cordis Loader).
 *
 * Every deployment-varying choice is a config field, so a profile patch can
 * tune it without editing source.
 */
import z from 'schemastery'

/** User-facing config shape. */
export interface Config {
  /**
   * Absolute path to the Chrome/Edge executable. Empty means auto-detect:
   * Chrome first, then Edge, then Chromium (per platform conventions).
   */
  executablePath?: string
  /**
   * Run the window headless. Default false — the whole point of the plugin
   * is a VISIBLE browser window the user can watch and take over.
   */
  headless?: boolean
  /**
   * Data root. Each session gets <dataRoot>/sessions/<sessionId>/ holding
   * its isolated browser profile and screenshots. Defaults to
   * <DSH_HOME>/data/dsh-plugin-chrome.
   */
  dataRoot?: string
  /**
   * Idle timeout in milliseconds. A Chrome window with no tool or UI
   * activity for this long closes automatically. 0 disables the timer.
   */
  idleTimeoutMs?: number
  /** Initial window width/height in pixels; 0 = Chrome default. */
  windowWidth?: number
  windowHeight?: number
  /** Extra Chrome command-line flags (joined with a space). */
  extraArgs?: string
  /**
   * Screencast frame skip: one frame is kept every N source frames.
   * Higher = less bandwidth, lower = smoother live preview.
   */
  screencastFrameSkip?: number
  /** Screencast JPEG quality, 1-100. */
  screencastQuality?: number
  /** Maximum characters of one snapshot result sent to the model. */
  maxSnapshotText?: number
  /** Maximum tabs a session window may open. */
  maxTabs?: number
}

/** Single source of truth for defaults (schema + resolver). */
const DEFAULTS = {
  executablePath: '',
  headless: false,
  dataRoot: '',
  idleTimeoutMs: 600000,
  windowWidth: 1280,
  windowHeight: 900,
  extraArgs: '',
  screencastFrameSkip: 4,
  screencastQuality: 70,
  maxSnapshotText: 60000,
  maxTabs: 16,
} as const satisfies Record<keyof Config, string | number | boolean>

/** Loader-validated config schema; defaults come from {@link DEFAULTS}. */
export const Config: z<Config> = z.object({
  executablePath: z.string().default(DEFAULTS.executablePath),
  headless: z.boolean().default(DEFAULTS.headless),
  dataRoot: z.string().default(DEFAULTS.dataRoot),
  idleTimeoutMs: z.number().min(0).default(DEFAULTS.idleTimeoutMs),
  windowWidth: z.number().min(0).default(DEFAULTS.windowWidth),
  windowHeight: z.number().min(0).default(DEFAULTS.windowHeight),
  extraArgs: z.string().default(DEFAULTS.extraArgs),
  screencastFrameSkip: z.number().min(1).default(DEFAULTS.screencastFrameSkip),
  screencastQuality: z.number().min(1).max(100).default(DEFAULTS.screencastQuality),
  maxSnapshotText: z.number().min(1000).default(DEFAULTS.maxSnapshotText),
  maxTabs: z.number().min(1).default(DEFAULTS.maxTabs),
})

/** Resolved shape after the Loader applies schema defaults. */
export type ResolvedConfig = {
  [K in keyof Config]-?: NonNullable<Config[K]>
}

/** Resolve a (possibly partial) raw config into a complete value. */
export function resolveConfig(raw: Partial<Config> = {}): ResolvedConfig {
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
    maxTabs: raw.maxTabs ?? DEFAULTS.maxTabs,
  }
}
