import type { PrototypeState } from '../domain/types'

export const PROTOTYPE_STORAGE_KEY = 'branchloom.prototype.v1'
export const SNAPSHOT_PAYLOADS_STORAGE_KEY = 'branchloom.prototype.v1.snapshot-payloads'
export const RECOVERY_STORAGE_PREFIX = 'branchloom.prototype.v1.recovery.'
export const SNAPSHOT_PAYLOADS_RECOVERY_STORAGE_PREFIX =
  'branchloom.prototype.v1.snapshot-payloads.recovery.'
export const TRANSACTION_RECOVERY_STORAGE_PREFIX = 'branchloom.prototype.v1.transaction.recovery.'
export const TRANSACTION_STORAGE_KEY = 'branchloom.prototype.v1.transaction'

export type RepositoryErrorCode = 'not-found' | 'validation' | 'storage' | 'corrupt'

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode
  override readonly cause: unknown

  constructor(code: RepositoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'RepositoryError'
    this.code = code
    this.cause = options?.cause
  }
}

export type PrototypeStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>

export type SnapshotPayloads = Record<string, PrototypeState>

export function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isOptional(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return value === undefined || guard(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString)
}

function isOneOf(value: unknown, choices: readonly string[]): boolean {
  return isString(value) && choices.includes(value)
}

function isArrayOf(value: unknown, guard: (candidate: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(guard)
}

function normalizeKnownNullableOptionals(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeKnownNullableOptionals)
    return
  }
  if (!isRecord(value)) return
  const projects = value.projects
  if (Array.isArray(projects)) {
    for (const project of projects) {
      if (!isRecord(project)) continue
      for (const key of ['coverUrl', 'defaultPersonId', 'lastBackupAt', 'backupSchedule']) {
        if (project[key] === null) delete project[key]
      }
    }
  }
  Object.values(value).forEach(normalizeKnownNullableOptionals)
}

function isGenealogyDate(value: unknown): boolean {
  return isRecord(value) &&
    isOptional(value.display, isString) &&
    isOptional(value.start, isString) &&
    isOptional(value.end, isString) &&
    isOneOf(value.precision, ['exact', 'about', 'before', 'after', 'range', 'unknown'])
}

function structuredDateDisplay(value: UnknownRecord): string {
  if (isString(value.display)) return value.display
  const start = isString(value.start) ? value.start : undefined
  const end = isString(value.end) ? value.end : undefined
  const span = start && end && start !== end ? `${start}—${end}` : start ?? end ?? ''
  if (value.precision === 'about') return span ? `约 ${span}` : ''
  if (value.precision === 'before') return span ? `${end ?? start} 以前` : ''
  if (value.precision === 'after') return span ? `${start ?? end} 以后` : ''
  return span
}

function hydrateGenealogyDateDisplays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateGenealogyDateDisplays)
  if (!isRecord(value)) return value

  const hydrated = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, hydrateGenealogyDateDisplays(item)]),
  )
  if (isGenealogyDate(hydrated) && hydrated.display === undefined) {
    hydrated.display = structuredDateDisplay(hydrated)
  }
  return hydrated
}

function hasEntityIdentity(value: UnknownRecord): boolean {
  return isString(value.id) && isString(value.projectId)
}

function isProject(value: unknown): boolean {
  return isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.description) &&
    isOptional(value.coverUrl, isString) &&
    isOptional(value.defaultPersonId, isString) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptional(value.lastBackupAt, isString) &&
    isOptional(value.backupSchedule, (candidate) => isOneOf(candidate, ['off', 'daily', 'weekly']))
}

function isPersonName(value: unknown): boolean {
  return isRecord(value) &&
    isString(value.value) &&
    isOneOf(value.type, [
      'personal', 'courtesy', 'art', 'genealogy', 'generation', 'childhood',
      'former', 'pen', 'religious', 'posthumous', 'temple', 'honorific',
      'alias', 'custom',
    ]) &&
    isBoolean(value.primary) &&
    isOptional(value.customTypeLabel, isString) &&
    isOptional(value.familyName, isString) &&
    isOptional(value.givenName, isString) &&
    isOptional(value.validFrom, isGenealogyDate) &&
    isOptional(value.validTo, isGenealogyDate) &&
    isOptional(value.context, isString) &&
    isOptional(value.notes, isString)
}

