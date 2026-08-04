<script setup lang="ts">
import {
  IconCalendarEvent,
  IconCamera,
  IconPhoto,
  IconPhotoPlus,
  IconTimeline,
  IconUserCircle,
  IconX,
} from '@tabler/icons-vue'
import { computed, ref, toRef, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import personPlaceholder from '../../../assets/person-placeholder-round.png'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import type { Attachment, AttachmentLink, FamilyEvent, Person, Place } from '../../../shared/domain/types'
import { getPrimaryName } from '../../../shared/domain/personNames'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  importLocalAttachment,
  refreshNativeRepository,
  setLocalAttachment,
  usesManagedLocalStorage,
} from '../../../shared/repository/TauriRepository'
import PlaceManager from '../../timeline/components/PlaceManager.vue'
import { usePersonEditor } from '../composables/usePersonEditor'
import PersonNameFields from './PersonNameFields.vue'
import PersonEventsModule from './PersonEventsModule.vue'

const props = withDefaults(defineProps<{
  projectId: string
  person?: Person
  events?: FamilyEvent[]
  layout?: 'default' | 'page'
}>(), { events: () => [], layout: 'default' })
const emit = defineEmits<{
  cancel: []
  saved: [person: Person]
  addEvent: []
  editEvent: [event: FamilyEvent]
}>()
const repository = useBranchloomRepository()
const session = useSessionStore()
const sourcePerson = toRef(props, 'person')
const projectId = toRef(props, 'projectId')
const editor = usePersonEditor(repository, session, projectId, sourcePerson)
const confirmClose = ref(false)
const avatarFile = ref<File>()
const avatarInput = ref<HTMLInputElement>()
const avatarPreview = ref('')
const avatarFailure = ref('')
const mediaFailure = ref('')
const avatarBusy = ref(false)
const places = ref<Place[]>([])
const placesFailure = ref('')
const placeManagerOpen = ref(false)
const existingAlbum = ref<Array<{ attachment: Attachment; link: AttachmentLink }>>([])
const stagedAlbum = ref<Array<{ id: string; file: File; previewUrl: string }>>([])
const albumInput = ref<HTMLInputElement>()
const managedLocalStorage = usesManagedLocalStorage(repository)
const activePageModule = ref<'overview' | 'life' | 'events' | 'materials'>('overview')

let fallbackId = 0
function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `${prefix}-${Date.now()}-${fallbackId}`
}

const editingName = computed(() => props.person ? getPrimaryName(props.person) : '新人物')
const pageTitle = computed(() => props.person ? `编辑${editingName.value}` : '新建人物')
const avatarSource = computed(() => avatarPreview.value || props.person?.avatarUrl || personPlaceholder)
const busy = computed(() => editor.saving.value || avatarBusy.value)

async function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')))
    reader.addEventListener('error', () => reject(reader.error ?? new Error('图片无法读取')))
    reader.readAsDataURL(file)
  })
}

async function loadPlaces() {
  placesFailure.value = ''
  try {
    places.value = await repository.listPlaces(props.projectId)
  } catch (error) {
    places.value = []
    placesFailure.value = error instanceof Error ? error.message : '地点资料无法读取'
  }
}

async function loadAlbum() {
  if (!props.person) {
    existingAlbum.value = []
    return
  }
  try {
    const [attachments, links] = await Promise.all([
      repository.listAttachments(props.projectId),
      repository.listAttachmentLinks(props.projectId),
    ])
    const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]))
    existingAlbum.value = links
      .filter((link) => link.targetType === 'person'
        && link.targetId === props.person?.id
        && link.role === 'media')
      .map((link) => ({ attachment: attachmentById.get(link.attachmentId), link }))
      .filter((item): item is { attachment: Attachment; link: AttachmentLink } =>
        Boolean(item.attachment?.mimeType.startsWith('image/')))
  } catch (error) {
    mediaFailure.value = error instanceof Error ? error.message : '人物相册无法读取'
  }
}

function clearSelectedFiles() {
  avatarFile.value = undefined
  avatarPreview.value = ''
  stagedAlbum.value = []
  if (avatarInput.value) avatarInput.value.value = ''
  if (albumInput.value) albumInput.value.value = ''
}

