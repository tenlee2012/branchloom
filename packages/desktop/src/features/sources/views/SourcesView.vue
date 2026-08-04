<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import type {
  Attachment,
  AttachmentLink,
  CareerRecord,
  Citation,
  FamilyEvent,
  Person,
  PersonTitle,
  Organization,
  Relationship,
  Source,
  SourceDeletionImpact,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import AttachmentPanel from '../components/AttachmentPanel.vue'
import CitationEditor from '../components/CitationEditor.vue'
import SourceEditorDrawer from '../components/SourceEditorDrawer.vue'
import SourceList from '../components/SourceList.vue'

const route = useRoute()
const repository = useBranchloomRepository()
const session = useSessionStore()
const projectId = computed(() => String(route.params.projectId ?? ''))
const sources = ref<Source[]>([])
const citations = ref<Citation[]>([])
const attachments = ref<Attachment[]>([])
const attachmentLinks = ref<AttachmentLink[]>([])
const people = ref<Person[]>([])
const events = ref<FamilyEvent[]>([])
const relationships = ref<Relationship[]>([])
const careers = ref<CareerRecord[]>([])
const organizations = ref<Organization[]>([])
const personTitles = ref<PersonTitle[]>([])
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const search = ref('')
const typeFilter = ref('')
const sourceEditorOpen = ref(false)
const selectedSource = ref<Source>()
const citationEditorOpen = ref(false)
const selectedCitation = ref<Citation>()
const deletingSource = ref<Source>()
const deletionImpact = ref<SourceDeletionImpact>()
const deletionImpactState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const deleting = ref(false)
const deleteFailure = ref('')
const pendingLocationMessage = ref('')
const locatedSourceId = computed(() => typeof route.query.source === 'string' ? route.query.source : '')
const locatedAttachmentId = computed(() => typeof route.query.attachment === 'string' ? route.query.attachment : '')
let loadRequest = 0
let deletionImpactRequest = 0
const PEOPLE_PAGE_SIZE = 100

const filteredSources = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return sources.value.filter((source) => {
    if (typeFilter.value && source.type !== typeFilter.value) return false
    if (!query) return true
    return [source.title, source.author, source.repository, source.referenceCode, source.notes]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query))
  })
})

async function listAllPeople(scopedProjectId: string) {
  const byId = new Map<string, Person>()
  let currentPage = 1
  let maxPages: number | undefined

  while (true) {
    const result = await repository.listPeople(scopedProjectId, {
      page: currentPage,
      pageSize: PEOPLE_PAGE_SIZE,
      sort: 'name',
    })
    if (!Number.isInteger(result.page) || result.page <= 0
      || !Number.isInteger(result.pageSize) || result.pageSize <= 0
      || !Number.isFinite(result.total) || result.total < 0) {
      throw new Error('人物分页信息无效，无法安全读取全部来源关联。')
    }
    maxPages ??= Math.max(1, Math.ceil(result.total / result.pageSize))
    const previousSize = byId.size
    for (const person of result.items) {
      if (person.projectId !== scopedProjectId || person.deletedAt || byId.has(person.id)) continue
      byId.set(person.id, person)
    }
    const addedNoPeople = byId.size === previousSize
    if (currentPage >= maxPages || result.items.length === 0 || addedNoPeople) break
    currentPage += 1
  }

  return [...byId.values()]
}

