<script setup lang="ts">
import {
  IconBrandGithub,
  IconCircleCheck,
  IconAlertCircle,
  IconExternalLink,
  IconGitMerge,
  IconHelpCircle,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-vue'
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useGithubSyncStore } from '../../../app/stores/githubSync'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import {
  githubError,
  isGithubConnectionFailure,
  githubSyncOutcomeError,
  tauriGithubSyncGateway,
  type ConflictChoice,
  type GithubConflictResolution,
  type GithubConnectionStatus,
  type GithubOperationKind,
  type GithubSyncGateway,
  type GithubSyncPreview,
} from '../../../shared/githubSync'
import { branchloomRepositoryKey } from '../../../shared/repository/injection'
import {
  NATIVE_STATE_REFRESHED_EVENT,
  refreshNativeRepository,
} from '../../../shared/repository/TauriRepository'
import { openExternalUrl } from '../../../shared/externalLinks'

const props = withDefaults(defineProps<{
  projectId: string
  gateway?: GithubSyncGateway
}>(), {
  gateway: () => tauriGithubSyncGateway,
})

const syncStore = useGithubSyncStore()
const repository = inject(branchloomRepositoryKey, undefined)
const desktopRuntime = computed(() => props.gateway.available())
const connection = ref<GithubConnectionStatus>()
const loading = ref(false)
const failure = ref('')
const success = ref('')
const preview = ref<GithubSyncPreview>()
const previewPullOnly = ref(false)
const appliedResolutions = ref<GithubConflictResolution[]>([])
const tokenHelpOpen = ref(false)
const tokenHelpFailure = ref('')
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
const manualOperation = computed(() => syncStore.manualStatus(props.projectId))
const operationRunning = computed(() => manualOperation.value?.state === 'running')
const connectionHealth = computed(() => connection.value
  ? syncStore.connectionHealth?.(props.projectId) ?? 'configured'
  : undefined)
const connectionBadge = computed(() => {
  if (!desktopRuntime.value) return { label: '仅桌面端', tone: 'warning' as const }
  if (!connection.value) return { label: '未配置', tone: 'neutral' as const }
  if (operationRunning.value && manualOperation.value?.operation === 'connect') {
    return { label: '连接中', tone: 'info' as const }
  }
  if (connectionHealth.value === 'healthy') return { label: '连接正常', tone: 'success' as const }
  if (connectionHealth.value === 'error') return { label: '连接异常', tone: 'danger' as const }
  return { label: '已配置', tone: 'neutral' as const }
})
const operationTitle = computed(() => {
  const labels: Record<GithubOperationKind, string> = {
    connect: connection.value ? '重新连接 GitHub' : '连接 GitHub',
    previewPull: '预览 GitHub Pull',
    previewFull: '预览完整同步',
    applyPull: '执行 GitHub Pull',
    applyFull: '执行 GitHub 完整同步',
  }
  const operation = manualOperation.value
  if (!operation) return ''
  const label = labels[operation.operation]
  if (operation.state === 'running') return `正在${label}`
  return operation.state === 'success' ? `${label}已完成` : `${label}失败`
})
const operationStateLabel = computed(() => {
  if (manualOperation.value?.state === 'running') return '进行中'
  return manualOperation.value?.state === 'success' ? '已完成' : '失败'
})
const operationElapsedSeconds = computed(() => {
  const operation = manualOperation.value
  if (!operation) return 0
  const end = operation.finishedAt ?? clock.value
  return Math.max(0, Math.floor((end - operation.startedAt) / 1000))
})
const operationElapsedLabel = computed(() => operationElapsedSeconds.value > 0
  ? `已用时 ${operationElapsedSeconds.value} 秒`
  : '刚刚开始')
