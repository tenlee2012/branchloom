<script setup lang="ts">
import { IconDeviceFloppy, IconPhotoPlus } from '@tabler/icons-vue'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProjectManagementTabs from '../../../app/components/ProjectManagementTabs.vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseField from '../../../design-system/BaseField.vue'
import type { Project } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  refreshNativeRepository,
  setLocalAttachment,
} from '../../../shared/repository/TauriRepository'
import DangerZone from '../components/DangerZone.vue'
import appIcon from '../../../../src-tauri/icons/icon.png'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const session = useSessionStore()
const projectId = computed(() => String(route.params.projectId ?? ''))
const project = ref<Project>()
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const validationError = ref('')
const saveFailure = ref('')
const dangerFailure = ref('')
const saving = ref(false)
const dangerBusy = ref(false)
const coverFile = ref<File>()
const coverInput = ref<HTMLInputElement>()
const coverPreview = ref('')
const coverFailure = ref('')
let loadRequest = 0

const draft = reactive({
  name: '',
  description: '',
})

const coverSource = computed(() => coverPreview.value || project.value?.coverUrl || appIcon)
const hasProjectCover = computed(() => Boolean(coverPreview.value || project.value?.coverUrl))

function replaceDraft(value: Project) {
  draft.name = value.name
  draft.description = value.description
}

async function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')))
    reader.addEventListener('error', () => reject(reader.error ?? new Error('图片无法读取')))
    reader.readAsDataURL(file)
  })
}

function clearCoverSelection() {
  coverFile.value = undefined
  coverPreview.value = ''
  coverFailure.value = ''
  if (coverInput.value) coverInput.value.value = ''
}

async function selectCover(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  saveFailure.value = ''
  coverFailure.value = ''
  if (!file.type.startsWith('image/')) {
    clearCoverSelection()
    coverFailure.value = '请选择图片文件。'
    return
  }
  try {
    coverPreview.value = await fileDataUrl(file)
    coverFile.value = file
  } catch (error) {
    clearCoverSelection()
    coverFailure.value = error instanceof Error ? error.message : '项目封面无法预览'
  }
}

async function loadSettings() {
  const request = ++loadRequest
  const scopedProjectId = projectId.value
  loadState.value = 'loading'
  loadError.value = ''
  try {
    const nextProject = await repository.getProject(scopedProjectId)
    if (request !== loadRequest) return
    project.value = nextProject
    replaceDraft(nextProject)
    clearCoverSelection()
    loadState.value = 'ready'
  } catch (error) {
    if (request !== loadRequest) return
    loadError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '项目设置暂时无法读取'
    loadState.value = 'error'
  }
}

watch(projectId, () => { void loadSettings() }, { immediate: true })

async function saveSettings() {
  if (saving.value || !project.value) return
  const name = draft.name.trim()
  if (!name) {
    validationError.value = '请填写项目名称。'
    return
  }
  validationError.value = ''
  saveFailure.value = ''
  saving.value = true
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const saved = await repository.updateProject(project.value.id, {
      name,
      description: draft.description.trim(),
    })
    if (coverFile.value) {
      await setLocalAttachment(saved.id, 'project', saved.id, 'cover', coverFile.value)
      await refreshNativeRepository(repository, true)
    }
    const refreshed = await repository.getProject(saved.id)
    project.value = refreshed
    replaceDraft(refreshed)
    clearCoverSelection()
    session.openProject(refreshed, repository.getHistoryState())
    session.saveStatus = 'saved'
  } catch (error) {
    const details = error instanceof Error && error.message.trim()
      ? error.message
      : '项目设置暂时无法保存'
    saveFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    saving.value = false
  }
}

async function deleteProject() {
  if (!project.value || dangerBusy.value) return
  dangerBusy.value = true
  dangerFailure.value = ''
  session.saveStatus = 'saving'
  try {
    await repository.deleteProject(project.value.id)
    session.closeProject(project.value.id)
    await router.replace({ name: 'home' })
  } catch (error) {
    const details = error instanceof Error && error.message.trim()
      ? error.message
      : '当前项目暂时无法删除'
    dangerFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    dangerBusy.value = false
  }
}

