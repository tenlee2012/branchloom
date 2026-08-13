<script setup lang="ts">
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCircleCheck,
  IconDownload,
} from '@tabler/icons-vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseField from '../../../design-system/BaseField.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import {
  githubError,
  tauriGithubSyncGateway,
  type GithubProjectImportPreview,
  type GithubProjectImportResult,
  type GithubSyncGateway,
} from '../../../shared/githubSync'

const props = withDefaults(defineProps<{
  placeholderProjectId?: string
  initialOwner?: string
  initialRepository?: string
  initialBranch?: string
  initialToken?: string
  autoPreview?: boolean
  gateway?: GithubSyncGateway
}>(), {
  initialOwner: '',
  initialRepository: '',
  initialBranch: 'main',
  initialToken: '',
  autoPreview: false,
  gateway: () => tauriGithubSyncGateway,
})

const emit = defineEmits<{
  imported: [result: GithubProjectImportResult]
  existing: [projectId: string]
}>()

const draft = reactive({
  owner: props.initialOwner,
  repository: props.initialRepository,
  branch: props.initialBranch,
  token: props.initialToken,
})
const preview = ref<GithubProjectImportPreview>()
const result = ref<GithubProjectImportResult>()
const loading = ref(false)
const failure = ref('')
const credentialRecovery = ref(false)

watch(
  () => [props.initialOwner, props.initialRepository, props.initialBranch] as const,
  ([owner, repository, branch]) => {
    if (preview.value || loading.value) return
    draft.owner = owner
    draft.repository = repository
    draft.branch = branch
  },
)

const desktopRuntime = computed(() => props.gateway.available())
const importingAsReplacement = computed(() => Boolean(props.placeholderProjectId))
const tokenRequired = computed(() => !props.placeholderProjectId || credentialRecovery.value)
const totalRecords = computed(() => Object.values(preview.value?.recordCounts ?? {})
  .reduce((total, count) => total + count, 0))
const requestInput = computed(() => ({
  ...(props.placeholderProjectId ? { placeholderProjectId: props.placeholderProjectId } : {}),
  owner: draft.owner.trim(),
  repository: draft.repository.trim(),
  branch: draft.branch.trim() || 'main',
  token: draft.token.trim(),
}))

function validateDraft(): string {
  if (!requestInput.value.owner) return '请输入 GitHub 仓库所有者。'
  if (!requestInput.value.repository) return '请输入 GitHub 仓库名称。'
  if (tokenRequired.value && !requestInput.value.token) return '请输入可访问该仓库的 GitHub Token。'
  return ''
}

