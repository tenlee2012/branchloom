<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  IconArrowsMaximize,
  IconMenu2,
  IconUserPlus,
} from '@tabler/icons-vue'
import BaseButton from '../../design-system/BaseButton.vue'
import DataRefreshButton from './DataRefreshButton.vue'
import PageBackLink from './PageBackLink.vue'

const route = useRoute()
defineProps<{ projectName?: string; showMenuButton?: boolean; menuOpen?: boolean }>()
const isTreeWorkspace = computed(() => route.name === 'project-tree')
const emit = defineEmits<{
  fitTree: []
  addPerson: []
  openMenu: []
}>()
</script>

<template>
  <header class="app-topbar" :class="{ 'app-topbar--compact': showMenuButton }" data-tauri-drag-region>
    <button
      v-if="showMenuButton"
      class="app-topbar__menu"
      type="button"
      aria-label="打开菜单"
      aria-controls="mobile-project-menu"
      aria-haspopup="dialog"
      :aria-expanded="Boolean(menuOpen)"
      @click="emit('openMenu')"
    >
      <IconMenu2 :size="22" aria-hidden="true" />
    </button>
    <div class="app-topbar__context">
      <div
        v-if="isTreeWorkspace"
        class="app-topbar__drag-surface"
        data-tauri-drag-region
        aria-hidden="true"
      >
        <span class="app-topbar__mobile-project">{{ projectName || '有谱' }}</span>
      </div>
      <PageBackLink v-else placement="topbar" />
    </div>

    <div
      v-if="route.name !== 'project-new' && route.name !== 'project-overview'"
      class="app-topbar__actions"
      :aria-label="isTreeWorkspace ? '家谱树操作' : '资料操作'"
    >
      <DataRefreshButton :compact-on-mobile="isTreeWorkspace" />
      <BaseButton v-if="isTreeWorkspace" class="app-topbar__fit-canvas" name="适应画布" size="sm" variant="secondary" @click="emit('fitTree')">
        <IconArrowsMaximize :size="17" aria-hidden="true" />适应画布
      </BaseButton>
      <BaseButton
        v-if="isTreeWorkspace"
        class="app-topbar__add-person"
        name="添加人物"
        aria-label="添加人物"
        title="添加人物"
        size="sm"
        @click="emit('addPerson')"
      >
        <IconUserPlus :size="18" aria-hidden="true" />
        <span class="app-topbar__add-person-label">添加人物</span>
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

.app-topbar__context { display: flex; min-width: 0; align-self: stretch; align-items: center; }
.app-topbar__drag-surface { flex: 1; }
.app-topbar__menu { display: grid; width: 2.75rem; height: 2.75rem; place-items: center; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-primary-strong); cursor: pointer; }

.app-topbar__drag-surface {
  min-width: 0;
  align-self: stretch;
}

.app-topbar__mobile-project {
  display: none;
}

.app-topbar__actions :deep(.base-button) {
  gap: .4rem;
  white-space: nowrap;
}

.app-topbar--compact {
  min-height: calc(3.75rem + env(safe-area-inset-top));
  padding: calc(.55rem + env(safe-area-inset-top)) .75rem .55rem;
  gap: .5rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.app-topbar--compact .app-topbar__mobile-project {
  display: block;
  overflow: hidden;
  color: var(--color-primary-strong);
  font-family: var(--font-heading);
  font-size: 1rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-topbar--compact .app-topbar__drag-surface {
  display: flex;
  align-items: center;
}

.app-topbar--compact .app-topbar__fit-canvas {
  display: none;
}

.app-topbar--compact .app-topbar__actions {
  gap: .25rem;
}

.app-topbar--compact .app-topbar__actions :deep(.base-button) {
  min-height: 2.75rem;
  padding-inline: .65rem;
}

.app-topbar--compact .app-topbar__add-person {
  width: 2.75rem;
  flex: 0 0 2.75rem;
}

.app-topbar--compact .app-topbar__add-person-label {
  display: none;
}

</style>