</script>

<template>
  <section class="project-settings" aria-label="项目设置">
    <ProjectManagementTabs />
    <div v-if="loadState === 'loading'" class="project-settings__state" role="status">正在读取项目设置…</div>
    <div v-else-if="loadState === 'error'" class="project-settings__state project-settings__error" role="alert">
      <strong>项目设置暂时无法读取</strong><span>{{ loadError }}</span>
      <BaseButton size="sm" variant="secondary" @click="loadSettings">重新读取</BaseButton>
    </div>
    <template v-else-if="project">
      <form class="project-settings__form" novalidate @submit.prevent="saveSettings">
        <header class="project-settings__form-heading">
          <div>
            <span>基础资料</span>
            <h2>项目身份</h2>
            <p>管理项目的展示信息。</p>
          </div>
          <small class="project-settings__stable-id">
            <span>稳定 ID</span>
            <code>{{ project.id }}</code>
          </small>
        </header>

        <section class="project-settings__section" aria-labelledby="project-profile-title">
          <header class="project-settings__section-heading">
            <div>
              <h3 id="project-profile-title">项目信息</h3>
              <p>这些内容会出现在项目列表、顶部栏与侧边栏中。</p>
            </div>
          </header>
          <div class="project-settings__fields">
            <BaseField id="project-name" label="项目名称" required>
              <input id="project-name" v-model="draft.name" name="projectName" autocomplete="off" />
            </BaseField>
            <BaseField
              id="project-cover"
              class="project-settings__field--wide"
              label="项目封面"
              hint="点击预览选择图片；保存项目设置后，文件才会复制到本地资料目录并生效。"
              :error="coverFailure"
            >
              <label
                class="project-settings__cover-picker"
                :class="{
                  'project-settings__cover-picker--empty': !hasProjectCover,
                  'project-settings__cover-picker--staged': Boolean(coverFile),
                }"
              >
                <img
                  :src="coverSource"
                  :alt="hasProjectCover ? `${draft.name || project.name}的项目封面` : '尚未设置项目封面'"
                />
                <span class="project-settings__cover-action">
                  <IconPhotoPlus :size="20" aria-hidden="true" />
                  {{ hasProjectCover ? '更换封面' : '上传封面' }}
                </span>
                <input
                  id="project-cover"
                  ref="coverInput"
                  name="projectCoverFile"
                  type="file"
                  accept="image/*"
                  @change="selectCover"
                />
              </label>
              <small v-if="coverFile" class="project-settings__cover-staged">
                {{ coverFile.name }} · 待保存
              </small>
            </BaseField>
            <BaseField id="project-description" class="project-settings__field--wide" label="项目简介">
              <textarea
                id="project-description"
                v-model="draft.description"
                name="projectDescription"
                rows="4"
              />
            </BaseField>
          </div>
        </section>

        <div v-if="validationError || saveFailure" class="project-settings__messages">
          <p v-if="validationError" class="project-settings__error" role="alert">{{ validationError }}</p>
          <p v-if="saveFailure" class="project-settings__error" role="alert">{{ saveFailure }}</p>
        </div>

        <footer class="project-settings__actions">
          <p><strong>保存后立即生效</strong><span>项目名称与封面会同步更新到桌面端界面。</span></p>
          <BaseButton name="保存项目设置" type="submit" size="lg" :loading="saving">
            <IconDeviceFloppy :size="18" aria-hidden="true" />
            保存项目设置
          </BaseButton>
        </footer>
      </form>
      <DangerZone
        :project="project"
        :busy="dangerBusy"
        :failure="dangerFailure"
        @delete-confirmed="deleteProject"
      />
    </template>
  </section>
</template>

<style scoped>
.project-settings {
  display: grid;
  width: min(64rem, 100%);
  gap: var(--space-6);
  margin: 0 auto;
}