watch(
  () => [props.person?.id, props.projectId] as const,
  () => {
    editor.reset()
    clearSelectedFiles()
    avatarFailure.value = ''
    mediaFailure.value = ''
    confirmClose.value = false
    activePageModule.value = 'overview'
    void loadPlaces()
    void loadAlbum()
  },
  { immediate: true },
)

function requestClose() {
  if (busy.value) return
  if (editor.dirty.value || avatarFile.value || stagedAlbum.value.length) confirmClose.value = true
  else emit('cancel')
}

function discardAndClose() {
  confirmClose.value = false
  editor.reset()
  clearSelectedFiles()
  emit('cancel')
}

async function selectAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  avatarFile.value = file
  avatarFailure.value = ''
  try {
    avatarPreview.value = await fileDataUrl(file)
  } catch (error) {
    avatarFailure.value = error instanceof Error ? error.message : '头像图片无法预览'
  }
}

async function selectAlbumPhotos(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])].filter((file) => file.type.startsWith('image/'))
  input.value = ''
  if (!files.length) return
  mediaFailure.value = ''
  try {
    const next = await Promise.all(files.map(async (file) => ({
      id: createId('staged-photo'),
      file,
      previewUrl: await fileDataUrl(file),
    })))
    stagedAlbum.value = [...stagedAlbum.value, ...next]
  } catch (error) {
    mediaFailure.value = error instanceof Error ? error.message : '相册照片无法预览'
  }
}

function removeStagedPhoto(id: string) {
  stagedAlbum.value = stagedAlbum.value.filter((photo) => photo.id !== id)
}

async function saveBrowserAvatar(saved: Person, file: File): Promise<Person> {
  return repository.savePerson({ ...saved, avatarUrl: await fileDataUrl(file) })
}

async function saveAlbumPhoto(person: Person, file: File) {
  const attachmentId = createId('attachment')
  let attachment: Attachment
  if (managedLocalStorage) {
    const imported = await importLocalAttachment(props.projectId, file)
    const duplicate = (await repository.listAttachments(props.projectId))
      .find(({ contentHash }) => contentHash === imported.contentHash)
    attachment = duplicate ?? await repository.saveAttachment({
      id: attachmentId,
      projectId: props.projectId,
      name: imported.name,
      mimeType: imported.mimeType,
      size: imported.size,
      contentHash: imported.contentHash,
      missing: false,
    })
  } else {
    attachment = await repository.saveAttachment({
      id: attachmentId,
      projectId: props.projectId,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: await fileDataUrl(file),
      contentHash: `prototype-media:${attachmentId}`,
      missing: false,
    })
  }
  await repository.saveAttachmentLink({
    id: createId('attachment-link'),
    projectId: props.projectId,
    attachmentId: attachment.id,
    targetType: 'person',
    targetId: person.id,
    role: 'media',
  })
}

async function submit() {
  if (busy.value) return
  const saved = await editor.save()
  if (!saved) return
  let result = saved
  let filePhase: 'avatar' | 'album' = 'avatar'
  avatarBusy.value = true
  avatarFailure.value = ''
  mediaFailure.value = ''
  try {
    if (avatarFile.value) {
      if (managedLocalStorage) {
        await setLocalAttachment(props.projectId, 'person', saved.id, 'avatar', avatarFile.value)
        await refreshNativeRepository(repository, true)
        result = await repository.getPerson(saved.id)
      } else {
        result = await saveBrowserAvatar(saved, avatarFile.value)
      }
    }
    filePhase = 'album'
    for (const photo of stagedAlbum.value) await saveAlbumPhoto(result, photo.file)
    if (managedLocalStorage && stagedAlbum.value.length) await refreshNativeRepository(repository, true)
    if (stagedAlbum.value.length) await session.refreshHistory(repository)
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message
      : '本地图片暂时无法保存'
    if (filePhase === 'avatar') avatarFailure.value = message
    else mediaFailure.value = message
    return
  } finally {
    avatarBusy.value = false
  }
  emit('saved', result)
}

