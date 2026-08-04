<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IconFilterX } from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import EmptyState from '../../../design-system/EmptyState.vue'
import FilterSelectControl from '../../../design-system/FilterSelectControl.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { FamilyEvent, Person, Place, Source } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import EventEditorDrawer from '../components/EventEditorDrawer.vue'
import PlaceManager from '../components/PlaceManager.vue'
import TimelineGroup from '../components/TimelineGroup.vue'
import { eventTypeLabel, groupEvents } from '../model/groupEvents'

const GROUPS_PER_PAGE = 12
const PEOPLE_PAGE_SIZE = 100
const route = useRoute()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const events = ref<FamilyEvent[]>([])
const people = ref<Person[]>([])
const places = ref<Place[]>([])
const sources = ref<Source[]>([])
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const participantFilter = ref('')
const eventTypeFilter = ref('')
const placeFilter = ref('')
const page = ref(1)
const editorOpen = ref(false)
const placeManagerOpen = ref(false)
const selectedEvent = ref<FamilyEvent>()
const locatedEventId = computed(() => {
  const value = route.query.event ?? route.query.eventId
  return typeof value === 'string' ? value : ''
})
let loadRequest = 0

function primaryName(person: Person): string {
  return getPrimaryName(person)
}

const personNames = computed<Record<string, string>>(() => Object.fromEntries(
  people.value.map((person) => [person.id, primaryName(person)]),
))
const placeNames = computed<Record<string, string>>(() => Object.fromEntries(
  places.value.map((place) => [place.id, place.name]),
))
const eventTypes = computed(() => [...new Set(events.value.map(({ type }) => type))]
  .sort((left, right) => eventTypeLabel(left).localeCompare(eventTypeLabel(right), 'zh-CN')))
const grouped = computed(() => groupEvents(events.value, {
  ...(participantFilter.value ? { participantId: participantFilter.value } : {}),
  ...(eventTypeFilter.value ? { eventType: eventTypeFilter.value } : {}),
  ...(placeFilter.value ? { placeId: placeFilter.value } : {}),
  page: page.value,
  pageSize: GROUPS_PER_PAGE,
}))

watch([participantFilter, eventTypeFilter, placeFilter], () => { page.value = 1 })

