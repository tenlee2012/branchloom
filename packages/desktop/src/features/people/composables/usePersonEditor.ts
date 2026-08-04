import { computed, ref, type Ref } from 'vue'
import type { Store } from 'pinia'
import { parseGenealogyDate, validateLifeDates } from '../../../shared/domain/date'
import type {
  BranchloomRepository,
  GenealogyDate,
  Person,
  PersonName,
  SaveStatus,
} from '../../../shared/domain/types'

interface SessionSaveState extends Store {
  saveStatus: SaveStatus
  saveError: string | undefined
  refreshHistory(repository: BranchloomRepository): Promise<void>
}

let fallbackId = 0

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `${prefix}-${Date.now()}-${fallbackId}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createPerson(projectId: string): Person {
  return {
    id: createId('person'),
    projectId,
    names: [{ value: '', type: 'personal', primary: true, notes: '' }],
    sex: 'unknown',
    status: 'unknown',
    biography: '',
    notes: '',
    updatedAt: new Date().toISOString(),
  }
}

export function normalizePersonNames(names: PersonName[]): PersonName[] {
  const trimmed = names
    .map((name) => {
      const legacyName = name as PersonName & { language?: string; script?: string }
      const { language: _language, script: _script, ...supportedName } = legacyName
      const normalized: PersonName = { ...supportedName, value: name.value.trim() }
      const customTypeLabel = normalized.customTypeLabel?.trim()
      if (customTypeLabel) normalized.customTypeLabel = customTypeLabel
      else delete normalized.customTypeLabel
      const familyName = normalized.familyName?.trim()
      if (familyName) normalized.familyName = familyName
      else delete normalized.familyName
      const givenName = normalized.givenName?.trim()
      if (givenName) normalized.givenName = givenName
      else delete normalized.givenName
      const context = normalized.context?.trim()
      if (context) normalized.context = context
      else delete normalized.context
      normalized.notes = normalized.notes?.trim() ?? ''
      return normalized
    })
    .filter(({ value }) => value.length > 0)
  if (trimmed.length === 0) return []

  const selectedPrimary = trimmed.findIndex(({ primary }) => primary)
  const primaryIndex = selectedPrimary >= 0 ? selectedPrimary : 0
  return trimmed.map((name, index) => ({ ...name, primary: index === primaryIndex }))
}

function optionalDate(value: string): GenealogyDate | undefined {
  return value.trim() ? parseGenealogyDate(value) : undefined
}

export function usePersonEditor(
  repository: BranchloomRepository,
  session: SessionSaveState,
  projectId: Ref<string>,
  sourcePerson: Ref<Person | undefined>,
) {
  const draft = ref<Person>(createPerson(projectId.value))
  const baseline = ref('')
  const saving = ref(false)
  const validationError = ref('')
  const saveFailure = ref('')

  const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
  const lifeDateWarnings = computed(() => validateLifeDates(draft.value))

  function reset() {
    draft.value = sourcePerson.value
      ? clone(sourcePerson.value)
      : createPerson(projectId.value)
    baseline.value = JSON.stringify(draft.value)
    validationError.value = ''
    saveFailure.value = ''
  }

  function setDate(field: 'birth' | 'death', value: string) {
    const date = optionalDate(value)
    if (date) draft.value[field] = date
    else delete draft.value[field]
  }

  async function save(): Promise<Person | undefined> {
    if (saving.value) return undefined
    const names = normalizePersonNames(draft.value.names)
    if (names.length === 0) {
      validationError.value = '请至少填写一个姓名。'
      return undefined
    }

    saving.value = true
    validationError.value = ''
    saveFailure.value = ''
    session.saveStatus = 'saving'
    session.saveError = undefined
    const candidate: Person = {
      ...clone(draft.value),
      projectId: projectId.value,
      names: clone(names),
      updatedAt: new Date().toISOString(),
    }

    try {
      const saved = await repository.savePerson(candidate)
      draft.value = clone(saved)
      baseline.value = JSON.stringify(draft.value)
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

  return {
    draft,
    dirty,
    saving,
    validationError,
    saveFailure,
    lifeDateWarnings,
    reset,
    setDate,
    save,
  }
}