function inputValue(event: Event) {
  return (event.target as HTMLInputElement).value
}

defineExpose({ requestClose, submit })
</script>

<template>
  <form
    class="person-editor"
    :class="{ 'person-editor--page': layout === 'page' }"
    novalidate
    @submit.prevent="submit"
  >
    <header v-if="layout === 'page'" class="person-editor__page-heading">
      <label class="person-editor__avatar-picker" for="person-page-avatar">
        <img :src="avatarSource" :alt="`${editingName}的头像预览`" />
        <span class="person-editor__avatar-action" aria-hidden="true"><IconCamera :size="17" /></span>
        <input
          id="person-page-avatar"
          ref="avatarInput"
          name="avatarFile"
          type="file"
          accept="image/*"
          aria-label="点击头像更换照片"
          @change="selectAvatar"
        />
      </label>
      <div class="person-editor__title-block">
        <p>人物档案</p>
        <h1 id="person-edit-title">{{ pageTitle }}</h1>
        <span>点击头像即可选择新的照片，保存后生效。</span>
      </div>
      <div class="person-editor__page-actions">
        <BaseButton name="取消" variant="secondary" :disabled="busy" @click="requestClose">取消</BaseButton>
        <BaseButton name="保存" type="submit" :loading="busy">保存</BaseButton>
      </div>
    </header>

    <nav v-if="layout === 'page'" class="person-editor__module-nav" aria-label="人物编辑模块" role="tablist">
      <button
        id="person-edit-tab-overview"
        :class="['person-editor__module-link', { 'person-editor__module-link--active': activePageModule === 'overview' }]"
        type="button"
        role="tab"
        :aria-selected="activePageModule === 'overview'"
        :tabindex="activePageModule === 'overview' ? 0 : -1"
        aria-controls="person-edit-panel-overview"
        @click="activePageModule = 'overview'"
      >
        <IconUserCircle :size="18" aria-hidden="true" />人物概览
      </button>
      <button
        id="person-edit-tab-life"
        :class="['person-editor__module-link', { 'person-editor__module-link--active': activePageModule === 'life' }]"
        type="button"
        role="tab"
        :aria-selected="activePageModule === 'life'"
        :tabindex="activePageModule === 'life' ? 0 : -1"
        aria-controls="person-edit-life"
        @click="activePageModule = 'life'"
      >
        <IconTimeline :size="18" aria-hidden="true" />生平轨迹
      </button>
      <button
        v-if="person"
        id="person-edit-tab-materials"
        :class="['person-editor__module-link', { 'person-editor__module-link--active': activePageModule === 'materials' }]"
        type="button"
        role="tab"
        :aria-selected="activePageModule === 'materials'"
        :tabindex="activePageModule === 'materials' ? 0 : -1"
        aria-controls="person-edit-materials"
        @click="activePageModule = 'materials'"
      >
        <IconPhoto :size="18" aria-hidden="true" />资料与相册
      </button>
      <button
        v-if="person"
        id="person-edit-tab-events"
        :class="['person-editor__module-link', { 'person-editor__module-link--active': activePageModule === 'events' }]"
        type="button"
        role="tab"
        :aria-selected="activePageModule === 'events'"
        :tabindex="activePageModule === 'events' ? 0 : -1"
        aria-controls="person-edit-events"
        @click="activePageModule = 'events'"
      >
        <IconCalendarEvent :size="18" aria-hidden="true" />事件
      </button>
    </nav>

    <div class="person-editor__body">
      <aside
        id="person-edit-panel-overview"
        v-show="layout !== 'page' || activePageModule === 'overview'"
        class="person-editor__secondary"
        aria-label="人物结构化编辑"
        :role="layout === 'page' ? 'tabpanel' : undefined"
        :aria-labelledby="layout === 'page' ? 'person-edit-tab-overview' : undefined"
      >
      <section class="person-editor__module person-editor__names-module" aria-label="姓名与称谓模块">
      <PersonNameFields
        :names="editor.draft.value.names"
        @update:names="editor.draft.value.names = $event"
      />
      </section>

      <section id="person-edit-overview" class="person-editor__module person-editor__basics-module" aria-labelledby="person-edit-basics-heading">
        <header class="person-editor__module-heading">
          <div>
            <h2 id="person-edit-basics-heading">基本资料</h2>
            <p>维护人物状态、时间与地点。</p>
          </div>
        </header>
      <div class="person-editor__grid">
        <BaseField id="person-status" label="生存状态">
          <BaseSelectControl>
            <select id="person-status" v-model="editor.draft.value.status" name="status">
              <option value="unknown">未知</option>
              <option value="living">在世</option>
              <option value="deceased">已故</option>
            </select>
          </BaseSelectControl>
        </BaseField>
        <BaseField id="person-sex" label="性别">
          <BaseSelectControl>
            <select id="person-sex" v-model="editor.draft.value.sex" name="sex">
              <option value="unknown">未知</option>
              <option value="female">女性</option>
              <option value="male">男性</option>
              <option value="nonbinary">非二元</option>
            </select>
          </BaseSelectControl>
        </BaseField>
        <BaseField id="person-birth" label="出生日期" hint="支持 YYYY、YYYY-MM 或 YYYY-MM-DD">
          <template #default="field">
            <input
              id="person-birth"
              name="birthDate"
              :value="editor.draft.value.birth?.display ?? ''"
              :aria-describedby="field.describedBy"
              @input="editor.setDate('birth', inputValue($event))"
            />
          </template>
        </BaseField>
        <BaseField id="person-death" label="死亡日期" hint="不确定时也可以保留原始文字">
          <template #default="field">
            <input
              id="person-death"
              name="deathDate"
              :value="editor.draft.value.death?.display ?? ''"
              :aria-describedby="field.describedBy"
              @input="editor.setDate('death', inputValue($event))"
            />
          </template>
        </BaseField>
        <BaseField id="person-birth-place" label="出生地">
          <BaseSelectControl>
            <select id="person-birth-place" v-model="editor.draft.value.birthPlaceId" name="birthPlaceId">
              <option :value="undefined">未设置出生地</option>
              <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
        <BaseField id="person-death-place" label="死亡地">
          <BaseSelectControl>
            <select id="person-death-place" v-model="editor.draft.value.deathPlaceId" name="deathPlaceId">
              <option :value="undefined">未设置死亡地</option>
              <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>
      <div class="person-editor__place-tools">
        <p v-if="placesFailure" role="alert">{{ placesFailure }}</p>
        <span v-else>出生地与死亡地共用项目地点资料。</span>
        <BaseButton name="管理地点" size="sm" variant="secondary" @click="placeManagerOpen = true">管理地点</BaseButton>
      </div>

      <div
        v-if="editor.lifeDateWarnings.value.length"
        class="person-editor__warning"
        role="status"
        data-life-date-warning
      >
        {{ editor.lifeDateWarnings.value[0]?.message }}
      </div>
      </section>
      </aside>

      <main class="person-editor__primary">
      <section
        id="person-edit-life"
        v-show="layout !== 'page' || activePageModule === 'life'"
        class="person-editor__module person-editor__life-module"
        aria-labelledby="person-edit-life-heading"
        :role="layout === 'page' ? 'tabpanel' : undefined"
      >
        <header class="person-editor__module-heading">
          <div>
            <h2 id="person-edit-life-heading">生平与地点</h2>
            <p>记录人物经历的概要；时间与地点在右侧基本资料中维护。</p>
          </div>
        </header>
      <BaseField id="person-biography" label="生平摘要">
        <textarea id="person-biography" v-model="editor.draft.value.biography" name="biography" rows="5" />
      </BaseField>
      </section>

      <PersonEventsModule
        v-if="layout === 'page' && person"
        id="person-edit-events"
        v-show="activePageModule === 'events'"
        class="person-editor__module"
        :person-id="person.id"
        :project-id="projectId"
        :events="events"
        :places="places"
        aria-labelledby="person-edit-tab-events"
        role="tabpanel"
        @create="emit('addEvent')"
        @edit="emit('editEvent', $event)"
      />

      <section
        v-if="layout === 'page' && person"
        v-show="activePageModule === 'materials'"
        id="person-edit-materials"
        class="person-editor__module person-editor__album"
        aria-labelledby="person-album-title"
        role="tabpanel"
      >
        <header>
          <div>
            <h2 id="person-album-title">人物相册</h2>
            <p>集中保存人物照片；新选择的照片会在保存人物资料时加入相册。</p>
          </div>
          <BaseButton name="添加照片" size="sm" variant="secondary" @click="albumInput?.click()">
            <IconPhotoPlus :size="18" aria-hidden="true" />添加照片
          </BaseButton>
          <input ref="albumInput" name="albumFiles" type="file" accept="image/*" multiple @change="selectAlbumPhotos" />
        </header>
        <div v-if="existingAlbum.length || stagedAlbum.length" class="person-editor__album-grid">
          <figure v-for="item in existingAlbum" :key="item.link.id">
            <img v-if="item.attachment.previewUrl" :src="item.attachment.previewUrl" :alt="item.attachment.name" />
            <span v-else class="person-editor__photo-fallback"><IconPhoto :size="28" aria-hidden="true" /></span>
            <figcaption>{{ item.attachment.name }}</figcaption>
          </figure>
          <figure v-for="photo in stagedAlbum" :key="photo.id" class="person-editor__photo--staged">
            <img :src="photo.previewUrl" :alt="`${photo.file.name}（待保存）`" />
            <figcaption>{{ photo.file.name }} · 待保存</figcaption>
            <button type="button" :aria-label="`移除待保存照片：${photo.file.name}`" @click="removeStagedPhoto(photo.id)">
              <IconX :size="16" aria-hidden="true" />
            </button>
          </figure>
        </div>
        <div v-else class="person-editor__album-empty">
          <IconPhoto :size="30" aria-hidden="true" />
          <span>尚未添加照片</span>
        </div>
      </section>

      <BaseField
        v-else-if="layout !== 'page'"
        id="person-avatar"
        label="人物头像"
        hint="从本机选择图片；保存后会复制到有谱的本地资料目录。"
      >
        <input id="person-avatar" ref="avatarInput" name="avatarFile" type="file" accept="image/*" @change="selectAvatar" />
        <small v-if="avatarFile">已选择：{{ avatarFile.name }}</small>
      </BaseField>
      </main>

      <section
        v-show="layout !== 'page' || activePageModule === 'life'"
        class="person-editor__module person-editor__notes-module"
        aria-labelledby="person-edit-notes-heading"
      >
        <header class="person-editor__module-heading">
          <div>
            <h2 id="person-edit-notes-heading">整理笔记</h2>
            <p>仅用于资料整理过程。</p>
          </div>
        </header>
        <BaseField id="person-notes" label="内部整理笔记">
          <textarea id="person-notes" v-model="editor.draft.value.notes" name="notes" rows="5" />
        </BaseField>
      </section>

      <p v-if="editor.validationError.value" class="person-editor__error" role="alert">
        {{ editor.validationError.value }}
      </p>
      <div v-if="editor.saveFailure.value" class="person-editor__error" role="alert">
        <strong>保存失败，人物资料尚未写入。</strong>
        <details open>
          <summary>错误详情</summary>
          <p>{{ editor.saveFailure.value }}</p>
        </details>
      </div>
      <div v-if="avatarFailure" class="person-editor__error" role="alert">
        <strong>人物资料已保存，但头像文件尚未写入。</strong>
        <p>{{ avatarFailure }}</p>
      </div>
      <div v-if="mediaFailure" class="person-editor__error" role="alert">
        <strong>相册照片暂时无法处理。</strong>
        <p>{{ mediaFailure }}</p>
      </div>

      <footer v-if="layout !== 'page'" class="person-editor__actions">
        <BaseButton name="取消" variant="secondary" :disabled="busy" @click="requestClose">取消</BaseButton>
        <BaseButton name="保存" type="submit" :loading="busy">保存</BaseButton>
      </footer>
    </div>
  </form>

  <PlaceManager
    :open="placeManagerOpen"
    :project-id="projectId"
    :places="places"
    @close="placeManagerOpen = false"
    @changed="loadPlaces"
  />

  <BaseDialog
    :open="confirmClose"
    title="放弃未保存的修改？"
    description="关闭后，这次填写的内容不会保留。"
    close-label="继续编辑"
    @close="confirmClose = false"
  >
    <div class="person-editor__confirm-actions">
      <BaseButton name="继续编辑" variant="secondary" @click="confirmClose = false">继续编辑</BaseButton>
      <BaseButton name="放弃修改" variant="danger" @click="discardAndClose">放弃修改</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.person-editor { display: grid; gap: var(--space-5); }
