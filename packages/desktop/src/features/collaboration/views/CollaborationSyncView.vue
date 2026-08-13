<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import { requestNativeRepositoryRefresh } from '../../../shared/repository/TauriRepository'
import { BrowserRecentProjectLocations } from '../../projects/model/recentProjectLocations'
import GithubSyncPanel from '../../projects/components/GithubSyncPanel.vue'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const recentLocations = new BrowserRecentProjectLocations()
const projectId = computed(() => String(route.params.projectId ?? ''))
const adoptionError = ref('')

async function openAdoptedProject(nextProjectId: string, replacedProjectId?: string) {
  adoptionError.value = ''
  try {
    await requestNativeRepositoryRefresh(repository)
    const project = await repository.getProject(nextProjectId)
    if (replacedProjectId) recentLocations.removeProject(replacedProjectId)
    recentLocations.record(project)
    await router.replace({
      name: 'project-collaboration-sync',
      params: { projectId: nextProjectId },
    })
  } catch (error) {
    adoptionError.value = error instanceof Error && error.message.trim()
      ? error.message
      : 'GitHub 项目已经导入，但页面暂时无法切换。请返回首页后重新打开。'
  }
}
</script>

<template>
  <GithubSyncPanel :project-id="projectId" @project-adopted="openAdoptedProject" />
  <p v-if="adoptionError" class="collaboration-sync__error" role="alert">
    {{ adoptionError }}
  </p>
</template>

<style scoped>
.collaboration-sync__error {
  padding: var(--space-3);
  margin: var(--space-4) 0 0;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}
</style>