function isPerson(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isArrayOf(value.names, isPersonName) &&
    isOneOf(value.sex, ['female', 'male', 'nonbinary', 'unknown']) &&
    isOneOf(value.status, ['living', 'deceased', 'unknown']) &&
    isOptional(value.avatarUrl, isString) &&
    isOptional(value.birth, isGenealogyDate) &&
    isOptional(value.death, isGenealogyDate) &&
    isOptional(value.birthPlaceId, isString) &&
    isOptional(value.deathPlaceId, isString) &&
    isString(value.biography) &&
    isString(value.notes) &&
    isOptional(value.sourceIds, isStringArray) &&
    isOptional(value.deletedAt, isString) &&
    isString(value.updatedAt)
}

function isRelationship(value: unknown): boolean {
  if (!isRecord(value) ||
    !hasEntityIdentity(value) ||
    !isString(value.fromPersonId) ||
    !isString(value.toPersonId) ||
    !isOptional(value.start, isGenealogyDate) ||
    !isOptional(value.end, isGenealogyDate) ||
    !isOptional(value.placeId, isString) ||
    !isString(value.notes) ||
    !isStringArray(value.sourceIds)) return false
  return value.category === 'parent'
    ? isOneOf(value.type, ['biological', 'adoptive', 'step', 'guardian'])
    : value.category === 'partner' &&
      isOneOf(value.type, ['engaged', 'married', 'partner', 'separated', 'divorced'])
}

function isEvent(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.type) &&
    isString(value.title) &&
    isGenealogyDate(value.date) &&
    isOptional(value.placeId, isString) &&
    isStringArray(value.participantIds) &&
    isOptional(value.participantRoles, isStringRecord) &&
    isStringArray(value.sourceIds) &&
    isString(value.notes)
}

function isPlace(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.name) &&
    isOptional(value.parentId, isString) &&
    isStringArray(value.aliases) &&
    isString(value.notes)
}

function isOrganization(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.name) &&
    isOneOf(value.type, [
      'company', 'government', 'imperial_court', 'military',
      'education', 'religious', 'clan', 'other',
    ]) &&
    isStringArray(value.aliases) &&
    isOptional(value.parentId, isString) &&
    isOptional(value.placeId, isString) &&
    isOptional(value.validFrom, isGenealogyDate) &&
    isOptional(value.validTo, isGenealogyDate) &&
    isString(value.notes) &&
    isStringArray(value.sourceIds)
}

function isCareer(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.personId) &&
    isOneOf(value.category, [
      'employment', 'civil_office', 'military_office', 'academic',
      'religious_office', 'self_employed', 'other',
    ]) &&
    isOptional(value.organizationId, isString) &&
    isString(value.positionTitle) &&
    isOptional(value.department, isString) &&
    isOptional(value.regime, isString) &&
    isOptional(value.rankOrGrade, isString) &&
    isOptional(value.appointmentType, isString) &&
    isOptional(value.jurisdictionPlaceId, isString) &&
    isOptional(value.appointedByPersonId, isString) &&
    isOptional(value.start, isGenealogyDate) &&
    isOptional(value.end, isGenealogyDate) &&
    isOneOf(value.status, ['current', 'former', 'unknown']) &&
    isString(value.description) &&
    isString(value.notes) &&
    isStringArray(value.sourceIds)
}

function isPersonTitle(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.personId) &&
    isOneOf(value.type, ['nobility', 'conferred-title', 'honorific-title', 'custom']) &&
    isString(value.value) &&
    isOptional(value.customTypeLabel, isString) &&
    isOptional(value.start, isGenealogyDate) &&
    isOptional(value.end, isGenealogyDate) &&
    isOptional(value.placeId, isString) &&
    isOptional(value.grantedByPersonId, isString) &&
    isString(value.notes) &&
    isStringArray(value.sourceIds)
}

function isSource(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.title) &&
    isOneOf(value.type, ['book', 'archive', 'web', 'interview', 'other']) &&
    isOptional(value.author, isString) &&
    isOptional(value.repository, isString) &&
    isOptional(value.url, isString) &&
    isOptional(value.date, isGenealogyDate) &&
    isOptional(value.referenceCode, isString) &&
    isString(value.notes)
}

function isCitation(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.sourceId) &&
    isOneOf(value.targetType, ['person', 'relationship', 'event', 'career']) &&
    isString(value.targetId) &&
    isOptional(value.locator, isString) &&
    isOptional(value.excerpt, isString) &&
    isOptional(value.accessedAt, isGenealogyDate) &&
    isString(value.notes)
}

function isAttachment(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.name) &&
    isString(value.mimeType) &&
    isNumber(value.size) &&
    isOptional(value.previewUrl, isString) &&
    isString(value.contentHash) &&
    isBoolean(value.missing)
}

