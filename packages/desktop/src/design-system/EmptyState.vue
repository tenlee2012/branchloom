<script setup lang="ts">
import { useId } from 'vue'

defineProps<{
  title: string
  description?: string
}>()

const titleId = `${useId()}-empty-state-title`
</script>

<template>
  <section class="empty-state" :aria-labelledby="titleId">
    <div v-if="$slots.default" class="empty-state__illustration" aria-hidden="true">
      <slot />
    </div>
    <h2 :id="titleId" class="empty-state__title">{{ title }}</h2>
    <p v-if="description" class="empty-state__description">{{ description }}</p>
    <div v-if="$slots.actions" class="empty-state__actions">
      <slot name="actions" />
    </div>
  </section>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  max-width: 32rem;
  padding: var(--space-8);
  margin: auto;
  text-align: center;
}

.empty-state__illustration {
  margin-bottom: var(--space-4);
  color: var(--color-primary);
}

.empty-state__title {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1.5rem;
}

.empty-state__description {
  margin: var(--space-3) 0 0;
  color: var(--color-muted);
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-3);
  margin-top: var(--space-6);
}
</style>
