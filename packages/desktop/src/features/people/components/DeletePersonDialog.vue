<script setup lang="ts">
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
    :title="`删除${personName}？`"
    description="人物会被移入已删除记录，相关资料不会自动删除。"
    close-label="取消删除人物"
    @close="emit('close')"
  >
    <div class="delete-person-dialog">
      <p v-if="loading" role="status">正在统计受影响的资料…</p>
      <template v-else-if="impact">
        <p>删除前请确认以下关联资料：</p>
        <ul aria-label="删除影响统计">
          <li>关系 {{ impact.relationships }} 条</li>
          <li>事件 {{ impact.events }} 条</li>
          <li>引用 {{ impact.citations }} 条</li>
        </ul>
      </template>
      <p v-else role="alert">暂时无法确认删除影响，请取消后重试。</p>
      <p v-if="error" class="delete-person-dialog__error" role="alert">删除失败：{{ error }}</p>
      <div class="delete-person-dialog__actions">
        <BaseButton variant="secondary" :disabled="deleting" @click="emit('close')">取消</BaseButton>
        <BaseButton
          name="确认删除"
          variant="danger"
          :disabled="loading || !impact"
          :loading="deleting"
          @click="emit('confirm')"
        >确认删除</BaseButton>
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
