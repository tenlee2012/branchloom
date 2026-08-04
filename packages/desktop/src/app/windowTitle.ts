const PRODUCT_NAME = '有谱'

export function formatWindowTitle(pageTitle: unknown): string {
  const title = typeof pageTitle === 'string' ? pageTitle.trim() : ''
  return title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME
}

export function updateWindowTitle(pageTitle: unknown): void {
  const title = formatWindowTitle(pageTitle)
  document.title = title

  if (!('__TAURI_INTERNALS__' in window)) return

  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {
      // document.title remains the browser and webview fallback.
    })
}
