import { onBeforeUnmount, onMounted, ref } from 'vue'

const historyKey = 'branchloomNavigationDrawer'
let nextDrawerId = 0

/** Give Android's WebView Back action a temporary, same-page menu entry. */
export function useNavigationDrawer() {
  const open = ref(false)
  const drawerId = `navigation-${Date.now()}-${++nextDrawerId}`
  let disposed = false
  let pendingClose: Promise<void> | undefined
  let finishClose: (() => void) | undefined

  function ownsHistoryEntry() {
    return window.history.state?.[historyKey] === drawerId
  }

  function handlePopState() {
    open.value = ownsHistoryEntry()
    finishClose?.()
    finishClose = undefined
    pendingClose = undefined
  }

  async function show() {
    await pendingClose
    if (disposed || open.value) return
    window.history.pushState({ ...window.history.state, [historyKey]: drawerId }, '')
    open.value = true
  }

  function close(): Promise<void> {
    open.value = false
    if (pendingClose) return pendingClose
    if (!ownsHistoryEntry()) return Promise.resolve()
    pendingClose = new Promise<void>((resolve) => { finishClose = resolve })
    window.history.back()
    return pendingClose
  }

  onMounted(() => window.addEventListener('popstate', handlePopState))
  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener('popstate', handlePopState)
    if (ownsHistoryEntry() && !pendingClose) window.history.back()
    finishClose?.()
  })

  return { open, show, close }
}
