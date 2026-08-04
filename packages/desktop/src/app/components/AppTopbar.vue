<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  IconArrowsMaximize,
  IconUserPlus,
} from '@tabler/icons-vue'
import BaseButton from '../../design-system/BaseButton.vue'
import DataRefreshButton from './DataRefreshButton.vue'
import PageBackLink from './PageBackLink.vue'

const route = useRoute()
const isTreeWorkspace = computed(() => route.name === 'project-tree')
const emit = defineEmits<{
  fitTree: []
  addPerson: []
}>()
</script>

<template>
  <header class="app-topbar" data-tauri-drag-region>
    <div
      v-if="isTreeWorkspace"
      class="app-topbar__drag-surface"
      data-tauri-drag-region
      aria-hidden="true"
    />
    <PageBackLink v-else placement="topbar" />

    <div class="app-topbar__actions" :aria-label="isTreeWorkspace ? '家谱树操作' : '资料操作'">
      <DataRefreshButton />
      <BaseButton v-if="isTreeWorkspace" name="适应画布" size="sm" variant="secondary" @click="emit('fitTree')">
        <IconArrowsMaximize :size="17" aria-hidden="true" />适应画布
      </BaseButton>
      <BaseButton v-if="isTreeWorkspace" name="添加人物" size="sm" @click="emit('addPerson')">
        <IconUserPlus :size="18" aria-hidden="true" />添加人物
      </BaseButton>
    </div>
  </header>
</template>

<style scoped>
.app-topbar {
  display: grid;
  min-height: 3.75rem;
  align-items: center;
  gap: var(--space-4);
  padding: .65rem clamp(1rem, 2.4vw, 1.4rem);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  grid-template-columns: minmax(0, 1fr) auto;
}

.app-topbar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  justify-self: end;
}

.app-topbar__drag-surface {
  min-width: 0;
  align-self: stretch;
}

.app-topbar__actions :deep(.base-button) {
  gap: .4rem;
  white-space: nowrap;
}

</style>
