<script setup lang="ts">
import { getLocale, localizeSystemMessage, t } from '../../../shared/i18n'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconBrandGithub,
  IconChevronRight,
  IconCircleCheck,
  IconExternalLink,
  IconGitMerge,
  IconHelpCircle,
  IconInfoCircle,
  IconLoader2,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-vue'
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import { useGithubSyncStore } from '../../../app/stores/githubSync'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import GithubProjectImportPanel from '../../collaboration/components/GithubProjectImportPanel.vue'
import {
  githubError,
  isGithubConnectionFailure,
  isGithubCredentialUnavailable,
  isGithubInitializationRequired,
  isGithubProjectMismatch,
  githubSyncOutcomeError,
  tauriGithubSyncGateway,
  type ConflictChoice,
  type GithubConflictResolution,
  type GithubConnectionStatus,
  type GithubOperationKind,
  type GithubProjectImportResult,
  type GithubSyncConflict,
  type GithubSyncGateway,
  type GithubSyncInitializationStrategy,
  type GithubSyncPreview,
} from '../../../shared/githubSync'
import { branchloomRepositoryKey } from '../../../shared/repository/injection'
import {
  NATIVE_STATE_REFRESHED_EVENT,
  refreshNativeRepository,
} from '../../../shared/repository/TauriRepository'
import { openExternalUrl } from '../../../shared/externalLinks'
import { loadRuntimeCapabilities } from '../../../shared/runtimeCapabilities'

const props = withDefaults(defineProps<{
  projectId: string
  gateway?: GithubSyncGateway
}>(), {
  gateway: () => tauriGithubSyncGateway,
})

const emit = defineEmits<{
  projectAdopted: [projectId: string, replacedProjectId?: string]
}>()

const syncStore = useGithubSyncStore()
const repository = inject(branchloomRepositoryKey, undefined)
const desktopRuntime = computed(() => props.gateway.available())
const scheduledSyncAvailable = ref(false)
const connection = ref<GithubConnectionStatus>()
const loading = ref(false)
const failure = ref('')
const preview = ref<GithubSyncPreview>()
const previewPullOnly = ref(false)
const appliedResolutions = ref<GithubConflictResolution[]>([])
const previewInitializationStrategy = ref<GithubSyncInitializationStrategy>()
const manualInitializationRequired = ref(false)
const initializationDialogOpen = ref(false)
const initializationChoiceInProgress = ref<GithubSyncInitializationStrategy>()
const projectMismatchDetected = ref(false)
const projectImportDialogOpen = ref(false)
const connectionSettingsOpen = ref(false)
const tokenHelpOpen = ref(false)
const tokenHelpFailure = ref('')
const activeTab = ref<'pending' | 'recent'>('pending')
const conflictRegion = ref<HTMLElement>()
const resolutionChoices = reactive<Record<string, ConflictChoice | ''>>({})
const clock = ref(Date.now())
let clockTimer: number | undefined
let stopProgressListener: (() => void) | undefined
let disposed = false

const GITHUB_NEW_REPOSITORY_URL = 'https://github.com/new'
const GITHUB_FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'
const GITHUB_CLASSIC_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=Branchloom'
const GITHUB_TOKEN_DOCUMENTATION_URL = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'

const draft = reactive({
  owner: '',
  repository: '',
  branch: 'main',
  token: '',
  createIfMissing: false,
})

const automaticStatus = computed(() => syncStore.status(props.projectId))
const initializationRequired = computed(() => !preview.value && (
  manualInitializationRequired.value
  || automaticStatus.value.state === 'initializationRequired'
))
const manualOperation = computed(() => syncStore.manualStatus(props.projectId))
const operationRunning = computed(() => manualOperation.value?.state === 'running')
const connectionHealth = computed(() => connection.value
  ? syncStore.connectionHealth?.(props.projectId) ?? 'configured'
  : undefined)
const operationTitle = computed(() => {
  const labels: Record<GithubOperationKind, string> = {
    connect: connection.value ? t('重新连接 GitHub') : t('连接 GitHub'),
    previewPull: t('预览 GitHub Pull'),
    previewFull: t('预览完整同步'),
    applyPull: t('执行 GitHub Pull'),
    applyFull: t('执行 GitHub 完整同步'),
    previewImport: t('预览 GitHub 项目导入'),
    applyImport: t('导入 GitHub 项目'),
  }
  const operation = manualOperation.value
  if (!operation) return ''
  const label = labels[operation.operation]
  if (operation.state === 'running') return t('正在{0}', [label])
  return operation.state === 'success' ? t('{0}已完成', [label]) : t('{0}失败', [label])
})
const operationStateLabel = computed(() => {
  if (manualOperation.value?.state === 'running') return t('进行中')
  return manualOperation.value?.state === 'success' ? t('已完成') : t('失败')
})
const operationElapsedSeconds = computed(() => {
  const operation = manualOperation.value
  if (!operation) return 0
  const end = operation.finishedAt ?? clock.value
  return Math.max(0, Math.floor((end - operation.startedAt) / 1000))
})
const operationElapsedLabel = computed(() => operationElapsedSeconds.value > 0
  ? t('已用时 {0} 秒', [operationElapsedSeconds.value])
  : t('刚刚开始'))
const operationSlow = computed(() => operationRunning.value && operationElapsedSeconds.value >= 15)
const showOperationBanner = computed(() => Boolean(manualOperation.value)
  && !projectMismatchDetected.value
  && !(manualOperation.value?.state === 'success'
    && ['previewPull', 'previewFull'].includes(manualOperation.value.operation)))
const effectiveToken = computed(() => draft.token.trim() || syncStore.credential(props.projectId) || '')
const credentialAvailable = computed(() => Boolean(effectiveToken.value)
  || syncStore.hasToken(props.projectId)
  || Boolean(connection.value?.credentialStored))
const connectedLabel = computed(() => connection.value
  ? `${connection.value.owner}/${connection.value.repository} · ${connection.value.branch}`
  : t('尚未连接 GitHub 仓库'))
const activeConflicts = computed(() => preview.value
  ? preview.value.conflicts
  : automaticStatus.value.conflicts)
const pendingCount = computed(() => activeConflicts.value.length)
const allConflictsResolved = computed(() => preview.value?.conflicts.length
  ? preview.value.conflicts.every((conflict) => Boolean(resolutionChoices[conflictKey(conflict.path, conflict.field)]))
  : false)
