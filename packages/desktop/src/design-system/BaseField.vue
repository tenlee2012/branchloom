<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    id: string
    label: string
    hint?: string
    error?: string
    required?: boolean
  }>(),
  { required: false },
)

defineSlots<{
  default(props: {
    describedBy: string | undefined
    invalid: boolean
    required: boolean
  }): unknown
  'label-action'?(): unknown
}>()

const describedBy = computed(() => {
  const ids = []
  if (props.hint) ids.push(`${props.id}-hint`)
  if (props.error) ids.push(`${props.id}-error`)
  return ids.length > 0 ? ids.join(' ') : undefined
})
</script>

<template>
  <div class="base-field" :class="{ 'base-field--invalid': Boolean(error) }">
    <div class="base-field__label-row">
      <label class="base-field__label" :for="id">
        {{ label }}
        <span v-if="required" aria-hidden="true" class="base-field__required">*</span>
      </label>
      <slot name="label-action" />
    </div>
    <slot :described-by="describedBy" :invalid="Boolean(error)" :required="required" />
    <p v-if="hint" :id="`${id}-hint`" class="base-field__hint">{{ hint }}</p>
    <p v-if="error" :id="`${id}-error`" class="base-field__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.base-field {
  display: grid;
  gap: var(--space-2);
}

.base-field__label-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: fit-content;
}

.base-field__label {
  width: fit-content;
  color: var(--color-text);
  font-weight: 650;
}

.base-field__required,
.base-field__error {
  color: var(--color-danger);
}

.base-field__hint,
.base-field__error {
  margin: 0;
  font-size: 0.8125rem;
}

.base-field__hint {
  color: var(--color-muted);
}
</style>
