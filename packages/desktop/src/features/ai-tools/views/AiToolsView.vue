<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconRefresh,
  IconRobot,
  IconShieldCheck,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import {
  aiToolsError,
  tauriAiToolsGateway,
  type AiToolComponent,
  type AiToolComponentState,
  type AiToolsAction,
  type AiToolsPlanPreview,
  type AiToolsStatus,
} from '../../../shared/aiTools'

const loading = ref(true)
const applying = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const status = ref<AiToolsStatus>()
const preview = ref<AiToolsPlanPreview>()

const available = tauriAiToolsGateway.available()
const components = computed(() => status.value ? [status.value.cli, status.value.skill] : [])
const needsInstall = computed(() => components.value.some((item) => item.state === 'notInstalled'))
const needsUpdate = computed(() => components.value.some((item) => item.state === 'updateAvailable'))
const needsRepair = computed(() => components.value.some((item) => ['modified', 'damaged'].includes(item.state)))
const hasConflict = computed(() => components.value.some((item) => item.state === 'conflict'))
const primaryAction = computed<AiToolsAction>(() => {
  if (needsRepair.value) return 'repair'
  if (needsUpdate.value) return 'update'
  if (needsInstall.value) return 'install'
  return 'repair'
})
const primaryLabel = computed(() => {
  if (needsRepair.value) return '修复 CLI 和 Skill'
  if (needsUpdate.value) return '更新 CLI 和 Skill'
  if (needsInstall.value) return '安装 CLI 和 Skill'
  return '重新校验并修复'
})
const statusHeading = computed(() => status.value?.compatible
  ? 'AI 工具已经可以使用'
  : '完成本机设置后即可使用')
const statusDescription = computed(() => {
  if (hasConflict.value) return '检测到现有文件冲突。Branchloom 不会覆盖不属于本应用的工具。'
  if (needsRepair.value) return '部分组件已被修改或损坏，修复后会恢复为当前桌面版本随附的文件。'
  if (needsUpdate.value) return '本机组件版本较旧，可以更新为当前桌面版本随附的组合。'
  if (needsInstall.value) return 'CLI 与 Skill 均由桌面应用离线提供，安装前会先显示具体修改。'
  if (!status.value?.pathAvailable) return 'CLI 与 Skill 已安装，完成下方 PATH 配置后即可从终端直接调用。'
  return 'CLI 与 Skill 版本匹配，并已通过本机完整性检查。'
})

function badge(state: AiToolComponentState) {
  const values: Record<AiToolComponentState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
    notInstalled: { label: '未安装', tone: 'neutral' },
    installed: { label: '已安装', tone: 'success' },
    updateAvailable: { label: '可更新', tone: 'info' },
    modified: { label: '已修改', tone: 'warning' },
    damaged: { label: '需要修复', tone: 'warning' },
    conflict: { label: '路径冲突', tone: 'danger' },
  }
  return values[state]
}

async function loadStatus() {
  if (!available) {
    loading.value = false
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    status.value = await tauriAiToolsGateway.status()
  } catch (error) {
    errorMessage.value = aiToolsError(error, 'AI 工具状态暂时无法读取')
  } finally {
    loading.value = false
  }
}

async function openPreview(action: AiToolsAction, selected: AiToolComponent[]) {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const plan = await tauriAiToolsGateway.preview(action, selected)
    if (plan.changes.length === 0) {
      successMessage.value = '当前安装已经是所需状态，无需修改。'
      await loadStatus()
      return
    }
    preview.value = plan
  } catch (error) {
    errorMessage.value = aiToolsError(error, '无法生成安装预览')
  }
}

async function applyPreview() {
  if (!preview.value) return
  applying.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await tauriAiToolsGateway.apply(preview.value.planId)
    status.value = result.status
    successMessage.value = result.changed.length
      ? 'AI 工具安装状态已更新。重新打开终端和 Codex 后即可使用。'
      : '当前安装已经是最新状态。'
    preview.value = undefined
  } catch (error) {
    errorMessage.value = aiToolsError(error, 'AI 工具安装失败')
  } finally {
    applying.value = false
  }
}

async function copyPathInstruction() {
  if (!status.value?.pathInstruction) return
  try {
    await navigator.clipboard.writeText(status.value.pathInstruction)
    successMessage.value = 'PATH 配置命令已复制。执行后请重新打开终端。'
  } catch {
    errorMessage.value = `无法自动复制，请手动复制：${status.value.pathInstruction}`
  }
}

onMounted(loadStatus)
</script>

