<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import AppSidebar from '../components/AppSidebar.vue'
import AppTopbar from '../components/AppTopbar.vue'
import { useSessionStore } from '../stores/session'
import { useBranchloomRepository } from '../../shared/repository/injection'
import { BrowserRecentProjectLocations } from '../../features/projects/model/recentProjectLocations'
import { selectInitialProject } from '../startup'
import appIcon from '../../../src-tauri/icons/icon.png'

const route = useRoute()
const repository = useBranchloomRepository()
const recentProjectLocations = new BrowserRecentProjectLocations()
const session = useSessionStore()
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const navigationProjectId = ref('')
const isTreeWorkspace = computed(() => route.name === 'project-tree')
const workspaceMode = computed(() => route.meta.workspaceMode ?? 'standard')
const isCanvasWorkspace = computed(() => workspaceMode.value === 'canvas')
const allowsMissingProject = computed(() => route.meta.allowMissingProject === true)
const isManagementWorkspace = computed(() => workspaceMode.value === 'management')
const routeView = ref<{
  fitCanvas?(): void
  addPerson?(): void
} | null>(null)
let latestRequest = 0

function fitTreeCanvas() {
  routeView.value?.fitCanvas?.()
}

function addTreePerson() {
  routeView.value?.addPerson?.()
}

watch(
  [() => String(route.params.projectId ?? ''), allowsMissingProject],
  async ([projectId, canLoadWithoutProject], _previousValue, onCleanup) => {
    const request = ++latestRequest
    let active = true
    onCleanup(() => {
      active = false
    })

    session.closeProject()
    navigationProjectId.value = ''
    loadState.value = 'loading'
    loadError.value = ''
    if (!projectId && !canLoadWithoutProject) return
    try {
      const project = projectId
        ? await repository.getProject(projectId)
        : selectInitialProject(
            await repository.listProjects(),
            recentProjectLocations.list().map(({ projectId: recentProjectId }) => recentProjectId),
          )
      if (!active || request !== latestRequest) return
      if (!project) {
        loadState.value = 'ready'
        return
      }

      const history = repository.getHistoryState()
      if (!active || request !== latestRequest) return
      session.openProject(project, history)
      navigationProjectId.value = project.id
      recentProjectLocations.record(project)
      loadState.value = 'ready'
    } catch (error) {
      if (!active || request !== latestRequest) return
      session.closeProject()
      if (!projectId && canLoadWithoutProject) {
        loadState.value = 'ready'
        return
      }
      loadError.value = error instanceof Error ? error.message : '项目资料无法读取'
      loadState.value = 'error'
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  latestRequest += 1
  session.closeProject()
})
</script>

<template>
  <div
    v-if="loadState === 'loading'"
    class="project-gate"
    aria-label="正在载入项目"
    role="status"
  >
    <img class="project-gate__seal" :src="appIcon" alt="" aria-hidden="true" />
    <p>正在载入家族档案…</p>
  </div>

  <main v-else-if="loadState === 'error'" class="project-gate project-gate--error">
    <div class="project-gate__error" role="alert">
      <p class="project-gate__eyebrow">项目未能打开</p>
      <h1>无法打开这个项目</h1>
      <p>项目不存在、已被移除，或本地资料暂时无法读取。</p>
      <small v-if="loadError">{{ loadError }}</small>
    </div>
    <RouterLink class="project-gate__home" to="/" aria-label="返回 Branchloom 首页">
      返回首页
    </RouterLink>
  </main>

  <div v-else class="project-layout">
    <AppSidebar
      :project-id="navigationProjectId"
      :project-name="session.currentProjectName"
    />
    <div class="project-layout__workspace">
      <AppTopbar
        @fit-tree="fitTreeCanvas"
        @add-person="addTreePerson"
      />
      <main
        data-tauri-drag-region
        :class="[
          'project-layout__main',
          {
            'project-layout__main--canvas': isCanvasWorkspace,
            'project-layout__main--management': isManagementWorkspace,
          },
        ]"
      >
        <RouterView v-slot="{ Component }">
          <component :is="Component" ref="routeView" />
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
.project-gate {
  display: grid;
  min-height: calc(100dvh - 2rem);
  place-content: center;
  justify-items: center;
  gap: var(--space-3);
  padding: var(--space-8);
  text-align: center;
}

.project-gate__seal {
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 50%;
  object-fit: cover;
}

.project-gate p {
  margin: 0;
  color: var(--color-muted);
}

.project-gate--error {
  grid-template-rows: auto auto;
}

.project-gate__error {
  max-width: 34rem;
  padding: clamp(2rem, 6vw, 4rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}

.project-gate__eyebrow {
  color: var(--color-danger) !important;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.project-gate h1 {
  margin: var(--space-2) 0 var(--space-4);
  font-family: var(--font-heading);
  font-size: clamp(1.75rem, 5vw, 3rem);
}

.project-gate small {
  display: block;
  margin-top: var(--space-4);
  color: var(--color-muted);
}

.project-gate__home {
  color: var(--color-primary);
  font-weight: 700;
}

.project-layout {
  display: grid;
  height: 100dvh;
  min-height: 42rem;
  overflow: hidden;
  grid-template-columns: 11.5rem minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}

.project-layout__workspace {
  display: grid;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  grid-template-rows: auto 1fr;
}

.project-layout__main {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: clamp(1.5rem, 4vw, 3.5rem);
  background:
    linear-gradient(rgb(80 107 87 / 3%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(80 107 87 / 3%) 1px, transparent 1px),
    var(--color-background);
  background-size: 2rem 2rem;
}

.project-layout__main--canvas {
  overflow: hidden;
  padding: 0;
  background: var(--color-surface);
}

.project-layout__main--management {
  padding: clamp(1.25rem, 3vw, 2.5rem);
}

@media (max-width: 64rem) {
  .project-layout {
    grid-template-columns: 4rem minmax(0, 1fr);
  }
}
</style>
