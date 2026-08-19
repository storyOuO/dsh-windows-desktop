/**
 * Bootstrap shell pages rendered inside the main BrowserWindow: a loading
 * page shown the instant the window opens, and an error state driven by
 * bootstrap-status IPC (phase 'error' swaps the spinner for the failure
 * reason and a retry button). Pages load as data URLs, so they carry no
 * assets; the preload bridge provides the IPC surface they script against.
 * @module electron/pages
 */

/** Bootstrap status pushed from main to the shell page. */
export interface BootstrapStatus {
  /** 'loading' shows the spinner; 'error' shows the reason and retry button. */
  phase: 'loading' | 'error'
  /** One-line human summary for the error phase. */
  message?: string
  /** Multi-line diagnostic detail (observed HTTP statuses, backend tail). */
  detail?: string
}

/** Escape text for safe embedding in an HTML body / attribute. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Shared CSS for the shell pages. */
const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #1a1a2e; color: #e8e8f0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 32px;
  }
  .wrap { max-width: 720px; width: 100%; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 24px; letter-spacing: .5px; }
  .spinner {
    width: 40px; height: 40px; margin: 0 auto 24px;
    border: 3px solid rgba(255,255,255,.15); border-top-color: #4f8cff;
    border-radius: 50%; animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .msg { font-size: 15px; color: #b8b8cc; margin-bottom: 16px; }
  .detail {
    text-align: left; font: 12px/1.5 "Cascadia Code", Consolas, monospace;
    background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08);
    border-radius: 8px; padding: 14px 16px; margin: 0 auto 24px;
    white-space: pre-wrap; word-break: break-all;
    max-height: 40vh; overflow: auto; display: none;
  }
  .detail.show { display: block; }
  button {
    display: none; padding: 10px 28px; font-size: 15px;
    background: #4f8cff; color: #fff; border: 0; border-radius: 6px;
    cursor: pointer;
  }
  button.show { display: inline-block; }
  button:hover { background: #6b9dff; }
`

/**
 * Build the shell page as a data URL. The page reacts to
 * `window.dshDesktop.onBootstrapStatus` events: phase 'loading' shows the
 * spinner; phase 'error' shows the message, the diagnostic detail, and a
 * retry button wired to `window.dshDesktop.retry()`.
 * @returns the `data:text/html,...` URL to load into the BrowserWindow.
 */
export function shellPageUrl(): string {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>DeepSeek Harness</title><style>${PAGE_STYLE}</style></head>
<body>
  <div class="wrap">
    <h1>DeepSeek Harness</h1>
    <div class="spinner" id="spinner"></div>
    <p class="msg" id="msg">正在启动后台服务…</p>
    <pre class="detail" id="detail"></pre>
    <button id="retry">重试</button>
  </div>
<script>
(function () {
  var spinner = document.getElementById('spinner')
  var msg = document.getElementById('msg')
  var detail = document.getElementById('detail')
  var retry = document.getElementById('retry')
  retry.addEventListener('click', function () {
    retry.disabled = true
    retry.textContent = '重试中…'
    window.dshDesktop.retry().catch(function () {})
  })
  window.dshDesktop.onBootstrapStatus(function (status) {
    if (status.phase === 'loading') {
      spinner.style.display = 'block'
      msg.textContent = status.message || '正在启动后台服务…'
      detail.classList.remove('show')
      retry.classList.remove('show')
      return
    }
    spinner.style.display = 'none'
    msg.textContent = status.message || '后台服务启动失败'
    detail.textContent = status.detail || ''
    detail.classList.add('show')
    retry.disabled = false
    retry.textContent = '重试'
    retry.classList.add('show')
  })
})()
</script>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export { escapeHtml }
