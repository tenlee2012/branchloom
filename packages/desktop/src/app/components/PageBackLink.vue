<script setup lang="ts">
import { computed } from 'vue'
import {
  RouterLink,
  useRoute,
  useRouter,
  type RouteLocationRaw,
} from 'vue-router'
import { IconArrowLeft } from '@tabler/icons-vue'

interface ParentRouteDefinition {
  name: string
  label: string
  inheritParams?: string[]
}

withDefaults(defineProps<{
  placement?: 'content' | 'topbar'
}>(), {
  placement: 'content',
})

const route = useRoute()
const router = useRouter()
const parent = computed(() => route.meta.parent as ParentRouteDefinition | undefined)
const usesHistoryBack = computed(() => route.meta.backBehavior === 'history')
const previousLocation = computed(() => {
  const previous = route.meta.previousFullPath
  return typeof previous === 'string' && previous !== '/' && previous !== route.fullPath
    ? previous
    : undefined
})
const treeReturnTarget = computed<RouteLocationRaw | undefined>(() => {
  const requested = route.query.returnTo
  const projectId = route.params.projectId
  if (typeof requested !== 'string' || typeof projectId !== 'string') return undefined
  const treePath = `/project/${encodeURIComponent(projectId)}/tree`
  if (requested !== treePath
    && !requested.startsWith(`${treePath}?`)
    && !requested.startsWith(`${treePath}#`)) return undefined
  return requested
})
const target = computed<RouteLocationRaw>(() => {
  if (treeReturnTarget.value) return treeReturnTarget.value
  const definition = parent.value
  if (!definition) return { name: 'home' }

  const params = Object.fromEntries(
    (definition.inheritParams ?? [])
      .map((key) => [key, route.params[key]])
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined),
  )

  return {
    name: definition.name,
    params,
  }
})
const label = computed(() => {
  if (usesHistoryBack.value && previousLocation.value) return '返回上一页'
  return treeReturnTarget.value ? '返回家谱树' : parent.value?.label ?? '返回首页'
})

function goBack() {
  if (previousLocation.value) {
    router.back()
    return
  }
  void router.push(target.value)
}
</script>

<template>
  <button
    v-if="parent && usesHistoryBack"
    type="button"
    :class="[
      'page-back-link',
      `page-back-link--${placement}`,
    ]"
    :aria-label="label"
    :title="label"
    @click="goBack"
  >
    <IconArrowLeft :size="18" :stroke-width="1.8" aria-hidden="true" />
    <span :class="{ 'page-back-link__label--hidden': placement === 'topbar' }">
      {{ label }}
    </span>
  </button>
  <RouterLink
    v-else-if="parent"
    :class="[
      'page-back-link',
      `page-back-link--${placement}`,
    ]"
    :to="target"
    :aria-label="label"
    :title="label"
  >
    <IconArrowLeft :size="18" :stroke-width="1.8" aria-hidden="true" />
    <span :class="{ 'page-back-link__label--hidden': placement === 'topbar' }">
      {{ label }}
    </span>
  </RouterLink>
</template>

<style scoped>
.page-back-link {
  display: inline-flex;
  width: fit-content;
  min-height: 2.25rem;
  align-items: center;
  justify-self: start;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: rgb(255 253 248 / 88%);
  color: var(--color-primary);
  font-size: .8125rem;
  font-weight: 700;
  font-family: inherit;
  text-decoration: none;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition:
    border-color 160ms ease,
    background-color 160ms ease,
    transform 160ms ease;
}

.page-back-link--content {
  margin-bottom: var(--space-4);
}

.page-back-link--topbar {
  width: 2.25rem;
  flex: 0 0 2.25rem;
  justify-content: center;
  padding: 0;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.page-back-link__label--hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.page-back-link:hover {
  border-color: var(--color-primary);
  background: var(--color-surface);
  transform: translateX(-2px);
}
</style>