function isAttachmentLink(value: unknown): boolean {
  return isRecord(value) &&
    hasEntityIdentity(value) &&
    isString(value.attachmentId) &&
    isOneOf(value.targetType, ['project', 'person', 'relationship', 'event', 'career', 'citation']) &&
    isString(value.targetId) &&
    isOptional(value.role, (candidate) => isOneOf(candidate, ['cover', 'avatar', 'evidence', 'document', 'media', 'other']))
}

function isSnapshot(value: unknown): boolean {
  if (!isRecord(value) ||
    !hasEntityIdentity(value) ||
    !isString(value.createdAt) ||
    !isOneOf(value.reason, ['manual', 'import', 'merge', 'cleanup', 'restore']) ||
    !isString(value.note) ||
    !isRecord(value.summary)) return false
  return isNumber(value.summary.people) &&
    isNumber(value.summary.relationships) &&
    isNumber(value.summary.events)
}

function isDataIssue(value: unknown): boolean {
  return isRecord(value) &&
    isString(value.id) &&
    isOneOf(value.severity, ['error', 'warning', 'info']) &&
    isString(value.code) &&
    isString(value.message) &&
    isOneOf(value.targetType, ['person', 'relationship', 'event', 'source', 'attachment']) &&
    isString(value.targetId) &&
    isOptional(value.origin, (candidate) => isOneOf(candidate, ['manual', 'derived']))
}

export function isPrototypeState(value: unknown): value is PrototypeState {
  return isRecord(value) &&
    value.schemaVersion === 2 &&
    isArrayOf(value.projects, isProject) &&
    isArrayOf(value.people, isPerson) &&
    isArrayOf(value.organizations, isOrganization) &&
    isArrayOf(value.careers, isCareer) &&
    isArrayOf(value.personTitles, isPersonTitle) &&
    isArrayOf(value.relationships, isRelationship) &&
    isArrayOf(value.events, isEvent) &&
    isArrayOf(value.places, isPlace) &&
    isArrayOf(value.sources, isSource) &&
    isArrayOf(value.citations, isCitation) &&
    isArrayOf(value.attachments, isAttachment) &&
    isArrayOf(value.attachmentLinks, isAttachmentLink) &&
    isArrayOf(value.snapshots, isSnapshot) &&
    isArrayOf(value.issues, isDataIssue)
}

export function parsePrototypeState(raw: string): PrototypeState {
  try {
    const parsed: unknown = JSON.parse(raw)
    normalizeKnownNullableOptionals(parsed)
    if (!isPrototypeState(parsed)) {
      throw new RepositoryError('corrupt', '本地资料格式不受支持或内容无效')
    }
    return hydrateGenealogyDateDisplays(parsed) as PrototypeState
  } catch (error) {
    if (error instanceof RepositoryError) throw error
    throw new RepositoryError('corrupt', 'Prototype data is not valid JSON', { cause: error })
  }
}

export function parseSnapshotPayloads(raw: string): SnapshotPayloads {
  try {
    const parsed: unknown = JSON.parse(raw)
    normalizeKnownNullableOptionals(parsed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RepositoryError('corrupt', 'Snapshot payload sidecar is invalid')
    }
    const payloads = Object.fromEntries(Object.entries(parsed))
    for (const payload of Object.values(payloads)) {
      if (!isPrototypeState(payload)) {
        throw new RepositoryError('corrupt', 'Snapshot payload sidecar contains invalid state')
      }
    }
    return hydrateGenealogyDateDisplays(payloads) as SnapshotPayloads
  } catch (error) {
    if (error instanceof RepositoryError) throw error
    throw new RepositoryError('corrupt', 'Snapshot payload sidecar is not valid JSON', { cause: error })
  }
}

