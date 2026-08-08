<script setup lang="ts">
import { IconArchive, IconDownload, IconUpload } from '@tabler/icons-vue'
import { open, save } from '@tauri-apps/plugin-dialog'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProjectManagementTabs from '../../../app/components/ProjectManagementTabs.vue'
import { useNotificationsStore } from '../../../app/stores/notifications'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import type { Project } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import { exchangeErrorMessage, exchangeFileName, selectedFileName } from '../model/exchangeFile'
import {
  exportProjectGedcom,
  exportProjectArchive,
  importProjectGedcom,
  importProjectArchive,
  requestNativeRepositoryRefresh,
  supportsProjectArchives,
} from '../../../shared/repository/TauriRepository'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const notifications = useNotificationsStore()
const session = useSessionStore()
const projectId = computed(() => String(route.params.projectId ?? ''))
const nativeArchivesAvailable = supportsProjectArchives()
const project = ref<Project>()
const mode = ref<'import' | 'export'>('import')
const format = ref<'blp' | 'gedcom'>(route.params.format === 'gedcom' ? 'gedcom' : 'blp')
const busy = ref(false)
const overwrite = ref(false)
const failure = ref('')
const result = ref('')
let loadRequest = 0

async function loadProject() {
  const request = ++loadRequest
  project.value = undefined
  failure.value = ''
  if (!projectId.value) return
  try {
    const next = await repository.getProject(projectId.value)
    if (request === loadRequest) project.value = next
  } catch (error) {
    if (request === loadRequest) failure.value = exchangeErrorMessage(error, '当前项目暂时无法读取')
  }
}

async function chooseFileToImport() {
  if (!nativeArchivesAvailable || busy.value) return
  failure.value = ''
  result.value = ''
  const selectedFormat = format.value
  const selected = await open({
    title: selectedFormat === 'gedcom' ? '选择 GEDCOM 文件' : '选择 Branchloom 项目包',
    filters: selectedFormat === 'gedcom'
      ? [{ name: 'GEDCOM 家谱', extensions: ['ged', 'gedcom'] }]
      : [{ name: 'Branchloom 项目包', extensions: ['blp'] }],
    multiple: false,
    directory: false,
    fileAccessMode: 'scoped',
  })
  if (!selected) return
  busy.value = true
  session.saveStatus = 'saving'
  try {
    let importedProjectId: string
    let importedMessage = ''
    let importWarnings: string[] = []
    if (selectedFormat === 'gedcom') {
      const imported = await importProjectGedcom(selected, overwrite.value)
      importedProjectId = imported.projectId
      importedMessage = `已导入 ${imported.people} 位人物、${imported.relationships} 条关系和 ${imported.places} 个地点。`
      importWarnings = imported.warnings
    } else {
      importedProjectId = await importProjectArchive(selected, overwrite.value)
    }
    await requestNativeRepositoryRefresh(repository)
    const importedProject = await repository.getProject(importedProjectId)
    session.openProject(importedProject, repository.getHistoryState())
    session.saveStatus = 'saved'
    await router.replace({
      name: selectedFormat === 'gedcom' ? 'project-exchange' : 'project-overview',
      params: { projectId: importedProjectId },
    })
    notifications.push(
      selectedFormat === 'gedcom'
        ? `GEDCOM 导入成功：${importedMessage}`
        : `项目包导入成功：${importedProject.name}`,
      'success',
    )
    if (importWarnings.length) notifications.push(importWarnings.join('；'), 'warning')
    if (importedMessage) result.value = importedMessage
  } catch (error) {
    failure.value = exchangeErrorMessage(error, selectedFormat === 'gedcom' ? 'GEDCOM 暂时无法导入' : '项目包暂时无法导入')
    session.saveStatus = 'failed'
    session.saveError = failure.value
  } finally {
    busy.value = false
  }
}

async function chooseExportDestination() {
  if (!nativeArchivesAvailable || !project.value || busy.value) return
  failure.value = ''
  result.value = ''
  const selectedFormat = format.value
  const selected = await save({
    title: selectedFormat === 'gedcom' ? '导出 GEDCOM 文件' : '导出 Branchloom 项目包',
    defaultPath: exchangeFileName(project.value.name, selectedFormat === 'gedcom' ? 'ged' : 'blp'),
    filters: selectedFormat === 'gedcom'
      ? [{ name: 'GEDCOM 家谱', extensions: ['ged'] }]
      : [{ name: 'Branchloom 项目包', extensions: ['blp'] }],
    canCreateDirectories: true,
  })
  if (!selected) return
  const extension = selectedFormat === 'gedcom' ? '.ged' : '.blp'
  const destination = selected.toLowerCase().endsWith(extension) ? selected : `${selected}${extension}`
  busy.value = true
  try {
    if (selectedFormat === 'gedcom') {
      const exported = await exportProjectGedcom(project.value.id, destination)
      const warning = exported.warnings.length ? ` ${exported.warnings.join('；')}` : ''
      result.value = `GEDCOM 已保存到 ${destination}。${warning}`
      notifications.push(`GEDCOM 导出成功：${selectedFileName(destination)}`, 'success')
      if (exported.warnings.length) notifications.push(exported.warnings.join('；'), 'warning')
    } else {
      await exportProjectArchive(project.value.id, destination)
      result.value = `项目包已保存到 ${destination}`
      notifications.push(`项目包导出成功：${selectedFileName(destination)}`, 'success')
    }
  } catch (error) {
    failure.value = exchangeErrorMessage(error, selectedFormat === 'gedcom' ? 'GEDCOM 暂时无法导出' : '项目包暂时无法导出')
  } finally {
    busy.value = false
  }
}

