import { computed, ref, type Ref } from 'vue'
import type { Store } from 'pinia'
import { parseGenealogyDate } from '../../../shared/domain/date'
import { validateRelationship } from '../../../shared/domain/relationships'
import type {
  BranchloomRepository,
  DataIssue,
  ParentRelation,
  PartnerRelation,
  Person,
  Place,
  Relationship,
  SaveStatus,
} from '../../../shared/domain/types'

interface SessionSaveState extends Store {
  saveStatus: SaveStatus
  saveError: string | undefined
  refreshHistory(repository: BranchloomRepository): Promise<void>
}

export const parentRelationshipOptions: ReadonlyArray<{ value: ParentRelation; label: string }> = [
  { value: 'biological', label: '亲生' },
  { value: 'adoptive', label: '收养' },
  { value: 'step', label: '继亲' },
  { value: 'guardian', label: '监护' },
]

export const partnerRelationshipOptions: ReadonlyArray<{ value: PartnerRelation; label: string }> = [
  { value: 'engaged', label: '订婚' },
  { value: 'married', label: '婚姻' },
  { value: 'partner', label: '事实伴侣' },
  { value: 'separated', label: '分居' },
  { value: 'divorced', label: '离异' },
]

const parentEndpointLabels: Record<ParentRelation, {
  from: string
  to: string
  father?: string
  mother?: string
}> = {
  biological: { from: '亲生子女', to: '亲生父母', father: '亲生父亲', mother: '亲生母亲' },
  adoptive: { from: '养子女', to: '养父母', father: '养父', mother: '养母' },
  step: { from: '继子女', to: '继父母', father: '继父', mother: '继母' },
  guardian: { from: '被监护人', to: '监护人' },
}

const partnerLabels: Record<PartnerRelation, string> = {
  engaged: '订婚伴侣',
  married: '配偶',
  partner: '事实伴侣',
  separated: '分居伴侣',
  divorced: '前配偶',
}

export function relationshipDisplayLabel(
  relationship: Relationship,
  personId: string,
  relativePerson?: Pick<Person, 'sex'>,
): string {
  if (relationship.category === 'partner') return partnerLabels[relationship.type]
  const labels = parentEndpointLabels[relationship.type]
  if (relationship.fromPersonId === personId) return labels.from
  if (relativePerson?.sex === 'male' && labels.father) return labels.father
  if (relativePerson?.sex === 'female' && labels.mother) return labels.mother
  return labels.to
}

let fallbackId = 0

export function createRelationshipId(prefix: 'person' | 'name' | 'relationship'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `${prefix}-${Date.now()}-${fallbackId}`
}

function optionalDate(value: string) {
  return value.trim() ? parseGenealogyDate(value) : undefined
}