async function loadSources() {
  const request = ++loadRequest
  const scopedProjectId = projectId.value
  loadState.value = 'loading'
  loadError.value = ''
  try {
    const [
      nextSources,
      nextCitations,
      nextAttachments,
      nextLinks,
      nextPeople,
      nextEvents,
      nextRelationships,
      nextCareers,
      nextOrganizations,
      nextPersonTitles,
    ] = await Promise.all([
      repository.listSources(scopedProjectId),
      repository.listCitations(scopedProjectId),
      repository.listAttachments(scopedProjectId),
      repository.listAttachmentLinks(scopedProjectId),
      listAllPeople(scopedProjectId),
      repository.listEvents(scopedProjectId),
      repository.listRelationships(scopedProjectId),
      repository.listCareers(scopedProjectId),
      repository.listOrganizations(scopedProjectId),
      repository.listPersonTitles(scopedProjectId),
    ])
    if (request !== loadRequest) return
    sources.value = nextSources.filter(({ projectId: id }) => id === scopedProjectId)
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN') || left.id.localeCompare(right.id))
    citations.value = nextCitations.filter(({ projectId: id }) => id === scopedProjectId)
    attachments.value = nextAttachments.filter(({ projectId: id }) => id === scopedProjectId)
    attachmentLinks.value = nextLinks.filter(({ projectId: id }) => id === scopedProjectId)
    people.value = nextPeople
    events.value = nextEvents.filter(({ projectId: id }) => id === scopedProjectId)
    relationships.value = nextRelationships.filter(({ projectId: id }) => id === scopedProjectId)
    careers.value = nextCareers.filter(({ projectId: id }) => id === scopedProjectId)
    organizations.value = nextOrganizations.filter(({ projectId: id }) => id === scopedProjectId)
    personTitles.value = nextPersonTitles.filter(({ projectId: id }) => id === scopedProjectId)
    loadState.value = 'ready'
    locateRouteTarget()
  } catch (error) {
    if (request !== loadRequest) return
    loadError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '无法读取来源与引用资料'
    loadState.value = 'error'
  }
}

watch(projectId, () => {
  search.value = ''
  typeFilter.value = ''
  sourceEditorOpen.value = false
  selectedSource.value = undefined
  citationEditorOpen.value = false
  selectedCitation.value = undefined
  pendingLocationMessage.value = ''
  closeDelete()
  void loadSources()
}, { immediate: true })

watch(() => [route.query.source, route.query.attachment] as const, () => {
  locateRouteTarget()
})

function createSource() {
  pendingLocationMessage.value = ''
  selectedSource.value = undefined
  sourceEditorOpen.value = true
}

function locateRouteTarget() {
  if (loadState.value !== 'ready') return
  if (sourceEditorOpen.value || citationEditorOpen.value) {
    pendingLocationMessage.value = '当前编辑尚未保存，已保留草稿；关闭编辑器后再定位目标。'
    return
  }
  pendingLocationMessage.value = ''
  if (locatedSourceId.value) {
    const target = sources.value.find(({ id }) => id === locatedSourceId.value)
    if (target) { selectedSource.value = target; sourceEditorOpen.value = true }
  }
}

function editSource(source: Source) {
  pendingLocationMessage.value = ''
  selectedSource.value = source
  sourceEditorOpen.value = true
}

function createCitation() {
  pendingLocationMessage.value = ''
  selectedCitation.value = undefined
  citationEditorOpen.value = true
}

function editCitation(citation: Citation) {
  pendingLocationMessage.value = ''
  selectedCitation.value = citation
  citationEditorOpen.value = true
}

function closeSourceEditor() {
  sourceEditorOpen.value = false
  selectedSource.value = undefined
  locateRouteTarget()
}

function closeCitationEditor() {
  citationEditorOpen.value = false
  selectedCitation.value = undefined
  locateRouteTarget()
}

async function saved() {
  sourceEditorOpen.value = false
  citationEditorOpen.value = false
  selectedSource.value = undefined
  selectedCitation.value = undefined
  await loadSources()
}

function localImpact(source: Source): SourceDeletionImpact {
  const removedCitations = citations.value.filter(({ sourceId }) => sourceId === source.id)
  const citationIds = new Set(removedCitations.map(({ id }) => id))
  return {
    citations: removedCitations.length,
    people: people.value.filter(({ sourceIds }) => (sourceIds ?? []).includes(source.id)).length,
    organizations: organizations.value.filter(({ sourceIds }) => sourceIds.includes(source.id)).length,
    careers: careers.value.filter(({ sourceIds }) => sourceIds.includes(source.id)).length,
    personTitles: personTitles.value.filter(({ sourceIds }) => sourceIds.includes(source.id)).length,
    relationships: relationships.value.filter(({ sourceIds }) => sourceIds.includes(source.id)).length,
    events: events.value.filter(({ sourceIds }) => sourceIds.includes(source.id)).length,
    attachmentLinks: attachmentLinks.value.filter(({ targetType, targetId }) => targetType === 'citation' && citationIds.has(targetId)).length,
  }
}

