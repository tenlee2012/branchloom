<script setup lang="ts">
import { t } from '../../../shared/i18n'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'

defineProps<{
  open: boolean
  personName: string
  impact: { relationships: number; events: number; citations: number } | null
  loading?: boolean
  deleting?: boolean
  error?: string
}>()

const emit = defineEmits<{ close: []; confirm: [] }>()
</script>

<template>
  <BaseDialog
    :open="open"
    :title="t('删除{0}？', [personName])"
    :description="t('人物将被永久删除。请先核对下方列出的关联资料影响，此操作无法撤销。')"
    :close-label="t('取消删除人物')"
    @close="emit('close')"
  >
    <div class="delete-person-dialog">
      <p v-if="loading" role="status">{{ t('正在统计受影响的资料…') }}</p>
      <template v-else-if="impact">
        <p>{{ t('删除前请确认以下关联资料：') }}</p>
        <ul :aria-label="t('删除影响统计')">
          <li>{{ t('关系 {0} 条', [impact.relationships]) }}</li>
          <li>{{ t('事件 {0} 条', [impact.events]) }}</li>
          <li>{{ t('引用 {0} 条', [impact.citations]) }}</li>
        </ul>
      </template>
      <p v-else role="alert">{{ t('暂时无法确认删除影响，请取消后重试。') }}</p>
      <p v-if="error" class="delete-person-dialog__error" role="alert">{{ t('删除失败：{0}', [error]) }}</p>
      <div class="delete-person-dialog__actions">
        <BaseButton variant="secondary" :disabled="deleting" @click="emit('close')">{{ t('取消') }}</BaseButton>
        <BaseButton
          :name="t('确认删除')"
          variant="danger"
          :disabled="loading || !impact"
          :loading="deleting"
          @click="emit('confirm')"
        >{{ t('确认删除') }}</BaseButton>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.delete-person-dialog { display: grid; gap: var(--space-4); }
.delete-person-dialog p { margin: 0; }
.delete-person-dialog ul { display: grid; gap: var(--space-2); margin: 0; padding: var(--space-4); list-style-position: inside; border-radius: var(--radius-sm); background: var(--color-muted-surface); }
.delete-person-dialog__error { color: var(--color-danger); }
.delete-person-dialog__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
</style>
