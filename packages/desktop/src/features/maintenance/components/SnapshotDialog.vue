<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import type { Snapshot } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'

const props = defineProps<{ open: boolean; projectId: string }>()
const emit = defineEmits<{ close: []; created: [snapshot: Snapshot] }>()
const repository = useBranchloomRepository()
const note = ref('')
const busy = ref(false)
const errorMessage = ref('')
const noteError = ref('')

watch(() => props.open, (open) => { if (open) { note.value = ''; noteError.value = ''; errorMessage.value = '' } })

async function create() {
  if (busy.value) return
  if (!note.value.trim()) { noteError.value = '请填写快照名称或备注'; return }
  noteError.value = ''
  busy.value = true; errorMessage.value = ''
  try {
    const snapshot = await repository.createSnapshot(props.projectId, 'manual', note.value)
    emit('created', snapshot)
    emit('close')
  } catch (error) {
    errorMessage.value = error instanceof Error && error.message ? error.message : '手动快照创建失败'
  } finally { busy.value = false }
}
</script>

<template>
  <BaseDialog :open="open" title="创建手动快照" description="保存当前项目状态，方便之后恢复。" @close="!busy && emit('close')">
    <form class="snapshot-dialog" novalidate @submit.prevent="create">
      <BaseField id="snapshot-note" label="名称或备注" hint="可记录研究节点、资料来源或操作目的。" :error="noteError" required>
        <template #default="field"><textarea id="snapshot-note" v-model="note" rows="4" v-bind="field" /></template>
      </BaseField>
      <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
      <footer><BaseButton variant="secondary" :disabled="busy" @click="emit('close')">取消</BaseButton><BaseButton name="创建手动快照" type="submit" :loading="busy">创建手动快照</BaseButton></footer>
    </form>
  </BaseDialog>
</template>

<style scoped>
.snapshot-dialog { display: grid; gap: var(--space-4); }
.snapshot-dialog textarea { box-sizing: border-box; width: 100%; padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font: inherit; }
.snapshot-dialog textarea:focus { border-color: var(--color-focus); outline: 0; box-shadow: var(--focus-ring); }
.snapshot-dialog [role='alert'] { color: var(--color-danger); }
.snapshot-dialog footer { display: flex; justify-content: flex-end; gap: var(--space-3); }
</style>
