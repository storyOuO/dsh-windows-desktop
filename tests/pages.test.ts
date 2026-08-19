import { describe, it, expect } from 'vitest'
import { shellPageUrl, escapeHtml } from '../electron/pages'

describe('shellPageUrl', () => {
  it('returns a data:text/html URL', () => {
    const url = shellPageUrl()
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
  })

  it('embeds the page skeleton (spinner, message, detail, retry button)', () => {
    const url = shellPageUrl()
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('id="spinner"')
    expect(html).toContain('id="msg"')
    expect(html).toContain('id="detail"')
    expect(html).toContain('id="retry"')
  })

  it('wires the page to the preload bridge API', () => {
    const url = shellPageUrl()
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('dshDesktop.onBootstrapStatus')
    expect(html).toContain('dshDesktop.retry')
  })

  it('produces stable output for repeated calls', () => {
    expect(shellPageUrl()).toBe(shellPageUrl())
  })
})

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('leaves plain text untouched', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123')
  })
})