async function listAllActivePeople(scopedProjectId: string): Promise<Person[]> {
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
      throw new Error('人物分页信息无效，无法安全读取全部人物。')
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

async function loadTimeline() {
  const request = ++loadRequest
  const scopedProjectId = projectId.value
  loadState.value = 'loading'
  loadError.value = ''
  try {
    const [listedEvents, listedPlaces, listedPeople, listedSources] = await Promise.all([
      repository.listEvents(scopedProjectId),
      repository.listPlaces(scopedProjectId),
      listAllActivePeople(scopedProjectId),
      repository.listSources(scopedProjectId),
    ])
    const scopedEvents = listedEvents.filter((event) => event.projectId === scopedProjectId)
    if (request !== loadRequest) return
    events.value = scopedEvents
    people.value = listedPeople
    places.value = listedPlaces.filter((place) => place.projectId === scopedProjectId)
    sources.value = listedSources.filter((source) => source.projectId === scopedProjectId)
    if (page.value > grouped.value.totalPages) page.value = grouped.value.totalPages
    loadState.value = 'ready'
    locateEvent()
  } catch (error) {
    if (request !== loadRequest) return
    loadError.value = error instanceof Error ? error.message : '无法读取时间线资料'
    loadState.value = 'error'
  }
}

watch(projectId, () => {
  participantFilter.value = ''
  eventTypeFilter.value = ''
  placeFilter.value = ''
  page.value = 1
  editorOpen.value = false
  selectedEvent.value = undefined
  void loadTimeline()
}, { immediate: true })
watch(locatedEventId, () => locateEvent())

function locateEvent() {
  if (loadState.value !== 'ready' || !locatedEventId.value) return
  const target = events.value.find(({ id }) => id === locatedEventId.value)
  if (!target) return
  selectedEvent.value = target
  editorOpen.value = true
}

function editEvent(event: FamilyEvent) {
  selectedEvent.value = event
  editorOpen.value = true
}

function createEvent() {
  selectedEvent.value = undefined
  editorOpen.value = true
}

function closeEditor() {
  editorOpen.value = false
  selectedEvent.value = undefined
}

async function eventSaved() {
  closeEditor()
  await loadTimeline()
}

async function placesChanged() {
  await loadTimeline()
}

function clearFilters() {
  participantFilter.value = ''
  eventTypeFilter.value = ''
  placeFilter.value = ''
}
</script>

<template>
  <section class="timeline-view" aria-labelledby="timeline-title">
    <header class="timeline-view__heading">
      <div>
        <h1 id="timeline-title">时间线</h1>
      </div>
      <div class="timeline-view__heading-actions">
        <div class="timeline-view__count" aria-live="polite">
          <strong>{{ grouped.totalEvents }}</strong>
          <span>件事件</span>
        </div>
        <BaseButton name="管理地点" variant="secondary" @click="placeManagerOpen = true">管理地点</BaseButton>
        <BaseButton name="新建事件" @click="createEvent">新建事件</BaseButton>
      </div>
    </header>
    <p v-if="selectedEvent && locatedEventId" class="timeline-view__located" role="status" :data-located-event-id="selectedEvent.id">已定位并打开事件 <code>{{ selectedEvent.id }}</code>：{{ selectedEvent.title }}</p>

    <form class="timeline-view__filters" aria-label="时间线筛选" @submit.prevent>
      <label>
        <span>参与人物</span>
        <FilterSelectControl>
          <select v-model="participantFilter" name="participantFilter">
            <option value="">全部人物</option>
            <option v-for="person in people" :key="person.id" :value="person.id">{{ primaryName(person) }}</option>
          </select>
        </FilterSelectControl>
      </label>
      <label>
        <span>事件类型</span>
        <FilterSelectControl>
          <select v-model="eventTypeFilter" name="eventTypeFilter">
            <option value="">全部类型</option>
            <option v-for="type in eventTypes" :key="type" :value="type">{{ eventTypeLabel(type) }}</option>
          </select>
        </FilterSelectControl>
      </label>
      <label>
        <span>地点</span>
        <FilterSelectControl>
          <select v-model="placeFilter" name="placeFilter">
            <option value="">全部地点</option>
            <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
          </select>
        </FilterSelectControl>
      </label>
      <BaseButton
        class="timeline-view__clear-filters"
        variant="secondary"
        aria-label="清除时间线筛选"
        title="清除筛选"
        @click="clearFilters"
      >
        <IconFilterX :size="18" :stroke-width="1.8" aria-hidden="true" />
      </BaseButton>
    </form>

    <div v-if="loadState === 'loading'" class="timeline-view__state" role="status">
      正在整理时间线…
    </div>
    <div v-else-if="loadState === 'error'" class="timeline-view__state timeline-view__state--error" role="alert">
      <strong>时间线暂时无法读取</strong>
      <span>{{ loadError }}</span>
      <BaseButton variant="secondary" size="sm" @click="loadTimeline">重新读取</BaseButton>
    </div>
    <EmptyState
      v-else-if="grouped.totalEvents === 0"
      title="没有符合条件的事件"
      description="可以清除筛选，或新建一件家庭事件。"
    >
      <span class="timeline-view__empty-mark">时</span>
      <template #actions>
        <BaseButton variant="secondary" size="sm" @click="clearFilters">清除筛选</BaseButton>
        <BaseButton size="sm" @click="createEvent">新建事件</BaseButton>
      </template>
    </EmptyState>
    <template v-else>
      <div class="timeline-view__groups" aria-live="polite">
        <TimelineGroup
          v-for="group in grouped.groups"
          :key="group.key"
          :group="group"
          :project-id="projectId"
          :person-names="personNames"
          :place-names="placeNames"
          @edit="editEvent"
        />
      </div>

      <nav v-if="grouped.totalPages > 1" class="timeline-view__pagination" aria-label="时间线分页">
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="page <= 1"
          aria-label="上一页时间段"
          @click="page -= 1"
        >
          ← 较早
        </BaseButton>
        <span>第 {{ grouped.page }} / {{ grouped.totalPages }} 页，共 {{ grouped.totalGroups }} 个时间段</span>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="page >= grouped.totalPages"
          aria-label="下一页时间段"
          @click="page += 1"
        >
          较晚 →
        </BaseButton>
      </nav>
    </template>

    <EventEditorDrawer
      :open="editorOpen"
      :project-id="projectId"
      :people="people"
      :places="places"
      :sources="sources"
      :event="selectedEvent"
      @close="closeEditor"
      @saved="eventSaved"
      @deleted="eventSaved"
    />
    <PlaceManager
      :open="placeManagerOpen"
      :project-id="projectId"
      :places="places"
      @close="placeManagerOpen = false"
      @changed="placesChanged"
    />
  </section>
</template>

<style scoped>
.timeline-view {
  display: grid;
  width: min(68rem, 100%);
  gap: var(--space-5);
  margin: 0 auto;
}

.timeline-view__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: var(--space-6);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.timeline-view h1 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: clamp(2.25rem, 5vw, 4.25rem);
  font-weight: 560;
  letter-spacing: -0.035em;
  line-height: 1.05;
}

.timeline-view__heading-actions { display: flex; align-items: end; gap: var(--space-4); }
.timeline-view__located { padding: var(--space-2) var(--space-3); margin: 0; border-radius: var(--radius-sm); background: var(--color-info-surface); color: var(--color-info); }
.timeline-view__count { display: grid; justify-items: end; color: var(--color-muted); }
.timeline-view__count strong { color: var(--color-primary); font-family: var(--font-heading); font-size: 2rem; line-height: 1; }

.timeline-view__filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  align-items: end;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgb(255 252 246 / 88%);
  box-shadow: var(--shadow-sm);
}

.timeline-view__filters label { display: grid; gap: var(--space-1); color: var(--color-muted); font-size: 0.75rem; font-weight: 700; }
.timeline-view__clear-filters { width: 2.75rem; height: 2.75rem; min-width: 2.75rem; padding: 0; }
.timeline-view__groups { display: grid; gap: var(--space-5); }

.timeline-view__state {
  display: grid;
  min-height: 16rem;
  place-content: center;
  justify-items: center;
  gap: var(--space-3);
  color: var(--color-muted);
}

.timeline-view__state--error { color: var(--color-danger); }
.timeline-view__pagination { display: flex; align-items: center; justify-content: center; gap: var(--space-4); color: var(--color-muted); font-size: 0.8125rem; }
.timeline-view__empty-mark { display: grid; width: 3.5rem; height: 3.5rem; place-items: center; border: 1px solid currentColor; border-radius: 50%; }

@media (max-width: 52rem) {
  .timeline-view__filters { grid-template-columns: 1fr 1fr; }
}

@media (max-width: 36rem) {
  .timeline-view__heading { align-items: start; flex-direction: column; }
  .timeline-view__filters { grid-template-columns: 1fr; }
  .timeline-view__pagination { align-items: stretch; flex-direction: column; text-align: center; }
}
</style>