const operationSlow = computed(() => operationRunning.value && operationElapsedSeconds.value >= 15)
const effectiveToken = computed(() => draft.token.trim() || syncStore.credential(props.projectId) || '')
const credentialAvailable = computed(() => Boolean(effectiveToken.value)
  || syncStore.hasToken(props.projectId)
  || Boolean(connection.value?.credentialStored))
const connectedLabel = computed(() => connection.value
  ? `${connection.value.owner}/${connection.value.repository} · ${connection.value.branch}`
  : '尚未连接')
const allConflictsResolved = computed(() => preview.value?.conflicts.length
  ? preview.value.conflicts.every((conflict) => Boolean(resolutionChoices[conflictKey(conflict.path, conflict.field)]))
  : false)

function conflictKey(path: string, field: string) {
  return `${path}\u0000${field}`
}

function resetMessages() {
  failure.value = ''
  success.value = ''
}

async function refreshLocalState() {
  if (repository) await refreshNativeRepository(repository)
  window.dispatchEvent(new Event(NATIVE_STATE_REFRESHED_EVENT))
}

function formatValue(value: unknown) {
  if (value === undefined) return '不存在'
  return JSON.stringify(value, null, 2)
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
    failure.value = githubError(error, '无法读取 GitHub 连接状态。')
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, () => {
  preview.value = undefined
  appliedResolutions.value = []
  void loadConnection()
}, { immediate: true })

onMounted(async () => {
  clockTimer = window.setInterval(() => { clock.value = Date.now() }, 1000)
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
  preview.value = undefined
  if (!draft.owner.trim() || !draft.repository.trim() || !draft.branch.trim()) {
    failure.value = '请填写仓库所有者、仓库名称和分支。'
    return
  }
  if (!credentialAvailable.value) {
    failure.value = '请输入 GitHub Token。连接成功后会保存到系统安全凭据存储。'
    return
  }
  const operationId = syncStore.beginManual(props.projectId, 'connect', '正在启动 GitHub 连接…')
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
    syncStore.start(props.projectId, '', props.gateway, 60, refreshLocalState)
    const message = result.privateRepositoryCreated
      ? '私有仓库已创建，当前项目已完成首次同步；每小时自动同步已开启。'
      : 'GitHub 仓库已连接；每小时自动同步已开启。'
    syncStore.finishManual(props.projectId, 'success', message)
    syncStore.markConnectionHealthy?.(props.projectId)
  } catch (error) {
    syncStore.finishManual(
      props.projectId,
      'failed',
      githubError(error, 'GitHub 仓库连接失败。'),
    )
    syncStore.markConnectionError?.(props.projectId)
  }
}

function syncRequest(
  pullOnly: boolean,
  resolutions: GithubConflictResolution[] = [],
  operationId?: string,
) {
  return {
    operationId,
    projectId: props.projectId,
    token: effectiveToken.value,
    pullOnly,
    resolutions,
  }
}

async function createPreview(pullOnly: boolean, resolutions: GithubConflictResolution[] = []) {
  if (operationRunning.value) return
  resetMessages()
  if (!connection.value) {
    failure.value = '请先连接 GitHub 仓库。'
    return
  }
  if (!credentialAvailable.value) {
    failure.value = '请输入 GitHub Token 并重新连接仓库。'
    return
  }
  const operation = pullOnly ? 'previewPull' : 'previewFull'
  const operationId = syncStore.beginManual(
    props.projectId,
    operation,
    pullOnly ? '正在启动 GitHub Pull 预览…' : '正在启动完整同步预览…',
  )
  try {
    const next = await props.gateway.preview(syncRequest(pullOnly, resolutions, operationId))
    preview.value = next
    previewPullOnly.value = pullOnly
    appliedResolutions.value = resolutions
    for (const key of Object.keys(resolutionChoices)) delete resolutionChoices[key]
    syncStore.finishManual(
      props.projectId,
      'success',
      next.conflicts.length > 0
        ? `同步预览已生成，发现 ${next.conflicts.length} 项冲突，需要选择处理方式。`
        : '同步预览已生成，请核对后确认执行。',
    )
    syncStore.markConnectionHealthy?.(props.projectId)
  } catch (error) {
    preview.value = undefined
    syncStore.finishManual(
      props.projectId,
      'failed',
      githubError(error, '无法生成同步预览。'),
    )
    if (isGithubConnectionFailure(error)) syncStore.markConnectionError?.(props.projectId)
  }
}

