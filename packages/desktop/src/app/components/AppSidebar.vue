<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { RouterLink, useRoute } from 'vue-router'
import {
  IconChevronDown,
  IconClock,
  IconFolder,
  IconHistory,
  IconNetwork,
  IconPlus,
  IconRotateClockwise,
  IconSettings,
  IconShieldCheck,
  IconUser,
  IconFileDescription,
} from '@tabler/icons-vue'
import BaseButton from '../../design-system/BaseButton.vue'
import type { Project } from '../../shared/domain/types'
import { useBranchloomRepository } from '../../shared/repository/injection'
import {
  NATIVE_STATE_REFRESHED_EVENT,
  PROJECT_DATA_CHANGED_EVENT,
} from '../../shared/repository/TauriRepository'
import { useSessionStore } from '../stores/session'
import appIcon from '../../../src-tauri/icons/icon.png'

const props = defineProps<{ projectId: string; projectName: string }>()
const route = useRoute()
const repository = useBranchloomRepository()
const session = useSessionStore()
const { canUndo, canRedo, saveStatus } = storeToRefs(session)
const projectSwitcher = ref<HTMLDetailsElement>()
const projects = ref<Project[]>([])
const projectListError = ref('')
const issueCount = ref<number>()
const projectTreePath = computed(() => `/project/${encodeURIComponent(props.projectId)}/tree`)
let issueRequestId = 0

async function loadProjects() {
  projectListError.value = ''
  try {
    projects.value = await repository.listProjects()
  } catch (error) {
    projectListError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '项目列表暂时无法读取'
  }
}

function closeProjectSwitcher() {
  projectSwitcher.value?.removeAttribute('open')
}

async function loadIssueCount(scopedProjectId = props.projectId) {
  const request = ++issueRequestId
  issueCount.value = undefined
  try {
    const issues = await repository.inspectProject(scopedProjectId)
    if (request !== issueRequestId || scopedProjectId !== props.projectId) return
    issueCount.value = issues.length
  } catch {
    if (request !== issueRequestId || scopedProjectId !== props.projectId) return
    issueCount.value = undefined
  }
}

watch(() => props.projectId, (projectId) => {
  void loadProjects()
  void loadIssueCount(projectId)
}, { immediate: true })

watch(saveStatus, (status) => {
  if (status === 'saved') void loadIssueCount()
})

function refreshIssueCount() {
  void loadIssueCount()
}

onMounted(() => {
  window.addEventListener(PROJECT_DATA_CHANGED_EVENT, refreshIssueCount)
  window.addEventListener(NATIVE_STATE_REFRESHED_EVENT, refreshIssueCount)
})

onBeforeUnmount(() => {
  window.removeEventListener(PROJECT_DATA_CHANGED_EVENT, refreshIssueCount)
  window.removeEventListener(NATIVE_STATE_REFRESHED_EVENT, refreshIssueCount)
})

const navigation = computed(() => {
  const base = `/project/${props.projectId}`
  return [
    { label: '家谱树', icon: IconNetwork, to: `${base}/tree`, segment: '/tree' },
    { label: '人物', icon: IconUser, to: `${base}/people`, segment: '/people' },
    { label: '时间线', icon: IconClock, to: `${base}/timeline`, segment: '/timeline' },
    { label: '资料来源', icon: IconFileDescription, to: `${base}/sources`, segment: '/sources' },
  ]
})

const projectNavigation = computed(() => {
  const base = `/project/${props.projectId}`
  return [
    {
      label: '项目管理',
      icon: IconFolder,
      to: `${base}/manage/overview`,
      segment: '/manage/',
      badge: undefined,
    },
    {
      label: '数据检查',
      icon: IconShieldCheck,
      to: `${base}/manage/checks`,
      segment: '/manage/checks',
      badge: issueCount.value,
    },
  ]
})

function isCurrent(segment: string) {
  return route.path.startsWith(`/project/${props.projectId}${segment}`)
}

function isExact(to: string) {
  return route.path === to
}
</script>

