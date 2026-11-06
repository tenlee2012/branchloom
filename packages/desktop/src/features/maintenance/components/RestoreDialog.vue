<script setup lang="ts">
import { getLocale, localizeSystemMessage, t } from '../../../shared/i18n'
import { ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import type { RestoreResult, Snapshot } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  advanceLongTask,
  cancelLongTask,
  completeLongTask,
  createLongTaskState,
  failLongTask,
  startLongTask,
} from '../model/longTasks'

const props = defineProps<{ open: boolean; snapshot: Snapshot }>()
const emit = defineEmits<{ close: []; restored: [result: RestoreResult] }>()
const repository = useBranchloomRepository()
const task = ref(createLongTaskState())
const errorMessage = ref('')

watch(() => [props.open, props.snapshot.id] as const, ([open]) => {
  if (open) { task.value = createLongTaskState(); errorMessage.value = '' }
})

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? t('时间记录无效') : new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function close() { if (task.value.stage !== 'committing') emit('close') }

function startRestore() { task.value = startLongTask(task.value) }
function cancelRestore() {
  if (task.value.stage === 'idle' || task.value.stage === 'cancelled' || task.value.stage === 'failed') {
    close()
    return
  }
  task.value = cancelLongTask(task.value)
}

async function continueRestore() {
  if (task.value.stage !== 'processing') return
  task.value = advanceLongTask(task.value)
  if (task.value.stage !== 'committing') return
  errorMessage.value = ''
  try {
    const result = await repository.restoreSnapshot(props.snapshot.id)
    task.value = completeLongTask(task.value, [t('恢复前快照已建立'), t('恢复后发现 {0} 个检查项', [result.issues.length])])
    emit('restored', result)
  } catch (error) {
    errorMessage.value = error instanceof Error && localizeSystemMessage(error.message) ? localizeSystemMessage(error.message) : t('恢复失败，当前项目保持可用')
    task.value = failLongTask(task.value, errorMessage.value)
  }
}
function retryRestore() { task.value = startLongTask(createLongTaskState()) }
</script>

<template>
  <BaseDialog
    :open="open"
    :title="t('恢复历史版本')"
    :description="t('恢复任务 · 写入前可安全取消')"
    :show-close="false"
    @close="close"
  >
    <div class="restore-dialog">
      <p class="restore-dialog__guard">{{ t('恢复前自动创建当前状态快照；恢复失败时当前项目与快照资料都不会被替换。') }}</p>
      <dl><div><dt>{{ t('版本时间') }}</dt><dd>{{ formatDate(snapshot.createdAt) }}</dd></div><div><dt>{{ t('原因与备注') }}</dt><dd>{{ snapshot.reason }} · {{ snapshot.note || t('无备注') }}</dd></div><div><dt>{{ t('数据规模') }}</dt><dd>{{ t('人物 {0} · 关系 {1} · 事件 {2}', [snapshot.summary.people, snapshot.summary.relationships, snapshot.summary.events]) }}</dd></div></dl>
      <div v-if="task.stage !== 'idle'" class="restore-dialog__progress"><progress :value="task.progress" max="100" role="progressbar" :aria-valuenow="task.progress">{{ task.progress }}%</progress><span>{{ task.phase }} · {{ task.stage === 'committing' ? t('正在原子恢复，当前阶段不可安全取消。') : task.stage === 'complete' ? t('恢复完成，已重新执行项目检查。') : task.stage === 'cancelled' ? t('已安全取消，当前项目未修改。') : t('当前阶段可以安全取消。') }}</span><ul v-if="task.report.length"><li v-for="line in task.report" :key="line">{{ line }}</li></ul></div>
      <p v-if="errorMessage" role="alert">{{ t('{0}；当前状态保持不变。', [errorMessage]) }}</p>
      <footer>
        <BaseButton
          v-if="task.stage !== 'complete'"
          :name="t('取消恢复')"
          variant="secondary"
          :disabled="task.stage === 'committing'"
          @click="cancelRestore"
        > {{ t('取消恢复') }} </BaseButton>
        <BaseButton v-if="task.stage === 'idle' || task.stage === 'cancelled'" :name="t('确认恢复')" variant="danger" @click="startRestore">{{ t('确认恢复') }}</BaseButton>
        <BaseButton v-if="task.stage === 'processing'" :name="t('继续恢复')" variant="danger" @click="continueRestore">{{ t('继续') }}</BaseButton>
        <BaseButton v-if="task.stage === 'failed'" :name="t('重试恢复')" variant="danger" @click="retryRestore">{{ t('重试恢复') }}</BaseButton>
        <BaseButton v-if="task.stage === 'complete'" @click="close">{{ t('完成') }}</BaseButton>
      </footer>
    </div>
  </BaseDialog>
</template>

<style scoped>
.restore-dialog { display: grid; gap: var(--space-4); }
.restore-dialog__guard { padding: var(--space-3); margin: 0; border-radius: var(--radius-sm); background: var(--color-warning-surface); color: var(--color-warning); }
.restore-dialog dl, .restore-dialog dl div { display: grid; gap: var(--space-2); }
.restore-dialog dl { margin: 0; }
.restore-dialog dl div { grid-template-columns: 6rem 1fr; padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border); }
.restore-dialog dt { color: var(--color-muted); }.restore-dialog dd { margin: 0; }
.restore-dialog__progress { display: grid; gap: var(--space-2); color: var(--color-muted); }.restore-dialog progress { width: 100%; accent-color: var(--color-primary); }
.restore-dialog [role='alert'] { color: var(--color-danger); }
.restore-dialog footer { display: flex; justify-content: flex-end; gap: var(--space-3); }
</style>
