/**
 * Screenshot metadata index (sidecar for the Web GUI history).
 *
 * Every chrome_screenshot records its full metadata (title/url/size) into a
 * per-session shots.json index so the history survives restarts. Listing
 * falls back to a plain directory scan for shots written by older plugin
 * versions — those simply show empty metadata.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScreenshotEntry } from '../shared/contract.ts'

/** Index file name inside a session's screenshots dir. */
export const SHOT_INDEX_NAME = 'shots.json'

/** Screenshot file-name whitelist (mirrors the API's). */
export const SHOT_NAME_RE = /^shot-[0-9]+-[A-Za-z0-9_-]{0,64}\.(png|jpeg|jpg)$/u

/** Max entries kept in the index (the listing caps at 50 anyway). */
const MAX_INDEX_ENTRIES = 200

/** Read the metadata index ([] when missing or corrupt). */
export function readShotIndex(dir: string): ScreenshotEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, SHOT_INDEX_NAME), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)) {
      return (parsed as { entries: ScreenshotEntry[] }).entries
    }
  } catch {
    // Missing/corrupt index: fall back to the directory scan.
  }
  return []
}

/** Prepend one entry to the index (bounded, newest first). */
export function appendShot(dir: string, entry: ScreenshotEntry): void {
  const next = [entry, ...readShotIndex(dir).filter((existing) => existing.name !== entry.name)].slice(0, MAX_INDEX_ENTRIES)
  try {
    writeFileSync(join(dir, SHOT_INDEX_NAME), JSON.stringify({ entries: next }))
  } catch {
    // Non-fatal: the screenshot file itself is already saved.
  }
}

/** All screenshot entries, newest first (metadata-enriched when indexed). */
export function screenshotHistory(dir: string): ScreenshotEntry[] {
  const indexed = new Map(readShotIndex(dir).map((entry) => [entry.name, entry]))
  const entries: ScreenshotEntry[] = []
  try {
    for (const name of readdirSync(dir)) {
      if (!SHOT_NAME_RE.test(name)) continue
      const info = statSync(join(dir, name))
      entries.push(indexed.get(name) ?? {
        name, createdAt: info.mtimeMs, bytes: info.size, width: 0, height: 0, fullPage: false, pageTitle: '', url: '',
      })
    }
  } catch {
    // The screenshots dir may not exist yet.
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
}

/** Name of the most recent screenshot (index-first, scan fallback). */
export function latestScreenshot(dir: string): string | null {
  const indexed = readShotIndex(dir)
  if (indexed.length > 0) return indexed[0]?.name ?? null
  return screenshotHistory(dir)[0]?.name ?? null
}