<template>
  <aside class="app-sidebar" data-tauri-drag-region>
    <RouterLink
      class="app-sidebar__brand"
      :to="projectTreePath"
      aria-label="返回当前项目家谱树"
      title="返回当前项目家谱树"
    >
      <img class="app-sidebar__seal" :src="appIcon" alt="" aria-hidden="true" />
      <span>
        <strong>有谱</strong>
        <small>BRANCHLOOM</small>
      </span>
    </RouterLink>

    <div class="app-sidebar__project">
      <span>当前项目</span>
      <details ref="projectSwitcher" class="app-sidebar__project-switcher">
        <summary aria-label="切换项目">
          <strong :title="projectName">{{ projectName }}</strong>
          <IconChevronDown :size="16" aria-hidden="true" />
        </summary>
        <div class="app-sidebar__project-panel">
          <nav aria-label="项目列表">
            <RouterLink
              v-for="project in projects"
              :key="project.id"
              :to="{ name: 'project-tree', params: { projectId: project.id } }"
              :aria-current="project.id === projectId ? 'page' : undefined"
              @click="closeProjectSwitcher"
            >
              <span>{{ project.name }}</span>
              <small v-if="project.id === projectId">当前</small>
            </RouterLink>
            <small v-if="projectListError" class="app-sidebar__project-error" role="alert">
              {{ projectListError }}
            </small>
          </nav>
          <RouterLink
            class="app-sidebar__new-project"
            :to="{ name: 'project-new', params: { projectId } }"
            aria-label="新建项目"
            @click="closeProjectSwitcher"
          >
            <IconPlus :size="17" aria-hidden="true" />新建项目
          </RouterLink>
          <div class="app-sidebar__history" aria-label="编辑历史">
            <BaseButton
              variant="ghost"
              size="sm"
              :disabled="!canUndo || saveStatus === 'saving'"
              aria-label="撤销最近修改"
              @click="session.undo(repository)"
            >
              <IconHistory :size="16" aria-hidden="true" />撤销
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              :disabled="!canRedo || saveStatus === 'saving'"
              aria-label="重做最近修改"
              @click="session.redo(repository)"
            >
              <IconRotateClockwise :size="16" aria-hidden="true" />重做
            </BaseButton>
          </div>
        </div>
      </details>
    </div>

    <nav class="app-sidebar__navigation" aria-label="项目导航">
      <RouterLink
        v-for="item in navigation"
        :key="item.label"
        :to="item.to"
        :aria-label="item.label"
        :aria-current="isExact(item.to) ? 'page' : undefined"
        :class="[
          'app-sidebar__link',
          { 'app-sidebar__link--active': isCurrent(item.segment) },
        ]"
      >
        <component :is="item.icon" class="app-sidebar__glyph" :size="24" :stroke-width="1.6" aria-hidden="true" />
        <span class="app-sidebar__link-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <nav class="app-sidebar__navigation app-sidebar__navigation--project" aria-label="项目管理导航">
      <RouterLink
        v-for="item in projectNavigation"
        :key="item.label"
        :to="item.to"
        :aria-label="item.label"
        :class="['app-sidebar__link', { 'app-sidebar__link--active': isCurrent(item.segment) }]"
      >
        <component :is="item.icon" class="app-sidebar__glyph" :size="24" :stroke-width="1.6" aria-hidden="true" />
        <span class="app-sidebar__link-copy">
          <span class="app-sidebar__link-label">{{ item.label }}</span>
        </span>
        <span
          v-if="item.badge"
          class="app-sidebar__badge"
          :aria-label="`${item.badge} 个问题`"
        >{{ item.badge }}</span>
      </RouterLink>
    </nav>

    <div class="app-sidebar__footer">
      <RouterLink :to="`/project/${projectId}/manage/settings`"><IconSettings :size="22" aria-hidden="true" />设置</RouterLink>
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar {
  display: flex;
  min-width: 0;
  flex-direction: column;
  border-right: 1px solid rgb(20 56 43 / 44%);
  background: var(--color-primary-strong);
  color: #fffdf6;
}

.app-sidebar__brand {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: .55rem;
  padding: 2.8rem 1rem 2rem;
  color: #fffdf6;
  text-align: center;
  text-decoration: none;
}

.app-sidebar__seal {
  width: 4.5rem;
  height: 4.5rem;
  border: 1px solid rgb(255 253 246 / 72%);
  border-radius: 50%;
  object-fit: cover;
}

.app-sidebar__brand strong,
.app-sidebar__brand small {
  display: block;
}

.app-sidebar__brand strong {
  font-family: var(--font-heading);
  font-size: 1.75rem;
  font-weight: 520;
  letter-spacing: .18em;
}

.app-sidebar__brand small {
  margin-top: .2rem;
  color: rgb(255 253 246 / 78%);
  font-size: .66rem;
  letter-spacing: .2em;
}

