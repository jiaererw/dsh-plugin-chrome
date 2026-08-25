import { describe, expect, it } from 'vitest'
import { normalizeUrl } from '../src/host/actions.ts'

describe('normalizeUrl', () => {
  it('prepends https:// to schemeless hostnames', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('  example.com/x?y=1  ')).toBe('https://example.com/x?y=1')
  })

  it('keeps existing safe schemes untouched', () => {
    expect(normalizeUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('data:text/html,<p>hi</p>')).toBe('data:text/html,<p>hi</p>')
  })

  it('rejects script-vector schemes', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/不安全/u)
    expect(() => normalizeUrl('vbscript:msgbox')).toThrow(/不安全/u)
  })
})