function requiresCredentialInput(error: unknown): boolean {
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

async function createPreview() {
  if (loading.value) return
  failure.value = validateDraft()
  if (failure.value) return
  loading.value = true
  preview.value = undefined
  result.value = undefined
  try {
    preview.value = await props.gateway.previewImport(requestInput.value)
    credentialRecovery.value = false
  } catch (error) {
    credentialRecovery.value = props.autoPreview && requiresCredentialInput(error)
    failure.value = githubError(error, '无法读取 GitHub 项目。')
  } finally {
    loading.value = false
  }
}

function editConnection() {
  preview.value = undefined
  result.value = undefined
  failure.value = ''
}

onMounted(() => {
  if (props.autoPreview && desktopRuntime.value) void createPreview()
})

async function applyImport() {
  if (!preview.value || loading.value) return
  failure.value = ''
  loading.value = true
  try {
    const outcome = await props.gateway.applyImport({
      ...requestInput.value,
      expectedFingerprint: preview.value.fingerprint,
    })
    result.value = outcome
    if (outcome.warnings.length === 0) emit('imported', outcome)
  } catch (error) {
    failure.value = githubError(error, 'GitHub 项目导入失败，请重新预览。')
    preview.value = undefined
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="github-import" :aria-busy="loading">
    <div v-if="!desktopRuntime" class="github-import__notice" role="status">
      <IconBrandGithub :size="24" aria-hidden="true" />
      <div>
        <strong>GitHub 项目导入仅在桌面端可用</strong>
        <p>请在 Branchloom 桌面应用中连接私有仓库并安全保存凭据。</p>
      </div>
    </div>

    <template v-else-if="result">
      <div class="github-import__result">
        <IconAlertTriangle :size="28" aria-hidden="true" />
        <div>
          <h3>项目已经导入，连接设置需要检查</h3>
          <p v-for="warning in result.warnings" :key="warning">{{ warning }}</p>
        </div>
      </div>
      <BaseButton name="打开已导入的 GitHub 项目" @click="emit('imported', result)">
        打开已导入项目
      </BaseButton>
    </template>

    <template v-else-if="preview">
      <article class="github-import__preview" aria-labelledby="github-import-preview-title">
        <div class="github-import__preview-heading">
          <span aria-hidden="true"><IconBrandGithub :size="24" /></span>
          <div>
            <p>GitHub 项目</p>
            <h3 id="github-import-preview-title">{{ preview.projectName }}</h3>
          </div>
          <StatusBadge :tone="preview.alreadyExists ? 'info' : 'success'">
            {{ preview.alreadyExists ? '本机已存在' : '可以导入' }}
          </StatusBadge>
        </div>
        <p v-if="preview.projectDescription" class="github-import__description">
          {{ preview.projectDescription }}
        </p>
        <dl>
          <div><dt>稳定项目 ID</dt><dd><code>{{ preview.projectId }}</code></dd></div>
          <div><dt>远端提交</dt><dd><code>{{ preview.commit || '未知' }}</code></dd></div>
          <div><dt>资料记录</dt><dd>{{ totalRecords }} 条</dd></div>
          <div><dt>人物 / 关系 / 附件</dt><dd>{{ preview.recordCounts.people || 0 }} / {{ preview.recordCounts.relationships || 0 }} / {{ preview.recordCounts.attachments || 0 }}</dd></div>
        </dl>
      </article>

      <div v-if="preview.alreadyExists" class="github-import__notice github-import__notice--success">
        <IconCircleCheck :size="24" aria-hidden="true" />
        <div>
          <strong>本机已经有这个稳定项目</strong>
          <p>不会重复导入或覆盖本地资料，可以直接打开现有项目。</p>
        </div>
      </div>

      <div v-else-if="importingAsReplacement" class="github-import__notice github-import__notice--replacement">
        <IconCircleCheck :size="24" aria-hidden="true" />
        <div>
          <strong>将直接覆盖当前空白项目</strong>
          <p>确认后会采用 GitHub 项目的内容与稳定身份；GitHub 仓库不会被修改。</p>
        </div>
      </div>

      <div class="github-import__actions">
        <BaseButton
          variant="ghost"
          :disabled="loading"
          @click="props.autoPreview ? createPreview() : editConnection()"
        >
          {{ props.autoPreview ? '重新检查' : '修改仓库' }}
        </BaseButton>
        <BaseButton
          v-if="preview.alreadyExists"
          name="打开本机已有的 GitHub 项目"
          @click="emit('existing', preview.projectId)"
        >
          打开已有项目
        </BaseButton>
        <BaseButton
          v-else
          name="确认导入 GitHub 项目"
          :loading="loading"
          @click="applyImport"
        >
          <IconDownload :size="18" aria-hidden="true" />
          {{ importingAsReplacement ? '覆盖当前空白项目' : '导入并建立同步' }}
        </BaseButton>
      </div>
    </template>

    <div v-else-if="props.autoPreview && loading" class="github-import__notice github-import__notice--loading" role="status">
      <IconBrandGithub :size="24" aria-hidden="true" />
      <div>
        <strong>正在检查已连接的 GitHub 项目…</strong>
        <p>将使用系统安全凭据读取仓库内容，不会修改本地项目或 GitHub。</p>
      </div>
    </div>

    <form
      v-else-if="props.autoPreview && credentialRecovery"
      class="github-import__form"
      @submit.prevent="createPreview"
    >
      <div class="github-import__notice">
        <IconAlertTriangle :size="24" aria-hidden="true" />
        <div>
          <strong>已保存的 GitHub 凭据不可用</strong>
          <p>请补充一个可访问当前仓库的 Token。验证成功后会重新安全保存。</p>
        </div>
      </div>
      <BaseField
        id="github-import-token"
        label="GitHub Token"
        hint="需要当前仓库的 Contents 读取权限。"
        required
      >
        <input
          id="github-import-token"
          v-model="draft.token"
          name="githubImportToken"
          type="password"
          autocomplete="off"
          placeholder="github_pat_…"
          required
        />
      </BaseField>
      <div class="github-import__actions">
        <BaseButton name="使用新 Token 重新检查 GitHub 项目" type="submit" :loading="loading">
          使用新 Token 重新检查
        </BaseButton>
      </div>
    </form>

    <div v-else-if="props.autoPreview" class="github-import__actions">
      <BaseButton name="重新检查 GitHub 项目" :loading="loading" @click="createPreview">
        重新检查
      </BaseButton>
    </div>

    <form v-else class="github-import__form" @submit.prevent="createPreview">
      <div class="github-import__fields">
        <BaseField id="github-import-owner" label="仓库所有者" required>
          <input id="github-import-owner" v-model="draft.owner" name="githubImportOwner" autocomplete="off" />
        </BaseField>
        <BaseField id="github-import-repository" label="仓库名称" required>
          <input id="github-import-repository" v-model="draft.repository" name="githubImportRepository" autocomplete="off" />
        </BaseField>
        <BaseField id="github-import-branch" label="分支" required>
          <input id="github-import-branch" v-model="draft.branch" name="githubImportBranch" autocomplete="off" />
        </BaseField>
        <BaseField
          id="github-import-token"
          label="GitHub Token"
          :hint="tokenRequired ? '需要 Contents 读取权限；导入后保存在系统安全凭据中。' : '留空时使用当前项目已安全保存的凭据。'"
          :required="tokenRequired"
        >
          <input
            id="github-import-token"
            v-model="draft.token"
            name="githubImportToken"
            type="password"
            autocomplete="off"
            :placeholder="tokenRequired ? 'github_pat_…' : '使用已保存凭据'"
          />
        </BaseField>
      </div>
      <div class="github-import__actions">
        <BaseButton name="预览 GitHub 项目导入" type="submit" :loading="loading">
          检查仓库并预览
        </BaseButton>
      </div>
    </form>

    <p v-if="failure" class="github-import__error" role="alert">{{ failure }}</p>
  </div>
</template>

<style scoped>
.github-import,
.github-import__form {
  display: grid;
  gap: var(--space-5);
}

.github-import__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--space-4);
}

.github-import input:not([type='checkbox']) {
  width: 100%;
  min-height: 2.75rem;
  box-sizing: border-box;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
}

.github-import input:focus-visible {
  border-color: var(--color-primary);
  outline: 3px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
}

.github-import__preview {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-muted-surface);
}

