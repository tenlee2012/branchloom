<script setup lang="ts">
import { ref } from 'vue'
import { IconRefresh } from '@tabler/icons-vue'
import BaseButton from '../../design-system/BaseButton.vue'
import { useBranchloomRepository } from '../../shared/repository/injection'
import { requestNativeRepositoryRefresh } from '../../shared/repository/TauriRepository'

const repository = useBranchloomRepository()
const refreshing = ref(false)
const refreshError = ref('')

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
  <div class="data-refresh">
    <small v-if="refreshError" class="data-refresh__error" role="alert">
      {{ refreshError }}
    </small>
    <BaseButton
      name="刷新资料"
      size="sm"
      variant="secondary"
      :disabled="refreshing"
      @click="refreshData"
    >
      <IconRefresh :size="17" aria-hidden="true" />{{ refreshing ? '刷新中…' : '刷新资料' }}
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
</style>