async function requestDelete(source: Source) {
  const request = ++deletionImpactRequest
  deletingSource.value = source
  deletionImpact.value = localImpact(source)
  deletionImpactState.value = 'loading'
  deleteFailure.value = ''
  try {
    const impact = await repository.getSourceDeletionImpact(source.id)
    if (request !== deletionImpactRequest || deletingSource.value?.id !== source.id) return
    deletionImpact.value = impact
    deletionImpactState.value = 'ready'
  } catch (error) {
    if (request !== deletionImpactRequest || deletingSource.value?.id !== source.id) return
    deleteFailure.value = error instanceof Error && error.message.trim()
      ? error.message
      : '无法读取删除影响'
    deletionImpactState.value = 'error'
  }
}

function closeDelete() {
  deletionImpactRequest += 1
  deletingSource.value = undefined
  deletionImpact.value = undefined
  deletionImpactState.value = 'idle'
  deleteFailure.value = ''
}

async function confirmDelete() {
  const source = deletingSource.value
  if (!source || deleting.value || deletionImpactState.value !== 'ready') return
  deleting.value = true
  deleteFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.deleteSource(source.id)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    closeDelete()
    await loadSources()
  } catch (error) {
    const details = error instanceof Error && error.message.trim()
      ? error.message
      : '来源暂时无法删除'
    deleteFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <section class="sources-view" aria-labelledby="sources-title">
    <header class="sources-view__heading">
      <div><p>证据、引用与附件</p><h1 id="sources-title">资料来源</h1></div>
      <div class="sources-view__heading-actions">
        <BaseButton name="新建引用" variant="secondary" @click="createCitation">新建引用</BaseButton>
        <BaseButton name="新建来源" @click="createSource">新建来源</BaseButton>
      </div>
    </header>
    <p v-if="pendingLocationMessage" class="sources-view__located" role="status">{{ pendingLocationMessage }}</p>
    <p v-if="locatedSourceId && selectedSource" class="sources-view__located" role="status" :data-located-source-id="selectedSource.id">已定位并打开来源 <code>{{ selectedSource.id }}</code>：{{ selectedSource.title }}</p>
    <p v-if="locatedAttachmentId && attachments.some(({ id }) => id === locatedAttachmentId)" class="sources-view__located" role="status" :data-located-attachment-id="locatedAttachmentId">已定位附件 <code>{{ locatedAttachmentId }}</code>，对应记录已高亮。</p>
    <form class="sources-view__filters" aria-label="来源搜索与筛选" @submit.prevent>
      <label><span>搜索来源</span><input v-model="search" name="sourceSearch" type="search" placeholder="标题、作者、机构或档案编号" /></label>
      <label><span>来源类型</span><BaseSelectControl><select v-model="typeFilter" name="sourceTypeFilter">
          <option value="">全部类型</option><option value="book">书籍</option><option value="web">网页</option>
          <option value="archive">档案</option><option value="interview">访谈</option><option value="other">其他</option>
        </select></BaseSelectControl></label>
      <span aria-live="polite">显示 {{ filteredSources.length }} / {{ sources.length }} 条来源</span>
    </form>
    <div v-if="loadState === 'loading'" class="sources-view__state" role="status">正在整理来源、引用与附件…</div>
    <div v-else-if="loadState === 'error'" class="sources-view__state sources-view__state--error" role="alert">
      <strong>资料来源暂时无法读取</strong><span>{{ loadError }}</span>
      <BaseButton size="sm" variant="secondary" @click="loadSources">重新读取</BaseButton>
    </div>
    <template v-else>
      <SourceList
        :project-id="projectId"
        :sources="filteredSources"
        :citations="citations"
        :people="people"
        :events="events"
        :relationships="relationships"
        :careers="careers"
        :organizations="organizations"
        :highlighted-source-id="locatedSourceId"
        @edit-source="editSource"
        @delete-source="requestDelete"
        @edit-citation="editCitation"
      />
      <AttachmentPanel
        :project-id="projectId"
        :attachments="attachments"
        :attachment-links="attachmentLinks"
        :highlighted-attachment-id="locatedAttachmentId"
        @changed="loadSources"
      />
    </template>
    <SourceEditorDrawer
      :open="sourceEditorOpen"
      :project-id="projectId"
      :source="selectedSource"
      @close="closeSourceEditor"
      @saved="saved"
    />
    <CitationEditor
      :open="citationEditorOpen"
      :project-id="projectId"
      :citation="selectedCitation"
      :sources="sources"
      :people="people"
      :events="events"
      :relationships="relationships"
      :careers="careers"
      :organizations="organizations"
      :attachments="attachments"
      :attachment-links="attachmentLinks"
      @close="closeCitationEditor"
      @saved="saved"
      @deleted="saved"
    />
    <BaseDialog
      :open="Boolean(deletingSource)"
      title="删除资料来源？"
      :description="deletingSource ? `删除“${deletingSource.title}”会同时清理相关引用和直接关联。` : ''"
      close-label="保留来源"
      @close="closeDelete"
    >
      <div v-if="deletionImpact" class="sources-view__impact">
        <strong>删除影响</strong>
        <ul>
          <li>{{ deletionImpact.citations }} 条引用</li>
          <li>{{ deletionImpact.people }} 位人物的直接来源关联</li>
          <li>{{ deletionImpact.organizations }} 个机构的直接来源关联</li>
          <li>{{ deletionImpact.careers }} 条履历的直接来源关联</li>
          <li>{{ deletionImpact.personTitles }} 条身份称号的直接来源关联</li>
          <li>{{ deletionImpact.relationships }} 段关系的直接来源关联</li>
          <li>{{ deletionImpact.events }} 件事件的直接来源关联</li>
          <li>{{ deletionImpact.attachmentLinks }} 处引用附件关联</li>
        </ul>
      </div>
      <p v-if="deletionImpactState === 'loading'" role="status">正在计算完整删除影响…</p>
      <div v-if="deleteFailure" class="sources-view__error" role="alert">
        <span>{{ deleteFailure }}</span>
        <BaseButton
          v-if="deletionImpactState === 'error' && deletingSource"
          name="重新计算删除影响"
          size="sm"
          variant="secondary"
          @click="requestDelete(deletingSource)"
        >重新计算影响</BaseButton>
      </div>
      <div class="sources-view__dialog-actions">
        <BaseButton name="保留来源" variant="secondary" :disabled="deleting" @click="closeDelete">保留来源</BaseButton>
        <BaseButton
          name="确认删除来源"
          variant="danger"
          :loading="deleting"
          :disabled="deletionImpactState !== 'ready' || deleting"
          @click="confirmDelete"
        >确认删除来源</BaseButton>
      </div>
    </BaseDialog>
  </section>
</template>

<style scoped>
.sources-view { display: grid; width: min(72rem, 100%); gap: var(--space-5); margin: 0 auto; }
.sources-view__heading { display: flex; align-items: end; justify-content: space-between; gap: var(--space-5); padding-bottom: var(--space-3); border-bottom: 1px solid var(--color-border); }
.sources-view__heading p, .sources-view__heading h1 { margin: 0; }
.sources-view__heading p { color: var(--color-accent); font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.sources-view__heading h1 { margin-top: var(--space-1); font-family: var(--font-heading); }
.sources-view__heading-actions, .sources-view__dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.sources-view__located { padding: var(--space-2) var(--space-3); margin: 0; border-radius: var(--radius-sm); background: var(--color-info-surface); color: var(--color-info); }
.sources-view__filters { display: grid; grid-template-columns: minmax(14rem, 1fr) minmax(10rem, .45fr) auto; align-items: end; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.sources-view__filters label { display: grid; gap: var(--space-2); color: var(--color-muted); font-size: .8125rem; font-weight: 650; }
.sources-view__filters input { min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.sources-view__filters > span { padding-bottom: var(--space-3); color: var(--color-muted); font-size: .8125rem; }
.sources-view__state { display: grid; justify-items: start; gap: var(--space-3); padding: var(--space-7); border: 1px dashed var(--color-border); border-radius: var(--radius-lg); color: var(--color-muted); }
.sources-view__state--error, .sources-view__error { color: var(--color-danger); }
.sources-view__impact { padding: var(--space-4); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.sources-view__impact ul { margin-bottom: 0; }
.sources-view__error { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); }
@media (max-width: 44rem) { .sources-view__heading { align-items: stretch; flex-direction: column; } .sources-view__filters { grid-template-columns: 1fr; } .sources-view__filters > span { padding: 0; } }
</style>
