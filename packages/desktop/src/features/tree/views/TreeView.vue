<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  IconArrowsMove,
  IconHierarchy,
  IconMaximize,
} from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import EmptyState from '../../../design-system/EmptyState.vue'
import type {
  BoundedFamilySlice,
  Citation,
  Person,
  Place,
  Project,
  PrototypeState,
  Relationship,
  Source,
} from '../../../shared/domain/types'
import { getPrimaryName } from '../../../shared/domain/personNames'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import QuickAddRelativeDialog from '../../relationships/components/QuickAddRelativeDialog.vue'
import RelationshipEditor from '../../relationships/components/RelationshipEditor.vue'
import FamilyGraph, { type GraphDensity } from '../components/FamilyGraph.vue'
import PersonPreviewDrawer from '../components/PersonPreviewDrawer.vue'
import RelationshipResearchPanel from '../components/RelationshipResearchPanel.vue'
import TreeToolbar from '../components/TreeToolbar.vue'
import { buildVisibleGraph, type TreeMode, type VisibleGraph } from '../model/buildVisibleGraph'

const props = withDefaults(defineProps<{ warningThreshold?: number }>(), { warningThreshold: 80 })
const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const project = ref<Project>()
const data = shallowRef<PrototypeState>()
const directoryPeople = ref<Person[]>([])
const currentSlice = shallowRef<BoundedFamilySlice>()
const locatedPeopleRecords = ref<Person[]>([])
const sliceMeta = ref<Pick<BoundedFamilySlice, 'truncated' | 'limits'>>()
const locatedRelationshipRecord = ref<Relationship>()
const researchSources = ref<Source[]>([])
const researchCitations = ref<Citation[]>([])
const researchPlaces = ref<Place[]>([])
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const centerPersonId = ref('')
const selectedPersonId = ref('')
const mode = ref<TreeMode>('combined')
const generationsUp = ref(2)
const generationsDown = ref(2)
const personSearch = ref('')
const collapsedPersonIds = ref<ReadonlySet<string>>(new Set())
const density = ref<GraphDensity>({
  avatars: true,
  dates: true,
  places: true,
  relationships: true,
  names: false,
})
const quickAddOpen = ref(false)
const relationshipEditorOpen = ref(false)
const researchClosed = ref(false)
const zoomLevel = ref(1)
const graphComponent = ref<{
  fit(): void
  relayout(): void
  zoomIn(): void
  zoomOut(): void
  zoomTo(zoomLevel: number): void
} | null>(null)
let latestRequest = 0
let latestDirectoryRequest = 0

const people = computed(() => data.value?.people.filter(({ deletedAt }) => !deletedAt) ?? [])
const relationships = computed(() => data.value?.relationships ?? [])
const centerPerson = computed(() => people.value.find(({ id }) => id === centerPersonId.value))
const selectedPerson = computed(() => people.value.find(({ id }) => id === selectedPersonId.value))
const previewPersonId = computed(() => {
  const value = route.query.previewPersonId
  return typeof value === 'string' ? value : ''
})
const locatedRelationshipId = computed(() => {
  const value = route.query.relationship ?? route.query.relationshipId
  return typeof value === 'string' ? value : ''
})
const locatedRelationship = computed(() => locatedRelationshipId.value
  ? relationships.value.find(({ id }) => id === locatedRelationshipId.value)
    ?? (locatedRelationshipRecord.value?.id === locatedRelationshipId.value
      ? locatedRelationshipRecord.value
      : undefined)
  : undefined)
const selectedRelationships = computed(() => selectedPerson.value
  ? relationships.value.filter(({ fromPersonId, toPersonId }) =>
      fromPersonId === selectedPerson.value!.id || toPersonId === selectedPerson.value!.id)
  : [])
