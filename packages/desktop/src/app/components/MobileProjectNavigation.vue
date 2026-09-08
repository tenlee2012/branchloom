<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  IconClock,
  IconFileDescription,
  IconFolder,
  IconNetwork,
  IconUser,
} from '@tabler/icons-vue'

const props = defineProps<{ projectId: string }>()
const route = useRoute()
const items = computed(() => {
  if (!props.projectId) return []
  const base = `/project/${encodeURIComponent(props.projectId)}`
  return [
    { label: '家谱', icon: IconNetwork, to: `${base}/tree`, section: '/tree' },
    { label: '人物', icon: IconUser, to: `${base}/people`, section: '/people' },
    { label: '时间', icon: IconClock, to: `${base}/timeline`, section: '/timeline' },
    { label: '资料', icon: IconFileDescription, to: `${base}/sources`, section: '/sources' },
    { label: '项目', icon: IconFolder, to: `${base}/manage/overview`, section: '' },
  ]
})

function isCurrent(section: string, to: string) {
  if (section) return route.path.startsWith(`/project/${props.projectId}${section}`)
  return route.path.includes('/manage/') || route.path.endsWith('/collaboration-sync')
    || route.path === to
}
</script>

<template>
  <nav class="mobile-project-navigation" aria-label="移动端项目导航">
    <RouterLink
      v-for="item in items"
      :key="item.label"
      :to="item.to"
      :aria-current="isCurrent(item.section, item.to) ? 'page' : undefined"
    >
      <component :is="item.icon" :size="22" :stroke-width="1.7" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.mobile-project-navigation {
  display: none;
}

@media (max-width: 48rem) {
  .mobile-project-navigation {
    z-index: 20;
    display: grid;
    min-height: calc(3.75rem + env(safe-area-inset-bottom));
    padding: .35rem .35rem calc(.35rem + env(safe-area-inset-bottom));
    border-top: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-surface) 96%, transparent);
    box-shadow: 0 -8px 24px rgb(44 45 42 / 8%);
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .mobile-project-navigation a {
    display: grid;
    min-width: 0;
    min-height: 3rem;
    place-content: center;
    justify-items: center;
    gap: .15rem;
    border-radius: .65rem;
    color: var(--color-muted);
    font-size: .65rem;
    font-weight: 680;
    text-decoration: none;
  }

  .mobile-project-navigation a[aria-current='page'] {
    background: var(--color-muted-surface);
    color: var(--color-primary-strong);
  }
}
</style>
