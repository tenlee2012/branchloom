import { beforeEach } from 'vitest'
import { setLocale } from '../shared/i18n'

Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  value: () => undefined,
})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
})
// Existing component assertions exercise the Chinese interface explicitly.
setLocale('zh-CN')
beforeEach(() => setLocale('zh-CN'))
