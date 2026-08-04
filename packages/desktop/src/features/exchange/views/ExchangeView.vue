<script setup lang="ts">
import { IconArchive, IconDownload, IconUpload } from '@tabler/icons-vue'
import { open, save } from '@tauri-apps/plugin-dialog'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProjectManagementTabs from '../../../app/components/ProjectManagementTabs.vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import type { Project } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  exportProjectArchive,
  importProjectArchive,
  requestNativeRepositoryRefresh,
  supportsProjectArchives,
} from '../../../shared/repository/TauriRepository'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const session = useSessionStore()
const projectId = computed(() => String(route.params.projectId ?? ''))
const nativeArchivesAvailable = supportsProjectArchives()
const project = ref<Project>()
const mode = ref<'import' | 'export'>('import')
const busy = ref(false)
const overwrite = ref(false)
const failure = ref('')
const result = ref('')
let loadRequest = 0

function archiveFileName(name: string): string {
  const safeName = name.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.+$/g, '') || '有谱项目'
  return `${safeName}.blp`
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

async function loadProject() {
  const request = ++loadRequest
  project.value = undefined
  failure.value = ''
  if (!projectId.value) return
  try {
    const next = await repository.getProject(projectId.value)
    if (request === loadRequest) project.value = next
  } catch (error) {
    if (request === loadRequest) failure.value = errorMessage(error, '当前项目暂时无法读取')
  }
}

async function chooseArchiveToImport() {
  if (!nativeArchivesAvailable || busy.value) return
  failure.value = ''
  result.value = ''
  const selected = await open({
    title: '选择 Branchloom 项目包',
    filters: [{ name: 'Branchloom 项目包', extensions: ['blp'] }],
    multiple: false,
    directory: false,
    fileAccessMode: 'scoped',
  })
  if (!selected) return
  busy.value = true
  session.saveStatus = 'saving'
  try {
    const importedProjectId = await importProjectArchive(selected, overwrite.value)
    await requestNativeRepositoryRefresh(repository)
    const imported = await repository.getProject(importedProjectId)
    session.openProject(imported, repository.getHistoryState())
    session.saveStatus = 'saved'
    await router.replace({ name: 'project-overview', params: { projectId: importedProjectId } })
  } catch (error) {
    failure.value = errorMessage(error, '项目包暂时无法导入')
    session.saveStatus = 'failed'
    session.saveError = failure.value
  } finally {
    busy.value = false
  }
}

async function chooseArchiveDestination() {
  if (!nativeArchivesAvailable || !project.value || busy.value) return
  failure.value = ''
  result.value = ''
  const selected = await save({
    title: '导出 Branchloom 项目包',
    defaultPath: archiveFileName(project.value.name),
    filters: [{ name: 'Branchloom 项目包', extensions: ['blp'] }],
    canCreateDirectories: true,
  })
  if (!selected) return
  const destination = selected.toLowerCase().endsWith('.blp') ? selected : `${selected}.blp`
  busy.value = true
  try {
    await exportProjectArchive(project.value.id, destination)
    result.value = `项目包已保存到 ${destination}`
  } catch (error) {
    failure.value = errorMessage(error, '项目包暂时无法导出')
  } finally {
    busy.value = false
  }
}

watch(projectId, () => {
  mode.value = 'import'
  result.value = ''
  void loadProject()
}, { immediate: true })
</script>

