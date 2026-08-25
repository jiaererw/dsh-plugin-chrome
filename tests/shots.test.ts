import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScreenshotEntry } from '../src/shared/contract.ts'
import { appendShot, latestScreenshot, readShotIndex, screenshotHistory } from '../src/host/shots.ts'

function entry(name: string, createdAt: number): ScreenshotEntry {
  return { name, createdAt, bytes: 100, width: 640, height: 480, fullPage: false, pageTitle: '测试页', url: 'https://example.com' }
}

describe('shot index', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-shots-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips metadata and lists newest first', () => {
    appendShot(dir, entry('shot-1-abc.png', 100))
    writeFileSync(join(dir, 'shot-1-abc.png'), 'x')
    appendShot(dir, entry('shot-2-abc.png', 200))
    writeFileSync(join(dir, 'shot-2-abc.png'), 'x')

    expect(latestScreenshot(dir)).toBe('shot-2-abc.png')
    const history = screenshotHistory(dir)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ name: 'shot-2-abc.png', pageTitle: '测试页', url: 'https://example.com', width: 640 })
  })

  it('falls back to a metadata-less scan for unindexed files', () => {
    writeFileSync(join(dir, 'shot-9-abc.png'), 'x')
    const history = screenshotHistory(dir)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ name: 'shot-9-abc.png', pageTitle: '', url: '' })
    expect(latestScreenshot(dir)).toBe('shot-9-abc.png')
  })

  it('tolerates a missing or corrupt index', () => {
    expect(readShotIndex(dir)).toEqual([])
    writeFileSync(join(dir, 'shots.json'), '{nope')
    expect(readShotIndex(dir)).toEqual([])
  })

  it('dedupes by name when the same shot is appended twice', () => {
    appendShot(dir, entry('shot-1-abc.png', 100))
    appendShot(dir, { ...entry('shot-1-abc.png', 200), pageTitle: '新标题' })
    expect(readShotIndex(dir)).toHaveLength(1)
    expect(readShotIndex(dir)[0]).toMatchObject({ pageTitle: '新标题', createdAt: 200 })
  })
})
