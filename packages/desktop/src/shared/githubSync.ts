import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type ConflictChoice = 'base' | 'ours' | 'theirs'
export type GithubSyncInitializationStrategy = 'remote' | 'local'

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
  initializationStrategy?: GithubSyncInitializationStrategy
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

export interface GithubProjectImportRequest {
  placeholderProjectId?: string
  owner: string
  repository: string
  branch: string
  token: string
  expectedFingerprint?: string
}

export interface GithubProjectImportPreview {
  projectId: string
  projectName: string
  projectDescription: string
  commit?: string
  recordCounts: Record<string, number>
  replacesProjectId?: string
  alreadyExists: boolean
  fingerprint: string
}

export interface GithubProjectImportResult {
  projectId: string
  replacedProjectId?: string
  baselineUpdated: boolean
  credentialStored: boolean
  warnings: string[]
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
  previewImport(input: GithubProjectImportRequest): Promise<GithubProjectImportPreview>
  applyImport(input: GithubProjectImportRequest): Promise<GithubProjectImportResult>
  subscribeProgress?(handler: (progress: GithubOperationProgress) => void): Promise<UnlistenFn>
}

export const tauriGithubSyncGateway: GithubSyncGateway = {
  available: () => isTauri(),
  connection: (projectId) => invoke('get_github_connection', { projectId }),
  connect: (input) => invoke('connect_github', { input }),
  preview: (input) => invoke('preview_github_sync', { input }),
  apply: (input) => invoke('apply_github_sync', { input }),
  previewImport: (input) => invoke('preview_github_project_import', { input }),
  applyImport: (input) => invoke('apply_github_project_import', { input }),
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
  if (isGithubProjectMismatch(error)) {
    return 'GitHub 仓库属于另一个稳定项目。当前项目为空时可以采用 GitHub 项目；已有本地资料时请从首页独立导入。'
  }
  if (isGithubInitializationRequired(error)) {
    return 'GitHub 仓库已有资料，但本地还没有同步基线。请选择首次同步时使用 GitHub 版本还是本地版本。'
  }
  if (normalized.includes('does not contain a branchloom project')) {
    return '这个 GitHub 仓库中没有可导入的 Branchloom 项目。请检查仓库和分支。'
  }
  if (normalized.includes('local project is not empty and cannot be replaced')) {
    return '当前项目已经包含资料，不能再用 GitHub 项目覆盖。请从首页将 GitHub 项目独立导入。'
  }
  if (normalized.includes('没有找到已保存的 github token')) {
    return '已保存的 GitHub Token 不可用，请重新输入并连接仓库。'
  }
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

export function isGithubProjectMismatch(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  const normalized = message.toLowerCase()
  return normalized.includes('remote project id')
    && normalized.includes('does not match local project id')
}

export function isGithubInitializationRequired(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  return message.toLowerCase().includes(
    'remote project has history but no local synchronization baseline',
  )
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

export function isGithubCredentialUnavailable(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  const normalized = message.toLowerCase()
  return normalized.includes('没有找到已保存的 github token')
    || normalized.includes('401')
    || normalized.includes('403')
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
    || normalized.includes('bad credentials')
}
