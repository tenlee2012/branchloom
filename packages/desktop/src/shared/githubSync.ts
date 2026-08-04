import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type ConflictChoice = 'base' | 'ours' | 'theirs'

export interface GithubConnectionStatus {
  owner: string
  repository: string
  branch: string
  lastSyncedCommit?: string
  credentialStored?: boolean
}

export interface GithubConnectionInput {
  operationId?: string
  projectId: string
  owner: string
  repository: string
  branch: string
  token: string
  createIfMissing: boolean
}

export interface GithubConnectionResult {
  repositoryExisted: boolean
  privateRepositoryCreated: boolean
}

export interface GithubSyncConflict {
  path: string
  field: string
  base?: unknown
  ours?: unknown
  theirs?: unknown
}

export interface GithubConflictResolution {
  path: string
  field: string
  choice: ConflictChoice
}

export interface GithubSyncRequest {
  operationId?: string
  projectId: string
  token: string
  pullOnly: boolean
  resolutions: GithubConflictResolution[]
  expectedFingerprint?: string
}

export interface GithubSyncPreview {
  pulledCommit?: string
  changedLocal: boolean
  willPush: boolean
  conflicts: GithubSyncConflict[]
  fingerprint: string
}

export interface GithubSyncOutcome {
  status: string
  pulledCommit?: string
  pushedCommit?: string
  changedLocal: boolean
  baselineUpdated?: boolean
  error?: string
}

export type GithubOperationKind = 'connect' | 'previewPull' | 'previewFull' | 'applyPull' | 'applyFull'

export interface GithubOperationProgress {
  operationId: string
  projectId: string
  operation: GithubOperationKind
  phase: string
  message: string
}

export function githubSyncOutcomeError(outcome: GithubSyncOutcome): string | undefined {
  if (!outcome.error) return undefined
  if (outcome.status === 'remotePushedLocalFailed') {
    return `远端已推送（${outcome.pushedCommit ?? '提交未知'}），但本地应用失败：${outcome.error}`
  }
  if (!outcome.baselineUpdated) {
    return `数据已部分同步，但同步基线保存失败：${outcome.error}`
  }
  return outcome.error
}

export interface GithubSyncGateway {
  available(): boolean
  connection(projectId: string): Promise<GithubConnectionStatus | null>
  connect(input: GithubConnectionInput): Promise<GithubConnectionResult>
  preview(input: GithubSyncRequest): Promise<GithubSyncPreview>
  apply(input: GithubSyncRequest): Promise<GithubSyncOutcome>
  subscribeProgress?(handler: (progress: GithubOperationProgress) => void): Promise<UnlistenFn>
}

export const tauriGithubSyncGateway: GithubSyncGateway = {
  available: () => isTauri(),
  connection: (projectId) => invoke('get_github_connection', { projectId }),
  connect: (input) => invoke('connect_github', { input }),
  preview: (input) => invoke('preview_github_sync', { input }),
  apply: (input) => invoke('apply_github_sync', { input }),
  subscribeProgress: (handler) => listen<GithubOperationProgress>(
    'github-sync-progress',
    (event) => handler(event.payload),
  ),
}

export function githubError(error: unknown, fallback: string): string {
  const message = typeof error === 'string'
    ? error.trim()
    : error instanceof Error
      ? error.message.trim()
      : ''
  const normalized = message.toLowerCase()
  if (normalized.includes('401') || normalized.includes('unauthorized') || normalized.includes('bad credentials')) {
    return 'GitHub Token 无效或已过期，请重新生成 Token 后再连接。'
  }
  if (normalized.includes('403') || normalized.includes('forbidden')) {
    return 'GitHub Token 没有访问该仓库的权限，请检查仓库授权和 Contents 读写权限。'
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return '连接 GitHub 超时，请检查网络后重试。'
  }
  return message || fallback
}

export function isGithubConnectionFailure(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  const normalized = message.toLowerCase()
  return [
    'remote operation failed',
    'github returned',
    '401',
    '403',
    'unauthorized',
    'forbidden',
    'bad credentials',
    'timed out',
    'timeout',
    'connection refused',
    'connection reset',
    'dns error',
  ].some((pattern) => normalized.includes(pattern))
}
