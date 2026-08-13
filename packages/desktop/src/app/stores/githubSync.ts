import { reactive } from 'vue'
import { acceptHMRUpdate, defineStore } from 'pinia'
import {
  githubError,
  isGithubConnectionFailure,
  isGithubInitializationRequired,
  githubSyncOutcomeError,
  tauriGithubSyncGateway,
  type GithubSyncConflict,
  type GithubSyncGateway,
  type GithubOperationKind,
  type GithubOperationProgress,
} from '../../shared/githubSync'

const DEFAULT_INTERVAL_MINUTES = 60

export interface AutomaticSyncStatus {
  enabled: boolean
  state: 'idle' | 'waiting' | 'syncing' | 'success' | 'conflict' | 'initializationRequired' | 'failed'
  lastAttemptAt?: string
  lastSuccessAt?: string
  message?: string
  conflicts: GithubSyncConflict[]
}

export interface ManualSyncStatus {
  operationId: string
  operation: GithubOperationKind
  state: 'running' | 'success' | 'failed'
  message: string
  startedAt: number
  finishedAt?: number
}

export type GithubConnectionHealth = 'configured' | 'healthy' | 'error'

interface ScheduledProject {
  token: string
  timer: ReturnType<typeof setInterval>
  gateway: GithubSyncGateway
  onLocalChange: () => void | Promise<void>
}

