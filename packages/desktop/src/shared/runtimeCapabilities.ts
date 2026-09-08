import { invoke, isTauri } from '@tauri-apps/api/core'

export interface RuntimeCapabilities {
  mobile: boolean
  aiTools: boolean
  scheduledSync: boolean
}

const browserCapabilities: RuntimeCapabilities = {
  mobile: false,
  aiTools: true,
  scheduledSync: true,
}

let pendingCapabilities: Promise<RuntimeCapabilities> | undefined

export function loadRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  if (!isTauri()) return Promise.resolve(browserCapabilities)
  pendingCapabilities ??= invoke<RuntimeCapabilities>('runtime_capabilities')
  return pendingCapabilities
}

export function resetRuntimeCapabilitiesForTesting() {
  pendingCapabilities = undefined
}