const hasReadyPreview = computed(() => Boolean(preview.value && preview.value.conflicts.length === 0))
const lastSyncLabel = computed(() => {
  const automaticSuccess = automaticStatus.value.lastSuccessAt
  if (automaticSuccess) return formatDateTime(automaticSuccess)
  const operation = manualOperation.value
  if (operation?.state === 'success' && operation.finishedAt) {
    return formatDateTime(new Date(operation.finishedAt).toISOString())
  }
  return connection.value?.lastSyncedCommit ? t('已建立同步基线') : t('尚未完成同步')
})
const heroTone = computed<'neutral' | 'success' | 'danger' | 'info'>(() => {
  if (projectMismatchDetected.value) return 'info'
  if (initializationRequired.value || pendingCount.value > 0 || manualOperation.value?.state === 'failed') return 'danger'
  if (operationRunning.value) return 'info'
  if (hasReadyPreview.value || manualOperation.value?.state === 'success') return 'success'
  return 'neutral'
})
const heroTitle = computed(() => {
  if (!desktopRuntime.value) return t('GitHub 同步仅在桌面端可用')
  if (loading.value) return t('正在读取连接状态…')
  if (!connection.value) return t('连接 GitHub 开始协作')
  if (operationRunning.value) return operationTitle.value
  if (projectMismatchDetected.value) return t('发现可导入的 GitHub 项目')
  if (initializationRequired.value) return t('首次同步需要选择版本')
  if (pendingCount.value > 0) return t('有 {0} 项冲突需要决定', [pendingCount.value])
  if (manualOperation.value?.state === 'failed') return t('同步遇到问题')
  if (hasReadyPreview.value) return t('同步预览已准备好')
  if (manualOperation.value?.state === 'success'
    && ['applyPull', 'applyFull'].includes(manualOperation.value.operation)) {
    return t('所有资料已同步')
  }
  return t('仓库已连接，可以同步')
})
const heroDescription = computed(() => {
  if (!desktopRuntime.value) return t('浏览器预览不会读取或上传项目资料，请在有谱桌面应用中使用。')
  if (loading.value) return t('正在确认仓库、分支与安全凭据。')
  if (!connection.value) return t('使用自己的 GitHub 私有仓库备份资料，并与可信家人异步协作。')
  if (operationRunning.value) return localizeSystemMessage(manualOperation.value?.message ?? t('正在等待 GitHub 响应。'))
  if (projectMismatchDetected.value) {
    return t('GitHub 仓库属于另一个稳定项目；当前项目为空时，可以检查内容并采用仓库项目。')
  }
  if (initializationRequired.value) {
    return t('本地与 GitHub 都有资料，但还没有共同同步基线。有谱不会自动覆盖任何一方，请先选择版本并查看预览。')
  }
  if (pendingCount.value > 0) return t('确认全部冲突后才会上传；未解决前不会修改远端仓库。')
  if (manualOperation.value?.state === 'failed') return localizeSystemMessage(manualOperation.value.message)
  if (hasReadyPreview.value) {
    if (!preview.value?.changedLocal && !preview.value?.willPush) return t('同步预览已生成，没有发现需要交换的更新。')
    return t('同步预览已生成，请核对下面的变更摘要；确认后才会修改本地资料或 GitHub 仓库。')
  }
  if (manualOperation.value?.state === 'success'
    && ['applyPull', 'applyFull'].includes(manualOperation.value.operation)) {
    return scheduledSyncAvailable.value
      ? t('{0}；下一次自动同步会继续先 Pull 并检查冲突。', [lastSyncLabel.value])
      : t('{0}；移动端只会在你手动操作时连接 GitHub。', [lastSyncLabel.value])
  }
  return t('先生成同步预览，再决定是否写入本地资料或上传 GitHub。')
})
const primaryActionLabel = computed(() => {
  if (!connection.value) return t('连接仓库')
  if (projectMismatchDetected.value) return t('检查并导入')
  if (initializationRequired.value) return t('选择首次同步方式')
  if (pendingCount.value > 0) return t('处理冲突')
  if (hasReadyPreview.value) return t('确认执行')
  if (manualOperation.value?.state === 'failed') return t('重新预览')
  return t('预览完整同步')
})
const primaryActionName = computed(() => {
  if (!connection.value) return t('打开连接设置')
  if (projectMismatchDetected.value) return t('检查并导入 GitHub 项目')
  if (initializationRequired.value) return t('选择 GitHub 首次同步方式')
  if (pendingCount.value > 0) return t('处理 GitHub 冲突')
  if (hasReadyPreview.value) return t('确认执行 GitHub 同步')
  return t('预览 GitHub 完整同步')
})
const automaticHeading = computed(() => {
  if (initializationRequired.value) return t('自动同步等待首次设置')
  if (automaticStatus.value.state === 'conflict' || pendingCount.value > 0) return t('自动同步已暂停')
  if (automaticStatus.value.enabled) return t('每 60 分钟自动同步')
  return t('自动同步已关闭')
})
const automaticDescription = computed(() => {
  if (initializationRequired.value) {
    return t('选择首次同步版本并完成确认后，才可以开启自动同步。')
  }
  if (automaticStatus.value.state === 'conflict' || pendingCount.value > 0) {
    return t('存在未解决的冲突；处理完成后可重新开启自动同步。')
  }
  return automaticStatus.value.message || t('连接仓库后可在应用运行期间定期检查更新。')
})

function conflictKey(path: string, field: string) {
  return `${path}\u0000${field}`
}

function resetMessages() {
  failure.value = ''
}

function clearPreview() {
  preview.value = undefined
  appliedResolutions.value = []
  previewInitializationStrategy.value = undefined
}

