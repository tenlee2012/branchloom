Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  value: () => undefined,
})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
})