function snapshotProjectPayload(
  state: PrototypeState,
  snapshot: PrototypeState['snapshots'][number],
): PrototypeState {
  const next = cloneValue(state)
  const project = state.projects.find(({ id }) => id === snapshot.projectId)
  if (!project) return next

  let people = state.people
    .filter(({ projectId, deletedAt }) => projectId === snapshot.projectId && !deletedAt)
    .slice(0, snapshot.summary.people)
  if (project.defaultPersonId &&
    people.length > 0 &&
    !people.some(({ id }) => id === project.defaultPersonId)) {
    const defaultPerson = state.people.find(({ id, projectId }) =>
      id === project.defaultPersonId && projectId === snapshot.projectId)
    if (defaultPerson) people = [...people.slice(0, -1), defaultPerson]
  }
  const personIds = new Set(people.map(({ id }) => id))
  const careers = state.careers.filter(({ projectId, personId }) =>
    projectId === snapshot.projectId && personIds.has(personId))
  const careerIds = new Set(careers.map(({ id }) => id))
  const personTitles = state.personTitles.filter(({ projectId, personId }) =>
    projectId === snapshot.projectId && personIds.has(personId))
  const relationships = state.relationships
    .filter(({ projectId, fromPersonId, toPersonId }) =>
      projectId === snapshot.projectId &&
      personIds.has(fromPersonId) &&
      personIds.has(toPersonId))
    .slice(0, snapshot.summary.relationships)
  const relationshipIds = new Set(relationships.map(({ id }) => id))
  const events = state.events
    .filter(({ projectId, participantIds }) =>
      projectId === snapshot.projectId && participantIds.every((id) => personIds.has(id)))
    .slice(0, snapshot.summary.events)
  const eventIds = new Set(events.map(({ id }) => id))

  next.people = [
    ...state.people.filter(({ projectId }) => projectId !== snapshot.projectId),
    ...people,
  ]
  next.careers = [
    ...state.careers.filter(({ projectId }) => projectId !== snapshot.projectId),
    ...careers,
  ]
  next.personTitles = [
    ...state.personTitles.filter(({ projectId }) => projectId !== snapshot.projectId),
    ...personTitles,
  ]
  next.relationships = [
    ...state.relationships.filter(({ projectId }) => projectId !== snapshot.projectId),
    ...relationships,
  ]
  next.events = [
    ...state.events.filter(({ projectId }) => projectId !== snapshot.projectId),
    ...events,
  ]
  const citations = state.citations.filter((citation) => {
    if (citation.projectId !== snapshot.projectId) return true
    return citation.targetType === 'person'
      ? personIds.has(citation.targetId)
      : citation.targetType === 'relationship'
        ? relationshipIds.has(citation.targetId)
        : citation.targetType === 'event'
          ? eventIds.has(citation.targetId)
          : careerIds.has(citation.targetId)
  })
  const citationIds = new Set(citations
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .map(({ id }) => id))
  next.citations = citations
  next.attachmentLinks = state.attachmentLinks.filter((link) => {
    if (link.projectId !== snapshot.projectId) return true
    return link.targetType === 'person'
      ? personIds.has(link.targetId)
      : link.targetType === 'relationship'
        ? relationshipIds.has(link.targetId)
        : link.targetType === 'event'
          ? eventIds.has(link.targetId)
          : link.targetType === 'career'
            ? careerIds.has(link.targetId)
            : citationIds.has(link.targetId)
  })
  next.issues = state.issues.filter((issue) => {
    if (issue.targetType === 'person') return !state.people.some(
      ({ id, projectId }) => id === issue.targetId && projectId === snapshot.projectId,
    ) || personIds.has(issue.targetId)
    if (issue.targetType === 'relationship') return !state.relationships.some(
      ({ id, projectId }) => id === issue.targetId && projectId === snapshot.projectId,
    ) || relationshipIds.has(issue.targetId)
    if (issue.targetType === 'event') return !state.events.some(
      ({ id, projectId }) => id === issue.targetId && projectId === snapshot.projectId,
    ) || eventIds.has(issue.targetId)
    return true
  })
  return cloneValue(next)
}