<template>
  <section class="exchange-view" :aria-label="projectId ? '导入与导出' : undefined" :aria-labelledby="projectId ? undefined : 'exchange-title'">
    <ProjectManagementTabs v-if="projectId" />
    <header v-else class="exchange-view__heading">
      <div><p>从项目包开始</p><h1 id="exchange-title">导入家谱</h1></div>
    </header>

    <div v-if="projectId" class="exchange-view__mode-switch" role="tablist" aria-label="选择导入或导出">
      <button type="button" role="tab" :aria-selected="mode === 'import'" :tabindex="mode === 'import' ? 0 : -1" @click="mode = 'import'">
        导入项目包
        <small>读取已有的 .blp 家谱项目</small>
      </button>
      <button type="button" role="tab" :aria-selected="mode === 'export'" :tabindex="mode === 'export' ? 0 : -1" @click="mode = 'export'">
        导出项目包
        <small>保存完整的本地项目备份</small>
      </button>
    </div>

    <section v-if="!projectId || mode === 'import'" class="exchange-card" aria-labelledby="archive-import-title">
      <div class="exchange-card__icon" aria-hidden="true"><IconUpload :size="28" /></div>
      <div class="exchange-card__copy">
        <p>Branchloom 项目包</p>
        <h2 id="archive-import-title">导入 .blp 项目</h2>
        <span>选择从另一台设备导出或此前备份的项目包。导入内容包括人物、关系、事件、来源和本地附件。</span>
      </div>
      <label class="exchange-card__overwrite">
        <input v-model="overwrite" type="checkbox" name="overwriteProject" />
        <span><strong>覆盖同 ID 的现有项目</strong><small>仅在确认要用项目包替换本地同一项目时勾选。</small></span>
      </label>
      <BaseButton name="选择 .blp 项目包" size="lg" :loading="busy" :disabled="!nativeArchivesAvailable" @click="chooseArchiveToImport">
        <IconArchive :size="19" aria-hidden="true" />
        选择项目包
      </BaseButton>
    </section>

    <section v-else class="exchange-card" aria-labelledby="archive-export-title">
      <div class="exchange-card__icon" aria-hidden="true"><IconDownload :size="28" /></div>
      <div class="exchange-card__copy">
        <p>完整项目备份</p>
        <h2 id="archive-export-title">导出 .blp 项目</h2>
        <span>把当前项目及其本地附件保存为一个可再次导入的项目包。</span>
      </div>
      <div v-if="!project && !failure" class="exchange-card__project" role="status">正在读取当前项目…</div>
      <div v-else-if="project" class="exchange-card__project">
        <span>准备导出</span><strong>{{ project.name }}</strong><code>{{ project.id }}</code>
      </div>
      <BaseButton name="导出 .blp 项目包" size="lg" :loading="busy" :disabled="!nativeArchivesAvailable || !project" @click="chooseArchiveDestination">
        <IconDownload :size="19" aria-hidden="true" />
        选择保存位置
      </BaseButton>
    </section>

    <p v-if="!nativeArchivesAvailable" class="exchange-view__availability" role="note">
      项目包导入与导出需要在 Mac 桌面版中使用。
    </p>
    <p v-if="failure" class="exchange-view__message exchange-view__message--error" role="alert">{{ failure }}</p>
    <p v-if="result" class="exchange-view__message" role="status">{{ result }}</p>
  </section>
</template>

<style scoped>
.exchange-view { display: grid; width: min(64rem, 100%); gap: var(--space-4); margin: 0 auto; }
.exchange-view__heading { display: flex; align-items: end; justify-content: space-between; gap: var(--space-5); padding-bottom: var(--space-3); border-bottom: 1px solid var(--color-border); }
.exchange-view__heading p, .exchange-view__heading h1 { margin: 0; }
.exchange-view__heading p, .exchange-card__copy p { color: var(--color-accent); font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.exchange-view__heading h1 { margin-top: var(--space-1); font-family: var(--font-heading); }
.exchange-view__mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: .25rem; padding: .25rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.exchange-view__mode-switch button { display: grid; justify-items: start; gap: .25rem; padding: .75rem 1rem; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted); font: inherit; font-weight: 700; text-align: left; cursor: pointer; }
.exchange-view__mode-switch button small { font-size: .72rem; font-weight: 500; }
.exchange-view__mode-switch button[aria-selected='true'] { background: var(--color-surface); color: var(--color-primary); box-shadow: var(--shadow-sm); }
.exchange-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-5); padding: clamp(1.5rem, 4vw, 2.5rem); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.exchange-card__icon { display: grid; width: 3.5rem; height: 3.5rem; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--color-primary) 12%, var(--color-surface)); color: var(--color-primary); }
.exchange-card__copy p, .exchange-card__copy h2 { margin: 0; }
.exchange-card__copy h2 { margin-top: var(--space-1); font-family: var(--font-heading); }
.exchange-card__copy > span { display: block; max-width: 38rem; margin-top: var(--space-2); color: var(--color-muted); line-height: 1.6; }
.exchange-card__overwrite, .exchange-card__project { grid-column: 2 / -1; }
.exchange-card__overwrite { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); cursor: pointer; }
.exchange-card__overwrite input { margin-top: .2rem; }
.exchange-card__overwrite span { display: grid; gap: .2rem; }
.exchange-card__overwrite small { color: var(--color-muted); }
.exchange-card__project { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-3); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); }
.exchange-card__project span { color: var(--color-muted); }
.exchange-card__project code { color: var(--color-muted); font-size: .75rem; }
.exchange-view__availability, .exchange-view__message { margin: 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-muted-surface); color: var(--color-muted); }
.exchange-view__message { border-color: color-mix(in srgb, var(--color-primary) 30%, var(--color-border)); color: var(--color-primary); }
.exchange-view__message--error { border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border)); background: var(--color-danger-surface); color: var(--color-danger); }
@media (max-width: 46rem) {
  .exchange-card { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
  .exchange-card > :deep(.base-button), .exchange-card__overwrite, .exchange-card__project { grid-column: 1 / -1; }
  .exchange-card > :deep(.base-button) { width: 100%; }
}
@media (max-width: 38rem) { .exchange-view__mode-switch { grid-template-columns: 1fr; } }
</style>