.person-editor__body { display: grid; gap: var(--space-5); }
.person-editor--page { gap: var(--space-5); }
.person-editor--page .person-editor__body { padding: clamp(1.25rem, 3vw, 2.5rem); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.person-editor__page-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: clamp(1rem, 2.5vw, 1.75rem); padding-bottom: var(--space-4); border-bottom: 1px solid var(--color-border); }
.person-editor__avatar-picker { position: relative; display: block; width: clamp(5.25rem, 9vw, 6.5rem); height: clamp(5.25rem, 9vw, 6.5rem); flex: 0 0 auto; overflow: hidden; border: 2px solid var(--color-surface); border-radius: 50%; background: var(--color-muted-surface); box-shadow: 0 0 0 1px var(--color-border), var(--shadow-sm); cursor: pointer; }
.person-editor__avatar-picker img { width: 100%; height: 100%; object-fit: cover; }
.person-editor__avatar-picker input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.person-editor__avatar-action { position: absolute; right: .25rem; bottom: .25rem; display: grid; width: 1.8rem; height: 1.8rem; place-items: center; border: 2px solid var(--color-surface); border-radius: 50%; background: var(--color-primary); color: var(--color-surface); pointer-events: none; }
.person-editor__title-block { min-width: 0; }
.person-editor__title-block p { margin: 0; color: var(--color-accent); font-size: .75rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
.person-editor__title-block h1 { margin: var(--space-1) 0 0; font-family: var(--font-heading); font-size: clamp(2rem, 4.6vw, 3.5rem); font-weight: 560; line-height: 1.05; }
.person-editor__title-block span { display: block; margin-top: var(--space-2); color: var(--color-muted); font-size: .8125rem; }
.person-editor__page-actions { display: flex; align-items: center; gap: var(--space-2); }
.person-editor__grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.person-editor input,
.person-editor textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.person-editor__place-tools { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--color-muted); font-size: .8125rem; }
.person-editor__place-tools p { margin: 0; color: var(--color-danger); }
.person-editor__place-tools :deep(.base-button) { flex: 0 0 auto; white-space: nowrap; }
.person-editor__warning { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-warning-surface); color: var(--color-warning); }
.person-editor__error { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.person-editor__error p { margin-bottom: 0; }
.person-editor__album { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.person-editor__album > header { display: grid; grid-template-columns: 1fr auto; align-items: start; gap: var(--space-3); }
.person-editor__album h2 { margin: 0; font-size: 1rem; }
.person-editor__album p { margin: var(--space-1) 0 0; color: var(--color-muted); font-size: .8125rem; }
.person-editor__album > header > input { position: absolute; width: 1px; height: 1px; min-height: 0; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.person-editor__album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: var(--space-3); }
.person-editor__album figure { position: relative; min-width: 0; margin: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); }
.person-editor__album figure > img,
.person-editor__photo-fallback { display: grid; width: 100%; aspect-ratio: 4 / 3; place-items: center; object-fit: cover; background: var(--color-surface); color: var(--color-muted); }
.person-editor__album figcaption { padding: var(--space-2); overflow: hidden; color: var(--color-muted); font-size: .75rem; text-overflow: ellipsis; white-space: nowrap; }
.person-editor__photo--staged { outline: 2px solid color-mix(in srgb, var(--color-primary) 35%, transparent); }
.person-editor__photo--staged button { position: absolute; top: .35rem; right: .35rem; display: grid; width: 1.75rem; height: 1.75rem; min-height: 0; padding: 0; place-items: center; border: 0; border-radius: 50%; background: color-mix(in srgb, var(--color-text) 78%, transparent); color: var(--color-surface); cursor: pointer; }
.person-editor__album-empty { display: flex; min-height: 6.5rem; align-items: center; justify-content: center; gap: var(--space-2); border: 1px dashed var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-muted); }
.person-editor__actions,
.person-editor__confirm-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.person-editor__module-nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--color-border); }
.person-editor__module-link { position: relative; display: inline-flex; min-height: 3.25rem; align-items: center; justify-content: center; gap: var(--space-2); padding: 0 var(--space-3); border: 0; background: transparent; color: var(--color-muted); font: inherit; font-size: .875rem; font-weight: 700; text-decoration: none; cursor: pointer; }
.person-editor__module-link::after { position: absolute; right: 28%; bottom: -1px; left: 28%; height: 2px; background: transparent; content: ''; }
.person-editor__module-link:hover,
.person-editor__module-link--active { color: var(--color-primary); }
.person-editor__module-link--active::after { background: var(--color-primary); }
.person-editor--page .person-editor__body { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: var(--space-4); padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.person-editor__primary { display: grid; gap: var(--space-4); }
.person-editor--page .person-editor__primary { grid-column: 1; }
.person-editor__secondary { display: grid; gap: var(--space-4); }
.person-editor--page .person-editor__secondary { grid-column: 1; }
.person-editor__basics-module { order: -1; }
.person-editor__notes-module { grid-column: 1; }
.person-editor__module { scroll-margin-top: var(--space-8); padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.person-editor__module-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.person-editor__module-heading h2,
.person-editor__module-heading p { margin: 0; }
.person-editor__module-heading h2 { font-family: var(--font-heading); font-size: 1.125rem; }
.person-editor__module-heading p { margin-top: var(--space-1); color: var(--color-muted); font-size: .8125rem; line-height: 1.5; }
.person-editor--page .person-editor__basics-module .person-editor__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.person-editor--page .person-editor__life-module textarea { min-height: 12rem; line-height: 1.75; }
.person-editor--page .person-editor__album { background: var(--color-surface); }
.person-editor--page .person-editor__album-grid { grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr)); }
.person-editor--page .person-editor__names-module :deep(.person-name-fields__card) { border-radius: var(--radius-sm); }
.person-editor--page .person-editor__names-module :deep(.person-name-fields__card--primary) { background: var(--color-paper-tint); }
.person-editor--page .person-editor__error { grid-column: 1 / -1; }
.person-editor:not(.person-editor--page) .person-editor__primary,
.person-editor:not(.person-editor--page) .person-editor__secondary { display: contents; }
.person-editor:not(.person-editor--page) .person-editor__module { padding: 0; border: 0; background: transparent; }
@media (max-width: 48rem) {
  .person-editor__page-heading { grid-template-columns: auto minmax(0, 1fr); }
  .person-editor__page-actions { grid-column: 1 / -1; justify-content: flex-end; }
}
@media (max-width: 48rem) {
  .person-editor--page .person-editor__basics-module .person-editor__grid { grid-template-columns: 1fr; }
  .person-editor--page .person-editor__names-module :deep(.person-name-fields__row),
  .person-editor--page .person-editor__names-module :deep(.person-name-fields__details-grid) { grid-template-columns: 1fr; }
}
@media (max-width: 36rem) {
  .person-editor__grid { grid-template-columns: 1fr; }
  .person-editor__page-heading { align-items: start; }
  .person-editor__avatar-picker { width: 4.75rem; height: 4.75rem; }
  .person-editor__title-block h1 { font-size: 2rem; }
  .person-editor__title-block span { display: none; }
  .person-editor__place-tools { align-items: flex-start; flex-direction: column; }
  .person-editor__album > header { grid-template-columns: 1fr; }
  .person-editor__module-nav { grid-template-columns: 1fr; }
  .person-editor__module-link { justify-content: flex-start; padding-inline: var(--space-3); }
  .person-editor__module-link::after { right: auto; left: 0; width: 2px; height: 55%; bottom: 22%; }
}
</style>
