<script setup lang="ts">
import { ref, toRef, useId } from 'vue'
import { useModalOverlay } from './useModalOverlay'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    closeLabel?: string
    showClose?: boolean
  }>(),
  { closeLabel: '关闭', showClose: true },
)

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement | null>(null)
const backdrop = ref<HTMLElement | null>(null)
const uid = useId()
const titleId = `${uid}-dialog-title`
const descriptionId = `${uid}-dialog-description`
useModalOverlay({
  open: toRef(props, 'open'),
  surface: dialog,
  backdrop,
  onClose: () => emit('close'),
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="backdrop"
      class="base-dialog__backdrop"
      @click.self="emit('close')"
    >
      <div
        ref="dialog"
        class="base-dialog__surface"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
        @click.stop
      >
        <header class="base-dialog__header">
          <div>
            <h2 :id="titleId" class="base-dialog__title">{{ title }}</h2>
            <p v-if="description" :id="descriptionId" class="base-dialog__description">
              {{ description }}
            </p>
          </div>
          <button
            v-if="showClose"
            class="base-dialog__close"
            type="button"
            :aria-label="closeLabel"
            @click="emit('close')"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div class="base-dialog__body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.base-dialog__backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: var(--color-overlay);
}

.base-dialog__surface {
  place-self: center;
  width: min(34rem, 100%);
  margin: auto;
  max-height: calc(100vh - var(--space-8));
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.base-dialog__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-6);
  border-bottom: 1px solid var(--color-border);
}

.base-dialog__title {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1.375rem;
  line-height: 1.25;
}

.base-dialog__description {
  margin: var(--space-2) 0 0;
  color: var(--color-muted);
}

.base-dialog__close {
  display: grid;
  flex: 0 0 auto;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-muted);
  font-size: 1.5rem;
  cursor: pointer;
}

.base-dialog__close:hover {
  background: var(--color-muted-surface);
  color: var(--color-text);
}

.base-dialog__body {
  padding: var(--space-6);
}
</style>
