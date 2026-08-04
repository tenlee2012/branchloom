import { compareGenealogyDates, normalizeIsoDate, validateLifeDates } from '../domain/date'
import { findDuplicateNameEvidence } from '../domain/duplicateInspection'
import { eventTypeLabel } from '../domain/eventTypes'
import { getPrimaryName, personNameTypeLabels } from '../domain/personNames'
import { hasAncestorCycle, validateRelationship } from '../domain/relationships'
import { createPersonMergePreview } from '../domain/personMerge'
import { traverseFamilyGraph } from '../domain/familyGraph'
import type {
  Attachment,
  AttachmentLink,
  BranchloomRepository,
  BoundedFamilySlice,
  BoundedFamilySliceQuery,
  CareerRecord,
  Citation,
  CleanupImpact,
  CleanupInput,
  CleanupResult,
  DataIssue,
  DuplicateCandidate,
  FamilyEvent,
  HistoryState,
  Page,
  Organization,
  Person,
  PersonTitle,
  PersonMergeInput,
  PersonMergeResult,
  PersonQuery,
  Place,
  Project,
  ProjectSummary,
  PrototypeState,
  Relationship,
  RestoreResult,
  Snapshot,
  Source,
  SourceDeletionImpact,
  UUID,
} from '../domain/types'
import { createDemoState } from '../fixtures/demoState'
import { createCanonicalDemoSnapshotPayloads } from './demoSnapshotPayloads'
import {
  PROTOTYPE_STORAGE_KEY,
  RECOVERY_STORAGE_PREFIX,
  RepositoryError,
  SNAPSHOT_PAYLOADS_STORAGE_KEY,
  SNAPSHOT_PAYLOADS_RECOVERY_STORAGE_PREFIX,
  TRANSACTION_RECOVERY_STORAGE_PREFIX,
  TRANSACTION_STORAGE_KEY,
  cloneValue,
  parsePrototypeState,
  repairSnapshotPayloads,
  safeRecoverySuffix,
  type PrototypeStorage,
  type SnapshotPayloads,
} from './storage'

export interface BrowserPrototypeRepositoryOptions {
  storage?: PrototypeStorage
  clock?: () => Date | string
  idFactory?: () => UUID
  invalidStatePolicy?: 'restore-demo' | 'throw'
}

const HISTORY_LIMIT = 100
const DERIVED_ISSUE_CODES = new Set([
  'self-parent', 'self-partner', 'ancestor-cycle', 'duplicate-relationship',
  'death-before-birth', 'event-outside-lifespan', 'missing-attachment',
  'damaged-attachment', 'unused-source', 'possible-duplicate', 'incomplete-date',
  'missing-place', 'uncertain-event-date',
])

function defaultStorage(): PrototypeStorage {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('window.localStorage is unavailable')
    }
    return window.localStorage
  } catch (error) {
    throw new RepositoryError(
      'storage',
      'BrowserPrototypeRepository requires browser localStorage or an injected storage adapter',
      { cause: error },
    )
  }
}

function defaultIdFactory(): UUID {
  try {
    return crypto.randomUUID()
  } catch (error) {
    throw new RepositoryError('storage', 'A UUID factory is unavailable', { cause: error })
  }
}

function stableId(left: { id: UUID }, right: { id: UUID }): number {
  return left.id.localeCompare(right.id)
}

function upsert<T extends { id: UUID }>(items: T[], value: T): T[] {
  const index = items.findIndex(({ id }) => id === value.id)
  if (index < 0) return [...items, value]
  const next = [...items]
  next[index] = value
  return next
}

function restoreScoped<T extends { projectId: UUID }>(
  current: T[],
  payload: T[],
  projectId: UUID,
): T[] {
  return cloneValue([
    ...current.filter(({ projectId: id }) => id !== projectId),
    ...payload.filter(({ projectId: id }) => id === projectId),
  ])
}

function primaryName(person: Person): string {
  return (getPrimaryName(person) === '未命名人物' ? '' : getPrimaryName(person))
    .trim()
    .toLocaleLowerCase()
}

function expandBoundary(value: string, edge: 'lower' | 'upper'): string | undefined {
  const normalized = normalizeIsoDate(value)
  if (!normalized) return undefined
  const [year, month, day] = normalized.split('-')
  if (!month) return edge === 'lower' ? `${year}-01-01` : `${year}-12-31`
  if (!day) {
    if (edge === 'lower') return `${year}-${month}-01`
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    return `${year}-${month}-${String(lastDay).padStart(2, '0')}`
  }
  return normalized
}

function dateStart(date: Person['birth']): string | undefined {
  if (!date || date.precision === 'unknown' || date.precision === 'before') return undefined
  const boundary = date.start ?? date.end
  return boundary ? expandBoundary(boundary, 'lower') : undefined
}

function dateEnd(date: Person['death']): string | undefined {
  if (!date || date.precision === 'unknown' || date.precision === 'after') return undefined
  const boundary = date.end ?? date.start
  return boundary ? expandBoundary(boundary, 'upper') : undefined
}

function dateLooksIncomplete(date: Person['birth']): boolean {
  if (!date) return false
  if (date.precision === 'unknown') return true
  if (date.start && !normalizeIsoDate(date.start)) return true
  if (date.end && !normalizeIsoDate(date.end)) return true
  if (date.precision === 'range' && (!date.start || !date.end)) return true
  return !date.start && !date.end
}

function issueFactory(
  severity: DataIssue['severity'],
  code: string,
  message: string,
  targetType: DataIssue['targetType'],
  targetId: UUID,
  identity = code,
): DataIssue {
  return { id: `issue-${targetId}-${identity}`, severity, code, message, targetType, targetId, origin: 'derived' }
}

function isDerivedIssue(issue: DataIssue): boolean {
  return issue.origin === 'derived' || (issue.origin !== 'manual' && DERIVED_ISSUE_CODES.has(issue.code))
}

interface PendingStorageTransaction {
  version: 1
  phase: 'prepared' | 'committed'
  previousState: string | null
  previousPayloads: string | null
  nextState: string
  nextPayloads: string
}

function parsePendingStorageTransaction(raw: string): PendingStorageTransaction | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    if (candidate.version !== 1 || (candidate.phase !== 'prepared' && candidate.phase !== 'committed')) return undefined
    if ((candidate.previousState !== null && typeof candidate.previousState !== 'string') ||
      (candidate.previousPayloads !== null && typeof candidate.previousPayloads !== 'string') ||
      typeof candidate.nextState !== 'string' || typeof candidate.nextPayloads !== 'string') return undefined
    return candidate as unknown as PendingStorageTransaction
  } catch {
    return undefined
  }
}

export class BrowserPrototypeRepository implements BranchloomRepository {
  private readonly storage: PrototypeStorage
  private readonly clock: () => Date | string
  private readonly idFactory: () => UUID
  private state: PrototypeState
  private snapshotPayloads: SnapshotPayloads
  private unavailableSnapshotIds = new Set<UUID>()
  private undoStack: PrototypeState[] = []
  private redoStack: PrototypeState[] = []
  private nextWriteFailure: unknown | undefined

  constructor(options: BrowserPrototypeRepositoryOptions = {}) {
    this.storage = options.storage ?? defaultStorage()
    this.clock = options.clock ?? (() => new Date())
    this.idFactory = options.idFactory ?? defaultIdFactory

    const demo = createDemoState()
    const canonicalDemoPayloads = createCanonicalDemoSnapshotPayloads()
    const recovered = this.recoverPendingTransaction()
    const raw = recovered ? recovered.state : this.read(PROTOTYPE_STORAGE_KEY)
    if (raw === null) {
      this.state = demo
      this.snapshotPayloads = canonicalDemoPayloads
      this.persistStateAndPayloads(this.state, this.snapshotPayloads)
      return
    }

    try {
      this.state = parsePrototypeState(raw)
    } catch (error) {
      if (options.invalidStatePolicy === 'throw') throw error
      this.preserveRecovery(raw)
      this.state = demo
      this.snapshotPayloads = canonicalDemoPayloads
      this.persistStateAndPayloads(this.state, this.snapshotPayloads)
      return
    }

    const rawPayloads = recovered ? recovered.payloads : this.read(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    if (rawPayloads === null) {
      const repaired = repairSnapshotPayloads('{}', this.state, canonicalDemoPayloads)
      this.snapshotPayloads = repaired.payloads
      this.unavailableSnapshotIds = new Set(repaired.unavailableIds)
      this.persistPayloads(this.snapshotPayloads)
      return
    }
    const repaired = repairSnapshotPayloads(rawPayloads, this.state, canonicalDemoPayloads)
    this.snapshotPayloads = repaired.payloads
    this.unavailableSnapshotIds = new Set(repaired.unavailableIds)
    if (repaired.damaged) {
      this.preserveRecovery(rawPayloads, SNAPSHOT_PAYLOADS_RECOVERY_STORAGE_PREFIX)
      this.persistPayloads(this.snapshotPayloads)
    }
  }

  failNextWrite(error: unknown): void {
    this.nextWriteFailure = error
  }

  async listProjects(): Promise<Project[]> {
    return cloneValue([...this.state.projects].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || stableId(left, right),
    ))
  }

  async createProject(input: Pick<Project, 'name' | 'description'>): Promise<Project> {
    const safeInput = cloneValue(input)
    const name = safeInput.name.trim()
    if (!name) this.validation('Project name is required')
    const timestamp = this.now()
    const project: Project = {
      id: this.idFactory(),
      name,
      description: safeInput.description.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      backupSchedule: 'weekly',
    }
    const next = cloneValue(this.state)
    next.projects.push(project)
    this.commit(next)
    return cloneValue(project)
  }

  async getProject(projectId: UUID): Promise<Project> {
    return cloneValue(this.requireProject(projectId))
  }

