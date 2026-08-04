<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import type { DataIssue } from '../../../shared/domain/types'

const props = defineProps<{ projectId: string; issues: DataIssue[] }>()

const groups = computed(() => [
  { severity: 'error' as const, label: '结构错误', tone: 'danger' as const },
  { severity: 'warning' as const, label: '警告', tone: 'warning' as const },
  { severity: 'info' as const, label: '提示', tone: 'info' as const },
].map((group) => ({
  ...group,
  issues: props.issues.filter(({ severity }) => severity === group.severity),
})).filter(({ issues }) => issues.length > 0))

function target(issue: DataIssue): string {
  const base = `/project/${props.projectId}`
  if (issue.targetType === 'person') return `${base}/people/${issue.targetId}`
  if (issue.targetType === 'relationship') return `${base}/tree?relationship=${encodeURIComponent(issue.targetId)}`
  if (issue.targetType === 'event') return `${base}/timeline?event=${encodeURIComponent(issue.targetId)}`
  if (issue.targetType === 'source') return `${base}/sources?source=${encodeURIComponent(issue.targetId)}`
  return `${base}/sources?attachment=${encodeURIComponent(issue.targetId)}`
}
</script>

<template>
  <div class="issue-list">
    <section v-for="group in groups" :key="group.severity" class="issue-list__group" :aria-label="group.label">
      <header><h2>{{ group.label }}</h2><StatusBadge :tone="group.tone">{{ group.issues.length }}</StatusBadge></header>
      <ul>
        <li v-for="item in group.issues" :key="item.id">
          <div><strong>{{ item.message }}</strong><code>{{ item.code }}</code></div>
          <RouterLink :to="target(item)" :aria-label="`查看资料：${item.message}`">查看资料</RouterLink>
        </li>
      </ul>
    </section>
    <section v-if="issues.length === 0" class="issue-list__empty" role="status">
      <strong>没有发现数据问题</strong><span>当前项目通过了完整性检查。</span>
    </section>
  </div>
</template>

<style scoped>
.issue-list { display: grid; gap: var(--space-4); }
.issue-list__group { overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.issue-list__group > header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-6); border-bottom: 1px solid var(--color-border); }
.issue-list h2 { margin: 0; font-family: var(--font-heading); font-size: 1.125rem; }
.issue-list ul { padding: 0; margin: 0; list-style: none; }
.issue-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-4) var(--space-6); }
.issue-list li + li { border-top: 1px solid var(--color-border); }
.issue-list li div { display: grid; gap: var(--space-1); }
.issue-list strong { font-weight: 600; }
.issue-list code { width: fit-content; color: var(--color-muted); font-size: .75rem; }
.issue-list a { flex: 0 0 auto; color: var(--color-primary); font-weight: 700; }
.issue-list__empty { display: grid; gap: var(--space-2); justify-items: center; padding: var(--space-8); border: 1px dashed var(--color-border); border-radius: var(--radius-lg); text-align: center; }
.issue-list__empty span { color: var(--color-muted); }
@media (max-width: 40rem) { .issue-list li { align-items: flex-start; flex-direction: column; } }
</style>
