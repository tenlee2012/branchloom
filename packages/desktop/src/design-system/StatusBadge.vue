<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  }>(),
  { tone: 'neutral' },
)
</script>

<template>
  <span :class="['status-badge', `status-badge--${tone}`]"><slot /></span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 1.5rem;
  padding: var(--space-1) var(--space-2);
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1;
}

.status-badge--neutral {
  background: var(--color-muted-surface);
  color: var(--color-muted);
}

.status-badge--success {
  background: var(--color-success-surface);
  color: var(--color-success);
}

.status-badge--warning {
  background: var(--color-warning-surface);
  color: var(--color-warning);
}

.status-badge--danger {
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.status-badge--info {
  background: var(--color-info-surface);
  color: var(--color-info);
}
</style>