  async updateProject(projectId: UUID, patch: Partial<Project>): Promise<Project> {
    const current = this.requireProject(projectId)
    const safePatch = cloneValue(patch)
    const nextProject: Project = {
      ...current,
      ...safePatch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    }
    nextProject.name = nextProject.name.trim()
    nextProject.description = nextProject.description.trim()
    if (!nextProject.name) this.validation('Project name is required')
    if (nextProject.backupSchedule
      && !['off', 'daily', 'weekly'].includes(nextProject.backupSchedule)) {
      this.validation('Project backup schedule is invalid')
    }
    if (nextProject.defaultPersonId) {
      this.requirePersonInProject(nextProject.defaultPersonId, projectId)
    }
    const next = cloneValue(this.state)
    next.projects = upsert(next.projects, nextProject)
    this.commit(next)
    return cloneValue(nextProject)
  }

  async deleteProject(projectId: UUID): Promise<void> {
    this.requireProject(projectId)
    const snapshotIds = new Set(this.state.snapshots
      .filter(({ projectId: id }) => id === projectId)
      .map(({ id }) => id))
    const next = this.stateWithoutProject(this.state, projectId)
    const nextPayloads = cloneValue(this.snapshotPayloads)
    for (const [snapshotId, payload] of Object.entries(nextPayloads)) {
      if (snapshotIds.has(snapshotId)) delete nextPayloads[snapshotId]
      else nextPayloads[snapshotId] = this.stateWithoutProject(payload, projectId)
    }

    this.persistStateAndPayloads(next, nextPayloads)
    this.state = next
    this.snapshotPayloads = nextPayloads
    for (const snapshotId of snapshotIds) this.unavailableSnapshotIds.delete(snapshotId)
    this.undoStack = []
    this.redoStack = []
  }

  async getProjectSummary(projectId: UUID): Promise<ProjectSummary> {
    const project = this.requireProject(projectId)
    const attachments = this.state.attachments.filter((item) => item.projectId === projectId)
    const summary: ProjectSummary = {
      people: this.state.people.filter((item) => item.projectId === projectId && !item.deletedAt).length,
      relationships: this.state.relationships.filter((item) => item.projectId === projectId).length,
      events: this.state.events.filter((item) => item.projectId === projectId).length,
      sources: this.state.sources.filter((item) => item.projectId === projectId).length,
      attachments: attachments.length,
      attachmentBytes: attachments.reduce((total, { size }) => total + size, 0),
      updatedAt: project.updatedAt,
      lastBackupAt: project.lastBackupAt ?? '',
    }
    return cloneValue(summary)
  }

  async listDuplicateCandidates(projectId: UUID): Promise<DuplicateCandidate[]> {
    this.requireProject(projectId)
    // Runtime desktop and local-web repositories delegate this formal rule to branchloom-core.
    return []
  }

  async listPeople(projectId: UUID, query: PersonQuery): Promise<Page<Person>> {
    this.requireProject(projectId)
    const safeQuery = cloneValue(query)
    if (!Number.isInteger(safeQuery.page) || safeQuery.page < 1) {
      this.validation('page must be a positive one-based integer')
    }
    if (!Number.isInteger(safeQuery.pageSize) || safeQuery.pageSize < 1) {
      this.validation('pageSize must be a positive integer')
    }

    let people = this.state.people.filter(({ projectId: id, deletedAt }) => id === projectId && !deletedAt)
    const search = safeQuery.search?.trim().toLocaleLowerCase()
    if (search) people = people.filter((person) => this.personSearchText(person).includes(search))
    if (safeQuery.status) people = people.filter(({ status }) => status === safeQuery.status)
    if (safeQuery.sex) people = people.filter(({ sex }) => sex === safeQuery.sex)
    if (safeQuery.hasAvatar !== undefined) {
      people = people.filter(({ avatarUrl }) => Boolean(avatarUrl) === safeQuery.hasAvatar)
    }
    if (safeQuery.hasSources !== undefined) {
      people = people.filter((person) => this.personHasSources(person) === safeQuery.hasSources)
    }
    if (safeQuery.hasBirth !== undefined) {
      people = people.filter(({ birth }) => Boolean(birth) === safeQuery.hasBirth)
    }
    if (safeQuery.hasDeath !== undefined) {
      people = people.filter(({ death }) => Boolean(death) === safeQuery.hasDeath)
    }
    if (safeQuery.hasIssues !== undefined) {
      people = people.filter((person) => this.personHasIssues(person) === safeQuery.hasIssues)
    }

    people = [...people].sort((left, right) => this.comparePeople(left, right, safeQuery.sort))
    const total = people.length
    const start = (safeQuery.page - 1) * safeQuery.pageSize
    return cloneValue({
      items: people.slice(start, start + safeQuery.pageSize),
      total,
      page: safeQuery.page,
      pageSize: safeQuery.pageSize,
    })
  }

  async getBoundedFamilySlice(
    projectId: UUID,
    centerPersonId: UUID,
    query: BoundedFamilySliceQuery,
  ): Promise<BoundedFamilySlice> {
    this.requireProject(projectId)
    if (!Number.isInteger(query.generationsUp) || query.generationsUp < 0 || query.generationsUp > 6
      || !Number.isInteger(query.generationsDown) || query.generationsDown < 0 || query.generationsDown > 6) {
      this.validation('bounded family generations must be integers from 0 to 6')
    }
    return this.buildFamilySlice(projectId, centerPersonId, query)
  }

  async getTreeFamilySlice(
    projectId: UUID,
    centerPersonId: UUID,
    query: BoundedFamilySliceQuery,
  ): Promise<BoundedFamilySlice> {
    this.requireProject(projectId)
    if (!Number.isInteger(query.generationsUp) || query.generationsUp < 0 || query.generationsUp > 8
      || !Number.isInteger(query.generationsDown) || query.generationsDown < 0 || query.generationsDown > 8) {
      this.validation('tree family generations must be integers from 0 to 8')
    }
    return this.buildFamilySlice(projectId, centerPersonId, query)
  }

  private buildFamilySlice(
    projectId: UUID,
    centerPersonId: UUID,
    query: BoundedFamilySliceQuery,
  ): BoundedFamilySlice {
    const traversal = traverseFamilyGraph(this.state.people, this.state.relationships, {
      projectId,
      centerPersonId,
      mode: 'combined',
      generationsUp: query.generationsUp,
      generationsDown: query.generationsDown,
      collapsedPersonIds: new Set(),
    })
    if (traversal.status === 'missing-center') this.notFound('Active person', centerPersonId)
    const boundedPeople = traversal.nodes.map(({ person }) => person)
    const boundedRelationships = traversal.relationships
    const placeIds = new Set([
      ...boundedPeople.flatMap(({ birthPlaceId, deathPlaceId }) => [birthPlaceId, deathPlaceId]),
      ...boundedRelationships.map(({ placeId }) => placeId),
    ].filter((id): id is UUID => Boolean(id)))
    return cloneValue({
      projectId,
      centerPersonId,
      people: boundedPeople,
      relationships: boundedRelationships,
      places: this.state.places.filter(({ projectId: idProject, id }) => idProject === projectId && placeIds.has(id)),
      truncated: traversal.truncated,
      limits: traversal.limits,
    })
  }

  async getPerson(personId: UUID): Promise<Person> {
    const person = this.state.people.find(({ id }) => id === personId)
    if (!person) this.notFound('Person', personId)
    return cloneValue(person)
  }

  async savePerson(person: Person): Promise<Person> {
    const value = cloneValue(person)
    this.validateEntityProject(this.state.people, value)
    if (value.names.length === 0 || value.names.every(({ value: name }) => !name.trim())) {
      this.validation('Person must have at least one name')
    }
    const normalizedNames = new Set<string>()
    let primaryNames = 0
    for (const name of value.names) {
      name.value = name.value.trim()
      const normalized = name.value.normalize('NFC').replace(/\s+/gu, ' ').toLocaleLowerCase()
      if (!name.value || normalizedNames.has(normalized)) {
        this.validation('Person name values must be non-empty and unique')
      }
      normalizedNames.add(normalized)
      if (name.primary) primaryNames += 1
      if (name.type === 'custom' && !name.customTypeLabel?.trim()) {
        this.validation('Custom person name type requires a label')
      }
    }
    if (primaryNames !== 1) this.validation('Person must have exactly one primary name')
    this.optionalPlace(value.birthPlaceId, value.projectId)
    this.optionalPlace(value.deathPlaceId, value.projectId)
    this.requireSources(value.sourceIds ?? [], value.projectId)
    const next = cloneValue(this.state)
    next.people = upsert(next.people, value)
    this.commit(next)
    return cloneValue(value)
  }

  async softDeletePerson(personId: UUID): Promise<void> {
    const current = this.state.people.find(({ id }) => id === personId)
    if (!current) this.notFound('Person', personId)
    const next = cloneValue(this.state)
    next.people = upsert(next.people, { ...cloneValue(current), deletedAt: this.now() })
    this.commit(next)
  }

