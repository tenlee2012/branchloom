import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  BranchloomRepository,
  HistoryState,
  Project,
  SaveStatus,
} from '../../shared/domain/types'

export const useSessionStore = defineStore('session', () => {
  const currentProject = ref<Project>()
  const saveStatus = ref<SaveStatus>('idle')
  const canUndo = ref(false)
  const canRedo = ref(false)
  const saveError = ref<string>()

  const currentProjectId = computed(() => currentProject.value?.id)
  const currentProjectName = computed(() => currentProject.value?.name ?? 'Branchloom')

  function applyHistory(history: HistoryState) {
    canUndo.value = history.canUndo
    canRedo.value = history.canRedo
  }

  function openProject(project: Project, history?: HistoryState) {
    currentProject.value = project
    if (history) applyHistory(history)
    saveStatus.value = 'saved'
    saveError.value = undefined
  }

  function closeProject(projectId?: string) {
    if (projectId && currentProject.value?.id !== projectId) return
    currentProject.value = undefined
    saveStatus.value = 'idle'
    canUndo.value = false
    canRedo.value = false
  }

  async function refreshHistory(repository: BranchloomRepository): Promise<void> {
    applyHistory(repository.getHistoryState())
  }

  async function runHistoryCommand(
    repository: BranchloomRepository,
    command: 'undo' | 'redo',
  ): Promise<void> {
    saveStatus.value = 'saving'
    saveError.value = undefined
    try {
      await repository[command]()
      await refreshHistory(repository)
      if (currentProjectId.value) {
        currentProject.value = await repository.getProject(currentProjectId.value)
      }
      saveStatus.value = 'saved'
    } catch (error) {
      saveStatus.value = 'failed'
      saveError.value = error instanceof Error ? error.message : '无法更新历史记录'
    }
  }

  async function undo(repository: BranchloomRepository) {
    if (!canUndo.value) return
    await runHistoryCommand(repository, 'undo')
  }

  async function redo(repository: BranchloomRepository) {
    if (!canRedo.value) return
    await runHistoryCommand(repository, 'redo')
  }

  return {
    currentProject,
    currentProjectId,
    currentProjectName,
    saveStatus,
    saveError,
    canUndo,
    canRedo,
    openProject,
    closeProject,
    refreshHistory,
    undo,
    redo,
  }
})