const emptyGraph: VisibleGraph = {
  status: 'missing-center', nodes: [], edges: [], thresholdExceeded: false, warningThreshold: props.warningThreshold,
}
const graph = computed(() => {
  if (!data.value) return emptyGraph
  const visible = buildVisibleGraph(data.value, {
      centerPersonId: centerPersonId.value,
      mode: mode.value,
      generationsUp: mode.value === 'descendants' ? 0 : generationsUp.value,
      generationsDown: mode.value === 'ancestors' ? 0 : generationsDown.value,
      collapsedPersonIds: collapsedPersonIds.value,
      warningThreshold: props.warningThreshold,
    })
  if (!sliceMeta.value || visible.status === 'missing-center') return visible
  return {
    ...visible,
    thresholdExceeded: visible.thresholdExceeded || sliceMeta.value.truncated,
    truncated: visible.truncated || sliceMeta.value.truncated,
    limits: sliceMeta.value.limits,
  }
})
const needsDefaultCenter = computed(() => (
  graph.value.status === 'missing-center'
  && !centerPersonId.value
  && !project.value?.defaultPersonId
  && people.value.length > 0
))
const visibleRelationshipIds = computed(() => new Set(graph.value.edges.map(({ id }) => id)))
const researchRelationship = computed(() => {
  if (locatedRelationship.value) return locatedRelationship.value
  const visiblePartners = relationships.value.filter(({ category, id }) =>
    category === 'partner' && visibleRelationshipIds.value.has(id))
  return visiblePartners.find(({ type }) => type === 'married')
    ?? visiblePartners[0]
    ?? relationships.value.find(({ category }) => category === 'partner')
})
const researchFromPerson = computed(() => researchRelationship.value
  ? people.value.find(({ id }) => id === researchRelationship.value!.fromPersonId)
  : undefined)

watch(projectId, () => {
  latestDirectoryRequest += 1
  personSearch.value = ''
  researchClosed.value = false
  relationshipEditorOpen.value = false
  void load()
}, { immediate: true })
watch(
  () => [route.query.personId, route.query.person] as const,
  ([personId, legacyPersonId]) => {
    if (loadState.value !== 'ready') return
    const nextCenter = typeof personId === 'string'
      ? personId
      : typeof legacyPersonId === 'string'
        ? legacyPersonId
        : project.value?.defaultPersonId ?? ''
    if (nextCenter !== centerPersonId.value) {
      centerPersonId.value = nextCenter
      selectedPersonId.value = ''
      void refreshFamilySlice(nextCenter)
    }
    if (typeof personId !== 'string' && typeof legacyPersonId === 'string') {
      const { person: _legacyPerson, ...query } = route.query
      void router.replace({ query: { ...query, personId: legacyPersonId } })
    }
  },
)
watch(locatedRelationshipId, (nextId, previousId) => {
  if (loadState.value !== 'ready' || nextId === previousId) return
  if (nextId) void load()
  else locatedRelationshipRecord.value = undefined
})
watch(previewPersonId, (nextId, previousId) => {
  if (loadState.value !== 'ready' || nextId === previousId) return
  if (nextId) void load()
  else selectedPersonId.value = ''
})
watch([mode, generationsUp, generationsDown], () => {
  if (loadState.value === 'ready' && centerPersonId.value) {
    void refreshFamilySlice(centerPersonId.value)
  }
})
watch(personSearch, () => {
  if (loadState.value === 'ready') void refreshPersonDirectory()
})

function locateRelationship() {
  if (loadState.value !== 'ready' || !locatedRelationship.value) return
  centerPersonId.value = locatedRelationship.value.fromPersonId
  selectedPersonId.value = locatedRelationship.value.toPersonId
}

