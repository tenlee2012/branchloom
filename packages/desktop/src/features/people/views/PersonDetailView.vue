<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  Attachment,
  AttachmentLink,
  CareerRecord,
  Citation,
  FamilyEvent,
  Organization,
  Person,
  Place,
  Relationship,
  Source,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import QuickAddRelativeDialog from '../../relationships/components/QuickAddRelativeDialog.vue'
import RelationshipEditor from '../../relationships/components/RelationshipEditor.vue'
import DeletePersonDialog from '../components/DeletePersonDialog.vue'
import CareerEditorDrawer from '../components/CareerEditorDrawer.vue'
import PersonDetailPanel from '../components/PersonDetailPanel.vue'
import EventEditorDrawer from '../../timeline/components/EventEditorDrawer.vue'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const session = useSessionStore()
const projectId = computed(() => String(route.params.projectId ?? ''))
const personId = computed(() => String(route.params.personId ?? ''))
const person = ref<Person>()
const projectPeople = ref<Person[]>([])
const relationships = ref<Relationship[]>([])
const projectRelationships = ref<Relationship[]>([])
const careers = ref<CareerRecord[]>([])
const organizations = ref<Organization[]>([])
const places = ref<Place[]>([])
const events = ref<FamilyEvent[]>([])
const sources = ref<Source[]>([])
const citations = ref<Citation[]>([])
const attachments = ref<Attachment[]>([])
const attachmentLinks = ref<AttachmentLink[]>([])
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const relationshipEditorOpen = ref(false)
const selectedRelationship = ref<Relationship>()
const quickAddOpen = ref(false)
const careerEditorOpen = ref(false)
const selectedCareer = ref<CareerRecord>()
const eventEditorOpen = ref(false)
const selectedEvent = ref<FamilyEvent>()
const deleteOpen = ref(false)
const deleteLoading = ref(false)
const deleting = ref(false)
const deleteError = ref('')
const deleteImpact = ref<{ relationships: number; events: number; citations: number } | null>(null)
let personRequest = 0
let impactRequest = 0
let deleteRequest = 0

function displayName(value: Person | undefined) {
  return value ? getPrimaryName(value) : '这位人物'
}

function editPerson() {
  void router.push({
    name: 'person-edit',
    params: { projectId: projectId.value, personId: personId.value },
  })
}

async function loadPerson(expectedProjectId: string, expectedPersonId: string) {
  const request = ++personRequest
  person.value = undefined
  projectPeople.value = []
  relationships.value = []
  projectRelationships.value = []
  careers.value = []
  organizations.value = []
  places.value = []
  events.value = []
  sources.value = []
  citations.value = []
  attachments.value = []
  attachmentLinks.value = []
  loadState.value = 'loading'
  loadError.value = ''
  relationshipEditorOpen.value = false
  selectedRelationship.value = undefined
  quickAddOpen.value = false
  careerEditorOpen.value = false
  selectedCareer.value = undefined
  eventEditorOpen.value = false
  selectedEvent.value = undefined
  deleteOpen.value = false
  try {
    const [
      personResult,
      peopleResult,
      relationshipsResult,
      careersResult,
      organizationsResult,
      placesResult,
      eventsResult,
      sourcesResult,
      citationsResult,
      attachmentsResult,
      attachmentLinksResult,
    ] = await Promise.allSettled([
      repository.getPerson(expectedPersonId),
      repository.listPeople(expectedProjectId, { page: 1, pageSize: 500, sort: 'name' }),
      repository.listRelationships(expectedProjectId),
      repository.listCareers(expectedProjectId, expectedPersonId),
      repository.listOrganizations(expectedProjectId),
      repository.listPlaces(expectedProjectId),
      repository.listEvents(expectedProjectId),
      repository.listSources(expectedProjectId),
      repository.listCitations(expectedProjectId),
      repository.listAttachments(expectedProjectId),
      repository.listAttachmentLinks(expectedProjectId),
    ])
    if (personResult.status === 'rejected') throw personResult.reason
    const loaded = personResult.value
    if (request !== personRequest || expectedProjectId !== projectId.value || expectedPersonId !== personId.value) return
    if (loaded.projectId !== expectedProjectId || loaded.deletedAt) throw new Error('人物不属于当前项目或已被删除')
    person.value = loaded
    projectPeople.value = peopleResult.status === 'fulfilled' ? peopleResult.value.items : [loaded]
    const relatedRelationships = relationshipsResult.status === 'fulfilled'
      ? relationshipsResult.value.filter(({ fromPersonId, toPersonId }) =>
        fromPersonId === loaded.id || toPersonId === loaded.id)
      : []
    const relatedCareers = careersResult.status === 'fulfilled' ? careersResult.value : []
    const relatedEvents = eventsResult.status === 'fulfilled'
      ? eventsResult.value.filter(({ participantIds }) => participantIds.includes(loaded.id))
      : []
    const relevantTargets = new Map<Citation['targetType'], Set<string>>([
      ['person', new Set([loaded.id])],
      ['relationship', new Set(relatedRelationships.map(({ id }) => id))],
      ['event', new Set(relatedEvents.map(({ id }) => id))],
      ['career', new Set(relatedCareers.map(({ id }) => id))],
    ])
    const relatedCitations = citationsResult.status === 'fulfilled'
      ? citationsResult.value.filter(({ targetType, targetId }) =>
        relevantTargets.get(targetType)?.has(targetId))
      : []
    const citationIds = new Set(relatedCitations.map(({ id }) => id))
    const relatedAttachmentLinks = attachmentLinksResult.status === 'fulfilled'
      ? attachmentLinksResult.value.filter(({ targetType, targetId }) =>
        targetType === 'citation'
          ? citationIds.has(targetId)
          : targetType === 'project'
            ? false
          : relevantTargets.get(targetType)?.has(targetId))
      : []
    const attachmentIds = new Set(relatedAttachmentLinks.map(({ attachmentId }) => attachmentId))
    relationships.value = relatedRelationships
    projectRelationships.value = relationshipsResult.status === 'fulfilled'
      ? relationshipsResult.value
      : relatedRelationships
    careers.value = relatedCareers
    organizations.value = organizationsResult.status === 'fulfilled' ? organizationsResult.value : []
    places.value = placesResult.status === 'fulfilled' ? placesResult.value : []
    events.value = relatedEvents
    citations.value = relatedCitations
    attachmentLinks.value = relatedAttachmentLinks
    sources.value = sourcesResult.status === 'fulfilled' ? sourcesResult.value : []
    attachments.value = attachmentsResult.status === 'fulfilled'
      ? attachmentsResult.value.filter(({ id }) => attachmentIds.has(id))
      : []
    loadState.value = 'ready'
  } catch (error) {
    if (request !== personRequest || expectedProjectId !== projectId.value || expectedPersonId !== personId.value) return
    loadState.value = 'error'
    loadError.value = error instanceof Error ? error.message : '人物资料无法读取'
  }
}

