<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconRefresh } from '@tabler/icons-vue'
import BaseButton from '../../design-system/BaseButton.vue'
import { useBranchloomRepository } from '../../shared/repository/injection'
import { requestNativeRepositoryRefresh } from '../../shared/repository/TauriRepository'

defineProps<{ compactOnMobile?: boolean }>()

const repository = useBranchloomRepository()
const refreshing = ref(false)
const refreshError = ref('')
const refreshLabel = computed(() => refreshing.value ? '刷新中…' : '刷新资料')

async function refreshData() {
  if (refreshing.value) return
  refreshing.value = true
  refreshError.value = ''
  try {
    await requestNativeRepositoryRefresh(repository)
  } catch (error) {
    refreshError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '资料刷新失败'
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <div :class="['data-refresh', { 'data-refresh--compact': compactOnMobile }]">
    <small v-if="refreshError" class="data-refresh__error" role="alert">
      {{ refreshError }}
    </small>
    <BaseButton
      class="data-refresh__button"
      name="刷新资料"
      size="sm"
      variant="secondary"
      :aria-label="refreshLabel"
      :title="refreshLabel"
      :aria-busy="refreshing"
      :disabled="refreshing"
      @click="refreshData"
    >
      <IconRefresh :size="17" aria-hidden="true" />
      <span class="data-refresh__label">{{ refreshLabel }}</span>
    </BaseButton>
  </div>
</template>

<style scoped>
.data-refresh {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.data-refresh__error {
  max-width: 20rem;
  overflow: hidden;
  color: var(--color-danger);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 48rem) {
  .data-refresh--compact .data-refresh__button {
    width: 2.75rem;
    min-height: 2.75rem;
    flex: 0 0 2.75rem;
    padding: 0;
  }

  .data-refresh--compact .data-refresh__label {
    display: none;
  }
}
</style>