<template>
  <section class="ai-tools" aria-labelledby="ai-tools-title">
    <header class="ai-tools__heading">
      <div>
        <p>全局设置</p>
        <h1 id="ai-tools-title">AI 工具</h1>
        <span>管理随桌面应用提供的 Branchloom CLI 与 Codex Skill。</span>
      </div>
      <div v-if="available && !loading && status" class="ai-tools__primary">
        <BaseButton
          :disabled="hasConflict"
          @click="openPreview(primaryAction, ['cli', 'skill'])"
        >
          <IconCheck :size="18" aria-hidden="true" />{{ primaryLabel }}
        </BaseButton>
      </div>
    </header>

    <p v-if="successMessage" class="ai-tools__feedback ai-tools__feedback--success" role="status">
      {{ successMessage }}
    </p>
    <p v-if="errorMessage && status" class="ai-tools__feedback ai-tools__feedback--error" role="alert">
      {{ errorMessage }}
    </p>

    <div v-if="!available" class="ai-tools__notice" role="status">
      <span class="ai-tools__notice-icon"><IconRobot :size="24" aria-hidden="true" /></span>
      <div>
        <strong>仅桌面版支持安装</strong>
        <p>浏览器开发模式可以查看此页面，但不会修改本机命令或 Codex Skill。</p>
      </div>
    </div>

    <div v-else-if="loading" class="ai-tools__notice" role="status" aria-busy="true">
      <span class="ai-tools__notice-icon"><IconRobot :size="24" aria-hidden="true" /></span>
      <div>
        <strong>正在检查本机 AI 工具</strong>
        <p>正在核对 CLI、Skill、版本与安装位置…</p>
      </div>
    </div>

    <div v-else-if="errorMessage && !status" class="ai-tools__notice ai-tools__notice--error" role="alert">
      <span class="ai-tools__notice-icon"><IconRobot :size="24" aria-hidden="true" /></span>
      <div>
        <strong>AI 工具状态暂时无法读取</strong>
        <p>{{ errorMessage }}</p>
      </div>
      <BaseButton size="sm" variant="secondary" @click="loadStatus">
        <IconRefresh :size="16" aria-hidden="true" />重新检查
      </BaseButton>
    </div>

    <template v-else-if="status">
      <section class="ai-tools__overview" aria-labelledby="ai-tools-status-title">
        <span :class="['ai-tools__overview-icon', { 'ai-tools__overview-icon--warning': !status.compatible }]">
          <IconCircleCheck v-if="status.compatible" :size="28" aria-hidden="true" />
          <IconShieldCheck v-else :size="28" aria-hidden="true" />
        </span>
        <div class="ai-tools__overview-copy">
          <p>本机状态</p>
          <h2 id="ai-tools-status-title">{{ statusHeading }}</h2>
          <span>{{ statusDescription }}</span>
        </div>
        <StatusBadge :tone="status.compatible ? 'success' : 'warning'">
          {{ status.compatible ? '版本兼容' : '需要设置' }}
        </StatusBadge>
        <dl class="ai-tools__summary">
          <div>
            <dt>桌面版本</dt>
            <dd>{{ status.desktopVersion }}</dd>
          </div>
          <div>
            <dt>CLI 合约</dt>
            <dd>v{{ status.contractVersion }}</dd>
          </div>
          <div>
            <dt>目标平台</dt>
            <dd>{{ status.platform }}</dd>
          </div>
        </dl>
      </section>

      <section class="ai-tools__components" aria-labelledby="ai-tools-components-title">
        <header class="ai-tools__section-heading">
          <div>
            <p>安装组件</p>
            <h2 id="ai-tools-components-title">CLI 与 Skill</h2>
          </div>
          <span>仅管理由 Branchloom 安装的文件</span>
        </header>
        <div class="ai-tools__cards">
          <article v-for="item in components" :key="item.component" class="ai-tools__card">
            <header>
              <span class="ai-tools__card-icon">
                <component
                  :is="item.component === 'cli' ? IconTerminal2 : IconRobot"
                  :size="24"
                  aria-hidden="true"
                />
              </span>
              <div>
                <h2>{{ item.component === 'cli' ? 'Branchloom CLI' : 'Branchloom Skill' }}</h2>
                <p>{{ item.component === 'cli' ? '供终端和 AI 调用的原生命令' : '供 AI Agent 理解并安全调用 CLI' }}</p>
              </div>
              <StatusBadge :tone="badge(item.state).tone">{{ badge(item.state).label }}</StatusBadge>
            </header>

            <dl>
              <div>
                <dt>安装位置</dt>
                <dd>{{ item.path }}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>{{ item.installedVersion ?? '未安装' }} / 安装包 {{ item.bundledVersion }}</dd>
              </div>
            </dl>
            <p class="ai-tools__card-message">{{ item.message }}</p>

            <footer>
              <BaseButton
                size="sm"
                variant="secondary"
                :disabled="item.state === 'conflict'"
                @click="openPreview(item.state === 'notInstalled' ? 'install' : 'repair', [item.component])"
              >
                <IconRefresh :size="16" aria-hidden="true" />
                {{ item.state === 'notInstalled' ? '安装' : '修复' }}
              </BaseButton>
              <BaseButton
                v-if="item.managed"
                size="sm"
                variant="ghost"
                @click="openPreview('uninstall', [item.component])"
              >
                <IconTrash :size="16" aria-hidden="true" />卸载
              </BaseButton>
            </footer>
          </article>
        </div>
      </section>

      <div v-if="hasConflict" class="ai-tools__conflict" role="alert">
        <IconShieldCheck :size="20" aria-hidden="true" />
        <p>请先处理组件卡片中标记的路径冲突。Branchloom 不会覆盖其他工具。</p>
      </div>

      <div v-if="!status.pathAvailable" class="ai-tools__path" role="status">
        <div>
          <strong>终端暂时找不到 branchloom 命令</strong>
          <p>CLI 可以安装，但需要把安装目录加入用户 PATH。</p>
          <code>{{ status.pathInstruction }}</code>
        </div>
        <BaseButton size="sm" variant="secondary" @click="copyPathInstruction">
          <IconCopy :size="16" aria-hidden="true" />复制配置
        </BaseButton>
      </div>
    </template>

    <BaseDialog
      :open="Boolean(preview)"
      :title="preview?.action === 'uninstall' ? '确认卸载 AI 工具' : '确认修改 AI 工具'"
      description="请核对目标位置。确认后只会修改下列 CLI 或 Skill 文件。"
      :show-close="!applying"
      @close="preview = undefined"
    >
      <div v-if="preview" class="ai-tools__preview">
        <ul>
          <li v-for="change in preview.changes" :key="`${change.component}-${change.path}`">
            <strong>{{ change.operation }} {{ change.component === 'cli' ? 'CLI' : 'Skill' }}</strong>
            <code>{{ change.path }}</code>
          </li>
        </ul>
        <p v-for="warning in preview.warnings" :key="warning" class="ai-tools__preview-warning">
          {{ warning }}
        </p>
        <footer>
          <BaseButton variant="secondary" :disabled="applying" @click="preview = undefined">取消</BaseButton>
          <BaseButton
            :variant="preview.action === 'uninstall' ? 'danger' : 'primary'"
            :loading="applying"
            @click="applyPreview"
          >
            {{ preview.action === 'uninstall' ? '确认卸载' : '确认并执行' }}
          </BaseButton>
        </footer>
      </div>
    </BaseDialog>
  </section>