.app-sidebar__project {
  display: grid;
  gap: .55rem;
  margin: 1rem 1.1rem 1rem;
  padding: 1rem .35rem;
  border-bottom: 1px solid rgb(255 253 246 / 26%);
}

.app-sidebar__project span {
  color: rgb(255 253 246 / 68%);
  font-size: .72rem;
  letter-spacing: .08em;
}

.app-sidebar__project-switcher {
  position: relative;
  min-width: 0;
}

.app-sidebar__project-switcher summary {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  cursor: pointer;
  list-style: none;
}

.app-sidebar__project-switcher summary::-webkit-details-marker {
  display: none;
}

.app-sidebar__project-switcher strong {
  overflow: hidden;
  font-family: var(--font-heading);
  font-size: 1.08rem;
  font-weight: 520;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-sidebar__project-panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + .6rem);
  left: -.35rem;
  display: grid;
  width: 17rem;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
  color: var(--color-text);
}

.app-sidebar__project-panel nav {
  display: grid;
  gap: .15rem;
  padding: .5rem;
}

.app-sidebar__project-panel nav a {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: .55rem;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: .8rem;
  text-decoration: none;
}

.app-sidebar__project-panel nav a:hover,
.app-sidebar__project-panel nav a[aria-current='page'] {
  background: var(--color-muted-surface);
}

.app-sidebar__project-panel nav a span {
  overflow: hidden;
  color: inherit;
  font-size: inherit;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-sidebar__project-panel nav a small {
  color: var(--color-primary);
}

.app-sidebar__project-error {
  padding: .4rem .55rem;
  color: var(--color-danger);
}

.app-sidebar__new-project {
  display: flex;
  align-items: center;
  gap: .4rem;
  padding: .7rem 1rem;
  border-top: 1px solid var(--color-border);
  color: var(--color-primary);
  font-size: .8rem;
  font-weight: 700;
  text-decoration: none;
}

.app-sidebar__history {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: .2rem;
  padding: .4rem;
  border-top: 1px solid var(--color-border);
}

.app-sidebar__navigation {
  display: grid;
  min-width: 0;
  gap: .38rem;
  padding: 0 .75rem;
}

.app-sidebar__link {
  display: flex;
  min-height: 3rem;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: .5rem;
  color: rgb(255 253 246 / 86%);
  font-size: .96rem;
  font-weight: 560;
  text-decoration: none;
}

.app-sidebar__link:hover {
  background: rgb(255 253 246 / 10%);
  color: #fff;
}

.app-sidebar__link--active,
.app-sidebar__link[aria-current='page'] {
  background: var(--color-primary-active);
  box-shadow: inset 0 0 0 1px rgb(255 253 246 / 10%);
  color: #fff;
}

.app-sidebar__glyph {
  flex: 0 0 auto;
  opacity: .9;
}

.app-sidebar__link-copy {
  display: grid;
  min-width: 0;
  gap: .12rem;
}

.app-sidebar__navigation--project {
  margin-top: auto;
  padding-top: 1.1rem;
  border-top: 1px solid rgb(255 253 246 / 26%);
}

.app-sidebar__badge {
  display: grid;
  width: 1.35rem;
  height: 1.35rem;
  margin-left: auto;
  place-items: center;
  border-radius: 50%;
  background: var(--color-accent);
  color: white;
  font-size: .7rem;
}

.app-sidebar__footer {
  display: grid;
  gap: .8rem;
  margin: 1rem 1.1rem 1.35rem;
  padding-top: 1rem;
  border-top: 1px solid rgb(255 253 246 / 26%);
  color: rgb(255 253 246 / 86%);
  font-size: .78rem;
}

.app-sidebar__footer a {
  display: flex;
  align-items: center;
  gap: .7rem;
  color: inherit;
  text-decoration: none;
}

@media (max-width: 64rem) {
  .app-sidebar__brand span:not(.app-sidebar__seal),
  .app-sidebar__project,
  .app-sidebar__link-label,
  .app-sidebar__link-copy,
  .app-sidebar__footer {
    display: none;
  }

  .app-sidebar__brand,
  .app-sidebar__link {
    min-width: 0;
    justify-content: center;
    gap: 0;
    padding-inline: var(--space-2);
  }

  .app-sidebar__link {
    width: 100%;
  }

  .app-sidebar__seal {
    width: 2.5rem;
    height: 2.5rem;
  }

  .app-sidebar__badge {
    display: none;
  }
}
</style>
