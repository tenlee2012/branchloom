<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { RouterLink } from 'vue-router'
import BaseButton from '../../../design-system/BaseButton.vue'
import type { Project } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'

defineProps<{ projectId: string }>()
const repository = useBranchloomRepository()
const disclosure = ref<HTMLDetailsElement>()
const summary = ref<HTMLElement>()
const projects = ref<Project[]>([])
const loading = ref(false)
const error = ref('')
let request = 0

async function loadProjects() {
  const current = ++request
  loading.value = true
  error.value = ''
  try {
    const result = await repository.listProjects()
    if (current === request) projects.value = result
  } catch (cause) {
    if (current === request) error.value = cause instanceof Error ? cause.message : '项目列表暂时无法读取'
  } finally {
    if (current === request) loading.value = false
  }
}

function close() {
  if (disclosure.value) disclosure.value.open = false
  summary.value?.focus()
}

onBeforeUnmount(() => { request += 1 })
</script>

<template>
  <details
    ref="disclosure"
    class="project-switcher"
    @toggle="disclosure?.open && loadProjects()"
    @keydown.esc.prevent.stop="close"
  >
    <summary ref="summary">切换项目</summary>
    <p v-if="loading" role="status">正在读取项目列表…</p>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <BaseButton variant="secondary" size="sm" @click="loadProjects">重新读取项目列表</BaseButton>
    </div>
    <p v-else-if="!projects.length" role="status">暂无可切换的项目。</p>
    <nav v-else aria-label="可切换的项目">
      <RouterLink
        v-for="project in projects"
        :key="project.id"
        :to="{ name: 'project-tree', params: { projectId: project.id } }"
        :aria-label="`打开项目：${project.name}`"
        @click="close"
      >
        <span>{{ project.name }}</span>
        <small v-if="project.id === projectId">当前项目</small>
      </RouterLink>
    </nav>
  </details>
</template>

<style scoped>
.project-switcher {
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.project-switcher summary {
  padding-block: var(--space-2);
  color: var(--color-primary);
  font-weight: 700;
  cursor: pointer;
}
.project-switcher nav { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.project-switcher a {
  display: flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  text-decoration: none;
}
.project-switcher a:hover { background: var(--color-muted-surface); }
.project-switcher a span { overflow-wrap: anywhere; }
.project-switcher small { flex-shrink: 0; color: var(--color-muted); }
.project-switcher summary:focus-visible,
.project-switcher a:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.project-switcher p { color: var(--color-muted); }
</style>
