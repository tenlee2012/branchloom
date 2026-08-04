<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
  },
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

function handleClick(event: MouseEvent) {
  if (props.disabled || props.loading) return
  emit('click', event)
}
</script>

<template>
  <button
    :class="['base-button', `base-button--${variant}`, `base-button--${size}`]"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="handleClick"
  >
    <span v-if="loading" class="base-button__spinner" aria-hidden="true" />
    <span class="base-button__content"><slot /></span>
  </button>
</template>

<style scoped>
.base-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-weight: 650;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

.base-button:hover:not(:disabled) {
  transform: translateY(-1px);
}

.base-button:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.base-button--sm {
  min-height: 2rem;
  padding: var(--space-2) var(--space-3);
  font-size: 0.8125rem;
}

.base-button--md {
  min-height: 2.5rem;
  padding: var(--space-3) var(--space-4);
  font-size: 0.9375rem;
}

.base-button--lg {
  min-height: 3rem;
  padding: var(--space-4) var(--space-6);
  font-size: 1rem;
}

.base-button--primary {
  background: var(--color-primary);
  color: var(--color-surface);
}

.base-button--secondary {
  border-color: var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.base-button--ghost {
  background: transparent;
  color: var(--color-primary);
}

.base-button--danger {
  background: var(--color-danger);
  color: var(--color-surface);
}

.base-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: inherit;
}

.base-button__spinner {
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: base-button-spin 700ms linear infinite;
}

@keyframes base-button-spin {
  to {
    transform: rotate(1turn);
  }
}
</style>