.project-settings__form {
  display: grid;
  gap: var(--space-6);
  padding: clamp(1.25rem, 3vw, 2rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.project-settings__form-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: var(--space-6);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.project-settings__form-heading > div {
  min-width: 0;
}

.project-settings__form-heading > div > span {
  color: var(--color-accent);
  font-size: .75rem;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.project-settings__form h2 {
  margin: var(--space-1) 0 0;
  font-family: var(--font-heading);
  font-size: clamp(1.45rem, 3vw, 1.8rem);
  line-height: 1.25;
}

.project-settings__form-heading p,
.project-settings__section-heading p {
  margin: var(--space-1) 0 0;
  color: var(--color-muted);
  font-size: .875rem;
}

.project-settings__stable-id {
  display: grid;
  flex: 0 0 auto;
  gap: .15rem;
  color: var(--color-muted);
  font-size: .75rem;
  text-align: right;
}

.project-settings__stable-id span {
  font-weight: 650;
}

.project-settings__stable-id code {
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: .78rem;
}

.project-settings__section {
  display: grid;
  gap: var(--space-4);
}

.project-settings__section + .project-settings__section {
  padding-top: var(--space-6);
  border-top: 1px solid var(--color-border);
}

.project-settings__section-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-4);
}

.project-settings__section-heading h3 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.4;
}

.project-settings__fields {
  display: grid;
  align-items: start;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-5) var(--space-6);
}

.project-settings__field--wide {
  grid-column: 1 / -1;
}

.project-settings__cover-picker {
  position: relative;
  display: block;
  min-height: 8.5rem;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-muted-surface);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.project-settings__cover-picker:hover {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-border));
  transform: translateY(-1px);
}

.project-settings__cover-picker:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
}

.project-settings__cover-picker--staged {
  outline: 2px solid color-mix(in srgb, var(--color-primary) 34%, transparent);
  outline-offset: 2px;
}

.project-settings__cover-picker img {
  display: block;
  width: 100%;
  height: 8.5rem;
  object-fit: cover;
}

.project-settings__cover-picker--empty img {
  padding: 2rem;
  object-fit: contain;
  opacity: .72;
}

.project-settings__cover-action {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  display: inline-flex;
  min-height: 2.25rem;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid rgb(255 253 248 / 72%);
  border-radius: var(--radius-sm);
  background: rgb(20 56 43 / 84%);
  color: #fffdf8;
  font-size: .8125rem;
  font-weight: 700;
  pointer-events: none;
}

.project-settings__cover-picker input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0;
  opacity: 0;
  cursor: pointer;
}

.project-settings__cover-staged {
  color: var(--color-primary);
  font-size: .75rem;
  font-weight: 650;
}

.project-settings__form input:not([type="file"]),
.project-settings__form textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 2.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: #fffefa;
  color: var(--color-text);
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
}

.project-settings__form input:not([type="file"]) {
  padding: 0 .875rem;
}

.project-settings__form textarea {
  min-height: 6.75rem;
  padding: .7rem .875rem;
  line-height: 1.55;
  resize: vertical;
}

.project-settings__form input:not([type="file"]):hover,
.project-settings__form textarea:hover {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
}

.project-settings__form input:not([type="file"]):focus-visible,
.project-settings__form textarea:focus-visible {
  border-color: var(--color-primary);
  outline: none;
  box-shadow: var(--focus-ring);
}

.project-settings__messages {
  display: grid;
  gap: var(--space-2);
}

.project-settings__error {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.project-settings__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--color-border);
}

.project-settings__actions p {
  display: grid;
  gap: .1rem;
  margin: 0;
  color: var(--color-muted);
  font-size: .8125rem;
}

.project-settings__actions strong {
  color: var(--color-text);
  font-size: .875rem;
}

.project-settings__state {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  padding: var(--space-7);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
}

@media (max-width: 48rem) {
  .project-settings__form-heading,
  .project-settings__section-heading,
  .project-settings__actions {
    align-items: stretch;
    flex-direction: column;
  }

  .project-settings__stable-id {
    text-align: left;
  }

  .project-settings__fields {
    grid-template-columns: 1fr;
  }

  .project-settings__field--wide {
    grid-column: auto;
  }

  .project-settings__actions :deep(.base-button) {
    width: 100%;
  }
}
</style>
