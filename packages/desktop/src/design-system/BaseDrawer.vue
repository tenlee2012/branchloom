<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useModalOverlay } from './useModalOverlay'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    closeLabel?: string
    inline?: boolean
  }>(),
  { closeLabel: '关闭', inline: false },
)

const emit = defineEmits<{ close: [] }>()
const drawer = ref<HTMLElement | null>(null)
const backdrop = ref<HTMLElement | null>(null)
const uid = useId()
const titleId = `${uid}-drawer-title`
const descriptionId = `${uid}-drawer-description`
useModalOverlay({
  open: computed(() => props.open && !props.inline),
  surface: drawer,
  backdrop,
  onClose: () => emit('close'),
})
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div
      v-if="open"
      ref="backdrop"
      :class="['base-drawer__backdrop', { 'base-drawer__backdrop--inline': inline }]"
      @click.self="emit('close')"
    >
      <aside
        ref="drawer"
        :class="['base-drawer__surface', { 'base-drawer__surface--inline': inline }]"
        :role="inline ? 'region' : 'dialog'"
        :aria-modal="inline ? undefined : 'true'"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
        @click.stop
      >
        <header class="base-drawer__header">
          <div>
            <h2 :id="titleId" class="base-drawer__title">{{ title }}</h2>
            <p v-if="description" :id="descriptionId" class="base-drawer__description">
              {{ description }}
            </p>
          </div>
          <button
            class="base-drawer__close"
            type="button"
            :aria-label="closeLabel"
            @click="emit('close')"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div class="base-drawer__body"><slot /></div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.base-drawer__backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background: var(--color-overlay);
}

.base-drawer__surface {
  width: min(30rem, 100%);
  height: 100%;
  overflow: auto;
  border-left: 1px solid var(--color-border);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.base-drawer__backdrop--inline {
  position: static;
  z-index: auto;
  display: block;
  min-width: 0;
  min-height: 0;
  background: transparent;
}

.base-drawer__surface--inline {
  width: 100%;
  height: 100%;
  border-left: 0;
  box-shadow: none;
}

.base-drawer__header {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-6);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.base-drawer__title {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1.375rem;
  line-height: 1.25;
}

.base-drawer__description {
  margin: var(--space-2) 0 0;
  color: var(--color-muted);
}

.base-drawer__close {
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

.base-drawer__close:hover {
  background: var(--color-muted-surface);
  color: var(--color-text);
}

.base-drawer__body {
  padding: var(--space-6);
}
</style>