function isSnapshotProjectPayloadValid(
  payload: PrototypeState,
  snapshot: PrototypeState['snapshots'][number],
): boolean {
  const project = payload.projects.find(({ id }) => id === snapshot.projectId)
  if (!project) return false
  const people = payload.people.filter(({ projectId, deletedAt }) =>
    projectId === snapshot.projectId && !deletedAt)
  const relationships = payload.relationships.filter(({ projectId }) => projectId === snapshot.projectId)
  const events = payload.events.filter(({ projectId }) => projectId === snapshot.projectId)
  if (people.length !== snapshot.summary.people ||
    relationships.length !== snapshot.summary.relationships ||
    events.length !== snapshot.summary.events) return false

  const personIds = new Set(people.map(({ id }) => id))
  const organizationIds = new Set(payload.organizations
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .map(({ id }) => id))
  const careers = payload.careers.filter(({ projectId }) => projectId === snapshot.projectId)
  const careerIds = new Set(careers.map(({ id }) => id))
  const placeIds = new Set(payload.places
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .map(({ id }) => id))
  const sourceIds = new Set(payload.sources
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .map(({ id }) => id))
  const relationshipIds = new Set(relationships.map(({ id }) => id))
  const eventIds = new Set(events.map(({ id }) => id))
  const citationIds = new Set(payload.citations
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .map(({ id }) => id))
  const attachmentIds = new Set(payload.attachments
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .map(({ id }) => id))

  if (project.defaultPersonId && !personIds.has(project.defaultPersonId)) return false
  if (!people.every(({ birthPlaceId, deathPlaceId, sourceIds: ids }) =>
    (!birthPlaceId || placeIds.has(birthPlaceId)) &&
    (!deathPlaceId || placeIds.has(deathPlaceId)) &&
    (ids ?? []).every((id) => sourceIds.has(id)))) return false
  if (!payload.places
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .every(({ parentId }) => !parentId || placeIds.has(parentId))) return false
  if (!payload.organizations
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .every(({ parentId, placeId, sourceIds: ids }) =>
      (!parentId || organizationIds.has(parentId)) &&
      (!placeId || placeIds.has(placeId)) &&
      ids.every((id) => sourceIds.has(id)))) return false
  if (!careers.every(({ personId, organizationId, jurisdictionPlaceId, appointedByPersonId, sourceIds: ids }) =>
    personIds.has(personId) &&
    (!organizationId || organizationIds.has(organizationId)) &&
    (!jurisdictionPlaceId || placeIds.has(jurisdictionPlaceId)) &&
    (!appointedByPersonId || personIds.has(appointedByPersonId)) &&
    ids.every((id) => sourceIds.has(id)))) return false
  if (!relationships.every(({ fromPersonId, toPersonId, placeId, sourceIds: ids }) =>
    personIds.has(fromPersonId) &&
    personIds.has(toPersonId) &&
    (!placeId || placeIds.has(placeId)) &&
    ids.every((id) => sourceIds.has(id)))) return false
  if (!events.every(({ participantIds, participantRoles, placeId, sourceIds: ids }) =>
    participantIds.every((id) => personIds.has(id)) &&
    (!participantRoles || Object.keys(participantRoles).every((id) => participantIds.includes(id))) &&
    (!placeId || placeIds.has(placeId)) &&
    ids.every((id) => sourceIds.has(id)))) return false
  if (!payload.citations
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .every(({ sourceId, targetType, targetId }) =>
      sourceIds.has(sourceId) && (targetType === 'person'
        ? personIds.has(targetId)
        : targetType === 'relationship'
          ? relationshipIds.has(targetId)
          : targetType === 'event'
            ? eventIds.has(targetId)
            : careerIds.has(targetId)))) return false
  return payload.attachmentLinks
    .filter(({ projectId }) => projectId === snapshot.projectId)
    .every(({ attachmentId, targetType, targetId }) =>
      attachmentIds.has(attachmentId) && (targetType === 'person'
        ? personIds.has(targetId)
        : targetType === 'relationship'
          ? relationshipIds.has(targetId)
          : targetType === 'event'
            ? eventIds.has(targetId)
            : targetType === 'career'
              ? careerIds.has(targetId)
              : citationIds.has(targetId)))
}

export function createSnapshotPayloads(state: PrototypeState): SnapshotPayloads {
  return Object.fromEntries(
    state.snapshots.map((snapshot) => [snapshot.id, snapshotProjectPayload(state, snapshot)]),
  )
}

export function repairSnapshotPayloads(
  raw: string,
  state: PrototypeState,
  canonicalPayloads: SnapshotPayloads = {},
): { payloads: SnapshotPayloads; damaged: boolean; unavailableIds: string[] } {
  let parsed: unknown
  let parseFailed = false
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}
    parseFailed = true
  }

  const payloads: SnapshotPayloads = {}
  let damaged = parseFailed || !isRecord(parsed)
  if (isRecord(parsed)) {
    for (const [id, payload] of Object.entries(parsed)) {
      if (isPrototypeState(payload)) {
        payloads[id] = hydrateGenealogyDateDisplays(payload) as PrototypeState
      }
      else damaged = true
    }
  }
  const unavailableIds: string[] = []
  for (const snapshot of state.snapshots) {
    const payload = payloads[snapshot.id]
    if (!payload || !isSnapshotProjectPayloadValid(payload, snapshot)) {
      damaged = true
      const canonical = canonicalPayloads[snapshot.id]
      const replacement = canonical && isSnapshotProjectPayloadValid(canonical, snapshot)
        ? canonical
        : undefined
      if (replacement) payloads[snapshot.id] = cloneValue(replacement)
      else {
        delete payloads[snapshot.id]
        unavailableIds.push(snapshot.id)
      }
    }
  }
  return { payloads, damaged, unavailableIds }
}

export function safeRecoverySuffix(isoTimestamp: string): string {
  return isoTimestamp.replace(/:/g, '-')
}