watch([projectId, personId], ([nextProjectId, nextPersonId]) => {
  if (!nextProjectId || !nextPersonId) return
  impactRequest += 1
  deleteRequest += 1
  deleteOpen.value = false
  deleting.value = false
  void loadPerson(nextProjectId, nextPersonId)
}, { immediate: true })

async function openDelete() {
  if (!person.value) return
  const request = ++impactRequest
  const target = person.value
  deleteOpen.value = true
  deleteLoading.value = true
  deleteImpact.value = null
  deleteError.value = ''
  try {
    const [relationships, events, citations] = await Promise.all([
      repository.listRelationships(target.projectId),
      repository.listEvents(target.projectId),
      repository.listCitations(target.projectId),
    ])
    if (request !== impactRequest || !deleteOpen.value || person.value?.id !== target.id) return
    deleteImpact.value = {
      relationships: relationships.filter(({ fromPersonId, toPersonId }) => fromPersonId === target.id || toPersonId === target.id).length,
      events: events.filter(({ participantIds }) => participantIds.includes(target.id)).length,
      citations: citations.filter(({ targetType, targetId }) => targetType === 'person' && targetId === target.id).length,
    }
  } catch (error) {
    if (request !== impactRequest || !deleteOpen.value) return
    deleteError.value = error instanceof Error ? error.message : '关联资料无法读取'
  } finally {
    if (request === impactRequest) deleteLoading.value = false
  }
}

function closeDelete() {
  if (deleting.value) return
  impactRequest += 1
  deleteOpen.value = false
}

async function confirmDelete() {
  if (!person.value || !deleteImpact.value || deleting.value) return
  const request = ++deleteRequest
  const target = person.value
  deleting.value = true
  deleteError.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.softDeletePerson(target.id)
    if (
      request !== deleteRequest ||
      target.projectId !== projectId.value ||
      target.id !== personId.value
    ) return
    await session.refreshHistory(repository)
    if (request !== deleteRequest) return
    session.saveStatus = 'saved'
    await router.replace({ name: 'project-people', params: { projectId: target.projectId } })
  } catch (error) {
    if (request !== deleteRequest) return
    const details = error instanceof Error ? error.message : '本地资料暂时无法写入'
    deleteError.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    if (request === deleteRequest) deleting.value = false
  }
}

function applySaved(saved: Person) {
  if (saved.id === personId.value && saved.projectId === projectId.value) person.value = saved
  const index = projectPeople.value.findIndex(({ id }) => id === saved.id)
  if (index < 0) projectPeople.value.push(saved)
  else projectPeople.value[index] = saved
}

function applyRelationship(saved: Relationship) {
  if (saved.projectId !== projectId.value) return
  const index = relationships.value.findIndex(({ id }) => id === saved.id)
  if (index < 0) relationships.value.push(saved)
  else relationships.value[index] = saved
}

