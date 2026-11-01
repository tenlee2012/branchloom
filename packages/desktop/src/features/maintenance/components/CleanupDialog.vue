<script setup lang="ts">
import { localizeSystemMessage, t } from '../../../shared/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import type { Attachment, CleanupImpact, CleanupResult, Source } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  advanceLongTask,
  canCancelLongTask,
  cancelLongTask,
  completeLongTask,
  createLongTaskState,
  failLongTask,
  startLongTask,
} from '../model/longTasks'

const props = defineProps<{ open: boolean; projectId: string }>()
const emit = defineEmits<{ close: []; completed: [result: CleanupResult] }>()
const repository = useBranchloomRepository()
const impact = ref<CleanupImpact>()
const attachments = ref<Attachment[]>([])
const sources = ref<Source[]>([])
const removeAttachments = ref(true)
const selectedSourceIds = ref<string[]>([])
const rebuildSearchIndex = ref(true)
const impactState = ref<'loading' | 'ready' | 'failed'>('loading')
const task = ref(createLongTaskState())
const errorMessage = ref('')
const locked = computed(() => task.value.stage === 'committing')
const cancellable = computed(() => canCancelLongTask(task.value))
let active = true
let loadRequest = 0

async function load(scopedProjectId = props.projectId) {
  const request = ++loadRequest
  impactState.value = 'loading'
  errorMessage.value = ''
  impact.value = undefined
  attachments.value = []
  sources.value = []
  task.value = createLongTaskState()
  try {
    const [nextImpact, nextAttachments, nextSources] = await Promise.all([
      repository.getCleanupImpact(scopedProjectId),
      repository.listAttachments(scopedProjectId),
      repository.listSources(scopedProjectId),
    ])
    if (!active || request !== loadRequest || scopedProjectId !== props.projectId || !props.open) return
    impact.value = nextImpact
    attachments.value = nextAttachments.filter(({ id }) => nextImpact.unusedAttachmentIds.includes(id))
    sources.value = nextSources.filter(({ id }) => nextImpact.unusedSourceIds.includes(id))
    selectedSourceIds.value = [...nextImpact.unusedSourceIds]
    impactState.value = 'ready'
  } catch (error) {
    if (!active || request !== loadRequest || scopedProjectId !== props.projectId || !props.open) return
    errorMessage.value = error instanceof Error && localizeSystemMessage(error.message) ? localizeSystemMessage(error.message) : t('无法计算清理影响范围')
    impactState.value = 'failed'
  }
}

watch(() => [props.open, props.projectId] as const, ([open, nextProjectId]) => {
  if (!open) {
    loadRequest += 1
    return
  }
  if (locked.value) return
  void load(nextProjectId)
}, { immediate: true })

function close() { if (!locked.value) emit('close') }

function startCleanup() {
  if (impactState.value !== 'ready') return
  task.value = startLongTask(task.value)
}

function cancelCleanup() { task.value = cancelLongTask(task.value) }

async function continueCleanup() {
  if (task.value.stage !== 'processing') return
  task.value = advanceLongTask(task.value)
  if (task.value.stage !== 'committing') return
  const scopedProjectId = props.projectId
  const input = {
    removeUnusedAttachments: removeAttachments.value,
    removeSourceIds: [...selectedSourceIds.value],
    rebuildSearchIndex: rebuildSearchIndex.value,
  }
  errorMessage.value = ''
  try {
    const result = await repository.cleanupProject(scopedProjectId, input)
    if (!active) return
    if (!props.open) {
      task.value = createLongTaskState()
      return
    }
    if (props.projectId !== scopedProjectId) {
      await load(props.projectId)
      return
    }
    task.value = completeLongTask(task.value, [
      t('移除附件 {0} 个', [result.removedAttachments]), t('移除来源 {0} 个', [result.removedSources]), t('重新检查完成'),
    ])
    emit('completed', result)
  } catch (error) {
    if (!active) return
    if (!props.open) {
      task.value = createLongTaskState()
      return
    }
    if (props.projectId !== scopedProjectId) {
      await load(props.projectId)
      return
    }
    errorMessage.value = error instanceof Error && localizeSystemMessage(error.message) ? localizeSystemMessage(error.message) : t('清理失败，项目资料保持不变')
    task.value = failLongTask(task.value, errorMessage.value)
  }
}