  async listOrganizations(projectId: UUID): Promise<Organization[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.organizations
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || stableId(left, right)))
  }

  async saveOrganization(organization: Organization): Promise<Organization> {
    const value = cloneValue(organization)
    this.validateEntityProject(this.state.organizations, value)
    value.name = value.name.trim()
    value.aliases = [...new Set(value.aliases.map((alias) => alias.trim()).filter(Boolean))]
    value.notes = value.notes.trim()
    if (!value.name) this.validation('Organization name is required')
    if (value.parentId === value.id) this.validation('Organization cannot be its own parent')
    if (value.parentId) {
      const parent = this.state.organizations.find(({ id }) => id === value.parentId)
      if (!parent || parent.projectId !== value.projectId) {
        this.validation('Referenced parent organization does not exist in the project')
      }
      const organizations = upsert(this.state.organizations, value)
      let cursor: UUID | undefined = value.parentId
      const visited = new Set<UUID>([value.id])
      while (cursor) {
        if (visited.has(cursor)) this.validation('Organization hierarchy cannot contain a cycle')
        visited.add(cursor)
        cursor = organizations.find(({ id }) => id === cursor)?.parentId
      }
    }
    this.optionalPlace(value.placeId, value.projectId)
    this.requireSources(value.sourceIds, value.projectId)
    const next = cloneValue(this.state)
    next.organizations = upsert(next.organizations, value)
    this.commit(next)
    return cloneValue(value)
  }

  async deleteOrganization(organizationId: UUID): Promise<void> {
    const current = this.state.organizations.find(({ id }) => id === organizationId)
    if (!current) this.notFound('Organization', organizationId)
    const used = this.state.organizations.some(({ parentId }) => parentId === organizationId)
      || this.state.careers.some(({ organizationId: id }) => id === organizationId)
    if (used) this.validation('Organization is still referenced and cannot be deleted')
    const next = cloneValue(this.state)
    next.organizations = next.organizations.filter(({ id }) => id !== organizationId)
    this.commit(next)
  }

  async listCareers(projectId: UUID, personId?: UUID): Promise<CareerRecord[]> {
    this.requireProject(projectId)
    if (personId) this.requirePersonInProject(personId, projectId)
    const records = this.state.careers.filter((item) =>
      item.projectId === projectId && (!personId || item.personId === personId))
    return cloneValue(records.sort((left, right) => {
      const leftDate = left.start?.start ?? left.start?.end ?? ''
      const rightDate = right.start?.start ?? right.start?.end ?? ''
      return rightDate.localeCompare(leftDate) || stableId(left, right)
    }))
  }

  async saveCareer(career: CareerRecord): Promise<CareerRecord> {
    const value = cloneValue(career)
    this.validateEntityProject(this.state.careers, value)
    value.positionTitle = value.positionTitle.trim()
    value.department = value.department?.trim() || undefined
    value.regime = value.regime?.trim() || undefined
    value.rankOrGrade = value.rankOrGrade?.trim() || undefined
    value.appointmentType = value.appointmentType?.trim() || undefined
    value.description = value.description.trim()
    value.notes = value.notes.trim()
    if (!value.positionTitle) this.validation('Career position title is required')
    if (value.status === 'current' && value.end) {
      this.validation('A current career record cannot have an end date')
    }
    this.requirePersonInProject(value.personId, value.projectId)
    if (value.appointedByPersonId) {
      this.requirePersonInProject(value.appointedByPersonId, value.projectId)
    }
    if (value.organizationId) {
      const organization = this.state.organizations.find(({ id }) => id === value.organizationId)
      if (!organization || organization.projectId !== value.projectId) {
        this.validation('Referenced organization does not exist in the project')
      }
    }
    this.optionalPlace(value.jurisdictionPlaceId, value.projectId)
    this.requireSources(value.sourceIds, value.projectId)
    const next = cloneValue(this.state)
    next.careers = upsert(next.careers, value)
    this.commit(next)
    return cloneValue(value)
  }

  async saveOrganizationWithCareer(
    organization: Organization,
    career: CareerRecord,
  ): Promise<{ organization: Organization; career: CareerRecord }> {
    const nextOrganization = cloneValue(organization)
    const nextCareer = cloneValue(career)
    this.validateEntityProject(this.state.organizations, nextOrganization)
    this.validateEntityProject(this.state.careers, nextCareer)
    if (this.state.organizations.some(({ id }) => id === nextOrganization.id)) {
      this.validation('Inline organization creation requires a new organization id')
    }
    nextOrganization.name = nextOrganization.name.trim()
    nextOrganization.aliases = [...new Set(nextOrganization.aliases.map((alias) => alias.trim()).filter(Boolean))]
    nextOrganization.notes = nextOrganization.notes.trim()
    if (!nextOrganization.name) this.validation('Organization name is required')
    if (nextOrganization.parentId === nextOrganization.id) {
      this.validation('Organization cannot be its own parent')
    }
    if (nextOrganization.parentId) {
      const parent = this.state.organizations.find(({ id }) => id === nextOrganization.parentId)
      if (!parent || parent.projectId !== nextOrganization.projectId) {
        this.validation('Referenced parent organization does not exist in the project')
      }
    }
    this.optionalPlace(nextOrganization.placeId, nextOrganization.projectId)
    this.requireSources(nextOrganization.sourceIds, nextOrganization.projectId)

    if (nextCareer.projectId !== nextOrganization.projectId) {
      this.validation('Organization and career must belong to the same project')
    }
    nextCareer.organizationId = nextOrganization.id
    nextCareer.positionTitle = nextCareer.positionTitle.trim()
    nextCareer.department = nextCareer.department?.trim() || undefined
    nextCareer.regime = nextCareer.regime?.trim() || undefined
    nextCareer.rankOrGrade = nextCareer.rankOrGrade?.trim() || undefined
    nextCareer.appointmentType = nextCareer.appointmentType?.trim() || undefined
    nextCareer.description = nextCareer.description.trim()
    nextCareer.notes = nextCareer.notes.trim()
    if (!nextCareer.positionTitle) this.validation('Career position title is required')
    if (nextCareer.status === 'current' && nextCareer.end) {
      this.validation('A current career record cannot have an end date')
    }
    this.requirePersonInProject(nextCareer.personId, nextCareer.projectId)
    if (nextCareer.appointedByPersonId) {
      this.requirePersonInProject(nextCareer.appointedByPersonId, nextCareer.projectId)
    }
    this.optionalPlace(nextCareer.jurisdictionPlaceId, nextCareer.projectId)
    this.requireSources(nextCareer.sourceIds, nextCareer.projectId)

    const next = cloneValue(this.state)
    next.organizations.push(nextOrganization)
    next.careers = upsert(next.careers, nextCareer)
    this.commit(next)
    return cloneValue({ organization: nextOrganization, career: nextCareer })
  }

  async deleteCareer(careerId: UUID): Promise<void> {
    const current = this.state.careers.find(({ id }) => id === careerId)
    if (!current) this.notFound('Career', careerId)
    const citationIds = new Set(this.state.citations
      .filter(({ targetType, targetId, projectId }) =>
        targetType === 'career' && targetId === careerId && projectId === current.projectId)
      .map(({ id }) => id))
    const next = cloneValue(this.state)
    next.careers = next.careers.filter(({ id }) => id !== careerId)
    next.citations = next.citations.filter(({ id }) => !citationIds.has(id))
    next.attachmentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      !(targetType === 'career' && targetId === careerId)
      && !(targetType === 'citation' && citationIds.has(targetId)))
    this.commit(next)
  }

  async listPersonTitles(projectId: UUID, personId?: UUID): Promise<PersonTitle[]> {
    this.requireProject(projectId)
    if (personId) this.requirePersonInProject(personId, projectId)
    return cloneValue(this.state.personTitles
      .filter((title) =>
        title.projectId === projectId && (!personId || title.personId === personId))
      .sort((left, right) =>
        (right.start?.start ?? right.start?.end ?? '').localeCompare(
          left.start?.start ?? left.start?.end ?? '',
        ) || stableId(left, right)))
  }

  async savePersonTitle(title: PersonTitle): Promise<PersonTitle> {
    const value = cloneValue(title)
    this.validateEntityProject(this.state.personTitles, value)
    value.value = value.value.trim()
    value.customTypeLabel = value.customTypeLabel?.trim() || undefined
    value.notes = value.notes.trim()
    if (!value.value) this.validation('Person title value is required')
    if (value.type === 'custom' && !value.customTypeLabel) {
      this.validation('Custom person title type requires a label')
    }
    this.requirePersonInProject(value.personId, value.projectId)
    if (value.grantedByPersonId) {
      this.requirePersonInProject(value.grantedByPersonId, value.projectId)
    }
    this.optionalPlace(value.placeId, value.projectId)
    this.requireSources(value.sourceIds, value.projectId)
    const next = cloneValue(this.state)
    next.personTitles = upsert(next.personTitles, value)
    this.commit(next)
    return cloneValue(value)
  }

  async deletePersonTitle(titleId: UUID): Promise<void> {
    const current = this.state.personTitles.find(({ id }) => id === titleId)
    if (!current) this.notFound('Person title', titleId)
    const next = cloneValue(this.state)
    next.personTitles = next.personTitles.filter(({ id }) => id !== titleId)
    this.commit(next)
  }

  async listRelationships(projectId: UUID): Promise<Relationship[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.relationships.filter((item) => item.projectId === projectId))
  }

  async getRelationship(projectId: UUID, relationshipId: UUID): Promise<Relationship> {
    this.requireProject(projectId)
    const relationship = this.state.relationships.find(({ id, projectId: idProject }) =>
      id === relationshipId && idProject === projectId)
    if (!relationship) this.notFound('Relationship', relationshipId)
    return cloneValue(relationship)
  }

  async saveRelationship(relationship: Relationship): Promise<Relationship> {
    const value = cloneValue(relationship)
    this.validateEntityProject(this.state.relationships, value)
    this.requirePersonInProject(value.fromPersonId, value.projectId)
    this.requirePersonInProject(value.toPersonId, value.projectId)
    this.optionalPlace(value.placeId, value.projectId)
    this.requireSources(value.sourceIds, value.projectId)
    const issue = validateRelationship(value, this.state.relationships)
    if (issue?.severity === 'error') this.validation(issue.message)
    const next = cloneValue(this.state)
    next.relationships = upsert(next.relationships, value)
    this.commit(next)
    return cloneValue(value)
  }

  async deleteRelationship(relationshipId: UUID): Promise<void> {
    const current = this.state.relationships.find(({ id }) => id === relationshipId)
    if (!current) this.notFound('Relationship', relationshipId)
    const citationIds = new Set(this.state.citations
      .filter(({ targetType, targetId, projectId }) =>
        targetType === 'relationship' && targetId === relationshipId && projectId === current.projectId)
      .map(({ id }) => id))
    const next = cloneValue(this.state)
    next.relationships = next.relationships.filter(({ id }) => id !== relationshipId)
    next.citations = next.citations.filter(({ id }) => !citationIds.has(id))
    next.attachmentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      !(targetType === 'relationship' && targetId === relationshipId)
      && !(targetType === 'citation' && citationIds.has(targetId)))
    next.issues = next.issues.filter(({ targetType, targetId }) =>
      targetType !== 'relationship' || targetId !== relationshipId)
    this.commit(next)
  }

  async savePersonWithRelationship(
    person: Person,
    relationship: Relationship,
  ): Promise<{ person: Person; relationship: Relationship }> {
    const nextPerson = cloneValue(person)
    const nextRelationship = cloneValue(relationship)
    this.validateEntityProject(this.state.people, nextPerson)
    if (this.state.people.some(({ id }) => id === nextPerson.id)) {
      this.validation('Quick-add requires a new person id')
    }
    if (
      nextPerson.names.length === 0 ||
      nextPerson.names.every(({ value: name }) => !name.trim())
    ) {
      this.validation('Person must have at least one name')
    }
    this.optionalPlace(nextPerson.birthPlaceId, nextPerson.projectId)
    this.optionalPlace(nextPerson.deathPlaceId, nextPerson.projectId)
    this.requireSources(nextPerson.sourceIds ?? [], nextPerson.projectId)

    this.validateEntityProject(this.state.relationships, nextRelationship)
    if (this.state.relationships.some(({ id }) => id === nextRelationship.id)) {
      this.validation('Quick-add requires a new relationship id')
    }
    if (nextRelationship.projectId !== nextPerson.projectId) {
      this.validation('Person and relationship must belong to the same project')
    }
    if (
      nextRelationship.fromPersonId !== nextPerson.id &&
      nextRelationship.toPersonId !== nextPerson.id
    ) {
      this.validation('Quick-add relationship must reference the new person')
    }

    const next = cloneValue(this.state)
    next.people.push(nextPerson)
    this.requirePersonInStateProject(next, nextRelationship.fromPersonId, nextRelationship.projectId)
    this.requirePersonInStateProject(next, nextRelationship.toPersonId, nextRelationship.projectId)
    this.optionalPlace(nextRelationship.placeId, nextRelationship.projectId)
    this.requireSources(nextRelationship.sourceIds, nextRelationship.projectId)
    const issue = validateRelationship(nextRelationship, next.relationships)
    if (issue?.severity === 'error') this.validation(issue.message)
    next.relationships = upsert(next.relationships, nextRelationship)
    this.commit(next)
    return cloneValue({ person: nextPerson, relationship: nextRelationship })
  }

  async listEvents(projectId: UUID): Promise<FamilyEvent[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.events.filter((item) => item.projectId === projectId))
  }

  async saveEvent(event: FamilyEvent): Promise<FamilyEvent> {
    const value = cloneValue(event)
    this.validateEntityProject(this.state.events, value)
    value.participantIds = [...new Set(value.participantIds)]
    const participantIds = new Set(value.participantIds)
    const participantRoles = Object.fromEntries(Object.entries(value.participantRoles ?? {})
      .map(([personId, role]) => [personId, role.trim()])
      .filter(([personId, role]) => participantIds.has(personId) && Boolean(role)))
    if (Object.keys(participantRoles).length) value.participantRoles = participantRoles
    else delete value.participantRoles
    for (const personId of value.participantIds) this.requirePersonInProject(personId, value.projectId)
    this.optionalPlace(value.placeId, value.projectId)
    this.requireSources(value.sourceIds, value.projectId)
    const next = cloneValue(this.state)
    next.events = upsert(next.events, value)
    this.commit(next)
    return cloneValue(value)
  }

  async deleteEvent(eventId: UUID): Promise<void> {
    const current = this.state.events.find(({ id }) => id === eventId)
    if (!current) this.notFound('Event', eventId)
    const citationIds = new Set(this.state.citations
      .filter(({ targetType, targetId, projectId }) =>
        targetType === 'event' && targetId === eventId && projectId === current.projectId)
      .map(({ id }) => id))
    const next = cloneValue(this.state)
    next.events = next.events.filter(({ id }) => id !== eventId)
    next.citations = next.citations.filter(({ id }) => !citationIds.has(id))
    next.attachmentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      !(targetType === 'event' && targetId === eventId)
      && !(targetType === 'citation' && citationIds.has(targetId)))
    next.issues = next.issues.filter(({ targetType, targetId }) =>
      targetType !== 'event' || targetId !== eventId)
    this.commit(next)
  }

  async listPlaces(projectId: UUID): Promise<Place[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.places.filter((item) => item.projectId === projectId))
  }

  async savePlace(place: Place): Promise<Place> {
    const value = cloneValue(place)
    this.validateEntityProject(this.state.places, value)
    if (!value.name.trim()) this.validation('Place name is required')
    if (value.parentId === value.id) this.validation('Place cannot be its own parent')
    this.optionalPlace(value.parentId, value.projectId)
    const next = cloneValue(this.state)
    next.places = upsert(next.places, value)
    this.commit(next)
    return cloneValue(value)
  }

  async deletePlace(placeId: UUID): Promise<void> {
    const current = this.state.places.find(({ id }) => id === placeId)
    if (!current) this.notFound('Place', placeId)
    const used = this.state.people.some(({ birthPlaceId, deathPlaceId }) =>
      birthPlaceId === placeId || deathPlaceId === placeId)
      || this.state.relationships.some(({ placeId: linkedPlaceId }) => linkedPlaceId === placeId)
      || this.state.events.some(({ placeId: linkedPlaceId }) => linkedPlaceId === placeId)
      || this.state.organizations.some(({ placeId: linkedPlaceId }) => linkedPlaceId === placeId)
      || this.state.careers.some(({ jurisdictionPlaceId }) => jurisdictionPlaceId === placeId)
      || this.state.personTitles.some(({ placeId: linkedPlaceId }) => linkedPlaceId === placeId)
      || this.state.places.some(({ parentId }) => parentId === placeId)
    if (used) this.validation('Place is still referenced and cannot be deleted')
    const next = cloneValue(this.state)
    next.places = next.places.filter(({ id }) => id !== placeId)
    this.commit(next)
  }

  async listSources(projectId: UUID): Promise<Source[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.sources.filter((item) => item.projectId === projectId))
  }

  async saveSource(source: Source): Promise<Source> {
    const value = cloneValue(source)
    this.validateEntityProject(this.state.sources, value)
    if (!value.title.trim()) this.validation('Source title is required')
    if (value.url) {
      let url: URL
      try {
        url = new URL(value.url)
      } catch {
        this.validation('Source URL must be a valid http:// or https:// URL')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        this.validation('Source URL must be a valid http:// or https:// URL')
      }
    }
    const next = cloneValue(this.state)
    next.sources = upsert(next.sources, value)
    this.commit(next)
    return cloneValue(value)
  }

  async getSourceDeletionImpact(sourceId: UUID): Promise<SourceDeletionImpact> {
    const source = this.state.sources.find(({ id }) => id === sourceId)
    if (!source) this.notFound('Source', sourceId)
    const citationIds = new Set(this.state.citations
      .filter(({ sourceId: id, projectId }) => id === sourceId && projectId === source.projectId)
      .map(({ id }) => id))
    return cloneValue({
      citations: citationIds.size,
      people: this.state.people.filter(({ projectId, sourceIds }) =>
        projectId === source.projectId && (sourceIds ?? []).includes(sourceId)).length,
      organizations: this.state.organizations.filter(({ projectId, sourceIds }) =>
        projectId === source.projectId && sourceIds.includes(sourceId)).length,
      careers: this.state.careers.filter(({ projectId, sourceIds }) =>
        projectId === source.projectId && sourceIds.includes(sourceId)).length,
      personTitles: this.state.personTitles.filter(({ projectId, sourceIds }) =>
        projectId === source.projectId && sourceIds.includes(sourceId)).length,
      relationships: this.state.relationships.filter(({ projectId, sourceIds }) =>
        projectId === source.projectId && sourceIds.includes(sourceId)).length,
      events: this.state.events.filter(({ projectId, sourceIds }) =>
        projectId === source.projectId && sourceIds.includes(sourceId)).length,
      attachmentLinks: this.state.attachmentLinks.filter(({ projectId, targetType, targetId }) =>
        projectId === source.projectId && targetType === 'citation' && citationIds.has(targetId)).length,
    })
  }

  async deleteSource(sourceId: UUID): Promise<void> {
    const source = this.state.sources.find(({ id }) => id === sourceId)
    if (!source) this.notFound('Source', sourceId)
    const citationIds = new Set(this.state.citations
      .filter(({ sourceId: id, projectId }) => id === sourceId && projectId === source.projectId)
      .map(({ id }) => id))
    const next = cloneValue(this.state)
    next.sources = next.sources.filter(({ id }) => id !== sourceId)
    next.citations = next.citations.filter(({ id }) => !citationIds.has(id))
    next.people = next.people.map((person) => person.projectId === source.projectId
      ? {
          ...person,
          sourceIds: (person.sourceIds ?? []).filter((id) => id !== sourceId),
        }
      : person)
    next.relationships = next.relationships.map((relationship) => relationship.projectId === source.projectId
      ? { ...relationship, sourceIds: relationship.sourceIds.filter((id) => id !== sourceId) }
      : relationship)
    next.events = next.events.map((event) => event.projectId === source.projectId
      ? { ...event, sourceIds: event.sourceIds.filter((id) => id !== sourceId) }
      : event)
    next.organizations = next.organizations.map((organization) => organization.projectId === source.projectId
      ? { ...organization, sourceIds: organization.sourceIds.filter((id) => id !== sourceId) }
      : organization)
    next.careers = next.careers.map((career) => career.projectId === source.projectId
      ? { ...career, sourceIds: career.sourceIds.filter((id) => id !== sourceId) }
      : career)
    next.personTitles = next.personTitles.map((title) => title.projectId === source.projectId
      ? { ...title, sourceIds: title.sourceIds.filter((id) => id !== sourceId) }
      : title)
    next.attachmentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      targetType !== 'citation' || !citationIds.has(targetId))
    next.issues = next.issues.filter(({ targetType, targetId }) =>
      targetType !== 'source' || targetId !== sourceId)
    this.commit(next)
  }

  async listCitations(projectId: UUID): Promise<Citation[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.citations.filter((item) => item.projectId === projectId))
  }

  async saveCitation(citation: Citation): Promise<Citation> {
    const value = cloneValue(citation)
    this.validateEntityProject(this.state.citations, value)
    this.requireSourceInProject(value.sourceId, value.projectId)
    this.requireTypedTarget(value.targetType, value.targetId, value.projectId)
    const next = cloneValue(this.state)
    next.citations = upsert(next.citations, value)
    this.commit(next)
    return cloneValue(value)
  }

  async saveCitationWithAttachmentLinks(
    citation: Citation,
    attachmentIds: UUID[],
  ): Promise<Citation> {
    const value = cloneValue(citation)
    const selectedAttachmentIds = [...new Set(cloneValue(attachmentIds))]
    this.validateEntityProject(this.state.citations, value)
    this.requireSourceInProject(value.sourceId, value.projectId)
    this.requireTypedTarget(value.targetType, value.targetId, value.projectId)
    for (const attachmentId of selectedAttachmentIds) {
      const attachment = this.state.attachments.find(({ id }) => id === attachmentId)
      if (!attachment || attachment.projectId !== value.projectId) {
        this.validation(`Attachment ${attachmentId} is missing from project ${value.projectId}`)
      }
    }

    const next = cloneValue(this.state)
    next.citations = upsert(next.citations, value)
    const currentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      targetType === 'citation' && targetId === value.id)
    const currentByAttachment = new Map(currentLinks.map((link) => [link.attachmentId, link]))
    next.attachmentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      targetType !== 'citation' || targetId !== value.id)
    next.attachmentLinks.push(...selectedAttachmentIds.map((attachmentId) =>
      currentByAttachment.get(attachmentId) ?? {
        id: this.idFactory(),
        projectId: value.projectId,
        attachmentId,
        targetType: 'citation' as const,
        targetId: value.id,
      }))
    this.commit(next)
    return cloneValue(value)
  }

  async deleteCitation(citationId: UUID): Promise<void> {
    const current = this.state.citations.find(({ id }) => id === citationId)
    if (!current) this.notFound('Citation', citationId)
    const next = cloneValue(this.state)
    next.citations = next.citations.filter(({ id }) => id !== citationId)
    next.attachmentLinks = next.attachmentLinks.filter(({ targetType, targetId }) =>
      targetType !== 'citation' || targetId !== citationId)
    this.commit(next)
  }

  async listAttachments(projectId: UUID): Promise<Attachment[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.attachments.filter((item) => item.projectId === projectId))
  }

  async saveAttachment(attachment: Attachment): Promise<Attachment> {
    const value = cloneValue(attachment)
    this.validateEntityProject(this.state.attachments, value)
    if (!Number.isFinite(value.size) || value.size < 0) this.validation('Attachment size is invalid')
    const next = cloneValue(this.state)
    next.attachments = upsert(next.attachments, value)
    if (!value.missing && value.contentHash.trim()) {
      next.issues = next.issues.filter((issue) =>
        !(issue.targetType === 'attachment' && issue.targetId === value.id && isDerivedIssue(issue)))
    }
    this.commit(next)
    return cloneValue(value)
  }

  async locateAttachment(attachmentId: UUID): Promise<Attachment> {
    const current = this.state.attachments.find(({ id }) => id === attachmentId)
    if (!current) this.notFound('Attachment', attachmentId)
    const located = { ...cloneValue(current), missing: false }
    const next = cloneValue(this.state)
    next.attachments = upsert(next.attachments, located)
    next.issues = next.issues.filter((issue) =>
      !(issue.targetType === 'attachment' && issue.targetId === attachmentId && isDerivedIssue(issue)))
    this.commit(next)
    return cloneValue(located)
  }

  async deleteAttachment(attachmentId: UUID): Promise<void> {
    const current = this.state.attachments.find(({ id }) => id === attachmentId)
    if (!current) this.notFound('Attachment', attachmentId)
    const next = cloneValue(this.state)
    next.attachments = next.attachments.filter(({ id }) => id !== attachmentId)
    next.attachmentLinks = next.attachmentLinks.filter(({ attachmentId: id }) => id !== attachmentId)
    next.issues = next.issues.filter(({ targetType, targetId }) =>
      targetType !== 'attachment' || targetId !== attachmentId)
    this.commit(next)
  }

  async listAttachmentLinks(projectId: UUID): Promise<AttachmentLink[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.attachmentLinks.filter((item) => item.projectId === projectId))
  }

  async saveAttachmentLink(link: AttachmentLink): Promise<AttachmentLink> {
    const value = cloneValue(link)
    this.validateEntityProject(this.state.attachmentLinks, value)
    const attachment = this.state.attachments.find(({ id }) => id === value.attachmentId)
    if (!attachment || attachment.projectId !== value.projectId) {
      this.validation('Attachment link references a missing attachment')
    }
    this.requireTypedTarget(value.targetType, value.targetId, value.projectId)
    const next = cloneValue(this.state)
    next.attachmentLinks = upsert(next.attachmentLinks, value)
    this.commit(next)
    return cloneValue(value)
  }

  async listSnapshots(projectId: UUID): Promise<Snapshot[]> {
    this.requireProject(projectId)
    return cloneValue(this.state.snapshots.filter((item) => item.projectId === projectId))
  }

  async createSnapshot(
    projectId: UUID,
    reason: Snapshot['reason'],
    note: string,
  ): Promise<Snapshot> {
    this.requireProject(projectId)
    if (reason === 'manual' && !note.trim()) this.validation('Manual snapshot requires a name or note')
    const snapshot: Snapshot = {
      id: this.idFactory(),
      projectId,
      createdAt: this.now(),
      reason,
      note: note.trim(),
      summary: {
        people: this.state.people.filter((item) => item.projectId === projectId && !item.deletedAt).length,
        relationships: this.state.relationships.filter((item) => item.projectId === projectId).length,
        events: this.state.events.filter((item) => item.projectId === projectId).length,
      },
    }
    const next = cloneValue(this.state)
    next.snapshots.push(snapshot)
    const nextPayloads = cloneValue(this.snapshotPayloads)
    nextPayloads[snapshot.id] = cloneValue(next)
    this.persistStateAndPayloads(next, nextPayloads)
    this.snapshotPayloads = nextPayloads
    this.unavailableSnapshotIds.delete(snapshot.id)
    this.state = next
    return cloneValue(snapshot)
  }

  async mergePeople(input: PersonMergeInput): Promise<PersonMergeResult> {
    const safeInput = cloneValue(input)
    const keep = this.state.people.find(({ id }) => id === safeInput.keepPersonId)
    const remove = this.state.people.find(({ id }) => id === safeInput.removePersonId)
    if (!keep || !remove) this.validation('Both merge people must exist')
    if (keep.deletedAt || remove.deletedAt) this.validation('Deleted people cannot be merged')
    if (keep.projectId !== remove.projectId) this.validation('Merge people must belong to the same project')
    const projectId = keep.projectId
    this.requireProject(projectId)

    let preview
    try {
      preview = createPersonMergePreview({
        people: this.state.people.filter(({ projectId: id }) => id === projectId),
        relationships: this.state.relationships.filter(({ projectId: id }) => id === projectId),
        events: this.state.events.filter(({ projectId: id }) => id === projectId),
        citations: this.state.citations.filter(({ projectId: id }) => id === projectId),
        attachmentLinks: this.state.attachmentLinks.filter(({ projectId: id }) => id === projectId),
        issues: this.state.issues.filter((issue) =>
          this.issueBelongsToStateProject(issue, projectId, this.state)),
      }, safeInput)
    } catch (error) {
      this.validation(error instanceof Error && error.message ? error.message : 'Person merge is invalid')
    }

    this.requireSources(preview.retainedPerson.sourceIds ?? [], projectId)
    this.optionalPlace(preview.retainedPerson.birthPlaceId, projectId)
    this.optionalPlace(preview.retainedPerson.deathPlaceId, projectId)
    for (const relationship of preview.relationships) {
      const issue = validateRelationship(relationship, preview.relationships)
      if (issue?.severity === 'error') this.validation(issue.message)
    }
    if (hasAncestorCycle(preview.relationships)) this.validation('人物关系图存在祖先循环。')

    const transactionTimestamp = this.now()
    const retainedPerson = { ...cloneValue(preview.retainedPerson), updatedAt: transactionTimestamp }
    preview.people = preview.people.map((person) => person.id === retainedPerson.id ? retainedPerson : person)
    const snapshot: Snapshot = {
      id: this.idFactory(),
      projectId,
      createdAt: transactionTimestamp,
      reason: 'merge',
      note: `合并人物：${remove.names[0]?.value ?? remove.id} → ${keep.names[0]?.value ?? keep.id}`,
      summary: {
        people: this.state.people.filter((item) => item.projectId === projectId && !item.deletedAt).length,
        relationships: this.state.relationships.filter((item) => item.projectId === projectId).length,
        events: this.state.events.filter((item) => item.projectId === projectId).length,
      },
    }
    const preMergeState = cloneValue(this.state)
    const next = cloneValue(this.state)
    next.snapshots.push(snapshot)
    next.people = restoreScoped(next.people, preview.people, projectId)
    next.relationships = restoreScoped(next.relationships, preview.relationships, projectId)
    next.events = restoreScoped(next.events, preview.events, projectId)
    next.citations = restoreScoped(next.citations, preview.citations, projectId)
    next.attachmentLinks = restoreScoped(next.attachmentLinks, preview.attachmentLinks, projectId)
    next.careers = next.careers.map((career) => career.projectId === projectId
      ? {
          ...career,
          personId: career.personId === remove.id ? keep.id : career.personId,
          appointedByPersonId: career.appointedByPersonId === remove.id
            ? keep.id
            : career.appointedByPersonId,
        }
      : career)
    next.personTitles = next.personTitles.map((title) => title.projectId === projectId
      ? {
          ...title,
          personId: title.personId === remove.id ? keep.id : title.personId,
          grantedByPersonId: title.grantedByPersonId === remove.id
            ? keep.id
            : title.grantedByPersonId,
        }
      : title)
    next.issues = [
      ...next.issues.filter((issue) => !this.issueBelongsToStateProject(issue, projectId, this.state)),
      ...cloneValue(preview.issues),
    ]
    next.projects = next.projects.map((project) => project.id === projectId
      ? {
          ...project,
          defaultPersonId: project.defaultPersonId === remove.id ? keep.id : project.defaultPersonId,
          updatedAt: transactionTimestamp,
        }
      : project)

    const nextPayloads = cloneValue(this.snapshotPayloads)
    const snapshotPayload = cloneValue(preMergeState)
    snapshotPayload.snapshots.push(cloneValue(snapshot))
    nextPayloads[snapshot.id] = snapshotPayload
    this.persistStateAndPayloads(next, nextPayloads)
    this.undoStack = this.limited([...this.undoStack, preMergeState])
    this.redoStack = []
    this.state = next
    this.snapshotPayloads = nextPayloads
    this.unavailableSnapshotIds.delete(snapshot.id)

    return cloneValue({
      snapshot,
      retainedPerson,
      removedPersonId: preview.removedPersonId,
      summary: preview.summary,
      issues: await this.inspectProject(projectId),
    })
  }

  async inspectProject(projectId: UUID): Promise<DataIssue[]> {
    this.requireProject(projectId)
    const issues: DataIssue[] = this.state.issues
      .filter((issue) => this.issueBelongsToProject(issue, projectId) && !isDerivedIssue(issue))
      .map((issue) => cloneValue(issue))

    for (const person of this.state.people) {
      if (person.projectId !== projectId || person.deletedAt) continue
      issues.push(...validateLifeDates(person))
      for (const [label, date] of [['出生', person.birth], ['死亡', person.death]] as const) {
        if (dateLooksIncomplete(date)) {
          issues.push(issueFactory(
            'warning',
            'incomplete-date',
            `${primaryName(person) || '人物'}的${label}日期无法解析或不完整，请核对原始记录。`,
            'person',
            person.id,
            label === '出生' ? 'incomplete-birth-date' : 'incomplete-death-date',
          ))
        }
      }
      for (const [label, placeId] of [['出生', person.birthPlaceId], ['死亡', person.deathPlaceId]] as const) {
        if (placeId && !this.state.places.some(({ id, projectId: idProject }) => id === placeId && idProject === projectId)) {
          issues.push(issueFactory(
            'warning', 'missing-place', `${primaryName(person) || '人物'}的${label}地点记录不完整。`,
            'person', person.id, label === '出生' ? 'missing-birth-place' : 'missing-death-place',
          ))
        }
      }
    }
    const relationships = this.state.relationships.filter((relationship) => relationship.projectId === projectId)
    for (const relationship of relationships) {
      const issue = validateRelationship(relationship, relationships)
      if (issue) issues.push(issue)
      if (dateLooksIncomplete(relationship.start) || dateLooksIncomplete(relationship.end)) {
        issues.push(issueFactory('warning', 'incomplete-date', '关系日期无法解析或不完整，请核对原始记录。', 'relationship', relationship.id))
      }
      if (relationship.placeId && !this.state.places.some(({ id }) => id === relationship.placeId)) {
        issues.push(issueFactory('warning', 'missing-place', '关系地点记录不完整。', 'relationship', relationship.id))
      }
    }
    if (hasAncestorCycle(relationships) && !issues.some(({ code }) => code === 'ancestor-cycle')) {
      const cycleTarget = relationships.find((relationship) =>
        relationship.category === 'parent' &&
        (relationship.type === 'biological' || relationship.type === 'adoptive'))
      if (cycleTarget) {
        issues.push(issueFactory(
          'error', 'ancestor-cycle', '父母关系形成明显的祖先环路，必须先修正结构。',
          'relationship', cycleTarget.id,
        ))
      }
    }
    const activePeople = new Map(this.state.people
      .filter(({ projectId: id, deletedAt }) => id === projectId && !deletedAt)
      .map((person) => [person.id, person]))
    for (const event of this.state.events.filter(({ projectId: id }) => id === projectId)) {
      if (dateLooksIncomplete(event.date)) {
        issues.push(issueFactory('warning', 'incomplete-date', `事件“${event.title}”的日期无法解析或不完整。`, 'event', event.id))
      }
      if (event.placeId && !this.state.places.some(({ id }) => id === event.placeId)) {
        issues.push(issueFactory('warning', 'missing-place', `事件“${event.title}”的地点记录不完整。`, 'event', event.id))
      }
      const eventStart = dateStart(event.date)
      const eventEnd = dateEnd(event.date)
      for (const participantId of event.participantIds) {
        const participant = activePeople.get(participantId)
        if (!participant) continue
        const birthStart = dateStart(participant.birth)
        const deathEnd = dateEnd(participant.death)
        if ((eventEnd && birthStart && eventEnd < birthStart) || (eventStart && deathEnd && eventStart > deathEnd)) {
          issues.push(issueFactory(
            'warning',
            'event-outside-lifespan',
            `事件“${event.title}”发生在${primaryName(participant) || '参与人物'}的生平范围之外，请核对日期。`,
            'event',
            event.id,
          ))
          break
        }
      }
    }
    for (const attachment of this.state.attachments) {
      if (attachment.projectId === projectId && attachment.missing) {
        issues.push({
          id: `issue-${attachment.id}-missing-attachment`,
          severity: 'warning',
          code: 'missing-attachment',
          message: `附件“${attachment.name}”缺失。`,
          targetType: 'attachment',
          targetId: attachment.id,
          origin: 'derived',
        })
      } else if (attachment.projectId === projectId && !attachment.contentHash.trim()) {
        issues.push(issueFactory(
          'warning', 'damaged-attachment', `附件“${attachment.name}”完整性校验失败，记录和引用已保留。`,
          'attachment', attachment.id,
        ))
      }
    }
    const usedSources = this.usedSourceIds(projectId)
    for (const source of this.state.sources) {
      if (source.projectId === projectId && !usedSources.has(source.id)) {
        issues.push({
          id: `issue-${source.id}-unused-source`,
          severity: 'info',
          code: 'unused-source',
          message: `来源“${source.title}”尚未被引用。`,
          targetType: 'source',
          targetId: source.id,
          origin: 'derived',
        })
      }
      if (source.projectId === projectId && dateLooksIncomplete(source.date)) {
        issues.push(issueFactory('warning', 'incomplete-date', `来源“${source.title}”的日期无法解析或不完整。`, 'source', source.id))
      }
    }

    for (const duplicate of findDuplicateNameEvidence([...activePeople.values()])) {
      issues.push(issueFactory(
        'warning', 'possible-duplicate',
        `人物“${duplicate.displayName}”与同名桶中的其他 ${duplicate.bucketSize - 1} 条记录可能重复，请比较日期与家庭关系。`,
        'person', duplicate.personId,
      ))
    }

    const seen = new Set<string>()
    return cloneValue(issues.filter((issue) => {
      const key = `${issue.id}\u0000${issue.code}\u0000${issue.targetType}\u0000${issue.targetId}\u0000${issue.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }))
  }

  async getCleanupImpact(projectId: UUID): Promise<CleanupImpact> {
    this.requireProject(projectId)
    const usedAttachmentIds = new Set(this.state.attachmentLinks
      .filter(({ projectId: id }) => id === projectId)
      .map(({ attachmentId }) => attachmentId))
    const unusedAttachments = this.state.attachments.filter(
      ({ projectId: itemProjectId, id }) => itemProjectId === projectId && !usedAttachmentIds.has(id),
    )
    const usedSourceIds = this.usedSourceIds(projectId)
    return cloneValue({
      unusedAttachmentIds: unusedAttachments.map(({ id }) => id).sort(),
      unusedAttachmentBytes: unusedAttachments.reduce((total, { size }) => total + size, 0),
      unusedSourceIds: this.state.sources
        .filter(({ projectId: itemProjectId, id }) => itemProjectId === projectId && !usedSourceIds.has(id))
        .map(({ id }) => id)
        .sort(),
    })
  }

  async cleanupProject(projectId: UUID, input: CleanupInput): Promise<CleanupResult> {
    this.requireProject(projectId)
    const safeInput = cloneValue(input)
    const impact = await this.getCleanupImpact(projectId)
    const unusedSources = new Set(impact.unusedSourceIds)
    if (new Set(safeInput.removeSourceIds).size !== safeInput.removeSourceIds.length) {
      this.validation('Cleanup source selection contains duplicate ids')
    }
    for (const sourceId of safeInput.removeSourceIds) {
      const source = this.state.sources.find(({ id }) => id === sourceId)
      if (!source || source.projectId !== projectId) this.validation('Cleanup source does not belong to the project')
      if (!unusedSources.has(sourceId)) this.validation('A referenced source cannot be removed by cleanup')
    }

    const timestamp = this.now()
    const snapshot: Snapshot = {
      id: this.uniqueSnapshotId(),
      projectId,
      createdAt: timestamp,
      reason: 'cleanup',
      note: `清理前自动快照：附件 ${safeInput.removeUnusedAttachments ? impact.unusedAttachmentIds.length : 0} 个，来源 ${safeInput.removeSourceIds.length} 个`,
      summary: this.snapshotSummary(projectId),
    }
    const preCleanupState = cloneValue(this.state)
    const next = cloneValue(this.state)
    next.snapshots.push(snapshot)
    const removedAttachmentIds = new Set(
      safeInput.removeUnusedAttachments ? impact.unusedAttachmentIds : [],
    )
    const removedSourceIds = new Set(safeInput.removeSourceIds)
    next.attachments = next.attachments.filter(({ id }) => !removedAttachmentIds.has(id))
    next.attachmentLinks = next.attachmentLinks.filter(({ attachmentId }) => !removedAttachmentIds.has(attachmentId))
    next.sources = next.sources.filter(({ id }) => !removedSourceIds.has(id))
    next.issues = next.issues.filter(({ targetType, targetId }) =>
      !(targetType === 'attachment' && removedAttachmentIds.has(targetId)) &&
      !(targetType === 'source' && removedSourceIds.has(targetId)))
    next.projects = next.projects.map((project) => project.id === projectId
      ? { ...project, updatedAt: timestamp }
      : project)

    const nextPayloads = cloneValue(this.snapshotPayloads)
    const snapshotPayload = cloneValue(preCleanupState)
    snapshotPayload.snapshots.push(cloneValue(snapshot))
    nextPayloads[snapshot.id] = snapshotPayload
    this.persistStateAndPayloads(next, nextPayloads)
    this.state = next
    this.snapshotPayloads = nextPayloads
    this.unavailableSnapshotIds.delete(snapshot.id)
    this.undoStack = []
    this.redoStack = []
    return cloneValue({
      snapshot,
      removedAttachments: removedAttachmentIds.size,
      removedSources: removedSourceIds.size,
      searchIndexRebuilt: safeInput.rebuildSearchIndex,
      issues: await this.inspectProject(projectId),
    })
  }

  async restoreSnapshot(snapshotId: UUID): Promise<RestoreResult> {
    const snapshot = this.state.snapshots.find(({ id }) => id === snapshotId)
    if (!snapshot) this.notFound('Snapshot', snapshotId)
    const payload = this.snapshotPayloads[snapshotId]
    if (!payload || this.unavailableSnapshotIds.has(snapshotId)) {
      throw new RepositoryError(
        'corrupt',
        `Snapshot payload ${snapshotId} is unavailable and cannot be reconstructed safely`,
      )
    }
    const timestamp = this.now()
    const safetySnapshot: Snapshot = {
      id: this.uniqueSnapshotId(),
      projectId: snapshot.projectId,
      createdAt: timestamp,
      reason: 'restore',
      note: `恢复前当前状态：准备恢复“${snapshot.note || snapshot.createdAt}”`,
      summary: this.snapshotSummary(snapshot.projectId),
    }
    const preRestoreState = cloneValue(this.state)
    const next = this.restoreProject(this.state, payload, snapshot.projectId)
    next.snapshots.push(safetySnapshot)
    const nextPayloads = cloneValue(this.snapshotPayloads)
    const safetyPayload = cloneValue(preRestoreState)
    safetyPayload.snapshots.push(cloneValue(safetySnapshot))
    nextPayloads[safetySnapshot.id] = safetyPayload
    this.persistStateAndPayloads(next, nextPayloads)
    this.state = next
    this.snapshotPayloads = nextPayloads
    this.unavailableSnapshotIds.delete(safetySnapshot.id)
    this.undoStack = []
    this.redoStack = []
    return cloneValue({ safetySnapshot, issues: await this.inspectProject(snapshot.projectId) })
  }

  async resetDemo(): Promise<void> {
    const next = createDemoState()
    const nextPayloads = createCanonicalDemoSnapshotPayloads()
    this.persistStateAndPayloads(next, nextPayloads)
    this.state = next
    this.snapshotPayloads = nextPayloads
    this.unavailableSnapshotIds.clear()
    this.undoStack = []
    this.redoStack = []
  }

  getHistoryState(): HistoryState {
    return cloneValue({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 })
  }

  async undo(): Promise<void> {
    const previous = this.undoStack.at(-1)
    if (!previous) this.notFound('Undo state', 'latest')
    const next = cloneValue(previous)
    next.snapshots = cloneValue(this.state.snapshots)
    this.persistState(next)
    const current = cloneValue(this.state)
    this.undoStack = this.undoStack.slice(0, -1)
    this.redoStack = this.limited([...this.redoStack, current])
    this.state = next
  }

  async redo(): Promise<void> {
    const following = this.redoStack.at(-1)
    if (!following) this.notFound('Redo state', 'latest')
    const next = cloneValue(following)
    next.snapshots = cloneValue(this.state.snapshots)
    this.persistState(next)
    const current = cloneValue(this.state)
    this.redoStack = this.redoStack.slice(0, -1)
    this.undoStack = this.limited([...this.undoStack, current])
    this.state = next
  }

  private read(key: string): string | null {
    try {
      return this.storage.getItem(key)
    } catch (error) {
      throw new RepositoryError('storage', `Failed to read prototype storage key ${key}`, { cause: error })
    }
  }

  private write(key: string, value: string): void {
    if (this.nextWriteFailure !== undefined) {
      const cause = this.nextWriteFailure
      this.nextWriteFailure = undefined
      throw new RepositoryError('storage', `Injected write failure for ${key}`, { cause })
    }
    try {
      this.storage.setItem(key, value)
    } catch (error) {
      throw new RepositoryError('storage', `Failed to write prototype storage key ${key}`, { cause: error })
    }
  }

  private persistState(state: PrototypeState): void {
    this.persistStateAndPayloads(state, this.snapshotPayloads)
  }

  private persistPayloads(payloads: SnapshotPayloads): void {
    this.persistStateAndPayloads(this.state, payloads)
  }

  private persistStateAndPayloads(state: PrototypeState, payloads: SnapshotPayloads): void {
    const previousState = JSON.stringify(this.state)
    const previousPayloads = JSON.stringify(this.snapshotPayloads)
    const transaction: PendingStorageTransaction = {
      version: 1,
      phase: 'prepared',
      previousState,
      previousPayloads,
      nextState: JSON.stringify(state),
      nextPayloads: JSON.stringify(payloads),
    }
    try {
      this.write(TRANSACTION_STORAGE_KEY, JSON.stringify(transaction))
      this.write(SNAPSHOT_PAYLOADS_STORAGE_KEY, transaction.nextPayloads)
      this.write(PROTOTYPE_STORAGE_KEY, transaction.nextState)
      transaction.phase = 'committed'
      this.write(TRANSACTION_STORAGE_KEY, JSON.stringify(transaction))
      try { this.storage.removeItem(TRANSACTION_STORAGE_KEY) } catch { /* committed marker is authoritative */ }
    } catch (writeError) {
      const rollbackErrors: unknown[] = []
      try {
        if (previousState === null) this.storage.removeItem(PROTOTYPE_STORAGE_KEY)
        else this.storage.setItem(PROTOTYPE_STORAGE_KEY, previousState)
      } catch (error) { rollbackErrors.push(error) }
      try {
        if (previousPayloads === null) this.storage.removeItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
        else this.storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, previousPayloads)
      } catch (error) { rollbackErrors.push(error) }
      if (rollbackErrors.length === 0) {
        try { this.storage.removeItem(TRANSACTION_STORAGE_KEY) } catch (error) { rollbackErrors.push(error) }
      }
      if (rollbackErrors.length > 0) {
        throw new RepositoryError(
          'storage',
          'Failed to persist prototype transaction and fully roll back; recovery journal was retained',
          { cause: new AggregateError([writeError, ...rollbackErrors]) },
        )
      }
      throw writeError
    }
  }

  private recoverPendingTransaction(): { state: string | null; payloads: string | null } | undefined {
    const rawJournal = this.read(TRANSACTION_STORAGE_KEY)
    if (rawJournal === null) return undefined
    const transaction = parsePendingStorageTransaction(rawJournal)
    if (!transaction) {
      this.preserveRecovery(rawJournal, TRANSACTION_RECOVERY_STORAGE_PREFIX)
      try { this.storage.removeItem(TRANSACTION_STORAGE_KEY) } catch { /* invalid evidence remains visible */ }
      return undefined
    }
    this.preserveRecovery(rawJournal, TRANSACTION_RECOVERY_STORAGE_PREFIX)
    const state = transaction.phase === 'committed' ? transaction.nextState : transaction.previousState
    const payloads = transaction.phase === 'committed' ? transaction.nextPayloads : transaction.previousPayloads
    let repaired = true
    try {
      if (state === null) this.storage.removeItem(PROTOTYPE_STORAGE_KEY)
      else this.storage.setItem(PROTOTYPE_STORAGE_KEY, state)
    } catch { repaired = false }
    try {
      if (payloads === null) this.storage.removeItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
      else this.storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, payloads)
    } catch { repaired = false }
    if (repaired) {
      try { this.storage.removeItem(TRANSACTION_STORAGE_KEY) } catch { /* journal remains authoritative */ }
    }
    return { state, payloads }
  }

  private preserveRecovery(raw: string, prefix = RECOVERY_STORAGE_PREFIX): void {
    try {
      this.storage.setItem(`${prefix}${safeRecoverySuffix(this.now())}`, raw)
    } catch {
      // Recovery preservation is best-effort; restoring the main key remains mandatory.
    }
  }

  private commit(next: PrototypeState): void {
    const candidate = cloneValue(next)
    this.persistState(candidate)
    this.undoStack = this.limited([...this.undoStack, cloneValue(this.state)])
    this.redoStack = []
    this.state = candidate
  }

  private limited(stack: PrototypeState[]): PrototypeState[] {
    return stack.length > HISTORY_LIMIT ? stack.slice(-HISTORY_LIMIT) : stack
  }

  private usedSourceIds(projectId: UUID): Set<UUID> {
    const used = new Set<UUID>()
    for (const person of this.state.people) {
      if (person.projectId === projectId && !person.deletedAt) {
        person.sourceIds?.forEach((id) => used.add(id))
      }
    }
    for (const relationship of this.state.relationships) {
      if (relationship.projectId === projectId) relationship.sourceIds.forEach((id) => used.add(id))
    }
    for (const event of this.state.events) {
      if (event.projectId === projectId) event.sourceIds.forEach((id) => used.add(id))
    }
    for (const organization of this.state.organizations) {
      if (organization.projectId === projectId) organization.sourceIds.forEach((id) => used.add(id))
    }
    for (const career of this.state.careers) {
      if (career.projectId === projectId) career.sourceIds.forEach((id) => used.add(id))
    }
    for (const title of this.state.personTitles) {
      if (title.projectId === projectId) title.sourceIds.forEach((id) => used.add(id))
    }
    for (const citation of this.state.citations) {
      if (citation.projectId === projectId) used.add(citation.sourceId)
    }
    return used
  }

  private snapshotSummary(projectId: UUID): Snapshot['summary'] {
    return {
      people: this.state.people.filter((item) => item.projectId === projectId && !item.deletedAt).length,
      relationships: this.state.relationships.filter((item) => item.projectId === projectId).length,
      events: this.state.events.filter((item) => item.projectId === projectId).length,
    }
  }

  private uniqueSnapshotId(): UUID {
    const base = this.idFactory()
    if (!this.state.snapshots.some(({ id }) => id === base)) return base
    let suffix = 2
    while (this.state.snapshots.some(({ id }) => id === `${base}-${suffix}`)) suffix += 1
    return `${base}-${suffix}`
  }

  private restoreProject(
    current: PrototypeState,
    payload: PrototypeState,
    projectId: UUID,
  ): PrototypeState {
    const project = payload.projects.find(({ id }) => id === projectId)
    if (!project) {
      throw new RepositoryError('corrupt', `Snapshot payload is missing project ${projectId}`)
    }
    const next = cloneValue(current)
    next.projects = current.projects.map((candidate) =>
      candidate.id === projectId ? cloneValue(project) : cloneValue(candidate))
    next.people = restoreScoped(current.people, payload.people, projectId)
    next.organizations = restoreScoped(current.organizations, payload.organizations, projectId)
    next.careers = restoreScoped(current.careers, payload.careers, projectId)
    next.personTitles = restoreScoped(current.personTitles, payload.personTitles, projectId)
    next.relationships = restoreScoped(current.relationships, payload.relationships, projectId)
    next.events = restoreScoped(current.events, payload.events, projectId)
    next.places = restoreScoped(current.places, payload.places, projectId)
    next.sources = restoreScoped(current.sources, payload.sources, projectId)
    next.citations = restoreScoped(current.citations, payload.citations, projectId)
    next.attachments = restoreScoped(current.attachments, payload.attachments, projectId)
    next.attachmentLinks = restoreScoped(current.attachmentLinks, payload.attachmentLinks, projectId)
    next.snapshots = cloneValue(current.snapshots)
    next.issues = [
      ...current.issues.filter((issue) => !this.issueBelongsToStateProject(issue, projectId, current)),
      ...payload.issues.filter((issue) => this.issueBelongsToStateProject(issue, projectId, payload)),
    ]
    return cloneValue(next)
  }

  private now(): string {
    const value = this.clock()
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.valueOf())) this.validation('Injected clock returned an invalid timestamp')
    return date.toISOString()
  }

  private requireProject(projectId: UUID): Project {
    const project = this.state.projects.find(({ id }) => id === projectId)
    if (!project) this.notFound('Project', projectId)
    return project
  }

  private requirePersonInProject(personId: UUID, projectId: UUID): Person {
    return this.requirePersonInStateProject(this.state, personId, projectId)
  }

  private requirePersonInStateProject(
    state: PrototypeState,
    personId: UUID,
    projectId: UUID,
  ): Person {
    const person = state.people.find(({ id }) => id === personId)
    if (!person || person.projectId !== projectId) this.validation('Referenced person does not exist in the project')
    return person
  }

  private requireSourceInProject(sourceId: UUID, projectId: UUID): Source {
    const source = this.state.sources.find(({ id }) => id === sourceId)
    if (!source || source.projectId !== projectId) this.validation('Referenced source does not exist in the project')
    return source
  }

  private requireSources(sourceIds: UUID[], projectId: UUID): void {
    for (const sourceId of sourceIds) this.requireSourceInProject(sourceId, projectId)
  }

  private optionalPlace(placeId: UUID | undefined, projectId: UUID): void {
    if (!placeId) return
    const place = this.state.places.find(({ id }) => id === placeId)
    if (!place || place.projectId !== projectId) this.validation('Referenced place does not exist in the project')
  }

  private validateEntityProject<T extends { id: UUID; projectId: UUID }>(items: T[], value: T): void {
    this.requireProject(value.projectId)
    const existing = items.find(({ id }) => id === value.id)
    if (existing && existing.projectId !== value.projectId) {
      this.validation('An existing id cannot be moved across projects')
    }
  }

  private requireTypedTarget(
    targetType: Citation['targetType'] | AttachmentLink['targetType'],
    targetId: UUID,
    projectId: UUID,
  ): void {
    const targets = targetType === 'person'
      ? this.state.people
      : targetType === 'relationship'
        ? this.state.relationships
        : targetType === 'event'
          ? this.state.events
          : targetType === 'career'
            ? this.state.careers
            : this.state.citations
    const target = targets.find(({ id }) => id === targetId)
    if (!target || target.projectId !== projectId) this.validation('Typed target does not exist in the project')
  }

  private personSearchText(person: Person): string {
    const placeIds = new Set([person.birthPlaceId, person.deathPlaceId].filter(Boolean))
    const events = this.state.events.filter(({ projectId, participantIds }) =>
      projectId === person.projectId && participantIds.includes(person.id))
    for (const event of events) if (event.placeId) placeIds.add(event.placeId)
    const careers = this.state.careers.filter(({ projectId, personId }) =>
      projectId === person.projectId && personId === person.id)
    for (const career of careers) if (career.jurisdictionPlaceId) placeIds.add(career.jurisdictionPlaceId)
    const places = this.state.places.filter(({ id, projectId }) =>
      projectId === person.projectId && placeIds.has(id))
    const organizationIds = new Set(careers.map(({ organizationId }) => organizationId).filter(Boolean))
    const organizations = this.state.organizations.filter(({ id, projectId }) =>
      projectId === person.projectId && organizationIds.has(id))
    return [
      ...person.names.flatMap(({
        value, type, customTypeLabel, familyName, givenName, context, notes,
      }) => [
        value,
        type,
        personNameTypeLabels[type],
        customTypeLabel,
        familyName,
        givenName,
        context,
        notes,
      ]),
      person.biography,
      person.notes,
      ...places.flatMap(({ name, aliases }) => [name, ...aliases]),
      ...events.flatMap(({ type, title, participantRoles, notes }) => [
        type,
        eventTypeLabel(type),
        title,
        ...Object.values(participantRoles ?? {}),
        notes,
      ]),
      ...organizations.flatMap(({ name, aliases, notes }) => [name, ...aliases, notes]),
      ...careers.flatMap(({
        positionTitle, department, regime, rankOrGrade, appointmentType, description, notes,
      }) => [positionTitle, department, regime, rankOrGrade, appointmentType, description, notes]),
    ].filter((value): value is string => Boolean(value)).join('\n').toLocaleLowerCase()
  }

  private personHasSources(person: Person): boolean {
    const careerIds = new Set(this.state.careers
      .filter(({ personId }) => personId === person.id)
      .map(({ id }) => id))
    return (person.sourceIds?.length ?? 0) > 0
      || this.state.careers.some(({ personId, sourceIds }) =>
        personId === person.id && sourceIds.length > 0)
      || this.state.citations.some(({ targetType, targetId }) =>
        (targetType === 'person' && targetId === person.id)
        || (targetType === 'career' && careerIds.has(targetId)))
  }

  private personHasIssues(person: Person): boolean {
    return this.state.issues.some(
      ({ targetType, targetId }) => targetType === 'person' && targetId === person.id,
    ) || validateLifeDates(person).length > 0
  }

  private comparePeople(left: Person, right: Person, sort: PersonQuery['sort']): number {
    let result = 0
    if (sort === 'name') {
      result = getPrimaryName(left).localeCompare(getPrimaryName(right), 'zh-CN')
    } else if (sort === 'updatedAt') {
      result = right.updatedAt.localeCompare(left.updatedAt)
    } else if (left.birth && right.birth) {
      result = compareGenealogyDates(left.birth, right.birth)
    } else if (left.birth) {
      result = -1
    } else if (right.birth) {
      result = 1
    }
    return result || stableId(left, right)
  }

  private issueBelongsToProject(issue: DataIssue, projectId: UUID): boolean {
    return this.issueBelongsToStateProject(issue, projectId, this.state)
  }

  private stateWithoutProject(state: PrototypeState, projectId: UUID): PrototypeState {
    const next = cloneValue(state)
    next.projects = next.projects.filter(({ id }) => id !== projectId)
    next.people = next.people.filter(({ projectId: id }) => id !== projectId)
    next.organizations = next.organizations.filter(({ projectId: id }) => id !== projectId)
    next.careers = next.careers.filter(({ projectId: id }) => id !== projectId)
    next.personTitles = next.personTitles.filter(({ projectId: id }) => id !== projectId)
    next.relationships = next.relationships.filter(({ projectId: id }) => id !== projectId)
    next.events = next.events.filter(({ projectId: id }) => id !== projectId)
    next.places = next.places.filter(({ projectId: id }) => id !== projectId)
    next.sources = next.sources.filter(({ projectId: id }) => id !== projectId)
    next.citations = next.citations.filter(({ projectId: id }) => id !== projectId)
    next.attachments = next.attachments.filter(({ projectId: id }) => id !== projectId)
    next.attachmentLinks = next.attachmentLinks.filter(({ projectId: id }) => id !== projectId)
    next.snapshots = next.snapshots.filter(({ projectId: id }) => id !== projectId)
    next.issues = next.issues.filter((issue) =>
      !this.issueBelongsToStateProject(issue, projectId, state))
    return next
  }

  private issueBelongsToStateProject(
    issue: DataIssue,
    projectId: UUID,
    state: PrototypeState,
  ): boolean {
    const targets = issue.targetType === 'person'
      ? state.people
      : issue.targetType === 'relationship'
        ? state.relationships
        : issue.targetType === 'event'
          ? state.events
          : issue.targetType === 'source'
            ? state.sources
            : state.attachments
    return targets.some(({ id, projectId: idProject }) => id === issue.targetId && idProject === projectId)
  }

  private validation(message: string): never {
    throw new RepositoryError('validation', message)
  }

  private notFound(entity: string, id: UUID): never {
    throw new RepositoryError('not-found', `${entity} ${id} was not found`)
  }
}
