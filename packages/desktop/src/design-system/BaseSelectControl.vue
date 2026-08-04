<script setup lang="ts">
import { IconChevronDown } from '@tabler/icons-vue'
</script>

<template>
  <span class="base-select-control">
    <slot />
    <IconChevronDown :size="17" :stroke-width="1.8" aria-hidden="true" />
  </span>
</template>

<style scoped>
.base-select-control {
  position: relative;
  display: block;
  min-width: 0;
}

.base-select-control :deep(select) {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 2.5rem;
  padding: var(--space-2) 2.5rem var(--space-2) var(--space-3);
  appearance: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  cursor: pointer;
  line-height: 1.2;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.base-select-control :deep(select:hover:not(:disabled)) {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
}

.base-select-control :deep(select:focus-visible) {
  border-color: var(--color-primary);
  outline: none;
  box-shadow: var(--focus-ring);
}

.base-select-control :deep(select:disabled) {
  cursor: not-allowed;
  opacity: .6;
}

.base-select-control > svg {
  position: absolute;
  top: 50%;
  right: .8rem;
  color: var(--color-muted);
  pointer-events: none;
  transform: translateY(-50%);
}

.base-select-control:has(select:disabled) > svg {
  opacity: .55;
}
</style>