async function load() {
  const request = ++latestRequest
  const scopedProjectId = projectId.value
  const requestedPreviewPersonId = previewPersonId.value
  loadState.value = 'loading'
  loadError.value = ''
  selectedPersonId.value = ''
  try {
    const [loadedProject, peoplePage, loadedSources, loadedCitations, loadedPlaces] = await Promise.all([
      repository.getProject(scopedProjectId),
      repository.listPeople(scopedProjectId, { page: 1, pageSize: 100, sort: 'name' }),
      repository.listSources(scopedProjectId),
      repository.listCitations(scopedProjectId),
      repository.listPlaces(scopedProjectId),
    ])
    const relationshipId = locatedRelationshipId.value
    const targetRelationship = relationshipId
      ? await repository.getRelationship(scopedProjectId, relationshipId)
      : undefined
    const routePersonId = typeof route.query.personId === 'string'
      ? route.query.personId
      : typeof route.query.person === 'string'
        ? route.query.person
        : undefined
    const nextCenterPersonId = targetRelationship?.fromPersonId
      ?? routePersonId
      ?? loadedProject.defaultPersonId
      ?? ''
    const slice = await loadSlice(scopedProjectId, nextCenterPersonId)
    const relationshipPeople = targetRelationship
      ? await Promise.all([
          repository.getPerson(targetRelationship.fromPersonId),
          repository.getPerson(targetRelationship.toPersonId),
        ])
      : []
    let previewPerson = requestedPreviewPersonId
      ? peoplePage.items.find(({ id }) => id === requestedPreviewPersonId)
        ?? slice?.people.find(({ id }) => id === requestedPreviewPersonId)
      : undefined
    if (requestedPreviewPersonId && !previewPerson) {
      try {
        const candidate = await repository.getPerson(requestedPreviewPersonId)
        if (candidate.projectId === scopedProjectId && !candidate.deletedAt) previewPerson = candidate
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'not-found')) throw error
      }
    }
    const locatedPeople = uniqueById([
      ...relationshipPeople,
      ...(previewPerson ? [previewPerson] : []),
    ])
    if (request !== latestRequest || scopedProjectId !== projectId.value
      || requestedPreviewPersonId !== previewPersonId.value) return
    project.value = loadedProject
    directoryPeople.value = peoplePage.items
    researchSources.value = loadedSources
    researchCitations.value = loadedCitations
    researchPlaces.value = loadedPlaces
    locatedRelationshipRecord.value = targetRelationship
    centerPersonId.value = nextCenterPersonId
    selectedPersonId.value = ''
    applySlice(loadedProject, slice, locatedPeople, targetRelationship)
    if (typeof route.query.personId !== 'string' && typeof route.query.person === 'string') {
      const { person: legacyPersonId, ...query } = route.query
      void router.replace({ query: { ...query, personId: legacyPersonId } })
    }
    loadState.value = 'ready'
    locateRelationship()
    if (previewPerson) selectedPersonId.value = previewPerson.id
  } catch (error) {
    if (request !== latestRequest) return
    loadError.value = error instanceof Error ? error.message : '本地家谱资料无法读取'
    loadState.value = 'error'
  }
}

