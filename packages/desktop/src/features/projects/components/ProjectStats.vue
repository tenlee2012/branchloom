<script setup lang="ts">
import {
  IconCalendarEvent,
  IconFile,
  IconLink,
  IconNotes,
  IconUsers,
} from '@tabler/icons-vue'
import type { ProjectSummary } from '../../../shared/domain/types'

const props = defineProps<{ summary: ProjectSummary }>()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const cards = [
  { key: 'people', label: '人物', helper: '人物档案', icon: IconUsers },
  { key: 'relationships', label: '关系', helper: '已记录关系', icon: IconLink },
  { key: 'events', label: '事件', helper: '时间事件', icon: IconCalendarEvent },
  { key: 'sources', label: '来源', helper: '资料来源', icon: IconNotes },
] as const
</script>

<template>
  <dl class="project-stats" aria-label="项目统计">
    <div v-for="card in cards" :key="card.key">
      <dt>
        <component :is="card.icon" :size="18" :stroke-width="1.7" aria-hidden="true" />
        {{ card.label }}
      </dt>
      <dd>{{ props.summary[card.key] }}</dd>
      <small>{{ card.helper }}</small>
    </div>
    <div>
      <dt><IconFile :size="18" :stroke-width="1.7" aria-hidden="true" />附件</dt>
      <dd>{{ summary.attachments }}</dd>
      <small>{{ formatBytes(summary.attachmentBytes) }} 本地文件</small>
    </div>
  </dl>
</template>

<style scoped>
.project-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(7.5rem, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.project-stats > div {
  display: grid;
  min-height: 6.25rem;
  align-content: space-between;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.project-stats dt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-muted);
  font-size: .8125rem;
  font-weight: 700;
}

.project-stats dd {
  margin: var(--space-1) 0 0;
  font-family: var(--font-heading);
  font-size: clamp(1.85rem, 3.5vw, 2.45rem);
  line-height: 1;
}

.project-stats small {
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: .7rem;
}

@media (max-width: 60rem) {
  .project-stats { grid-template-columns: repeat(3, minmax(7rem, 1fr)); }
}

@media (max-width: 34rem) { .project-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