.github-import__preview-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
}

.github-import__preview-heading > span {
  display: grid;
  width: 2.75rem;
  height: 2.75rem;
  place-items: center;
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--color-surface);
}

.github-import__preview h3,
.github-import__preview p,
.github-import__result h3,
.github-import__result p,
.github-import__notice p {
  margin: 0;
}

.github-import__preview-heading p {
  color: var(--color-muted);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.github-import__preview h3,
.github-import__result h3 {
  margin-top: var(--space-1);
  font-family: var(--font-heading);
}

.github-import__description,
.github-import__notice p,
.github-import__result p {
  color: var(--color-muted);
}

.github-import__preview dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.github-import__preview dl > div {
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.github-import__preview dt {
  color: var(--color-muted);
  font-size: .75rem;
}

.github-import__preview dd {
  overflow: hidden;
  margin: var(--space-1) 0 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.github-import__notice,
.github-import__result {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-sm);
  background: var(--color-warning-surface);
}

.github-import__notice--success {
  border-color: var(--color-success);
  background: var(--color-success-surface);
}

.github-import__notice--loading {
  border-color: var(--color-info);
  background: var(--color-info-surface);
}

.github-import__notice--replacement {
  border-color: var(--color-success);
  background: var(--color-success-surface);
}

.github-import__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-3);
}

.github-import__error {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

@media (max-width: 38rem) {
  .github-import__fields,
  .github-import__preview dl {
    grid-template-columns: 1fr;
  }

  .github-import__preview-heading {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .github-import__preview-heading .status-badge {
    grid-column: 2;
  }

  .github-import__actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }
}
</style>