watch(projectId, () => {
  mode.value = 'import'
  result.value = ''
  void loadProject()
}, { immediate: true })

watch(() => route.params.format, (nextFormat) => {
  if (!projectId.value) format.value = nextFormat === 'gedcom' ? 'gedcom' : 'blp'
})
</script>

<template>
  <section class="exchange-view" :aria-label="projectId ? '导入与导出' : undefined" :aria-labelledby="projectId ? undefined : 'exchange-title'">
    <ProjectManagementTabs v-if="projectId" />
    <header v-else class="exchange-view__heading">
      <div><p>从外部资料开始</p><h1 id="exchange-title">导入家谱</h1></div>
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

    <fieldset class="exchange-view__formats">
      <legend>交换格式</legend>
      <div class="exchange-view__format-options">
        <label :class="{ 'exchange-view__format--selected': format === 'blp' }">
          <input v-model="format" type="radio" name="exchangeFormat" value="blp" />
          <span><strong>Branchloom 项目包</strong><small>完整保留全部资料和本地附件</small></span>
        </label>
        <label :class="{ 'exchange-view__format--selected': format === 'gedcom' }">
          <input v-model="format" type="radio" name="exchangeFormat" value="gedcom" />
          <span><strong>GEDCOM</strong><small>与其他家谱软件交换人物和家庭关系</small></span>
        </label>
      </div>
    </fieldset>

    <section v-if="!projectId || mode === 'import'" class="exchange-card" aria-labelledby="archive-import-title">
      <div class="exchange-card__icon" aria-hidden="true"><IconUpload :size="28" /></div>
      <div class="exchange-card__copy">
        <p>{{ format === 'gedcom' ? '通用家谱交换' : 'Branchloom 项目包' }}</p>
        <h2 id="archive-import-title">{{ format === 'gedcom' ? '导入 GEDCOM 家谱' : '导入 .blp 项目' }}</h2>
        <span v-if="format === 'gedcom'">选择 .ged 或 .gedcom 文件，将人物、姓名、生卒信息、地点和家庭关系导入为一个项目。原文件不会被修改。</span>
        <span v-else>选择从另一台设备导出或此前备份的项目包。导入内容包括人物、关系、事件、来源和本地附件。</span>
      </div>
      <label class="exchange-card__overwrite">
        <input v-model="overwrite" type="checkbox" name="overwriteProject" />
        <span><strong>覆盖同 ID 的现有项目</strong><small>仅在确认要用所选文件替换本地同一项目时勾选。</small></span>
      </label>
      <BaseButton :name="format === 'gedcom' ? '选择 GEDCOM 文件' : '选择 .blp 项目包'" size="lg" :loading="busy" :disabled="!nativeArchivesAvailable" @click="chooseFileToImport">
        <IconArchive :size="19" aria-hidden="true" />
        {{ format === 'gedcom' ? '选择 GEDCOM 文件' : '选择项目包' }}
      </BaseButton>
    </section>

    <section v-else class="exchange-card" aria-labelledby="archive-export-title">
      <div class="exchange-card__icon" aria-hidden="true"><IconDownload :size="28" /></div>
      <div class="exchange-card__copy">
        <p>{{ format === 'gedcom' ? '通用家谱交换' : '完整项目备份' }}</p>
        <h2 id="archive-export-title">{{ format === 'gedcom' ? '导出 GEDCOM 家谱' : '导出 .blp 项目' }}</h2>
        <span v-if="format === 'gedcom'">导出人物、姓名、生卒信息、地点和家庭关系。来源、附件等 Branchloom 扩展资料请用 .blp 完整备份。</span>
        <span v-else>把当前项目及其本地附件保存为一个可再次导入的项目包。</span>
      </div>
      <div v-if="!project && !failure" class="exchange-card__project" role="status">正在读取当前项目…</div>
      <div v-else-if="project" class="exchange-card__project">
        <span>准备导出</span><strong>{{ project.name }}</strong><code>{{ project.id }}</code>
      </div>
      <BaseButton :name="format === 'gedcom' ? '导出 GEDCOM 文件' : '导出 .blp 项目包'" size="lg" :loading="busy" :disabled="!nativeArchivesAvailable || !project" @click="chooseExportDestination">
        <IconDownload :size="19" aria-hidden="true" />
        选择保存位置
      </BaseButton>
    </section>

    <p v-if="!nativeArchivesAvailable" class="exchange-view__availability" role="note">
      文件导入与导出需要在 Branchloom 桌面版中使用。
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
.exchange-view__formats { min-width: 0; margin: 0; padding: 0; border: 0; }
.exchange-view__formats legend { margin-bottom: var(--space-2); color: var(--color-muted); font-size: .78rem; font-weight: 700; }
.exchange-view__format-options { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.exchange-view__formats label { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); cursor: pointer; }
.exchange-view__formats label:focus-within { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.exchange-view__formats label.exchange-view__format--selected { border-color: color-mix(in srgb, var(--color-primary) 50%, var(--color-border)); background: color-mix(in srgb, var(--color-primary) 7%, var(--color-surface)); }
.exchange-view__formats input { margin-top: .2rem; }
.exchange-view__formats span { display: grid; gap: .2rem; }
.exchange-view__formats small { color: var(--color-muted); }
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
@media (max-width: 38rem) { .exchange-view__mode-switch, .exchange-view__format-options { grid-template-columns: 1fr; } }
</style>
