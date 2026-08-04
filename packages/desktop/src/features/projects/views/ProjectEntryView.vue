<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../../../design-system/BaseButton.vue'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import { selectInitialProject } from '../../../app/startup'
import { BrowserRecentProjectLocations } from '../model/recentProjectLocations'
import appIcon from '../../../../src-tauri/icons/icon.png'

const repository = useBranchloomRepository()
const recentProjectLocations = new BrowserRecentProjectLocations()
const router = useRouter()
const state = ref<'loading' | 'error'>('loading')
const errorMessage = ref('')
let request = 0

async function enterWorkspace() {
  const currentRequest = ++request
  state.value = 'loading'
  errorMessage.value = ''
  try {
    const projects = await repository.listProjects()
    const project = selectInitialProject(
      projects,
      recentProjectLocations.list().map(({ projectId }) => projectId),
    )
    if (currentRequest !== request) return
    if (!project) {
      await router.replace({ name: 'new-project' })
      return
    }
    await router.replace({
      name: 'project-tree',
      params: { projectId: project.id },
    })
  } catch (error) {
    if (currentRequest !== request) return
    errorMessage.value = error instanceof Error && error.message.trim()
      ? error.message
      : '本地项目暂时无法读取'
    state.value = 'error'
  }
}

onMounted(enterWorkspace)
</script>

<template>
  <section class="project-entry" :aria-busy="state === 'loading'">
    <template v-if="state === 'loading'">
      <img class="project-entry__seal" :src="appIcon" alt="" aria-hidden="true" />
      <p role="status">正在打开最近使用的家谱…</p>
    </template>
    <template v-else>
      <p class="project-entry__eyebrow">项目入口暂时不可用</p>
      <h1>无法打开本地家谱</h1>
      <p role="alert">{{ errorMessage }}</p>
      <BaseButton variant="secondary" @click="enterWorkspace">重新读取</BaseButton>
    </template>
  </section>
</template>

<style scoped>
.project-entry {
  display: grid;
  max-width: 32rem;
  justify-items: center;
  gap: var(--space-3);
  text-align: center;
}

.project-entry__seal {
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 50%;
  object-fit: cover;
}

.project-entry p {
  margin: 0;
  color: var(--color-muted);
}

.project-entry__eyebrow {
  color: var(--color-danger) !important;
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .12em;
}

.project-entry h1 {
  margin: 0;
  font-family: var(--font-heading);
}
</style>
