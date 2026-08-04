import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

interface ModalOverlayOptions {
  open: Readonly<Ref<boolean>>
  surface: Readonly<Ref<HTMLElement | null>>
  backdrop: Readonly<Ref<HTMLElement | null>>
  onClose: () => void
}

interface ModalOverlayEntry {
  token: symbol
  surface: HTMLElement
  backdrop: HTMLElement
  onClose: () => void
  previousFocus: HTMLElement | null
}

interface IsolationState {
  inert: string | null
  ariaHidden: string | null
}

const focusableSelector = [
  'button:not([disabled]):not([hidden])',
  '[href]:not([hidden])',
  'input:not([disabled]):not([hidden])',
  'select:not([disabled]):not([hidden])',
  'textarea:not([disabled]):not([hidden])',
  '[tabindex]:not([tabindex="-1"]):not([hidden])',
  '[contenteditable="true"]:not([hidden])',
  '[contenteditable="plaintext-only"]:not([hidden])',
].join(',')

const overlayStack: ModalOverlayEntry[] = []
const isolatedElements = new Map<HTMLElement, IsolationState>()
let isListening = false

function getTopOverlay() {
  return overlayStack.at(-1)
}

function isHiddenFromFocus(element: HTMLElement) {
  let currentElement: HTMLElement | null = element

  while (currentElement) {
    if (
      currentElement.hidden ||
      currentElement.hasAttribute('inert') ||
      currentElement.getAttribute('aria-hidden') === 'true'
    ) {
      return true
    }

    const style = getComputedStyle(currentElement)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return true
    }

    currentElement = currentElement.parentElement
  }

  return false
}

function isTopLevelEditable(element: HTMLElement) {
  const editableValue = element.getAttribute('contenteditable')
  if (editableValue !== 'true' && editableValue !== 'plaintext-only') return false
  if (element.hasAttribute('tabindex') && element.tabIndex < 0) return false

  let ancestor = element.parentElement
  while (ancestor) {
    const ancestorEditableValue = ancestor.getAttribute('contenteditable')
    if (ancestorEditableValue === 'false') return true
    if (
      ancestorEditableValue === '' ||
      ancestorEditableValue === 'true' ||
      ancestorEditableValue === 'plaintext-only'
    ) {
      return false
    }
    ancestor = ancestor.parentElement
  }

  return true
}

function getFocusableElements(surface: HTMLElement) {
  return Array.from(surface.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      (element.tabIndex >= 0 || isTopLevelEditable(element)) &&
      !element.matches(':disabled') &&
      !isHiddenFromFocus(element),
  )
}

function focusFirst(entry: ModalOverlayEntry) {
  const firstFocusable = getFocusableElements(entry.surface)[0]
  const focusTarget = firstFocusable ?? entry.surface
  focusTarget.focus()
}

function trapFocus(event: KeyboardEvent, entry: ModalOverlayEntry) {
  const focusableElements = getFocusableElements(entry.surface)
  const firstFocusable = focusableElements[0]
  const lastFocusable = focusableElements.at(-1)
  const activeElement = document.activeElement

  if (!firstFocusable || !lastFocusable) {
    event.preventDefault()
    entry.surface.focus()
    return
  }

  if (
    !(activeElement instanceof HTMLElement) ||
    !entry.surface.contains(activeElement) ||
    !focusableElements.includes(activeElement)
  ) {
    event.preventDefault()
    firstFocusable.focus()
    return
  }

  if (event.shiftKey && activeElement === firstFocusable) {
    event.preventDefault()
    lastFocusable.focus()
  } else if (!event.shiftKey && activeElement === lastFocusable) {
    event.preventDefault()
    firstFocusable.focus()
  }
}

function handleKeydown(event: KeyboardEvent) {
  const topOverlay = getTopOverlay()
  if (!topOverlay) return

  if (event.key === 'Escape') {
    event.preventDefault()
    topOverlay.onClose()
  } else if (event.key === 'Tab') {
    trapFocus(event, topOverlay)
  }
}

function syncKeydownListener() {
  const shouldListen = overlayStack.length > 0
  if (shouldListen === isListening) return

  if (shouldListen) {
    document.addEventListener('keydown', handleKeydown)
  } else {
    document.removeEventListener('keydown', handleKeydown)
  }
  isListening = shouldListen
}

function isolateElement(element: HTMLElement) {
  if (!isolatedElements.has(element)) {
    isolatedElements.set(element, {
      inert: element.getAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    })
  }
  element.setAttribute('inert', '')
  element.setAttribute('aria-hidden', 'true')
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

function restoreElement(element: HTMLElement) {
  const state = isolatedElements.get(element)
  if (!state) return

  restoreAttribute(element, 'inert', state.inert)
  restoreAttribute(element, 'aria-hidden', state.ariaHidden)
  isolatedElements.delete(element)
}

function updateBodyIsolation() {
  const topOverlay = getTopOverlay()
  const elementsToIsolate = new Set<HTMLElement>()

  if (topOverlay) {
    for (const child of document.body.children) {
      if (child instanceof HTMLElement && child !== topOverlay.backdrop) {
        elementsToIsolate.add(child)
      }
    }
  }

  for (const element of isolatedElements.keys()) {
    if (!elementsToIsolate.has(element)) restoreElement(element)
  }
  for (const element of elementsToIsolate) isolateElement(element)
}

function registerOverlay(entry: ModalOverlayEntry) {
  overlayStack.push(entry)
  syncKeydownListener()
  updateBodyIsolation()
  focusFirst(entry)
}

function preserveFocusReturnChain(entry: ModalOverlayEntry, index: number) {
  for (let overlayIndex = index + 1; overlayIndex < overlayStack.length; overlayIndex += 1) {
    const upperOverlay = overlayStack[overlayIndex]!
    const focusReturnTarget = upperOverlay.previousFocus
    if (
      focusReturnTarget &&
      (entry.surface.contains(focusReturnTarget) || !focusReturnTarget.isConnected)
    ) {
      upperOverlay.previousFocus = entry.previousFocus
    }
  }
}

function unregisterOverlay(entry: ModalOverlayEntry) {
  const index = overlayStack.findIndex((candidate) => candidate.token === entry.token)
  if (index < 0) return

  const wasTopOverlay = index === overlayStack.length - 1
  preserveFocusReturnChain(entry, index)
  overlayStack.splice(index, 1)
  updateBodyIsolation()
  syncKeydownListener()
  void nextTick(updateBodyIsolation)

  if (!wasTopOverlay) return

  if (entry.previousFocus?.isConnected) entry.previousFocus.focus()
  const nextOverlay = getTopOverlay()
  if (nextOverlay && !nextOverlay.surface.contains(document.activeElement)) {
    focusFirst(nextOverlay)
  }
}

export function useModalOverlay(options: ModalOverlayOptions) {
  let entry: ModalOverlayEntry | null = null
  let updateId = 0

  function unregisterCurrentOverlay() {
    if (!entry) return
    unregisterOverlay(entry)
    entry = null
  }

  watch(
    options.open,
    async (open) => {
      const currentUpdateId = ++updateId
      if (!open) {
        unregisterCurrentOverlay()
        return
      }

      const previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()

      if (currentUpdateId !== updateId || !options.open.value) return
      const surface = options.surface.value
      const backdrop = options.backdrop.value
      if (!surface || !backdrop) return

      unregisterCurrentOverlay()
      entry = {
        token: Symbol('modal-overlay'),
        surface,
        backdrop,
        onClose: options.onClose,
        previousFocus,
      }
      registerOverlay(entry)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    updateId += 1
    unregisterCurrentOverlay()
  })
}