function cancelPreview() {
  const wasInitializationPreview = Boolean(previewInitializationStrategy.value)
  clearPreview()
  if (wasInitializationPreview) manualInitializationRequired.value = true
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return t('时间记录无效')
  return new Intl.DateTimeFormat(getLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatValue(value: unknown) {
  if (value === undefined) return t('不存在')
  if (value === null) return t('空值')
  if (typeof value === 'string') return value || t('空文本')
  return JSON.stringify(value, null, 2)
}

const FIELD_LABELS: Record<string, string> = {
  biography: t('生平'),
  birthPlace: t('出生地点'),
  deathPlace: t('去世地点'),
  name: t('名称'),
  notes: t('备注'),
  occupation: t('职业经历'),
  title: t('标题'),
}

function conflictTitle(conflict: GithubSyncConflict) {
  const field = conflict.field.split('/').filter(Boolean).at(-1) ?? t('记录')
  const fieldLabel = FIELD_LABELS[field] ?? field
  if (conflict.path.includes('/people/')) return t('人物资料 · {0}', [fieldLabel])
  if (conflict.path.includes('/events/')) return t('事件资料 · {0}', [fieldLabel])
  if (conflict.path.includes('/sources/')) return t('史料来源 · {0}', [fieldLabel])
  if (conflict.path.includes('/relationships/')) return t('关系资料 · {0}', [fieldLabel])
  return t('项目资料 · {0}', [fieldLabel])
}

async function refreshLocalState() {
  if (repository) await refreshNativeRepository(repository)
  window.dispatchEvent(new Event(NATIVE_STATE_REFRESHED_EVENT))
}

function applyConnection(value: GithubConnectionStatus | null) {
  connection.value = value ?? undefined
  if (!value) {
    syncStore.clearConnectionHealth?.(props.projectId)
    return
  }
  syncStore.markConnectionConfigured?.(props.projectId)
  draft.owner = value.owner
  draft.repository = value.repository
  draft.branch = value.branch
}

async function loadConnection() {
  if (!desktopRuntime.value) return
  loading.value = true
  resetMessages()
  try {
    const value = await props.gateway.connection(props.projectId)
    applyConnection(value)
  } catch (error) {
    failure.value = githubError(error, t('无法读取 GitHub 连接状态。'))
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, () => {
  clearPreview()
  manualInitializationRequired.value = false
  initializationDialogOpen.value = false
  initializationChoiceInProgress.value = undefined
  projectMismatchDetected.value = false
  projectImportDialogOpen.value = false
  connectionSettingsOpen.value = false
  activeTab.value = 'pending'
  for (const key of Object.keys(resolutionChoices)) delete resolutionChoices[key]
  void loadConnection()
}, { immediate: true })

onMounted(async () => {
  clockTimer = window.setInterval(() => { clock.value = Date.now() }, 1000)
  try {
    scheduledSyncAvailable.value = (await loadRuntimeCapabilities()).scheduledSync
  } catch {
    scheduledSyncAvailable.value = false
  }
  if (!scheduledSyncAvailable.value && automaticStatus.value.enabled) {
    syncStore.stop(props.projectId)
  }
  if (!props.gateway.subscribeProgress) return
  try {
    const unlisten = await props.gateway.subscribeProgress((progress) => {
      syncStore.updateManual(progress)
    })
    if (disposed) unlisten()
    else stopProgressListener = unlisten
  } catch {
    // The command itself still reports completion; progress events are an enhancement.
  }
})

onBeforeUnmount(() => {
  disposed = true
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
  stopProgressListener?.()
})

async function connect() {
  if (operationRunning.value) return
  resetMessages()
  clearPreview()
  manualInitializationRequired.value = false
  initializationDialogOpen.value = false
  initializationChoiceInProgress.value = undefined
  projectMismatchDetected.value = false
  if (!draft.owner.trim() || !draft.repository.trim() || !draft.branch.trim()) {
    failure.value = t('请填写仓库所有者、仓库名称和分支。')
    return
  }
  if (!credentialAvailable.value) {
    failure.value = t('请输入 GitHub Token。连接成功后会保存到系统安全凭据存储。')
    return
  }
  const operationId = syncStore.beginManual(props.projectId, 'connect', t('正在启动 GitHub 连接…'))
  try {
    const result = await props.gateway.connect({
      operationId,
      projectId: props.projectId,
      owner: draft.owner.trim(),
      repository: draft.repository.trim(),
      branch: draft.branch.trim(),
      token: draft.token.trim(),
      createIfMissing: draft.createIfMissing,
    })
    applyConnection(await props.gateway.connection(props.projectId))
    if (scheduledSyncAvailable.value) {
      syncStore.start(props.projectId, '', props.gateway, 60, refreshLocalState)
    }
    const message = scheduledSyncAvailable.value
      ? result.privateRepositoryCreated
        ? t('私有仓库已创建，当前项目已完成首次同步；每小时自动同步已开启。')
        : t('GitHub 仓库已连接；每小时自动同步已开启。')
      : result.privateRepositoryCreated
        ? t('私有仓库已创建，当前项目已完成首次同步。移动端只进行手动同步，Token 仅在本次运行期间保留。')
        : t('GitHub 仓库已连接。移动端只进行手动同步，Token 仅在本次运行期间保留。')
    syncStore.finishManual(props.projectId, 'success', message)
    syncStore.markConnectionHealthy?.(props.projectId)
    draft.token = ''
    connectionSettingsOpen.value = false
  } catch (error) {
    syncStore.finishManual(
      props.projectId,
      'failed',
      githubError(error, t('GitHub 仓库连接失败。')),
    )
    syncStore.markConnectionError?.(props.projectId)
  }
}

function syncRequest(
  pullOnly: boolean,
  resolutions: GithubConflictResolution[] = [],
  operationId?: string,
  initializationStrategy?: GithubSyncInitializationStrategy,
) {
  return {
    operationId,
    projectId: props.projectId,
    token: effectiveToken.value,
    pullOnly,
    resolutions,
    ...(initializationStrategy ? { initializationStrategy } : {}),
  }
}

async function createPreview(
  pullOnly: boolean,
  resolutions: GithubConflictResolution[] = [],
  initializationStrategy?: GithubSyncInitializationStrategy,
) {
  if (operationRunning.value) return
  resetMessages()
  if (!connection.value) {
    connectionSettingsOpen.value = true
    failure.value = t('请先连接 GitHub 仓库。')
    return
  }
  if (!credentialAvailable.value) {
    connectionSettingsOpen.value = true
    failure.value = t('请输入 GitHub Token 并重新连接仓库。')
    return
  }
  const operation = pullOnly ? 'previewPull' : 'previewFull'
  const operationId = syncStore.beginManual(
    props.projectId,
    operation,
    pullOnly ? t('正在启动 GitHub Pull 预览…') : t('正在启动完整同步预览…'),
  )
  try {
    const next = await props.gateway.preview(syncRequest(
      pullOnly,
      resolutions,
      operationId,
      initializationStrategy,
    ))
    preview.value = next
    previewPullOnly.value = pullOnly
    appliedResolutions.value = resolutions
    previewInitializationStrategy.value = initializationStrategy
    manualInitializationRequired.value = false
    projectMismatchDetected.value = false
    initializationDialogOpen.value = false
    activeTab.value = 'pending'
    for (const key of Object.keys(resolutionChoices)) delete resolutionChoices[key]
    syncStore.finishManual(
      props.projectId,
      'success',
      next.conflicts.length > 0
        ? t('同步预览已生成，发现 {0} 项冲突，需要选择处理方式。', [next.conflicts.length])
        : t('同步预览已生成，请核对后确认执行。'),
    )
    syncStore.markConnectionHealthy?.(props.projectId)
  } catch (error) {
    clearPreview()
    if (isGithubProjectMismatch(error)) {
      projectMismatchDetected.value = true
      if (automaticStatus.value.enabled) syncStore.stop(props.projectId)
      syncStore.finishManual(
        props.projectId,
        'success',
        t('GitHub 仓库是另一个稳定项目。当前项目为空时，可以预览并采用 GitHub 项目。'),
      )
      return
    }
    if (isGithubInitializationRequired(error)) {
      manualInitializationRequired.value = true
      initializationDialogOpen.value = true
      if (automaticStatus.value.enabled) syncStore.stop(props.projectId)
      syncStore.finishManual(
        props.projectId,
        'success',
        t('GitHub 仓库已有资料，需要先选择首次同步版本。'),
      )
      return
    }
    if (initializationStrategy) {
      manualInitializationRequired.value = false
      initializationDialogOpen.value = false
    }
    if (isGithubCredentialUnavailable(error)) {
      if (connection.value) connection.value = { ...connection.value, credentialStored: false }
      connectionSettingsOpen.value = true
    }
    syncStore.finishManual(
      props.projectId,
      'failed',
      githubError(error, t('无法生成同步预览。')),
    )
    if (isGithubConnectionFailure(error)) syncStore.markConnectionError?.(props.projectId)
  }
}

function handleProjectImported(result: GithubProjectImportResult) {
  projectImportDialogOpen.value = false
  projectMismatchDetected.value = false
  syncStore.stop(props.projectId)
  emit('projectAdopted', result.projectId, result.replacedProjectId)
}

function handleExistingProject(projectId: string) {
  projectImportDialogOpen.value = false
  emit('projectAdopted', projectId)
}

async function createInitializationPreview(strategy: GithubSyncInitializationStrategy) {
  initializationChoiceInProgress.value = strategy
  try {
    await createPreview(false, [], strategy)
  } finally {
    if (initializationChoiceInProgress.value === strategy) {
      initializationChoiceInProgress.value = undefined
    }
  }
}

async function recreatePreview() {
  if (!preview.value) {
    await createPreview(true)
    return
  }
  await createPreview(
    previewPullOnly.value,
    appliedResolutions.value,
    previewInitializationStrategy.value,
  )
}

async function resolveConflicts() {
  const current = preview.value
  if (!current || !allConflictsResolved.value) return
  const resolutions = current.conflicts.map((conflict) => ({
    path: conflict.path,
    field: conflict.field,
    choice: resolutionChoices[conflictKey(conflict.path, conflict.field)] as ConflictChoice,
  }))
  await createPreview(
    previewPullOnly.value,
    resolutions,
    previewInitializationStrategy.value,
  )
}

async function applyPreview() {
  const current = preview.value
  if (!current || current.conflicts.length > 0 || operationRunning.value) return
  resetMessages()
  const operationId = syncStore.beginManual(
    props.projectId,
    previewPullOnly.value ? 'applyPull' : 'applyFull',
    previewPullOnly.value ? t('正在启动 GitHub Pull…') : t('正在启动 GitHub 完整同步…'),
  )
  try {
    const outcome = await props.gateway.apply({
      ...syncRequest(
        previewPullOnly.value,
        appliedResolutions.value,
        operationId,
        previewInitializationStrategy.value,
      ),
      expectedFingerprint: current.fingerprint,
    })
    syncStore.clearAutomaticBlockers(props.projectId)
    clearPreview()
    manualInitializationRequired.value = false
    initializationDialogOpen.value = false
    activeTab.value = 'recent'
    applyConnection(await props.gateway.connection(props.projectId))
    if (outcome.changedLocal) await refreshLocalState()
    const partialError = githubSyncOutcomeError(outcome)
    syncStore.markConnectionHealthy?.(props.projectId)
    if (partialError) {
      syncStore.finishManual(props.projectId, 'failed', partialError)
    } else {
      syncStore.finishManual(
        props.projectId,
        'success',
        previewPullOnly.value ? t('GitHub Pull 已完成。') : t('GitHub 同步已完成。'),
      )
    }
  } catch (error) {
    syncStore.finishManual(
      props.projectId,
      'failed',
      githubError(error, t('同步预览已过期或执行失败，请重新预览。')),
    )
    if (isGithubConnectionFailure(error)) syncStore.markConnectionError?.(props.projectId)
  }
}

async function handleConflicts() {
  activeTab.value = 'pending'
  if (!preview.value?.conflicts.length) await createPreview(false)
  await nextTick()
  conflictRegion.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  conflictRegion.value?.querySelector<HTMLSelectElement>('select')?.focus()
}

async function runPrimaryAction() {
  if (!connection.value) {
    connectionSettingsOpen.value = true
    return
  }
  if (projectMismatchDetected.value) {
    projectImportDialogOpen.value = true
    return
  }
  if (initializationRequired.value) {
    initializationDialogOpen.value = true
    return
  }
  if (pendingCount.value > 0) {
    await handleConflicts()
    return
  }
  if (hasReadyPreview.value) {
    await applyPreview()
    return
  }
  await createPreview(false)
}

function toggleAutomaticSync() {
  resetMessages()
  if (!scheduledSyncAvailable.value) return
  if (automaticStatus.value.enabled) {
    syncStore.stop(props.projectId)
    return
  }
  if (initializationRequired.value) {
    initializationDialogOpen.value = true
    return
  }
  if (pendingCount.value > 0) {
    void handleConflicts()
    return
  }
  if (!connection.value) {
    connectionSettingsOpen.value = true
    failure.value = t('请先连接 GitHub 仓库。')
    return
  }
  if (!credentialAvailable.value) {
    connectionSettingsOpen.value = true
    failure.value = t('请输入 GitHub Token 并重新连接仓库后再开启自动同步。')
    return
  }
  syncStore.start(props.projectId, effectiveToken.value, props.gateway, 60, refreshLocalState)
}

async function openTokenHelpUrl(url: string) {
  tokenHelpFailure.value = ''
  try {
    await openExternalUrl(url)
  } catch {
    tokenHelpFailure.value = t('无法打开系统浏览器，请稍后重试或复制链接手动访问。')
  }
}
</script>

<template>
  <section class="github-sync" aria-labelledby="github-sync-title">
    <header class="github-sync__page-heading">
      <div>
        <h1 id="github-sync-title">{{ t('协作同步') }}</h1>
        <p>{{ loading ? t('正在读取仓库…') : connectedLabel }}</p>
      </div>
      <BaseButton
        :name="t('打开连接设置')"
        variant="secondary"
        @click="connectionSettingsOpen = true"
      >
        <IconSettings :size="18" aria-hidden="true" /> {{ t('连接设置') }} </BaseButton>
    </header>

    <section
      class="github-sync__hero"
      :class="`github-sync__hero--${heroTone}`"
      aria-labelledby="github-sync-state-title"
    >
      <div class="github-sync__hero-icon" aria-hidden="true">
        <IconLoader2 v-if="operationRunning || loading" class="github-sync__spinner" :size="28" />
        <IconAlertTriangle v-else-if="heroTone === 'danger'" :size="28" />
        <IconCircleCheck v-else-if="heroTone === 'success'" :size="28" />
        <IconInfoCircle v-else :size="28" />
      </div>
      <div class="github-sync__hero-copy">
        <h2 id="github-sync-state-title">{{ heroTitle }}</h2>
        <p>{{ heroDescription }}</p>
      </div>
      <div v-if="desktopRuntime && !loading" class="github-sync__hero-actions">
        <BaseButton
          :name="primaryActionName"
          size="lg"
          :disabled="operationRunning"
          :loading="operationRunning"
          @click="runPrimaryAction"
        >
          {{ primaryActionLabel }}
        </BaseButton>
        <BaseButton
          v-if="connection && !initializationRequired && !projectMismatchDetected"
          :name="preview ? t('重新预览 GitHub 同步') : t('预览 GitHub Pull')"
          size="lg"
          variant="secondary"
          :disabled="operationRunning"
          @click="recreatePreview"
        >
          <IconRefresh :size="18" aria-hidden="true" />
          {{ preview ? t('重新预览') : t('仅拉取更新') }}
        </BaseButton>
      </div>
    </section>

    <section
      v-if="showOperationBanner && manualOperation"
      class="github-sync__operation"
      :class="`github-sync__operation--${manualOperation.state}`"
      :role="manualOperation.state === 'failed' ? 'alert' : 'status'"
      aria-live="polite"
    >
      <div class="github-sync__operation-icon" aria-hidden="true">
        <IconLoader2 v-if="manualOperation.state === 'running'" class="github-sync__spinner" :size="22" />
        <IconCircleCheck v-else-if="manualOperation.state === 'success'" :size="22" />
        <IconAlertCircle v-else :size="22" />
      </div>
      <div class="github-sync__operation-copy">
        <div>
          <strong>{{ operationTitle }}</strong>
          <StatusBadge :tone="manualOperation.state === 'failed' ? 'danger' : manualOperation.state === 'success' ? 'success' : 'info'">
            {{ operationStateLabel }}
          </StatusBadge>
        </div>
        <p>{{ localizeSystemMessage(manualOperation.message) }}</p>
        <span v-if="manualOperation.state === 'running'">
          {{ operationElapsedLabel }}<template v-if="operationSlow"> {{ t('· GitHub 响应较慢，仍在等待，请勿重复操作') }}</template>
        </span>
      </div>
    </section>

    <section class="github-sync__inbox" :aria-label="t('同步变更')">
      <div class="github-sync__tabs" role="tablist" :aria-label="t('同步变更视图')">
        <button
          id="github-sync-pending-tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'pending'"
          aria-controls="github-sync-pending-panel"
          @click="activeTab = 'pending'"
        > {{ t('待处理') }} <span v-if="pendingCount" aria-hidden="true">{{ pendingCount }}</span>
          <span v-if="pendingCount" class="visually-hidden">{{ t('{0} 项', [pendingCount]) }}</span>
        </button>
        <button
          id="github-sync-recent-tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'recent'"
          aria-controls="github-sync-recent-panel"
          @click="activeTab = 'recent'"
        > {{ t('最近同步') }} </button>
      </div>

      <div
        v-if="activeTab === 'pending'"
        id="github-sync-pending-panel"
        class="github-sync__tab-panel"
        role="tabpanel"
        aria-labelledby="github-sync-pending-tab"
      >
        <div v-if="!desktopRuntime" class="github-sync__empty">
          <IconInfoCircle :size="28" aria-hidden="true" />
          <strong>{{ t('桌面端会在这里展示同步预览') }}</strong>
          <span>{{ t('浏览器开发预览不会读取或上传项目资料。') }}</span>
        </div>
        <div v-else-if="loading" class="github-sync__empty" role="status">
          <IconLoader2 class="github-sync__spinner" :size="28" aria-hidden="true" />
          <strong>{{ t('正在读取 GitHub 连接状态…') }}</strong>
        </div>
        <div v-else-if="!connection" class="github-sync__empty">
          <IconBrandGithub :size="30" aria-hidden="true" />
          <strong>{{ t('尚未连接 GitHub 仓库') }}</strong>
          <span>{{ t('连接私有仓库后，先预览再交换家谱更新。') }}</span>
          <BaseButton :name="t('从待处理区域打开连接设置')" @click="connectionSettingsOpen = true"> {{ t('连接仓库') }} </BaseButton>
        </div>

        <div v-else-if="initializationRequired" class="github-sync__empty">
          <IconAlertTriangle :size="30" aria-hidden="true" />
          <strong>{{ t('首次同步需要选择版本') }}</strong>
          <span>{{ t('本地与 GitHub 都有资料。有谱不会自动覆盖任何一方，请先选择一种方式并查看预览。') }}</span>
          <BaseButton
            :name="t('从待处理区域选择首次同步方式')"
            :disabled="operationRunning"
            @click="initializationDialogOpen = true"
          > {{ t('选择首次同步方式') }} </BaseButton>
        </div>

        <template v-else-if="activeConflicts.length">
          <ol ref="conflictRegion" class="github-sync__conflicts">
            <li
              v-for="conflict in activeConflicts"
              :key="conflictKey(conflict.path, conflict.field)"
            >
              <header>
                <div class="github-sync__conflict-title">
                  <span class="github-sync__conflict-icon" aria-hidden="true">
                    <IconAlertCircle :size="20" />
                  </span>
                  <div>
                    <strong>{{ conflictTitle(conflict) }}</strong>
                    <div class="github-sync__conflict-meta">
                      <code>{{ conflict.path }}{{ conflict.field }}</code>
                      <span>{{ t('共同基线：{0}', [formatValue(conflict.base)]) }}</span>
                    </div>
                  </div>
                </div>
                <StatusBadge tone="danger">{{ t('字段冲突') }}</StatusBadge>
              </header>
              <div class="github-sync__conflict-values">
                <div>
                  <span>{{ t('本地版本') }}</span>
                  <pre>{{ formatValue(conflict.ours) }}</pre>
                </div>
                <div>
                  <span>{{ t('GitHub 版本') }}</span>
                  <pre>{{ formatValue(conflict.theirs) }}</pre>
                </div>
                <label v-if="preview?.conflicts.length" class="github-sync__choice">
                  <span>{{ t('保留哪个结果') }}</span>
                  <BaseSelectControl>
                    <select v-model="resolutionChoices[conflictKey(conflict.path, conflict.field)]">
                      <option value="">{{ t('请选择') }}</option>
                      <option value="base">{{ t('共同基线') }}</option>
                      <option value="ours">{{ t('本地版本') }}</option>
                      <option value="theirs">{{ t('GitHub 版本') }}</option>
                    </select>
                  </BaseSelectControl>
                </label>
              </div>
            </li>
          </ol>
          <div
            v-if="preview && (preview.changedLocal || preview.willPush)"
            class="github-sync__change-list github-sync__change-list--mixed"
            :aria-label="t('可自动处理的同步更新')"
          >
            <article v-if="preview.changedLocal">
              <span class="github-sync__change-icon github-sync__change-icon--pull" aria-hidden="true">
                <IconArrowDown :size="18" />
              </span>
              <div>
                <strong>{{ t('其余 GitHub 更新可自动写入本地') }}</strong>
                <span>{{ t('解决字段冲突后，会在执行同步时一并更新。') }}</span>
              </div>
              <StatusBadge tone="success">{{ t('可自动合并') }}</StatusBadge>
              <IconChevronRight :size="18" aria-hidden="true" />
            </article>
            <article v-if="preview.willPush">
              <span class="github-sync__change-icon" aria-hidden="true">
                <IconArrowUp :size="18" />
              </span>
              <div>
                <strong>{{ t('本地更新将在冲突解决后上传') }}</strong>
                <span>{{ t('未解决前不会修改 GitHub 仓库。') }}</span>
              </div>
              <StatusBadge tone="success">{{ t('等待确认') }}</StatusBadge>
              <IconChevronRight :size="18" aria-hidden="true" />
            </article>
          </div>
          <footer class="github-sync__conflict-actions">
            <BaseButton
              v-if="preview?.conflicts.length"
              :name="t('应用 GitHub 冲突选择')"
              :disabled="!allConflictsResolved || operationRunning"
              :loading="operationRunning && (manualOperation?.operation === 'previewPull' || manualOperation?.operation === 'previewFull')"
              @click="resolveConflicts"
            > {{ t('应用选择并重新预览') }} </BaseButton>
            <BaseButton
              v-else
              :name="t('重新获取 GitHub 冲突预览')"
              @click="createPreview(false)"
            > {{ t('重新预览并处理') }} </BaseButton>
          </footer>
        </template>

        <template v-else-if="preview">
          <div class="github-sync__change-list">
            <article v-if="preview.changedLocal">
              <span class="github-sync__change-icon github-sync__change-icon--pull" aria-hidden="true">
                <IconArrowDown :size="18" />
              </span>
              <div>
                <strong>{{ t('GitHub 更新将写入本地') }}</strong>
                <span>{{ t('执行后会刷新当前项目资料。') }}</span>
              </div>
              <StatusBadge tone="success">{{ t('可自动合并') }}</StatusBadge>
              <IconChevronRight :size="18" aria-hidden="true" />
            </article>
            <article v-if="preview.willPush">
              <span class="github-sync__change-icon" aria-hidden="true">
                <IconArrowUp :size="18" />
              </span>
              <div>
                <strong>{{ t('本地更新将上传到 GitHub') }}</strong>
                <span>{{ t('执行前已经完成 Pull 与字段级合并检查。') }}</span>
              </div>
              <StatusBadge tone="success">{{ t('可安全上传') }}</StatusBadge>
              <IconChevronRight :size="18" aria-hidden="true" />
            </article>
            <article v-if="!preview.changedLocal && !preview.willPush">
              <span class="github-sync__change-icon" aria-hidden="true">
                <IconCircleCheck :size="18" />
              </span>
              <div>
                <strong>{{ t('没有待同步的更新') }}</strong>
                <span>{{ t('本地资料与 GitHub 仓库已经一致。') }}</span>
              </div>
              <StatusBadge tone="success">{{ t('已是最新') }}</StatusBadge>
            </article>
          </div>
          <footer class="github-sync__preview-footer">
            <span>{{ t('远端 commit：') }}<code>{{ preview.pulledCommit || t('空仓库') }}</code></span>
            <BaseButton variant="ghost" :disabled="operationRunning" @click="cancelPreview"> {{ t('取消预览') }} </BaseButton>
          </footer>
        </template>

        <div v-else class="github-sync__empty">
          <IconGitMerge :size="30" aria-hidden="true" />
          <strong>{{ t('尚未生成同步预览') }}</strong>
          <span>{{ t('完整同步会先 Pull，再检查本地更新、远端更新和字段冲突。') }}</span>
          <BaseButton
            :name="t('从待处理区域预览 GitHub 完整同步')"
            :disabled="operationRunning"
            @click="createPreview(false)"
          > {{ t('生成同步预览') }} </BaseButton>
        </div>
      </div>

      <div
        v-else
        id="github-sync-recent-panel"
        class="github-sync__tab-panel"
        role="tabpanel"
        aria-labelledby="github-sync-recent-tab"
      >
        <div class="github-sync__recent-list">
          <article v-if="manualOperation">
            <span
              class="github-sync__change-icon"
              :class="{ 'github-sync__change-icon--danger': manualOperation.state === 'failed' }"
              aria-hidden="true"
            >
              <IconAlertCircle v-if="manualOperation.state === 'failed'" :size="18" />
              <IconRefresh v-else :size="18" />
            </span>
            <div>
              <strong>{{ operationTitle }}</strong>
              <span>{{ localizeSystemMessage(manualOperation.message) }}</span>
            </div>
            <time v-if="manualOperation.finishedAt" :datetime="new Date(manualOperation.finishedAt).toISOString()">
              {{ formatDateTime(new Date(manualOperation.finishedAt).toISOString()) }}
            </time>
          </article>
          <article v-if="connection?.lastSyncedCommit">
            <span class="github-sync__change-icon" aria-hidden="true">
              <IconBrandGithub :size="18" />
            </span>
            <div>
              <strong>{{ t('当前同步基线') }}</strong>
              <code>{{ connection.lastSyncedCommit }}</code>
            </div>
            <StatusBadge :tone="connectionHealth === 'error' ? 'danger' : 'success'">
              {{ connectionHealth === 'error' ? t('连接异常') : t('已记录') }}
            </StatusBadge>
          </article>
          <div v-if="!manualOperation && !connection?.lastSyncedCommit" class="github-sync__empty">
            <IconInfoCircle :size="28" aria-hidden="true" />
            <strong>{{ t('还没有同步记录') }}</strong>
            <span>{{ t('完成第一次同步后，这里会显示最近结果与同步基线。') }}</span>
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="scheduledSyncAvailable"
      class="github-sync__automatic"
      :class="{ 'github-sync__automatic--paused': initializationRequired || automaticStatus.state === 'conflict' || pendingCount > 0 }"
      aria-labelledby="github-sync-automatic-title"
    >
      <IconInfoCircle :size="28" aria-hidden="true" />
      <div>
        <h2 id="github-sync-automatic-title">{{ automaticHeading }}</h2>
        <p>{{ automaticDescription }}</p>
      </div>
      <BaseButton
        :name="t('切换每小时自动同步')"
        size="sm"
        variant="secondary"
        :disabled="operationRunning || !desktopRuntime"
        @click="toggleAutomaticSync"
      >
        {{ initializationRequired ? t('选择版本') : pendingCount ? t('处理冲突') : automaticStatus.enabled ? t('关闭') : t('开启') }}
      </BaseButton>
    </section>

    <p v-if="failure" class="github-sync__error" role="alert">{{ failure }}</p>

    <BaseDialog
      :open="projectImportDialogOpen"
      :title="t('用 GitHub 项目覆盖当前空白项目')"
      :description="t('先确认仓库项目内容；提交时会再次检查当前项目仍为空白，然后直接覆盖。')"
      :close-label="t('关闭 GitHub 项目导入')"
      @close="projectImportDialogOpen = false"
    >
      <GithubProjectImportPanel
        v-if="connection"
        :placeholder-project-id="projectId"
        :initial-owner="connection.owner"
        :initial-repository="connection.repository"
        :initial-branch="connection.branch"
        :initial-token="effectiveToken"
        auto-preview
        :gateway="gateway"
        @imported="handleProjectImported"
        @existing="handleExistingProject"
      />
    </BaseDialog>

    <BaseDialog
      :open="initializationDialogOpen"
      :title="t('首次同步需要选择版本')"
      :description="t('本地项目与 GitHub 仓库都有资料，但还没有共同同步基线。请选择一种方式先生成预览。')"
      :close-label="t('暂不处理首次同步')"
      @close="initializationDialogOpen = false"
    >
      <div class="github-sync__initialization">
        <p class="github-sync__initialization-note"> {{ t('这里的选择只会生成预览，不会立即修改本地资料或 GitHub。核对变更摘要并再次确认后才会执行。') }} </p>

        <section class="github-sync__initialization-option">
          <span class="github-sync__change-icon github-sync__change-icon--pull" aria-hidden="true">
            <IconArrowDown :size="18" />
          </span>
          <div>
            <h3>{{ t('使用 GitHub 版本') }}</h3>
            <p>{{ t('预览用 GitHub 仓库内容替换当前本地项目，并将远端提交设为共同基线。') }}</p>
          </div>
          <BaseButton
            :name="t('预览使用 GitHub 版本进行首次同步')"
            :disabled="operationRunning"
            :loading="initializationChoiceInProgress === 'remote'"
            @click="createInitializationPreview('remote')"
          > {{ t('使用 GitHub 版本') }} </BaseButton>
        </section>

        <section class="github-sync__initialization-option github-sync__initialization-option--local">
          <span class="github-sync__change-icon" aria-hidden="true">
            <IconArrowUp :size="18" />
          </span>
          <div>
            <h3>{{ t('使用本地版本') }}</h3>
            <p>{{ t('预览用当前本地项目更新 GitHub 仓库。执行时会保留 Git 历史并新增一次同步提交。') }}</p>
          </div>
          <BaseButton
            :name="t('预览使用本地版本进行首次同步')"
            variant="secondary"
            :disabled="operationRunning"
            :loading="initializationChoiceInProgress === 'local'"
            @click="createInitializationPreview('local')"
          > {{ t('使用本地版本') }} </BaseButton>
        </section>

        <div class="github-sync__settings-actions">
          <BaseButton
            :name="t('暂不处理首次同步')"
            variant="ghost"
            :disabled="operationRunning"
            @click="initializationDialogOpen = false"
          > {{ t('暂不处理') }} </BaseButton>
        </div>
      </div>
    </BaseDialog>

    <BaseDialog
      :open="connectionSettingsOpen"
      :title="t('连接设置')"
      :description="t('配置当前项目使用的 GitHub 私有仓库与安全凭据。')"
      :close-label="t('关闭 GitHub 连接设置')"
      @close="connectionSettingsOpen = false"
    >
      <div class="github-sync__settings">
        <div class="github-sync__fields">
          <BaseField id="github-owner" :label="t('仓库所有者')" required>
            <input id="github-owner" v-model="draft.owner" name="githubOwner" autocomplete="off" />
          </BaseField>
          <BaseField id="github-repository" :label="t('仓库名称')" required>
            <input id="github-repository" v-model="draft.repository" name="githubRepository" autocomplete="off" />
          </BaseField>
          <BaseField id="github-branch" :label="t('分支')" required>
            <input id="github-branch" v-model="draft.branch" name="githubBranch" autocomplete="off" />
          </BaseField>
          <BaseField
            id="github-token"
            label="GitHub token"
            :hint="t('连接成功后保存在系统安全凭据存储；不会写入 SQLite、项目、.blp 或同步基线。')"
            required
          >
            <template #label-action>
              <button
                class="github-sync__help"
                type="button"
                :aria-label="t('查看 GitHub token 申请帮助')"
                aria-haspopup="dialog"
                @click="tokenHelpOpen = true"
              >
                <IconHelpCircle :size="18" aria-hidden="true" />
              </button>
            </template>
            <div class="github-sync__token-input">
              <input
                id="github-token"
                v-model="draft.token"
                name="githubToken"
                type="password"
                autocomplete="off"
                :class="{ 'github-sync__token-input-control--stored': connection?.credentialStored && !draft.token }"
              />
              <template v-if="connection?.credentialStored && !draft.token">
                <span class="github-sync__token-mask" aria-hidden="true">••••••••••••••••</span>
                <span class="github-sync__token-stored">{{ t('已安全保存') }}</span>
              </template>
            </div>
          </BaseField>
        </div>

        <label class="github-sync__create">
          <input v-model="draft.createIfMissing" type="checkbox" name="githubCreateIfMissing" /> {{ t('仓库不存在时创建私有仓库并执行首次同步') }} </label>

        <p v-if="failure" class="github-sync__error" role="alert">{{ failure }}</p>

        <div class="github-sync__settings-actions">
          <BaseButton
            :name="t('连接 GitHub 仓库')"
            :disabled="operationRunning"
            :loading="operationRunning && manualOperation?.operation === 'connect'"
            @click="connect"
          >
            <IconBrandGithub :size="18" aria-hidden="true" />
            {{ connection ? t('重新连接') : t('连接仓库') }}
          </BaseButton>
          <BaseButton variant="ghost" @click="connectionSettingsOpen = false">{{ t('取消') }}</BaseButton>
        </div>
      </div>
    </BaseDialog>

    <BaseDialog
      :open="tokenHelpOpen"
      :title="t('如何申请 GitHub token？')"
      :description="t('按使用方式选择权限；日常同步建议使用权限最小的 fine-grained token。')"
      :close-label="t('关闭 GitHub token 申请帮助')"
      @close="tokenHelpOpen = false"
    >
      <div class="github-sync__token-help">
        <section>
          <span class="github-sync__recommended">{{ t('推荐') }}</span>
          <h3>{{ t('已有仓库：Fine-grained token') }}</h3>
          <ol>
            <li> {{ t('先在 GitHub') }} <a
                :href="GITHUB_NEW_REPOSITORY_URL"
                target="_blank"
                rel="noreferrer"
                @click.prevent="openTokenHelpUrl(GITHUB_NEW_REPOSITORY_URL)"
              > {{ t('新建一个私有仓库') }} <IconExternalLink :size="14" aria-hidden="true" />
              </a> {{ t('，或使用已有仓库。') }} </li>
            <li>{{ t('创建 token 时，将 Resource owner 设为仓库所有者。') }}</li>
            <li>{{ t('Repository access 只选择要同步的仓库。') }}</li>
            <li>{{ t('在 Repository permissions 中，将 Contents 设为 Read and write。') }}</li>
            <li>{{ t('生成后立即复制 token，粘贴到当前输入框。') }}</li>
          </ol>
          <a
            class="github-sync__token-link"
            :href="GITHUB_FINE_GRAINED_TOKEN_URL"
            target="_blank"
            rel="noreferrer"
            @click.prevent="openTokenHelpUrl(GITHUB_FINE_GRAINED_TOKEN_URL)"
          > {{ t('创建 Fine-grained token') }} <IconExternalLink :size="16" aria-hidden="true" />
          </a>
        </section>

        <section>
          <h3>{{ t('由 Branchloom 创建仓库：Classic token') }}</h3>
          <p> {{ t('如果勾选“仓库不存在时创建”，可创建 classic token 并授予') }} <code>repo</code> {{ t('权限。该权限覆盖范围更宽；仓库创建完成后，建议改用上面的 fine-grained token。') }} </p>
          <a
            class="github-sync__token-link github-sync__token-link--secondary"
            :href="GITHUB_CLASSIC_TOKEN_URL"
            target="_blank"
            rel="noreferrer"
            @click.prevent="openTokenHelpUrl(GITHUB_CLASSIC_TOKEN_URL)"
          > {{ t('创建 Classic token') }} <IconExternalLink :size="16" aria-hidden="true" />
          </a>
        </section>

        <p class="github-sync__token-warning"> {{ t('Token 相当于密码，请勿分享。组织仓库还可能要求管理员批准或完成 SSO 授权。 有谱使用系统安全凭据存储保存 Token，不会将其写入项目资料。') }} </p>

        <a
          class="github-sync__docs-link"
          :href="GITHUB_TOKEN_DOCUMENTATION_URL"
          target="_blank"
          rel="noreferrer"
          @click.prevent="openTokenHelpUrl(GITHUB_TOKEN_DOCUMENTATION_URL)"
        > {{ t('查看 GitHub 官方 token 文档') }} <IconExternalLink :size="15" aria-hidden="true" />
        </a>

        <p v-if="tokenHelpFailure" class="github-sync__token-link-error" role="alert">
          {{ tokenHelpFailure }}
        </p>
      </div>
    </BaseDialog>
  </section>
</template>

<style scoped>
.github-sync {
  display: grid;
  width: min(72rem, 100%);
  gap: var(--space-8);
  padding-top: var(--space-3);
  margin: 0 auto;
}

.github-sync h1,
.github-sync h2,
.github-sync h3,
.github-sync p {
  margin: 0;
}

.github-sync__page-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-5);
  margin-bottom: var(--space-4);
}

.github-sync__page-heading h1 {
  font-family: var(--font-heading);
  font-size: clamp(2rem, 4vw, 3rem);
  font-weight: 520;
  line-height: 1.1;
}

.github-sync__page-heading p {
  margin-top: var(--space-3);
  color: var(--color-muted);
  font-size: .9375rem;
}

.github-sync__hero {
  display: grid;
  align-items: center;
  gap: var(--space-4);
  padding: clamp(1.5rem, 3vw, 2.5rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgb(255 253 248 / 76%);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.github-sync__hero-icon {
  display: grid;
  width: 3rem;
  height: 3rem;
  place-items: center;
  border-radius: 50%;
  background: var(--color-muted-surface);
  color: var(--color-muted);
}

.github-sync__hero--danger .github-sync__hero-icon {
  background: var(--color-warning-surface);
  color: var(--color-accent);
}

.github-sync__hero--success .github-sync__hero-icon {
  background: var(--color-success-surface);
  color: var(--color-success);
}

.github-sync__hero--info .github-sync__hero-icon {
  background: var(--color-info-surface);
  color: var(--color-info);
}

.github-sync__hero-copy {
  display: grid;
  gap: var(--space-1);
}

.github-sync__hero-copy h2 {
  font-family: var(--font-body);
  font-size: clamp(1.3rem, 2.4vw, 1.65rem);
  font-weight: 700;
}

.github-sync__hero-copy p {
  max-width: 42rem;
  color: var(--color-muted);
  font-size: .95rem;
}

.github-sync__hero-actions,
.github-sync__settings-actions,
.github-sync__conflict-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
}

.github-sync__operation {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, var(--color-border));
  border-radius: var(--radius-md);
  background: var(--color-info-surface);
  color: var(--color-info);
}

.github-sync__operation--success {
  border-color: color-mix(in srgb, var(--color-success) 30%, var(--color-border));
  background: var(--color-success-surface);
  color: var(--color-success);
}

.github-sync__operation--failed {
  border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border));
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.github-sync__operation-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
}