</template>

<style scoped>
.ai-tools {
  display: grid;
  width: min(72rem, 100%);
  gap: var(--space-4);
  align-self: start;
  margin: 0 auto;
}

.ai-tools__heading p,
.ai-tools__heading h1,
.ai-tools__heading span,
.ai-tools__overview p,
.ai-tools__overview h2,
.ai-tools__notice p,
.ai-tools__card p,
.ai-tools__path p,
.ai-tools__conflict p,
.ai-tools__section-heading p,
.ai-tools__section-heading h2 {
  margin: 0;
}

.ai-tools__heading,
.ai-tools__section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
}

.ai-tools__heading {
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.ai-tools__heading p,
.ai-tools__overview-copy > p,
.ai-tools__section-heading p {
  color: var(--color-accent);
  font-size: .7rem;
  font-weight: 750;
  letter-spacing: .12em;
}

.ai-tools__heading h1 {
  margin-top: var(--space-1);
  font-family: var(--font-heading);
  font-size: clamp(1.85rem, 3vw, 2.35rem);
  font-weight: 560;
}

.ai-tools__heading div > span {
  display: block;
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: .8125rem;
}

.ai-tools__notice,
.ai-tools__path,
.ai-tools__overview {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}

.ai-tools__notice {
  display: grid;
  align-items: center;
  gap: var(--space-4);
  min-height: 7rem;
  padding: var(--space-5);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.ai-tools__notice-icon,
.ai-tools__card-icon,
.ai-tools__overview-icon {
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--color-muted-surface);
  color: var(--color-primary);
}

.ai-tools__notice-icon {
  width: 2.75rem;
  height: 2.75rem;
}

.ai-tools__notice div {
  display: grid;
  gap: var(--space-1);
}

.ai-tools__notice--error {
  border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border));
}

