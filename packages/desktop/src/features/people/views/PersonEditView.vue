<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseButton from '../../../design-system/BaseButton.vue'
import type { FamilyEvent, Person, Place, Source } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import EventEditorDrawer from '../../timeline/components/EventEditorDrawer.vue'
import PersonEditorForm from '../components/PersonEditorForm.vue'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const personId = computed(() => String(route.params.personId ?? ''))
const isNew = computed(() => route.name === 'person-new')
const person = ref<Person>()
const people = ref<Person[]>([])
const places = ref<Place[]>([])
const sources = ref<Source[]>([])
const events = ref<FamilyEvent[]>([])
const eventEditorOpen = ref(false)
const selectedEvent = ref<FamilyEvent>()
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
let requestId = 0

async function loadPerson(expectedProjectId = projectId.value, expectedPersonId = personId.value) {
  const request = ++requestId
  person.value = undefined
  people.value = []
  places.value = []
  sources.value = []
  events.value = []
  eventEditorOpen.value = false
  selectedEvent.value = undefined
  loadState.value = 'loading'
  loadError.value = ''
  if (isNew.value) {
    loadState.value = 'ready'
    return
  }
  try {
    const [personResult, peopleResult, placesResult, sourcesResult, eventsResult] = await Promise.allSettled([
      repository.getPerson(expectedPersonId),
      repository.listPeople(expectedProjectId, { page: 1, pageSize: 500, sort: 'name' }),
      repository.listPlaces(expectedProjectId),
      repository.listSources(expectedProjectId),
      repository.listEvents(expectedProjectId),
    ])
    if (personResult.status === 'rejected') throw personResult.reason
    const loaded = personResult.value
    if (request !== requestId || expectedProjectId !== projectId.value || expectedPersonId !== personId.value) return
    if (loaded.projectId !== expectedProjectId || loaded.deletedAt) throw new Error('人物不属于当前项目或已被删除')
    person.value = loaded
    people.value = peopleResult.status === 'fulfilled' ? peopleResult.value.items : [loaded]
    places.value = placesResult.status === 'fulfilled' ? placesResult.value : []
    sources.value = sourcesResult.status === 'fulfilled' ? sourcesResult.value : []
    events.value = eventsResult.status === 'fulfilled'
      ? eventsResult.value.filter(({ participantIds }) => participantIds.includes(loaded.id))
      : []
    loadState.value = 'ready'
  } catch (error) {
    if (request !== requestId) return
    loadState.value = 'error'
    loadError.value = error instanceof Error ? error.message : '人物资料无法读取'
  }
}

function detailLocation() {
  return { name: 'person-detail', params: { projectId: projectId.value, personId: personId.value } }
}

function cancel() {
  void router.push(isNew.value
    ? { name: 'project-people', params: { projectId: projectId.value } }
    : detailLocation())
}

function saved(savedPerson: Person) {
  void router.replace({ name: 'person-detail', params: { projectId: savedPerson.projectId, personId: savedPerson.id } })
}

function openNewEvent() {
  selectedEvent.value = undefined
  eventEditorOpen.value = true
}

function openEvent(event: FamilyEvent) {
  selectedEvent.value = event
  eventEditorOpen.value = true
}

function closeEventEditor() {
  eventEditorOpen.value = false
  selectedEvent.value = undefined
}

async function refreshEvents() {
  closeEventEditor()
  const listed = await repository.listEvents(projectId.value)
  if (!person.value) return
  events.value = listed.filter(({ participantIds }) => participantIds.includes(person.value!.id))
}

watch([projectId, personId, isNew], () => { void loadPerson() }, { immediate: true })
onBeforeUnmount(() => { requestId += 1 })
</script>

<template>
  <section class="person-edit-view" aria-labelledby="person-edit-title">
    <div v-if="loadState === 'loading'" class="person-edit-view__state" role="status">正在读取人物档案…</div>
    <div v-else-if="loadState === 'error'" class="person-edit-view__state" role="alert">
      <strong>人物档案未能打开</strong>
      <span>{{ loadError }}</span>
      <BaseButton variant="secondary" @click="loadPerson()">重新读取</BaseButton>
    </div>
    <PersonEditorForm
      v-else-if="isNew || person"
      layout="page"
      :project-id="projectId"
      v-bind="person ? { person } : {}"
      :events="events"
      @cancel="cancel"
      @saved="saved"
      @add-event="openNewEvent"
      @edit-event="openEvent"
    />
    <EventEditorDrawer
      v-if="person"
      :open="eventEditorOpen"
      :project-id="projectId"
      :people="people"
      :places="places"
      :sources="sources"
      :default-participant-ids="[person.id]"
      v-bind="selectedEvent ? { event: selectedEvent } : {}"
      @close="closeEventEditor"
      @saved="refreshEvents"
      @deleted="refreshEvents"
    />
  </section>
</template>

<style scoped>
.person-edit-view { width: min(68rem, 100%); margin: 0 auto; }
.person-edit-view__state { display: grid; min-height: 20rem; place-content: center; justify-items: center; gap: var(--space-3); color: var(--color-muted); text-align: center; }
</style>