.github-sync__operation-copy {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.github-sync__operation-copy > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.github-sync__operation-copy p,
.github-sync__operation-copy span {
  color: currentColor;
}

.github-sync__operation-copy span {
  font-size: .8125rem;
  opacity: .82;
}

.github-sync__spinner {
  animation: github-sync-spin .8s linear infinite;
}

@keyframes github-sync-spin {
  to { transform: rotate(1turn); }
}

.github-sync__inbox {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgb(255 253 248 / 76%);
}

.github-sync__tabs {
  display: flex;
  min-height: 3.6rem;
  align-items: end;
  gap: var(--space-6);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.github-sync__tabs button {
  position: relative;
  display: inline-flex;
  min-height: 3.6rem;
  align-items: center;
  gap: var(--space-2);
  padding: 0 .25rem;
  border: 0;
  background: transparent;
  color: var(--color-muted);
  font-size: 1.0625rem;
  font-weight: 700;
  cursor: pointer;
}

.github-sync__tabs button::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: transparent;
  content: '';
}

.github-sync__tabs button[aria-selected='true'] {
  color: var(--color-primary);
}

.github-sync__tabs button[aria-selected='true']::after {
  background: var(--color-primary);
}

.github-sync__tabs button > span:not(.visually-hidden) {
  display: inline-grid;
  min-width: 1.35rem;
  height: 1.35rem;
  place-items: center;
  padding: 0 .3rem;
  border-radius: 999px;
  background: var(--color-accent);
  color: white;
  font-size: .72rem;
}

.github-sync__tab-panel {
  min-height: 14rem;
  padding: var(--space-5);
}

.github-sync__empty {
  display: grid;
  min-height: 12rem;
  place-content: center;
  justify-items: center;
  gap: var(--space-2);
  color: var(--color-muted);
  text-align: center;
}

.github-sync__empty strong {
  color: var(--color-text);
  font-family: var(--font-heading);
  font-size: 1.1rem;
}

.github-sync__empty .base-button {
  margin-top: var(--space-2);
}

.github-sync__conflicts,
.github-sync__change-list,
.github-sync__recent-list {
  display: grid;
  gap: 0;
  padding: 0;
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  list-style: none;
}

.github-sync__change-list--mixed {
  margin-top: var(--space-3);
}

.github-sync__conflicts > li {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.github-sync__conflicts > li:last-child {
  border-bottom: 0;
}

.github-sync__conflicts header,
.github-sync__conflict-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.github-sync__conflicts header {
  justify-content: space-between;
}

.github-sync__conflict-title {
  min-width: 0;
}

.github-sync__conflict-title strong {
  font-size: 1.0625rem;
}

.github-sync__conflict-title > div {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
}

.github-sync__conflict-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
}

.github-sync__conflict-meta code {
  overflow: hidden;
  color: var(--color-muted);
  font-size: .72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.github-sync__conflict-meta span {
  flex: 0 0 auto;
  color: var(--color-muted);
  font-size: .72rem;
}

.github-sync__conflict-icon,
.github-sync__change-icon {
  display: inline-grid;
  flex: 0 0 auto;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border-radius: 50%;
  background: var(--color-warning-surface);
  color: var(--color-accent);
  font-weight: 800;
}

.github-sync__change-icon {
  background: var(--color-success-surface);
  color: var(--color-success);
}

.github-sync__change-icon--pull {
  background: var(--color-info-surface);
  color: var(--color-info);
}

.github-sync__change-icon--danger {
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.github-sync__conflict-values {
  display: grid;
  align-items: end;
  grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(13rem, .85fr);
  gap: var(--space-3);
}

.github-sync__conflict-values > div {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
}

.github-sync__conflict-values span,
.github-sync__choice > span {
  color: var(--color-muted);
  font-size: .8125rem;
  font-weight: 700;
}

.github-sync__conflict-values pre {
  min-height: 3rem;
  max-height: 9rem;
  overflow: auto;
  padding: var(--space-3);
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 1rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.github-sync__choice {
  display: grid;
  width: 100%;
  gap: var(--space-1);
}

.github-sync__conflict-actions {
  margin-top: var(--space-4);
}

.github-sync__change-list article,
.github-sync__recent-list article {
  display: grid;
  min-width: 0;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);
  grid-template-columns: auto minmax(0, 1fr) auto auto;
}

.github-sync__change-list article:last-child,
.github-sync__recent-list article:last-child {
  border-bottom: 0;
}

.github-sync__change-list article > div,
.github-sync__recent-list article > div {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
}

.github-sync__change-list article strong,
.github-sync__recent-list article strong {
  font-size: 1.0625rem;
}

.github-sync__change-list article span,
.github-sync__recent-list article span,
.github-sync__recent-list time {
  color: var(--color-muted);
  font-size: .9375rem;
}

.github-sync__recent-list code {
  overflow: hidden;
  color: var(--color-muted);
  font-size: .78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.github-sync__preview-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
  color: var(--color-muted);
  font-size: .78rem;
}

.github-sync__automatic {
  display: grid;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgb(255 253 248 / 68%);
  color: var(--color-primary);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.github-sync__automatic--paused {
  background: var(--color-muted-surface);
}

.github-sync__automatic h2 {
  font-family: var(--font-body);
  font-size: 1.2rem;
  font-weight: 700;
}

.github-sync__automatic p {
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: .875rem;
}

.github-sync__settings,
.github-sync__initialization,
.github-sync__token-help,
.github-sync__token-help section {
  display: grid;
  gap: var(--space-4);
}

.github-sync__initialization-note {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-info-surface);
  color: var(--color-info);
  font-size: .875rem;
}

.github-sync__initialization-option {
  display: grid;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.github-sync__initialization-option--local {
  border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
}

.github-sync__initialization-option > div {
  display: grid;
  gap: var(--space-1);
}

.github-sync__initialization-option h3 {
  font-family: var(--font-body);
  font-size: 1rem;
  font-weight: 700;
}

.github-sync__initialization-option p {
  color: var(--color-muted);
  font-size: .875rem;
}

.github-sync__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--space-4);
}

.github-sync__fields input {
  width: 100%;
  min-height: 2.75rem;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
}

.github-sync__token-input {
  position: relative;
}

.github-sync__token-input-control--stored {
  padding-right: 7.5rem !important;
}

.github-sync__token-mask,
.github-sync__token-stored {
  position: absolute;
  top: 50%;
  pointer-events: none;
  transform: translateY(-50%);
}

.github-sync__token-mask {
  left: var(--space-3);
  color: var(--color-text);
  letter-spacing: .12em;
}

.github-sync__token-stored {
  right: var(--space-3);
  padding: .2rem .5rem;
  border-radius: 999px;
  background: var(--color-success-surface);
  color: var(--color-success);
  font-size: .75rem;
  font-weight: 700;
}

.github-sync__help {
  display: inline-grid;
  flex: 0 0 auto;
  width: 1.5rem;
  height: 1.5rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}

.github-sync__help:hover,
.github-sync__help:focus-visible {
  background: var(--color-muted-surface);
  color: var(--color-accent);
}

.github-sync__create {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text);
  font-size: .875rem;
}

.github-sync__token-help h3,
.github-sync__token-help ol,
.github-sync__token-help p {
  margin: 0;
}

.github-sync__token-help ol {
  display: grid;
  gap: var(--space-2);
  padding-left: 1.25rem;
  color: var(--color-muted);
}

.github-sync__token-help li a,
.github-sync__docs-link {
  display: inline-flex;
  align-items: center;
  gap: .2rem;
  color: var(--color-accent);
}

.github-sync__recommended {
  width: fit-content;
  padding: .15rem .5rem;
  border-radius: 999px;
  background: var(--color-success-surface);
  color: var(--color-success);
  font-size: .75rem;
  font-weight: 700;
}

.github-sync__token-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: fit-content;
  min-height: 2.5rem;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: white;
  font-weight: 650;
  text-decoration: none;
}