function removeRelationship(relationshipId: string) {
  relationships.value = relationships.value.filter(({ id }) => id !== relationshipId)
  closeRelationshipEditor()
}

function applyRelative(savedPerson: Person, savedRelationship: Relationship) {
  applySaved(savedPerson)
  applyRelationship(savedRelationship)
}

function openNewRelationship() {
  selectedRelationship.value = undefined
  relationshipEditorOpen.value = true
}

function openRelationship(relationship: Relationship) {
  selectedRelationship.value = relationship
  relationshipEditorOpen.value = true
}

function closeRelationshipEditor() {
  relationshipEditorOpen.value = false
  selectedRelationship.value = undefined
}

function openNewCareer() {
  selectedCareer.value = undefined
  careerEditorOpen.value = true
}

function openCareer(career: CareerRecord) {
  selectedCareer.value = career
  careerEditorOpen.value = true
}

function applyCareer(saved: CareerRecord) {
  const index = careers.value.findIndex(({ id }) => id === saved.id)
  if (index < 0) careers.value.push(saved)
  else careers.value[index] = saved
  careerEditorOpen.value = false
  selectedCareer.value = undefined
  void repository.listOrganizations(projectId.value).then((items) => { organizations.value = items })
}

function removeCareer(careerId: string) {
  careers.value = careers.value.filter(({ id }) => id !== careerId)
  careerEditorOpen.value = false
  selectedCareer.value = undefined
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
  await loadPerson(projectId.value, personId.value)
}

onBeforeUnmount(() => {
  personRequest += 1
  impactRequest += 1
  deleteRequest += 1
})
</script>

<template>
  <section class="person-detail-view" aria-label="人物详情">
    <div v-if="loadState === 'loading'" id="person-detail-state" class="person-detail-view__state" role="status">
      正在读取人物档案…
    </div>
    <div v-else-if="loadState === 'error'" id="person-detail-state" class="person-detail-view__state" role="alert">
      <strong>人物档案未能打开</strong>
      <span>{{ loadError }}</span>
      <BaseButton variant="secondary" @click="loadPerson(projectId, personId)">重新读取</BaseButton>
    </div>
    <PersonDetailPanel
      v-else-if="person"
      :person="person"
      :people="projectPeople"
      :relationships="relationships"
      :project-relationships="projectRelationships"
      :careers="careers"
      :organizations="organizations"
      :places="places"
      :events="events"
      :sources="sources"
      :citations="citations"
      :attachments="attachments"
      :attachment-links="attachmentLinks"
      @edit="editPerson"
      @delete="openDelete"
      @add-relationship="openNewRelationship"
      @quick-add-relative="quickAddOpen = true"
      @edit-relationship="openRelationship"
      @add-career="openNewCareer"
      @edit-career="openCareer"
      @add-event="openNewEvent"
      @edit-event="openEvent"
    />

    <EventEditorDrawer
      v-if="person"
      :open="eventEditorOpen"
      :project-id="projectId"
      :people="projectPeople"
      :places="places"
      :sources="sources"
      :default-participant-ids="[person.id]"
      v-bind="selectedEvent ? { event: selectedEvent } : {}"
      @close="closeEventEditor"
      @saved="refreshEvents"
      @deleted="refreshEvents"
    />

    <CareerEditorDrawer
      v-if="person"
      :open="careerEditorOpen"
      :project-id="projectId"
      :person-id="person.id"
      v-bind="selectedCareer ? { career: selectedCareer } : {}"
      @close="careerEditorOpen = false"
      @saved="applyCareer"
      @deleted="removeCareer"
    />
    <DeletePersonDialog
      :open="deleteOpen"
      :person-name="displayName(person)"
      :impact="deleteImpact"
      :loading="deleteLoading"
      :deleting="deleting"
      v-bind="deleteError ? { error: deleteError } : {}"
      @close="closeDelete"
      @confirm="confirmDelete"
    />
    <RelationshipEditor
      v-if="person"
      :open="relationshipEditorOpen"
      :project-id="projectId"
      :person="person"
      v-bind="selectedRelationship ? { relationship: selectedRelationship } : {}"
      @close="closeRelationshipEditor"
      @saved="applyRelationship"
      @deleted="removeRelationship"
    />
    <QuickAddRelativeDialog
      v-if="person"
      :open="quickAddOpen"
      :project-id="projectId"
      :person="person"
      @close="quickAddOpen = false"
      @saved="applyRelative"
    />
  </section>
</template>

<style scoped>
.person-detail-view { display: grid; width: min(82rem, 100%); gap: var(--space-4); margin: 0 auto; }
.person-detail-view__state { display: grid; min-height: 20rem; place-content: center; justify-items: center; gap: var(--space-3); padding: var(--space-8); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); color: var(--color-muted); text-align: center; }
</style>