async function resolveConflicts() {
  const current = preview.value
  if (!current || !allConflictsResolved.value) return
  const resolutions = current.conflicts.map((conflict) => ({
    path: conflict.path,
    field: conflict.field,
    choice: resolutionChoices[conflictKey(conflict.path, conflict.field)] as ConflictChoice,
  }))
  await createPreview(previewPullOnly.value, resolutions)
}

async function applyPreview() {
  const current = preview.value
  if (!current || current.conflicts.length > 0 || operationRunning.value) return
  resetMessages()
  const operationId = syncStore.beginManual(
    props.projectId,
    previewPullOnly.value ? 'applyPull' : 'applyFull',
    previewPullOnly.value ? '正在启动 GitHub Pull…' : '正在启动 GitHub 完整同步…',
  )
  try {
    const outcome = await props.gateway.apply({
      ...syncRequest(previewPullOnly.value, appliedResolutions.value, operationId),
      expectedFingerprint: current.fingerprint,
    })
    preview.value = undefined
    appliedResolutions.value = []
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
        previewPullOnly.value ? 'GitHub Pull 已完成。' : 'GitHub 同步已完成。',
      )
    }
  } catch (error) {
    syncStore.finishManual(
      props.projectId,
      'failed',
      githubError(error, '同步预览已过期或执行失败，请重新预览。'),
    )
    if (isGithubConnectionFailure(error)) syncStore.markConnectionError?.(props.projectId)
  }
}

function toggleAutomaticSync() {
  resetMessages()
  if (automaticStatus.value.enabled) {
    syncStore.stop(props.projectId)
    return
  }
  if (!connection.value) {
    failure.value = '请先连接 GitHub 仓库。'
    return
  }
  if (!credentialAvailable.value) {
    failure.value = '请输入 GitHub Token 并重新连接仓库后再开启自动同步。'
    return
  }
  syncStore.start(props.projectId, effectiveToken.value, props.gateway, 60, refreshLocalState)
}

async function openTokenHelpUrl(url: string) {
  tokenHelpFailure.value = ''
  try {
    await openExternalUrl(url)
  } catch {
    tokenHelpFailure.value = '无法打开系统浏览器，请稍后重试或复制链接手动访问。'
  }
}
</script>