.github-sync__token-link--secondary {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.github-sync__token-warning {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-muted-surface);
  color: var(--color-muted);
  font-size: .875rem;
}

.github-sync__docs-link {
  width: fit-content;
  font-size: .875rem;
}

.github-sync__token-link-error,
.github-sync__error {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
  font-size: .875rem;
}

@media (max-width: 54rem) {
  .github-sync__hero {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .github-sync__hero-actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }

  .github-sync__conflict-values {
    grid-template-columns: 1fr;
  }

  .github-sync__initialization-option {
    align-items: start;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .github-sync__initialization-option .base-button {
    grid-column: 2;
    justify-self: start;
  }
}

@media (max-width: 42rem) {
  .github-sync__page-heading,
  .github-sync__hero-actions,
  .github-sync__settings-actions,
  .github-sync__conflict-actions,
  .github-sync__preview-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .github-sync__hero {
    grid-template-columns: 1fr;
  }

  .github-sync__hero-icon {
    width: 2.5rem;
    height: 2.5rem;
  }

  .github-sync__tabs {
    padding: 0 var(--space-3);
  }

  .github-sync__tab-panel {
    padding: var(--space-3);
  }

  .github-sync__change-list article,
  .github-sync__recent-list article {
    align-items: start;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .github-sync__change-list article > .status-badge,
  .github-sync__recent-list article > .status-badge,
  .github-sync__change-list article > svg,
  .github-sync__recent-list article > time {
    grid-column: 2;
  }

  .github-sync__automatic {
    align-items: start;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .github-sync__automatic .base-button {
    grid-column: 1 / -1;
  }

  .github-sync__fields {
    grid-template-columns: 1fr;
  }

  .github-sync__initialization-option {
    grid-template-columns: 1fr;
  }

  .github-sync__initialization-option .base-button {
    grid-column: 1;
    justify-self: stretch;
  }
}
</style>
