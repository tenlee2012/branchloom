import { invoke, isTauri } from '@tauri-apps/api/core'

export type AiToolComponent = 'cli' | 'skill'
export type AiToolsAction = 'install' | 'update' | 'repair' | 'uninstall'
export type AiToolComponentState =
  | 'notInstalled'
  | 'installed'
  | 'updateAvailable'
  | 'modified'
  | 'damaged'
  | 'conflict'

export interface AiToolComponentStatus {
  component: AiToolComponent
  state: AiToolComponentState
  path: string
  installedVersion?: string
  bundledVersion: string
  contractVersion?: number
  managed: boolean
  message: string
}

export interface AiToolsStatus {
  platform: string
  targetTriple: string
  desktopVersion: string
  contractVersion: number
  cli: AiToolComponentStatus
  skill: AiToolComponentStatus
  compatible: boolean
  pathAvailable: boolean
  pathInstruction?: string
}

export interface AiToolsPlanChange {
  component: AiToolComponent
  operation: string
  path: string
}

export interface AiToolsPlanPreview {
  planId: string
  action: AiToolsAction
  changes: AiToolsPlanChange[]
  warnings: string[]
}

export interface AiToolsApplyResult {
  status: AiToolsStatus
  changed: AiToolComponent[]
}

export interface AiToolsGateway {
  available(): boolean
  status(): Promise<AiToolsStatus>
  preview(action: AiToolsAction, components: AiToolComponent[]): Promise<AiToolsPlanPreview>
  apply(planId: string): Promise<AiToolsApplyResult>
}

export const tauriAiToolsGateway: AiToolsGateway = {
  available: () => isTauri(),
  status: () => invoke('get_ai_tools_status'),
  preview: (action, components) => invoke('preview_ai_tools_change', {
    input: { action, components },
  }),
  apply: (planId) => invoke('apply_ai_tools_change', {
    input: { planId },
  }),
}

export function aiToolsError(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return fallback
}
