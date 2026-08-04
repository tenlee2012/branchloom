<script setup lang="ts">
import { IconAlertTriangle, IconTrash } from '@tabler/icons-vue'
import { ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import type { Project } from '../../../shared/domain/types'

const props = defineProps<{
  project: Project
  busy: boolean
  failure?: string | undefined
}>()
const emit = defineEmits<{ deleteConfirmed: [] }>()
const deleteOpen = ref(false)
const deleteConfirmation = ref('')

function openDelete() {
  deleteConfirmation.value = ''
  deleteOpen.value = true
}

function closeDialogs() {
  if (props.busy) return
  deleteOpen.value = false
  deleteConfirmation.value = ''
}

watch(() => props.project.id, closeDialogs)
</script>

<template>
  <section class="danger-zone" aria-labelledby="danger-zone-title">
    <header>
      <div class="danger-zone__heading">
        <span class="danger-zone__heading-icon" aria-hidden="true">
          <IconAlertTriangle :size="18" />
        </span>
        <div><p>高风险操作</p><h2 id="danger-zone-title">危险区域</h2></div>
      </div>
      <span class="danger-zone__guard">需要逐字确认</span>
    </header>
    <article>
      <div class="danger-zone__copy">
        <h3>删除当前项目</h3>
        <p>删除当前项目中的人物、关系、事件、来源和附件记录。此操作无法撤销。</p>
      </div>
      <BaseButton name="删除当前项目" variant="danger" @click="openDelete">
        <IconTrash :size="18" aria-hidden="true" />
        删除当前项目
      </BaseButton>
    </article>
  </section>

  <BaseDialog
    :open="deleteOpen"
    title="删除当前项目？"
    description="项目中的人物、关系、事件、来源和附件记录将被永久删除。"
    close-label="取消删除项目"
    @close="closeDialogs"
  >
    <div class="danger-zone__dialog">
      <label>
        <span>输入项目名称“{{ project.name }}”以确认</span>
        <input v-model="deleteConfirmation" name="deleteProjectConfirmation" autocomplete="off" />
      </label>
      <p v-if="failure" role="alert">{{ failure }}</p>
      <div class="danger-zone__actions">
        <BaseButton variant="secondary" :disabled="busy" @click="closeDialogs">取消</BaseButton>
        <BaseButton
          name="确认删除当前项目"
          variant="danger"
          :loading="busy"
          :disabled="deleteConfirmation !== project.name || busy"
          @click="emit('deleteConfirmed')"
        >确认删除</BaseButton>
      </div>
    </div>
  </BaseDialog>

</template>

<style scoped>
.danger-zone {
  display: grid;
  gap: var(--space-4);
  padding: clamp(1.25rem, 3vw, 1.75rem);
  border: 1px solid color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.danger-zone > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid color-mix(in srgb, var(--color-danger) 20%, var(--color-border));
}

.danger-zone__heading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.danger-zone__heading-icon {
  display: inline-flex;
  width: 2.25rem;
  height: 2.25rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.danger-zone > header p,
.danger-zone h2,
.danger-zone h3,
.danger-zone article p {
  margin: 0;
}

.danger-zone > header p {
  color: var(--color-danger);
  font-size: .7rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.danger-zone h2 {
  margin-top: .1rem;
  font-family: var(--font-heading);
  font-size: 1.35rem;
  line-height: 1.3;
}

.danger-zone__guard {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-2);
  border-radius: 999px;
  background: var(--color-danger-surface);
  color: var(--color-danger);
  font-size: .72rem;
  font-weight: 700;
}

.danger-zone article {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-5);
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--color-danger) 16%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-danger-surface) 28%, var(--color-surface));
}

.danger-zone__copy {
  min-width: 0;
}

.danger-zone h3 {
  font-size: .95rem;
}

.danger-zone article p {
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: .8125rem;
  line-height: 1.55;
}

.danger-zone__dialog, .danger-zone__dialog label { display: grid; gap: var(--space-3); }
.danger-zone__dialog label span { font-weight: 650; }
.danger-zone__dialog input { min-height: 2.75rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); }
.danger-zone__dialog input:focus-visible { border-color: var(--color-primary); outline: none; box-shadow: var(--focus-ring); }
.danger-zone__dialog [role="alert"] { margin: 0; padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.danger-zone__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }

@media (max-width: 38rem) {
  .danger-zone > header {
    align-items: flex-start;
    flex-direction: column;
  }

  .danger-zone article {
    align-items: stretch;
    grid-template-columns: 1fr;
  }

  .danger-zone article :deep(.base-button) {
    width: 100%;
  }
}
</style>