export const useGithubSyncStore = defineStore('github-sync', () => {
  const statusByProject = reactive<Record<string, AutomaticSyncStatus>>({})
  const manualStatusByProject = reactive<Record<string, ManualSyncStatus>>({})
  const connectionHealthByProject = reactive<Record<string, GithubConnectionHealth>>({})
  const scheduled = new Map<string, ScheduledProject>()

  function manualStatus(projectId: string): ManualSyncStatus | undefined {
    return manualStatusByProject[projectId]
  }

  let manualOperationSequence = 0

  function beginManual(projectId: string, operation: GithubOperationKind, message: string): string {
    manualOperationSequence += 1
    const operationId = `${projectId}-${Date.now()}-${manualOperationSequence}`
    manualStatusByProject[projectId] = {
      operationId,
      operation,
      state: 'running',
      message,
      startedAt: Date.now(),
    }
    return operationId
  }

  function updateManual(progress: GithubOperationProgress) {
    const current = manualStatus(progress.projectId)
    if (
      !current
      || current.state !== 'running'
      || current.operationId !== progress.operationId
      || current.operation !== progress.operation
    ) return
    manualStatusByProject[progress.projectId] = {
      ...current,
      message: progress.message,
    }
  }

  function finishManual(projectId: string, state: 'success' | 'failed', message: string) {
    const current = manualStatus(projectId)
    if (!current) return
    manualStatusByProject[projectId] = {
      ...current,
      state,
      message,
      finishedAt: Date.now(),
    }
  }

  function connectionHealth(projectId: string): GithubConnectionHealth | undefined {
    return connectionHealthByProject[projectId]
  }

  function markConnectionConfigured(projectId: string) {
    if (!connectionHealth(projectId)) connectionHealthByProject[projectId] = 'configured'
  }

  function markConnectionHealthy(projectId: string) {
    connectionHealthByProject[projectId] = 'healthy'
  }

  function markConnectionError(projectId: string) {
    connectionHealthByProject[projectId] = 'error'
  }

  function clearConnectionHealth(projectId: string) {
    delete connectionHealthByProject[projectId]
  }

  function status(projectId: string): AutomaticSyncStatus {
    return statusByProject[projectId] ?? {
      enabled: false,
      state: 'idle',
      conflicts: [],
    }
  }

  function setStatus(projectId: string, patch: Partial<AutomaticSyncStatus>) {
    statusByProject[projectId] = {
      ...status(projectId),
      ...patch,
      conflicts: patch.conflicts ?? status(projectId).conflicts,
    }
  }

  function clearAutomaticBlockers(projectId: string) {
    const current = status(projectId)
    if (
      current.state !== 'conflict'
      && current.state !== 'initializationRequired'
      && current.conflicts.length === 0
    ) return
    setStatus(projectId, {
      state: current.enabled ? 'waiting' : 'idle',
      message: current.enabled
        ? current.message
        : '手工同步已处理待办；自动同步仍保持关闭。',
      conflicts: [],
    })
  }

  async function runAutomatic(projectId: string): Promise<void> {
    const schedule = scheduled.get(projectId)
    if (!schedule || status(projectId).state === 'syncing') return
    setStatus(projectId, {
      state: 'syncing',
      lastAttemptAt: new Date().toISOString(),
      message: undefined,
      conflicts: [],
    })
    try {
      const preview = await schedule.gateway.preview({
        projectId,
        token: schedule.token,
        pullOnly: false,
        resolutions: [],
      })
      markConnectionHealthy(projectId)
      if (preview.conflicts.length > 0) {
        stop(projectId)
        setStatus(projectId, {
          enabled: false,
          state: 'conflict',
          message: '自动同步已暂停，请在“协作同步”中解决冲突。',
          conflicts: preview.conflicts,
        })
        return
      }
      const outcome = await schedule.gateway.apply({
        projectId,
        token: schedule.token,
        pullOnly: false,
        resolutions: [],
        expectedFingerprint: preview.fingerprint,
      })
      markConnectionHealthy(projectId)
      if (outcome.changedLocal) await schedule.onLocalChange()
      const partialError = githubSyncOutcomeError(outcome)
      setStatus(projectId, partialError ? {
        state: 'failed',
        message: partialError,
      } : {
        state: 'success',
        lastSuccessAt: new Date().toISOString(),
        message: '自动同步完成。',
        conflicts: [],
      })
    } catch (error) {
      if (isGithubInitializationRequired(error)) {
        stop(projectId)
        setStatus(projectId, {
          enabled: false,
          state: 'initializationRequired',
          message: '自动同步已暂停，请先在“协作同步”中选择首次同步版本。',
          conflicts: [],
        })
        return
      }
      if (isGithubConnectionFailure(error)) markConnectionError(projectId)
      setStatus(projectId, {
        state: 'failed',
        message: githubError(error, '自动同步失败，将在下个周期重试。'),
      })
    }
  }

  function start(
    projectId: string,
    token: string,
    gateway: GithubSyncGateway = tauriGithubSyncGateway,
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    onLocalChange: () => void | Promise<void> = () => undefined,
  ) {
    stop(projectId)
    const timer = setInterval(
      () => { void runAutomatic(projectId) },
      intervalMinutes * 60 * 1000,
    )
    scheduled.set(projectId, { token, timer, gateway, onLocalChange })
    setStatus(projectId, {
      enabled: true,
      state: 'waiting',
      message: `已开启每 ${intervalMinutes} 分钟自动同步。`,
      conflicts: [],
    })
  }

  function stop(projectId: string) {
    const current = scheduled.get(projectId)
    if (current) clearInterval(current.timer)
    scheduled.delete(projectId)
    setStatus(projectId, {
      enabled: false,
      state: status(projectId).state === 'syncing' ? 'idle' : status(projectId).state,
      message: '自动同步已关闭。',
    })
  }

  function hasToken(projectId: string): boolean {
    return scheduled.has(projectId)
  }

  function credential(projectId: string): string | undefined {
    return scheduled.get(projectId)?.token
  }

  return {
    statusByProject,
    manualStatusByProject,
    connectionHealthByProject,
    status,
    manualStatus,
    beginManual,
    updateManual,
    finishManual,
    connectionHealth,
    markConnectionConfigured,
    markConnectionHealthy,
    markConnectionError,
    clearConnectionHealth,
    clearAutomaticBlockers,
    start,
    stop,
    runAutomatic,
    hasToken,
    credential,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGithubSyncStore, import.meta.hot))
}
