<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseField from '../../../design-system/BaseField.vue'

withDefaults(
  defineProps<{
    saving?: boolean
    submitError?: string
  }>(),
  { saving: false },
)

const emit = defineEmits<{
  submit: [input: { name: string; description: string }]
}>()

const name = ref('')
const description = ref('')
const attempted = ref(false)
const nameError = computed(() =>
  attempted.value && !name.value.trim() ? '请输入项目名称。' : '',
)

function submit() {
  attempted.value = true
  if (nameError.value) return
  emit('submit', {
    name: name.value.trim(),
    description: description.value.trim(),
  })
}
</script>

<template>
  <form class="new-project-form" novalidate @submit.prevent="submit">
    <BaseField
      id="new-project-name"
      label="项目名称"
      hint="例如：林氏家庭档案、外婆家的故事"
      :error="nameError"
      required
    >
      <template #default="{ describedBy, invalid, required }">
        <input
          id="new-project-name"
          v-model="name"
          class="new-project-form__control"
          name="name"
          type="text"
          autocomplete="off"
          autofocus
          :aria-describedby="describedBy"
          :aria-invalid="invalid ? 'true' : undefined"
          :aria-required="required ? 'true' : undefined"
        />
      </template>
    </BaseField>

    <BaseField
      id="new-project-description"
      label="项目简介（可选）"
      hint="写下一句整理目标，之后可以在项目设置中修改。"
    >
      <template #default="{ describedBy }">
        <textarea
          id="new-project-description"
          v-model="description"
          class="new-project-form__control new-project-form__textarea"
          name="description"
          rows="4"
          :aria-describedby="describedBy"
        />
      </template>
    </BaseField>

    <p v-if="submitError" class="new-project-form__submit-error" role="alert">
      {{ submitError }}
    </p>

    <div class="new-project-form__actions">
      <BaseButton type="submit" size="lg" :loading="saving">
        {{ saving ? '正在建立…' : '建立家谱' }}
      </BaseButton>
    </div>
  </form>
</template>

<style scoped>
.new-project-form {
  display: grid;
  gap: var(--space-6);
}

.new-project-form__control {
  width: 100%;
  min-height: 2.75rem;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: rgb(255 255 255 / 72%);
}

.new-project-form__control[aria-invalid='true'] {
  border-color: var(--color-danger);
}

.new-project-form__textarea {
  min-height: 7rem;
  resize: vertical;
}

.new-project-form__submit-error {
  padding: var(--space-3) var(--space-4);
  margin: 0;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.new-project-form__actions {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 34rem) {
  .new-project-form__actions :deep(button) {
    width: 100%;
  }
}
</style>