<template>
  <section class="github-sync" aria-labelledby="github-sync-title">
    <header class="github-sync__heading">
      <div>
        <span>GitHub</span>
        <h2 id="github-sync-title">同步项目仓库</h2>
        <p>GitHub 保存展开后的 JSON-LD 项目文件；每次 Push 前都会先 Pull 并检查冲突。</p>
      </div>
      <StatusBadge :tone="connectionBadge.tone">
        {{ connectionBadge.label }}
      </StatusBadge>
    </header>

    <div v-if="!desktopRuntime" class="github-sync__notice" role="note">
      GitHub 同步只在 Tauri 桌面应用中可用；浏览器开发预览不会读取或上传项目资料。
    </div>

    <template v-else>
      <div class="github-sync__connection">
        <p><strong>当前仓库</strong><span>{{ loading ? '正在读取…' : connectedLabel }}</span></p>
        <code v-if="connection?.lastSyncedCommit">{{ connection.lastSyncedCommit }}</code>
      </div>

      <div class="github-sync__fields">
        <BaseField id="github-owner" label="仓库所有者" required>
          <input id="github-owner" v-model="draft.owner" name="githubOwner" autocomplete="off" />
        </BaseField>
        <BaseField id="github-repository" label="仓库名称" required>
          <input id="github-repository" v-model="draft.repository" name="githubRepository" autocomplete="off" />
        </BaseField>
        <BaseField id="github-branch" label="分支" required>
          <input id="github-branch" v-model="draft.branch" name="githubBranch" autocomplete="off" />
        </BaseField>
        <BaseField
          id="github-token"
          label="GitHub token"
          hint="连接成功后保存在系统安全凭据存储；不会写入 SQLite、项目、.blp 或同步基线。"
          required
        >
          <template #label-action>
            <button
              class="github-sync__help"
              type="button"
              aria-label="查看 GitHub token 申请帮助"
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
              <span class="github-sync__token-stored">已安全保存</span>
            </template>
          </div>
        </BaseField>
      </div>

      <label class="github-sync__create">
        <input v-model="draft.createIfMissing" type="checkbox" name="githubCreateIfMissing" />
        仓库不存在时创建私有仓库并执行首次同步
      </label>

      <div class="github-sync__actions">
        <BaseButton
          name="连接 GitHub 仓库"
          :disabled="operationRunning"
          :loading="operationRunning && manualOperation?.operation === 'connect'"
          @click="connect"
        >
          <IconBrandGithub :size="18" aria-hidden="true" />
          {{ connection ? '重新连接' : '连接仓库' }}
        </BaseButton>
        <BaseButton
          name="预览 GitHub Pull"
          variant="secondary"
          :disabled="!connection || operationRunning"
          :loading="operationRunning && manualOperation?.operation === 'previewPull'"
          @click="createPreview(true)"
        >
          <IconRefresh :size="18" aria-hidden="true" />
          预览 Pull
        </BaseButton>
        <BaseButton
          name="预览 GitHub 完整同步"
          variant="secondary"
          :disabled="!connection || operationRunning"
          :loading="operationRunning && manualOperation?.operation === 'previewFull'"
          @click="createPreview(false)"
        >
          <IconGitMerge :size="18" aria-hidden="true" />
          预览完整同步
        </BaseButton>
      </div>

      <section
        v-if="manualOperation"
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
          <p>{{ manualOperation.message }}</p>
          <span v-if="manualOperation.state === 'running'">
            {{ operationElapsedLabel }}<template v-if="operationSlow"> · GitHub 响应较慢，仍在等待，请勿重复操作</template>
          </span>
        </div>
      </section>

      <div class="github-sync__automatic">
        <div>
          <strong>应用运行期间每小时同步</strong>
          <span>{{ automaticStatus.message || '连接仓库后默认开启；应用退出后停止。' }}</span>
        </div>
        <BaseButton
          name="切换每小时自动同步"
          size="sm"
          variant="secondary"
          :disabled="operationRunning"
          @click="toggleAutomaticSync"
        >
          {{ automaticStatus.enabled ? '关闭' : '开启' }}
        </BaseButton>
      </div>

      <section v-if="preview" class="github-sync__preview" aria-labelledby="github-sync-preview-title">
        <header>
          <div>
            <span>同步预览</span>
            <h3 id="github-sync-preview-title">{{ previewPullOnly ? 'Pull' : 'Pull、合并并 Push' }}</h3>
          </div>
          <StatusBadge :tone="preview.conflicts.length ? 'danger' : 'info'">
            {{ preview.conflicts.length ? `${preview.conflicts.length} 项冲突` : '可以执行' }}
          </StatusBadge>
        </header>
        <dl>
          <div><dt>本地将更新</dt><dd>{{ preview.changedLocal ? '是' : '否' }}</dd></div>
          <div><dt>将 Push</dt><dd>{{ preview.willPush ? '是' : '否' }}</dd></div>
          <div><dt>远端 commit</dt><dd><code>{{ preview.pulledCommit || '空仓库' }}</code></dd></div>
        </dl>

        <ol v-if="preview.conflicts.length" class="github-sync__conflicts">
          <li v-for="conflict in preview.conflicts" :key="conflictKey(conflict.path, conflict.field)">
            <header><strong>{{ conflict.path }}</strong><code>{{ conflict.field || '/' }}</code></header>
            <div>
              <label>共同基线<pre>{{ formatValue(conflict.base) }}</pre></label>
              <label>本地版本<pre>{{ formatValue(conflict.ours) }}</pre></label>
              <label>GitHub 版本<pre>{{ formatValue(conflict.theirs) }}</pre></label>
            </div>
            <label class="github-sync__choice">
              选择结果
              <BaseSelectControl>
                <select v-model="resolutionChoices[conflictKey(conflict.path, conflict.field)]">
                  <option value="">请选择</option>
                  <option value="base">共同基线</option>
                  <option value="ours">本地版本</option>
                  <option value="theirs">GitHub 版本</option>
                </select>
              </BaseSelectControl>
            </label>
          </li>
        </ol>

        <footer>
          <BaseButton
            v-if="preview.conflicts.length"
            name="应用 GitHub 冲突选择"
            :disabled="!allConflictsResolved || operationRunning"
            :loading="operationRunning && (manualOperation?.operation === 'previewPull' || manualOperation?.operation === 'previewFull')"
            @click="resolveConflicts"
          >
            应用选择并重新预览
          </BaseButton>
          <BaseButton
            v-else
            name="确认执行 GitHub 同步"
            :disabled="operationRunning"
            :loading="operationRunning && (manualOperation?.operation === 'applyPull' || manualOperation?.operation === 'applyFull')"
            @click="applyPreview"
          >
            确认执行
          </BaseButton>
          <BaseButton variant="ghost" :disabled="operationRunning" @click="preview = undefined">取消预览</BaseButton>
        </footer>
      </section>

      <p v-if="success" class="github-sync__success" role="status">{{ success }}</p>
      <p v-if="failure" class="github-sync__error" role="alert">{{ failure }}</p>
    </template>

    <BaseDialog
      :open="tokenHelpOpen"
      title="如何申请 GitHub token？"
      description="按使用方式选择权限；日常同步建议使用权限最小的 fine-grained token。"
      close-label="关闭 GitHub token 申请帮助"
      @close="tokenHelpOpen = false"
    >
      <div class="github-sync__token-help">
        <section>
          <span class="github-sync__recommended">推荐</span>
          <h3>已有仓库：Fine-grained token</h3>
          <ol>
            <li>
              先在 GitHub
              <a
                :href="GITHUB_NEW_REPOSITORY_URL"
                target="_blank"
                rel="noreferrer"
                @click.prevent="openTokenHelpUrl(GITHUB_NEW_REPOSITORY_URL)"
              >
                新建一个私有仓库
                <IconExternalLink :size="14" aria-hidden="true" />
              </a>
              ，或使用已有仓库。
            </li>
            <li>创建 token 时，将 Resource owner 设为仓库所有者。</li>
            <li>Repository access 只选择要同步的仓库。</li>
            <li>在 Repository permissions 中，将 Contents 设为 Read and write。</li>
            <li>生成后立即复制 token，粘贴到当前输入框。</li>
          </ol>
          <a
            class="github-sync__token-link"
            :href="GITHUB_FINE_GRAINED_TOKEN_URL"
            target="_blank"
            rel="noreferrer"
            @click.prevent="openTokenHelpUrl(GITHUB_FINE_GRAINED_TOKEN_URL)"
          >
            创建 Fine-grained token
            <IconExternalLink :size="16" aria-hidden="true" />
          </a>
        </section>

        <section>
          <h3>由 Branchloom 创建仓库：Classic token</h3>
          <p>
            如果勾选“仓库不存在时创建”，可创建 classic token 并授予
            <code>repo</code>
            权限。该权限覆盖范围更宽；仓库创建完成后，建议改用上面的 fine-grained token。
          </p>
          <a
            class="github-sync__token-link github-sync__token-link--secondary"
            :href="GITHUB_CLASSIC_TOKEN_URL"
            target="_blank"
            rel="noreferrer"
            @click.prevent="openTokenHelpUrl(GITHUB_CLASSIC_TOKEN_URL)"
          >
            创建 Classic token
            <IconExternalLink :size="16" aria-hidden="true" />
          </a>
        </section>

        <p class="github-sync__token-warning">
          Token 相当于密码，请勿分享。组织仓库还可能要求管理员批准或完成 SSO 授权。
          有谱使用系统安全凭据存储保存 Token，不会将其写入项目资料。
        </p>

        <a
          class="github-sync__docs-link"
          :href="GITHUB_TOKEN_DOCUMENTATION_URL"
          target="_blank"
          rel="noreferrer"
          @click.prevent="openTokenHelpUrl(GITHUB_TOKEN_DOCUMENTATION_URL)"
        >
          查看 GitHub 官方 token 文档
          <IconExternalLink :size="15" aria-hidden="true" />
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
  gap: var(--space-5);
  padding: clamp(1.25rem, 3vw, 2rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.github-sync__heading,
.github-sync__actions,
.github-sync__automatic,
.github-sync__preview > header,
.github-sync__preview footer,
.github-sync__connection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.github-sync__heading > div > span,
.github-sync__preview > header span {
  color: var(--color-accent);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.github-sync h2,
.github-sync h3,
.github-sync p {
  margin: 0;
}

.github-sync h2 {
  margin-top: var(--space-1);
  font-family: var(--font-heading);
}

.github-sync__heading p,
.github-sync__automatic span {
  display: block;
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: .875rem;
}

.github-sync__notice,
.github-sync__automatic {
  padding: var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-muted-surface);
  color: var(--color-muted);
}

.github-sync__connection {
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.github-sync__connection p {
  display: grid;
  gap: var(--space-1);
}

.github-sync__connection span {
  color: var(--color-muted);
}

.github-sync__connection code {
  max-width: 20rem;
  overflow: hidden;
  color: var(--color-muted);
  font-size: .75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.github-sync__token-help {
  display: grid;
  gap: var(--space-5);
}

.github-sync__token-help section {
  display: grid;
  gap: var(--space-3);
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

.github-sync__token-link-error {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
  font-size: .875rem;
}

.github-sync__create,
.github-sync__choice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text);
  font-size: .875rem;
}

.github-sync__actions {
  justify-content: flex-start;
  flex-wrap: wrap;
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

.github-sync__preview {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-background);
}

.github-sync__preview dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.github-sync__preview dl > div {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.github-sync__preview dt {
  color: var(--color-muted);
  font-size: .75rem;
}

.github-sync__preview dd {
  margin: 0;
  font-weight: 650;
}

.github-sync__conflicts {
  display: grid;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.github-sync__conflicts > li {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
}

.github-sync__conflicts header,
.github-sync__conflicts > li > div {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.github-sync__conflicts header {
  grid-template-columns: 1fr auto;
}

.github-sync__conflicts label {
  min-width: 0;
  color: var(--color-muted);
  font-size: .75rem;
}

.github-sync__conflicts pre {
  max-height: 12rem;
  overflow: auto;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.github-sync__choice {
  color: var(--color-text);
  font-size: .875rem;
  font-weight: 650;
}

.github-sync__success,
.github-sync__error {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
}

.github-sync__success {
  background: var(--color-success-surface);
  color: var(--color-success);
}

.github-sync__error {
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

@media (max-width: 760px) {
  .github-sync__fields,
  .github-sync__preview dl,
  .github-sync__conflicts > li > div {
    grid-template-columns: 1fr;
  }

  .github-sync__heading,
  .github-sync__automatic,
  .github-sync__connection {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