export function useRelationshipEditor(
  repository: BranchloomRepository,
  session: SessionSaveState,
  projectId: Ref<string>,
  currentPerson: Ref<Person>,
  sourceRelationship: Ref<Relationship | undefined>,
) {
  const category = ref<Relationship['category']>('parent')
  const parentType = ref<ParentRelation>('biological')
  const partnerType = ref<PartnerRelation>('married')
  const relativePersonId = ref('')
  const direction = ref<'relative-is-parent' | 'current-is-parent'>('relative-is-parent')
  const start = ref('')
  const end = ref('')
  const placeId = ref('')
  const notes = ref('')
  const people = ref<Person[]>([])
  const places = ref<Place[]>([])
  const relationships = ref<Relationship[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const loadFailure = ref('')
  const saveFailure = ref('')
  const baseline = ref('')

  const type = computed<ParentRelation | PartnerRelation>(() =>
    category.value === 'parent' ? parentType.value : partnerType.value)

  const candidate = computed<Relationship | undefined>(() => {
    if (!relativePersonId.value) return undefined
    const currentId = currentPerson.value.id
    const otherId = relativePersonId.value
    const source = sourceRelationship.value
    const editingPartner = category.value === 'partner' && Boolean(source)
    const currentWasFrom = source?.fromPersonId === currentId
    const currentWasTo = source?.toPersonId === currentId
    const fromPersonId = editingPartner
      ? currentWasFrom
        ? currentId
        : currentWasTo
          ? otherId
          : source!.fromPersonId
      : category.value === 'partner' || direction.value === 'current-is-parent'
        ? currentId
        : otherId
    const toPersonId = editingPartner
      ? currentWasTo
        ? currentId
        : currentWasFrom
          ? otherId
          : source!.toPersonId
      : category.value === 'partner'
        ? otherId
        : direction.value === 'relative-is-parent'
          ? currentId
          : otherId
    const base = {
      ...(source ? clone(source) : {}),
      id: source?.id ?? createStableDraftId(currentId, otherId),
      projectId: source?.projectId ?? projectId.value,
      fromPersonId,
      toPersonId,
      notes: notes.value.trim(),
      sourceIds: source ? [...source.sourceIds] : [],
    }
    const startDate = unchangedDate(start.value, source?.start)
    const endDate = unchangedDate(end.value, source?.end)
    const selectedPlaceId = placeId.value || undefined
    const relationship: Relationship = category.value === 'parent'
      ? { ...base, category: 'parent', type: parentType.value }
      : { ...base, category: 'partner', type: partnerType.value }
    if (startDate) relationship.start = startDate
    else delete relationship.start
    if (endDate) relationship.end = endDate
    else delete relationship.end
    if (selectedPlaceId) relationship.placeId = selectedPlaceId
    else delete relationship.placeId
    return relationship
  })

  const feedback = computed<DataIssue | undefined>(() =>
    candidate.value ? validateRelationship(candidate.value, relationships.value) : undefined)
  const blocking = computed(() => feedback.value?.severity === 'error')
  const dirty = computed(() => draftFingerprint() !== baseline.value)

  async function load() {
    loading.value = true
    loadFailure.value = ''
    try {
      const [page, loadedRelationships, loadedPlaces] = await Promise.all([
        repository.listPeople(projectId.value, { page: 1, pageSize: 500, sort: 'name' }),
        repository.listRelationships(projectId.value),
        repository.listPlaces(projectId.value),
      ])
      people.value = page.items
      relationships.value = loadedRelationships
      places.value = loadedPlaces
    } catch (error) {
      loadFailure.value = error instanceof Error ? error.message : '人物关系无法读取'
    } finally {
      loading.value = false
    }
  }

  function reset() {
    const source = sourceRelationship.value
    category.value = source?.category ?? 'parent'
    parentType.value = source?.category === 'parent' ? source.type : 'biological'
    partnerType.value = source?.category === 'partner' ? source.type : 'married'
    if (source) {
      if (source.category === 'parent') {
        const currentIsParent = source.fromPersonId === currentPerson.value.id
        direction.value = currentIsParent ? 'current-is-parent' : 'relative-is-parent'
        relativePersonId.value = currentIsParent ? source.toPersonId : source.fromPersonId
      } else {
        direction.value = 'relative-is-parent'
        relativePersonId.value = source.fromPersonId === currentPerson.value.id
          ? source.toPersonId
          : source.fromPersonId
      }
    } else {
      relativePersonId.value = ''
      direction.value = 'relative-is-parent'
    }
    start.value = source?.start?.display ?? ''
    end.value = source?.end?.display ?? ''
    placeId.value = source?.placeId ?? ''
    notes.value = source?.notes ?? ''
    saveFailure.value = ''
    baseline.value = draftFingerprint()
  }

  async function save(): Promise<Relationship | undefined> {
    if (saving.value || !candidate.value || blocking.value) return undefined
    saving.value = true
    saveFailure.value = ''
    session.saveStatus = 'saving'
    session.saveError = undefined
    const value = {
      ...candidate.value,
      id: sourceRelationship.value?.id ?? createRelationshipId('relationship'),
    } as Relationship
    try {
      const saved = await repository.saveRelationship(value)
      const index = relationships.value.findIndex(({ id }) => id === saved.id)
      if (index < 0) relationships.value.push(saved)
      else relationships.value[index] = saved
      baseline.value = draftFingerprint()
      await session.refreshHistory(repository)
      session.saveStatus = 'saved'
      return saved
    } catch (error) {
      const details = error instanceof Error ? error.message : '本地资料暂时无法写入'
      saveFailure.value = details
      session.saveStatus = 'failed'
      session.saveError = details
      return undefined
    } finally {
      saving.value = false
    }
  }

  function draftFingerprint(): string {
    return JSON.stringify({
      category: category.value,
      parentType: parentType.value,
      partnerType: partnerType.value,
      relativePersonId: relativePersonId.value,
      direction: direction.value,
      start: start.value,
      end: end.value,
      placeId: placeId.value,
      notes: notes.value,
    })
  }

  return {
    category,
    parentType,
    partnerType,
    type,
    relativePersonId,
    direction,
    start,
    end,
    placeId,
    notes,
    people,
    places,
    relationships,
    loading,
    saving,
    loadFailure,
    saveFailure,
    candidate,
    feedback,
    blocking,
    dirty,
    load,
    reset,
    save,
  }
}

function createStableDraftId(currentId: string, otherId: string): string {
  return `draft-${currentId}-${otherId}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function unchangedDate(value: string, source: Relationship['start']) {
  if (source && value.trim() === source.display) return clone(source)
  return optionalDate(value)
}