.ai-tools__notice--error .ai-tools__notice-icon {
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.ai-tools__notice p,
.ai-tools__path p {
  color: var(--color-muted);
  font-size: .875rem;
}

.ai-tools__overview {
  display: grid;
  align-items: center;
  gap: var(--space-4) var(--space-5);
  padding: var(--space-5);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.ai-tools__overview-icon {
  width: 3rem;
  height: 3rem;
  background: var(--color-success-surface);
  color: var(--color-success);
}

.ai-tools__overview-icon--warning {
  background: var(--color-warning-surface);
  color: var(--color-warning);
}

.ai-tools__overview-copy {
  display: grid;
  gap: var(--space-1);
}

.ai-tools__overview-copy h2 {
  font-family: var(--font-heading);
  font-size: 1.45rem;
  font-weight: 560;
}

.ai-tools__overview-copy > span {
  color: var(--color-muted);
  font-size: .85rem;
}

.ai-tools__summary {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
  grid-column: 1 / -1;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.ai-tools__summary div {
  display: grid;
  gap: var(--space-1);
}

.ai-tools__summary dt,
.ai-tools__card dt {
  color: var(--color-muted);
  font-size: .75rem;
}

.ai-tools__summary dd {
  margin: 0;
  font-size: .875rem;
  font-weight: 700;
}

.ai-tools__components {
  display: grid;
  gap: var(--space-3);
}

.ai-tools__section-heading {
  align-items: end;
}

.ai-tools__section-heading h2 {
  margin-top: var(--space-1);
  font-family: var(--font-heading);
  font-size: 1.35rem;
  font-weight: 560;
}

.ai-tools__section-heading > span {
  color: var(--color-muted);
  font-size: .75rem;
}

.ai-tools__cards {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ai-tools__card {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-card);
  box-shadow: var(--shadow-sm);
}

.ai-tools__card > header {
  display: grid;
  align-items: start;
  gap: var(--space-3);
  grid-template-columns: auto 1fr auto;
}

.ai-tools__card-icon {
  width: 2.5rem;
  height: 2.5rem;
}

.ai-tools__card h2 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1.2rem;
  font-weight: 560;
}

.ai-tools__card header p,
.ai-tools__card-message {
  color: var(--color-muted);
  font-size: .85rem;
}

.ai-tools__card dl {
  display: grid;
  gap: var(--space-3);
  margin: 0;
}

.ai-tools__card dl div {
  display: grid;
  gap: var(--space-1);
}

.ai-tools__card dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .78rem;
}

.ai-tools__card footer,
.ai-tools__preview footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.ai-tools__card footer {
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.ai-tools__path {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5);
}

.ai-tools__path code,
.ai-tools__preview code {
  display: block;
  margin-top: var(--space-2);
  overflow-wrap: anywhere;
  color: var(--color-primary-strong);
  font-size: .78rem;
}

.ai-tools__feedback {
  padding: var(--space-4);
  margin: 0;
  border-radius: var(--radius-sm);
}

.ai-tools__feedback--error {
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.ai-tools__feedback--success {
  background: var(--color-success-surface);
  color: var(--color-success);
}

.ai-tools__conflict {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.ai-tools__preview ul {
  display: grid;
  gap: var(--space-4);
  padding: 0;
  margin: 0 0 var(--space-5);
  list-style: none;
}

.ai-tools__preview-warning {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-warning-surface);
  color: var(--color-warning);
}

.ai-tools__preview footer {
  margin-top: var(--space-6);
}

@media (max-width: 48rem) {
  .ai-tools__cards {
    grid-template-columns: 1fr;
  }

  .ai-tools__heading {
    align-items: stretch;
    flex-direction: column;
  }

  .ai-tools__primary :deep(.base-button) {
    width: 100%;
  }

  .ai-tools__notice,
  .ai-tools__overview {
    align-items: start;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .ai-tools__notice > :deep(.base-button),
  .ai-tools__overview > :deep(.status-badge) {
    grid-column: 2;
  }

  .ai-tools__path {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (max-width: 34rem) {
  .ai-tools__summary {
    grid-template-columns: 1fr;
  }

  .ai-tools__section-heading > span {
    display: none;
  }

  .ai-tools__card > header {
    grid-template-columns: auto 1fr;
  }

  .ai-tools__card > header :deep(.status-badge) {
    grid-column: 2;
  }
}
</style>