async function loadSlice(scopedProjectId: string, personId: string): Promise<BoundedFamilySlice | undefined> {
  if (!personId) return undefined
  try {
    return await repository.getTreeFamilySlice(scopedProjectId, personId, {
      generationsUp: mode.value === 'descendants' ? 0 : generationsUp.value,
      generationsDown: mode.value === 'ancestors' ? 0 : generationsDown.value,
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'not-found') return undefined
    throw error
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()]
}

function applySlice(
  loadedProject: Project,
  slice: BoundedFamilySlice | undefined,
  locatedPeople: Person[] = [],
  targetRelationship?: Relationship,
) {
  currentSlice.value = slice
  locatedPeopleRecords.value = locatedPeople
  locatedRelationshipRecord.value = targetRelationship
  sliceMeta.value = slice
    ? { truncated: slice.truncated, limits: slice.limits }
    : undefined
  data.value = {
    schemaVersion: 2,
    projects: [loadedProject],
    people: uniqueById([...directoryPeople.value, ...(slice?.people ?? []), ...locatedPeople]),
    organizations: [],
    careers: [],
    personTitles: [],
    relationships: uniqueById([...(slice?.relationships ?? []), ...(targetRelationship ? [targetRelationship] : [])]),
    places: slice?.places ?? [],
    events: [], sources: [], citations: [], attachments: [], attachmentLinks: [], snapshots: [], issues: [],
  }
}

async function refreshPersonDirectory() {
  if (!project.value) return
  const request = ++latestDirectoryRequest
  const scopedProjectId = project.value.id
  try {
    const page = await repository.listPeople(scopedProjectId, {
      page: 1,
      pageSize: 100,
      ...(personSearch.value.trim() ? { search: personSearch.value.trim() } : {}),
      sort: 'name',
    })
    if (request !== latestDirectoryRequest || scopedProjectId !== projectId.value || !project.value) return
    directoryPeople.value = page.items
    applySlice(project.value, currentSlice.value, locatedPeopleRecords.value, locatedRelationshipRecord.value)
  } catch (error) {
    if (request !== latestDirectoryRequest) return
    loadError.value = error instanceof Error ? error.message : '人物跳转目录无法读取'
    loadState.value = 'error'
  }
}

async function refreshFamilySlice(personId: string) {
  if (!project.value) return
  const request = ++latestRequest
  const scopedProjectId = project.value.id
  loadError.value = ''
  try {
    const slice = await loadSlice(scopedProjectId, personId)
    if (request !== latestRequest || scopedProjectId !== projectId.value
      || personId !== centerPersonId.value || !project.value) return
    applySlice(project.value, slice)
  } catch (error) {
    if (request !== latestRequest) return
    loadError.value = error instanceof Error ? error.message : '本地家谱资料无法读取'
    loadState.value = 'error'
  }
}

function primaryName(person: Person | undefined) {
  return person ? getPrimaryName(person) : '未选择'
}

async function changeCenter(personId: string) {
  selectedPersonId.value = personId
  const {
    person: _legacyPerson,
    relationship: _relationship,
    relationshipId: _relationshipId,
    previewPersonId: _previewPersonId,
    ...query
  } = route.query
  await router.replace({ query: { ...query, personId } })
}

async function closePersonPreview() {
  selectedPersonId.value = ''
  if (!previewPersonId.value) return
  const { previewPersonId: _previewPersonId, ...query } = route.query
  await router.replace({ query })
}

async function changeMode(nextMode: TreeMode) {
  mode.value = nextMode
  if (nextMode === 'combined') return
  const selectedId = selectedPersonId.value
  if (selectedId && selectedId !== centerPersonId.value) await changeCenter(selectedId)
}

function selectPerson(personId: string) {
  selectedPersonId.value = personId
}

function toggleBranch(personId: string) {
  const next = new Set(collapsedPersonIds.value)
  if (next.has(personId)) next.delete(personId)
  else next.add(personId)
  collapsedPersonIds.value = next
}

function handleRelativeSaved(person: Person, relationship: Relationship) {
  if (!data.value) return
  data.value = {
    ...data.value,
    people: [...data.value.people, person],
    relationships: [...data.value.relationships, relationship],
  }
  quickAddOpen.value = false
}

function handleRelationshipSaved(relationship: Relationship) {
  if (!data.value) return
  data.value = {
    ...data.value,
    relationships: data.value.relationships.map((item) =>
      item.id === relationship.id ? relationship : item),
  }
  locatedRelationshipRecord.value = relationship
  relationshipEditorOpen.value = false
}

function openQuickAdd() {
  selectedPersonId.value ||= centerPersonId.value
  if (selectedPersonId.value) quickAddOpen.value = true
}

function fitCanvas() {
  graphComponent.value?.fit()
}

function addPerson() {
  void router.push({ name: 'person-new', params: { projectId: projectId.value } })
}

function shrinkRange() {
  if (generationsUp.value >= generationsDown.value && generationsUp.value > 0) generationsUp.value -= 1
  else if (generationsDown.value > 0) generationsDown.value -= 1
}

onBeforeUnmount(() => { latestRequest += 1 })

defineExpose({ fitCanvas, addPerson })
</script>

<template>
  <section class="tree-view" aria-labelledby="tree-view-title">
    <h1 id="tree-view-title" class="visually-hidden">家谱树</h1>
    <p
      v-if="locatedRelationship"
      class="tree-view__located"
      role="status"
      :data-located-relationship-id="locatedRelationship.id"
    >已定位关系 <code>{{ locatedRelationship.id }}</code>，并选中相关人物。</p>

    <TreeToolbar
      :mode="mode"
      :generations-up="generationsUp"
      :generations-down="generationsDown"
      :density="density"
      :people="people"
      :center-person-id="centerPersonId"
      :person-search="personSearch"
      :collapsed-count="collapsedPersonIds.size"
      :zoom-level="zoomLevel"
      @update-mode="changeMode"
      @update-generations-up="generationsUp = $event"
      @update-generations-down="generationsDown = $event"
      @update-density="density = $event"
      @update-person-search="personSearch = $event"
      @jump="changeCenter"
      @relayout="graphComponent?.relayout()"
      @zoom-in="graphComponent?.zoomIn()"
      @zoom-out="graphComponent?.zoomOut()"
      @zoom-to="graphComponent?.zoomTo($event)"
      @clear-collapsed="collapsedPersonIds = new Set()"
    />

    <div
      class="tree-view__workbench"
      :class="{ 'tree-view__workbench--no-panel': !selectedPerson && (!researchRelationship || researchClosed) }"
    >
      <div v-if="loadState === 'loading'" class="tree-view__state" role="status">
        <span class="tree-view__spinner" aria-hidden="true" />
        正在计算家谱显示范围…
      </div>
      <div v-else-if="loadState === 'error'" class="tree-view__state tree-view__state--error" role="alert">
        <strong>家谱树未能读取</strong>
        <span>{{ loadError }}</span>
        <BaseButton variant="secondary" size="sm" @click="load">重新读取</BaseButton>
      </div>

      <div v-else-if="graph.status === 'missing-center'" class="tree-view__empty" role="status">
        <EmptyState
          :title="needsDefaultCenter ? '尚未设置中心人物' : '没有找到中心人物'"
          :description="needsDefaultCenter
            ? '请前往人物列表选择一位中心人物，再查看家谱树。'
            : people.length
              ? '请从工具栏选择一位人物，或返回人物档案确认资料。'
              : '从第一个人物开始，逐步添加父母、伴侣和子女。'"
        >
          <span class="tree-view__empty-mark">谱</span>
          <template #actions>
            <RouterLink
              v-if="needsDefaultCenter"
              :to="{ name: 'project-people', params: { projectId } }"
            >
              前往人物列表设置
            </RouterLink>
            <RouterLink v-else :to="{ name: 'project-people', params: { projectId } }">
              前往人物档案
            </RouterLink>
          </template>
        </EmptyState>
      </div>

      <div v-else-if="graph.thresholdExceeded" class="tree-view__threshold" role="alert">
        <span class="tree-view__threshold-mark" aria-hidden="true">!</span>
        <div>
          <strong>当前范围包含 {{ graph.nodes.length }} 位人物，请缩小显示范围</strong>
          <p>为保持缩放和平移流畅，家谱树一次最多建议显示 {{ graph.warningThreshold }} 位人物。减少代数或收起分支后再查看。</p>
        </div>
        <BaseButton variant="secondary" @click="shrinkRange">缩小显示范围</BaseButton>
      </div>

      <div v-else class="tree-view__canvas-wrap">
        <FamilyGraph
          ref="graphComponent"
          :graph="graph"
          :density="density"
          :selected-person-id="selectedPersonId"
          @node-click="selectPerson"
          @node-double-click="changeCenter"
          @zoom-change="zoomLevel = $event"
        />
        <div v-if="centerPerson" class="visually-hidden" aria-live="polite">
          中心人物：<strong>{{ primaryName(centerPerson) }}</strong>
        </div>
        <div class="tree-view__legend" aria-label="关系图例">
          <span><i class="married" aria-hidden="true"></i>婚姻</span>
          <span><i class="biological" aria-hidden="true"></i>父母子女</span>
          <span><i class="adoptive" aria-hidden="true"></i>收养</span>
          <span class="visually-hidden">亲生 继亲 监护 订婚 事实伴侣 分居 离异</span>
        </div>
        <div class="tree-view__canvas-actions" aria-label="画布工具">
          <button type="button" aria-label="拖动画布"><IconArrowsMove :size="22" aria-hidden="true" /></button>
          <button type="button" aria-label="适应家谱" @click="graphComponent?.fit()"><IconMaximize :size="22" aria-hidden="true" /></button>
          <button type="button" aria-label="重新排列家谱" @click="graphComponent?.relayout()"><IconHierarchy :size="22" aria-hidden="true" /></button>
        </div>
      </div>
      <PersonPreviewDrawer
        v-if="selectedPerson"
        inline
        :open="true"
        :person="selectedPerson"
        :relationships="selectedRelationships"
        :people="people"
        :collapsed="selectedPerson ? collapsedPersonIds.has(selectedPerson.id) : false"
        :is-center="selectedPerson?.id === centerPersonId"
        @close="closePersonPreview"
        @center="changeCenter"
        @toggle-branch="toggleBranch"
        @quick-add="quickAddOpen = true"
      />
      <RelationshipResearchPanel
        v-else-if="researchRelationship && !researchClosed"
        :project-id="projectId"
        :relationship="researchRelationship"
        :people="people"
        :places="researchPlaces"
        :sources="researchSources"
        :citations="researchCitations"
        @close="researchClosed = true"
        @edit="relationshipEditorOpen = true"
      />
    </div>
    <QuickAddRelativeDialog
      v-if="selectedPerson"
      :open="quickAddOpen"
      :project-id="projectId"
      :person="selectedPerson"
      @close="quickAddOpen = false"
      @saved="handleRelativeSaved"
    />
    <RelationshipEditor
      v-if="researchRelationship && researchFromPerson"
      :open="relationshipEditorOpen"
      :project-id="projectId"
      :person="researchFromPerson"
      :relationship="researchRelationship"
      @close="relationshipEditorOpen = false"
      @saved="handleRelationshipSaved"
    />
  </section>
</template>

<style scoped>
.tree-view { position: relative; display: grid; height: 100%; min-height: 0; grid-template-rows: auto minmax(0, 1fr); background: var(--color-card); }
.tree-view__workbench { display: grid; min-width: 0; min-height: 0; grid-template-columns: minmax(0, 1fr) 26rem; }
.tree-view__workbench--no-panel { grid-template-columns: minmax(0, 1fr); }
.tree-view__state, .tree-view__empty, .tree-view__threshold { display: grid; min-height: 28rem; place-content: center; justify-items: center; gap: var(--space-3); padding: var(--space-8); background: var(--color-surface); text-align: center; }
.tree-view__located { position: absolute; z-index: 8; top: 5rem; left: 50%; padding: var(--space-2) var(--space-3); margin: 0; transform: translateX(-50%); border-radius: var(--radius-sm); background: var(--color-info-surface); color: var(--color-info); }
.tree-view__state--error { border-color: var(--color-danger); background: var(--color-danger-surface); color: var(--color-danger); }
.tree-view__spinner { width: 2rem; height: 2rem; border: 3px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: spin .7s linear infinite; }
.tree-view__empty-mark { display: grid; width: 3.5rem; height: 3.5rem; place-items: center; border-radius: 50%; background: var(--color-primary); color: var(--color-surface); font-family: var(--font-heading); font-size: 1.4rem; }
.tree-view__empty a { color: var(--color-primary); font-weight: 700; }
.tree-view__threshold { grid-template-columns: auto minmax(0, 32rem) auto; min-height: 24rem; place-items: center start; text-align: left; }
.tree-view__threshold-mark { display: grid; width: 3rem; height: 3rem; place-items: center; border-radius: 50%; background: var(--color-warning-surface); color: var(--color-warning); font-family: var(--font-heading); font-size: 1.5rem; }
.tree-view__threshold p { margin-bottom: 0; color: var(--color-muted); }
.tree-view__canvas-wrap { position: relative; min-width: 0; min-height: 0; overflow: hidden; border-right: 1px solid var(--color-border); background: var(--color-card); }
.tree-view__legend { position: absolute; z-index: 2; top: 1.25rem; left: 1.25rem; display: grid; gap: .65rem; padding: .75rem .85rem; border: 1px solid var(--color-border); border-radius: .35rem; background: rgb(255 253 248 / 95%); color: var(--color-muted); font-size: .72rem; }
.tree-view__legend span { display: flex; align-items: center; gap: var(--space-1); }
.tree-view__legend i { display: block; width: 2.5rem; height: 0; flex: 0 0 2.5rem; border-top: 3px solid #506b57; }
.tree-view__legend .married { border-color: #a76548; }
.tree-view__legend .biological { border-color: #506b57; }
.tree-view__legend .adoptive { border-color: #9b783d; border-top-style: dashed; }
.tree-view__canvas-actions { position: absolute; z-index: 2; bottom: 1.35rem; left: 1.25rem; display: flex; overflow: hidden; border: 1px solid var(--color-border); border-radius: .35rem; background: var(--color-card); box-shadow: var(--shadow-sm); }
.tree-view__canvas-actions button { display: grid; width: 2.8rem; height: 2.8rem; place-items: center; border: 0; border-right: 1px solid var(--color-border); background: transparent; color: var(--color-text-soft); cursor: pointer; }
.tree-view__canvas-actions button:last-child { border-right: 0; }
.tree-view__canvas-actions button:hover { background: var(--color-muted-surface); }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .tree-view__spinner { animation: none; } }
@media (max-width: 72rem) { .tree-view__workbench { grid-template-columns: minmax(0, 1fr); } .tree-view__workbench > :deep(.person-preview-shell), .tree-view__workbench > :deep(.relationship-research) { display: none; } }
@media (max-width: 42rem) { .tree-view__threshold { grid-template-columns: 1fr; place-items: center; text-align: center; } }
</style>