function retryCleanup() { task.value = startLongTask(createLongTaskState()) }

onBeforeUnmount(() => {
  active = false
  loadRequest += 1
})
</script>

<template>
  <BaseDialog :open="open" :title="t('清理项目')" :description="t('危险操作 · 将在写入前创建快照')" @close="close">
    <div class="cleanup-dialog">
      <p class="cleanup-dialog__snapshot">{{ t('确认后会先自动创建快照，再作为一个事务清理所选资料。') }}</p>
      <p v-if="impactState === 'loading'" role="status">{{ t('正在计算影响范围…') }}</p>
      <div v-else-if="impact" class="cleanup-dialog__choices">
        <label><input v-model="removeAttachments" type="checkbox"> {{ t('清理未引用附件（{0} 个，{1} 字节）', [impact.unusedAttachmentIds.length, impact.unusedAttachmentBytes]) }}</label>
        <ul v-if="attachments.length"><li v-for="item in attachments" :key="item.id">{{ item.name }}</li></ul>
        <fieldset><legend>{{ t('已确认不需要的来源') }}</legend><label v-for="item in sources" :key="item.id"><input v-model="selectedSourceIds" type="checkbox" :value="item.id"> {{ item.title }}</label><span v-if="sources.length === 0">{{ t('没有未引用来源') }}</span></fieldset>
        <label><input v-model="rebuildSearchIndex" type="checkbox"> {{ t('重建搜索索引并重新执行完整性检查') }}</label>
      </div>
      <div v-if="task.stage !== 'idle'" class="cleanup-dialog__progress">
        <progress :value="task.progress" max="100" role="progressbar" :aria-valuenow="task.progress">{{ task.progress }}%</progress>
        <span>{{ task.phase }} · {{ task.stage === 'committing' ? t('正在写入，当前阶段不可安全取消。') : task.stage === 'cancelled' ? t('已安全取消，项目未修改。') : task.stage === 'complete' ? t('清理完成，已重新检查项目。') : t('当前阶段可以安全取消。') }}</span>
        <ul v-if="task.report.length"><li v-for="line in task.report" :key="line">{{ line }}</li></ul>
      </div>
      <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
      <footer>
        <BaseButton :name="t('取消清理')" variant="secondary" :disabled="!cancellable || task.stage === 'idle'" @click="cancelCleanup">{{ t('取消清理') }}</BaseButton>
        <BaseButton v-if="task.stage === 'idle' || task.stage === 'cancelled'" :name="t('开始清理')" variant="danger" :disabled="impactState !== 'ready'" @click="startCleanup">{{ t('开始清理') }}</BaseButton>
        <BaseButton v-if="task.stage === 'processing'" :name="t('继续清理')" variant="danger" @click="continueCleanup">{{ t('继续') }}</BaseButton>
        <BaseButton v-if="task.stage === 'failed'" :name="t('重试清理')" variant="danger" @click="retryCleanup">{{ t('重试清理') }}</BaseButton>
        <BaseButton v-if="task.stage === 'complete'" @click="close">{{ t('完成') }}</BaseButton>
      </footer>
    </div>
  </BaseDialog>
</template>

<style scoped>
.cleanup-dialog { display: grid; gap: var(--space-4); }
.cleanup-dialog__snapshot { padding: var(--space-3); margin: 0; border-radius: var(--radius-sm); background: var(--color-warning-surface); color: var(--color-warning); }
.cleanup-dialog__choices, fieldset { display: grid; gap: var(--space-3); }
.cleanup-dialog ul { margin: 0; color: var(--color-muted); }
.cleanup-dialog fieldset { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.cleanup-dialog__progress { display: grid; gap: var(--space-2); color: var(--color-muted); }
.cleanup-dialog progress { width: 100%; accent-color: var(--color-primary); }
.cleanup-dialog [role='alert'] { color: var(--color-danger); }
.cleanup-dialog footer { display: flex; justify-content: flex-end; gap: var(--space-3); }
</style>
