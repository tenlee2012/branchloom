<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()
const projectId = computed(() => String(route.params.projectId ?? ''))

const destinations = computed(() => [
  {
    label: '导入与导出',
    path: `/project/${projectId.value}/manage/exchange`,
    active: route.path.endsWith('/manage/exchange'),
  },
  {
    label: '备份与历史',
    path: `/project/${projectId.value}/manage/history`,
    active: route.path.endsWith('/manage/history'),
  },
  {
    label: '数据检查',
    path: `/project/${projectId.value}/manage/checks`,
    active: route.path.endsWith('/manage/checks'),
  },
  {
    label: '项目设置',
    path: `/project/${projectId.value}/manage/settings`,
    active: route.path.endsWith('/manage/settings'),
  },
])
</script>

<template>
  <nav class="project-management-tabs" aria-label="项目管理二级导航">
    <span class="project-management-tabs__label">项目管理工具</span>
    <div class="project-management-tabs__links">
      <RouterLink
        v-for="destination in destinations"
        :key="destination.path"
        :to="destination.path"
        :aria-current="destination.active ? 'page' : undefined"
      >
        {{ destination.label }}
      </RouterLink>
    </div>
  </nav>
</template>

<style scoped>
.project-management-tabs {
  display: grid;
  min-height: 2.75rem;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  padding: .3rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgb(255 253 248 / 72%);
}

.project-management-tabs__label {
  min-width: 0;
  justify-self: start;
  padding: 0 var(--space-3);
  color: var(--color-muted);
  font-size: .72rem;
  font-weight: 700;
  letter-spacing: .08em;
  white-space: nowrap;
}

.project-management-tabs__links {
  display: flex;
  grid-column: 2;
  justify-self: center;
  gap: .2rem;
}

.project-management-tabs a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.05rem;
  padding: .48rem .72rem;
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  font-size: .78rem;
  font-weight: 650;
  line-height: 1;
  text-decoration: none;
}

.project-management-tabs a:hover {
  background: var(--color-muted-surface);
  color: var(--color-primary);
}

.project-management-tabs a[aria-current='page'] {
  background: var(--color-primary);
  color: var(--color-surface);
}

@media (max-width: 38rem) {
  .project-management-tabs {
    display: flex;
    align-items: stretch;
    flex-direction: column;
    gap: var(--space-2);
  }

  .project-management-tabs__label {
    align-self: flex-start;
    padding-top: var(--space-2);
  }

  .project-management-tabs__links {
    flex-wrap: wrap;
    justify-content: center;
  }
}
</style>
