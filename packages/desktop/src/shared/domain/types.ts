export type UUID = string

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'
export type PersonStatus = 'living' | 'deceased' | 'unknown'
export type Sex = 'female' | 'male' | 'nonbinary' | 'unknown'
export type ParentRelation = 'biological' | 'adoptive' | 'step' | 'guardian'
export type PartnerRelation = 'engaged' | 'married' | 'partner' | 'separated' | 'divorced'
export type BackupSchedule = 'off' | 'daily' | 'weekly'
export type PersonNameType =
  | 'personal'
  | 'courtesy'
  | 'art'
  | 'genealogy'
  | 'generation'
  | 'childhood'
  | 'former'
  | 'pen'
  | 'religious'
  | 'posthumous'
  | 'temple'
  | 'honorific'
  | 'alias'
  | 'custom'

export interface GenealogyDate {
  display: string
  start?: string
  end?: string
  precision: 'exact' | 'about' | 'before' | 'after' | 'range' | 'unknown'
}

export interface Project {
  id: UUID
  name: string
  description: string
  /** Runtime-only local attachment preview; never persisted as project data. */
  coverUrl?: string
  defaultPersonId?: UUID
  createdAt: string
  updatedAt: string
  lastBackupAt?: string
  backupSchedule?: BackupSchedule
}

export interface PersonName {
  value: string
  type: PersonNameType
  primary: boolean
  customTypeLabel?: string
  familyName?: string
  givenName?: string
  validFrom?: GenealogyDate
  validTo?: GenealogyDate
  context?: string
  notes?: string
}

export interface Person {
  id: UUID
  projectId: UUID
  names: PersonName[]
  sex: Sex
  status: PersonStatus
  /** Runtime-only local attachment preview; never persisted as person data. */
  avatarUrl?: string
  birth?: GenealogyDate
  death?: GenealogyDate
  birthPlaceId?: UUID
  deathPlaceId?: UUID
  biography: string
  notes: string
  /** @deprecated Person evidence is represented by citations. */
  sourceIds?: UUID[]
  deletedAt?: string
  updatedAt: string
}

export interface RelationshipBase {
  id: UUID
  projectId: UUID
  /** For parent relationships, from is the parent or guardian and to is the child or ward. */
  fromPersonId: UUID
  /** Partner relationships are stored directionally but treated as symmetric by the UI. */
  toPersonId: UUID
  start?: GenealogyDate
  end?: GenealogyDate
  placeId?: UUID
  notes: string
  sourceIds: UUID[]
}

export interface ParentRelationship extends RelationshipBase {
  category: 'parent'
  type: ParentRelation
}

export interface PartnerRelationship extends RelationshipBase {
  category: 'partner'
  type: PartnerRelation
}

export type Relationship = ParentRelationship | PartnerRelationship

export interface FamilyEvent {
  id: UUID
  projectId: UUID
  type: string
  title: string
  date: GenealogyDate
  placeId?: UUID
  participantIds: UUID[]
  participantRoles?: Record<UUID, string>
  sourceIds: UUID[]
  notes: string
}

export interface Place {
  id: UUID
  projectId: UUID
  name: string
  parentId?: UUID
  aliases: string[]
  notes: string
}

export type OrganizationType =
  | 'company'
  | 'government'
  | 'imperial_court'
  | 'military'
  | 'education'
  | 'religious'
  | 'clan'
  | 'other'

export interface Organization {
  id: UUID
  projectId: UUID
  name: string
  type: OrganizationType
  aliases: string[]
  parentId?: UUID
  placeId?: UUID
  validFrom?: GenealogyDate
  validTo?: GenealogyDate
  notes: string
  sourceIds: UUID[]
}

export type CareerCategory =
  | 'employment'
  | 'civil_office'
  | 'military_office'
  | 'academic'
  | 'religious_office'
  | 'self_employed'
  | 'other'

export interface CareerRecord {
  id: UUID
  projectId: UUID
  personId: UUID
  category: CareerCategory
  organizationId?: UUID
  positionTitle: string
  department?: string
  regime?: string
  rankOrGrade?: string
  appointmentType?: string
  jurisdictionPlaceId?: UUID
  appointedByPersonId?: UUID
  start?: GenealogyDate
  end?: GenealogyDate
  status: 'current' | 'former' | 'unknown'
  description: string
  notes: string
  sourceIds: UUID[]
}

export interface PersonTitle {
  id: UUID
  projectId: UUID
  personId: UUID
  type: 'nobility' | 'conferred-title' | 'honorific-title' | 'custom'
  value: string
  customTypeLabel?: string
  start?: GenealogyDate
  end?: GenealogyDate
  placeId?: UUID
  grantedByPersonId?: UUID
  notes: string
  sourceIds: UUID[]
}

export interface Source {
  id: UUID
  projectId: UUID
  title: string
  type: 'book' | 'archive' | 'web' | 'interview' | 'other'
  author?: string
  repository?: string
  url?: string
  date?: GenealogyDate
  referenceCode?: string
  notes: string
}

export interface Citation {
  id: UUID
  projectId: UUID
  sourceId: UUID
  targetType: 'person' | 'relationship' | 'event' | 'career'
  targetId: UUID
  locator?: string
  excerpt?: string
  accessedAt?: GenealogyDate
  notes: string
}

export interface Attachment {
  id: UUID
  projectId: UUID
  name: string
  mimeType: string
  size: number
  /** Runtime-only local attachment preview; never persisted as attachment data. */
  previewUrl?: string
  contentHash: string
  missing: boolean
}

export interface AttachmentLink {
  id: UUID
  projectId: UUID
  attachmentId: UUID
  targetType: 'project' | 'person' | 'relationship' | 'event' | 'career' | 'citation'
  targetId: UUID
  role?: 'cover' | 'avatar' | 'evidence' | 'document' | 'media' | 'other'
}

export interface Snapshot {
  id: UUID
  projectId: UUID
  createdAt: string
  reason: 'manual' | 'import' | 'merge' | 'cleanup' | 'restore'
  note: string
  summary: {
    people: number
    relationships: number
    events: number
  }
}

export interface DataIssue {
  id: UUID
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  targetType: 'person' | 'relationship' | 'event' | 'source' | 'attachment'
  targetId: UUID
  /** Derived issues are regenerated by inspection; manual issues remain persistent. */
  origin?: 'manual' | 'derived'
}

export interface PrototypeState {
  schemaVersion: 2
  projects: Project[]
  people: Person[]
  organizations: Organization[]
  careers: CareerRecord[]
  personTitles: PersonTitle[]
  relationships: Relationship[]
  events: FamilyEvent[]
  places: Place[]
  sources: Source[]
  citations: Citation[]
  attachments: Attachment[]
  attachmentLinks: AttachmentLink[]
  snapshots: Snapshot[]
  issues: DataIssue[]
}

export interface PersonQuery {
  search?: string
  status?: PersonStatus
  sex?: Sex
  hasAvatar?: boolean
  hasSources?: boolean
  hasBirth?: boolean
  hasDeath?: boolean
  hasIssues?: boolean
  page: number
  pageSize: number
  sort: 'name' | 'updatedAt' | 'birth'
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface BoundedFamilySliceQuery {
  generationsUp: number
  generationsDown: number
}

export interface BoundedFamilySlice {
  projectId: UUID
  centerPersonId: UUID
  people: Person[]
  relationships: Relationship[]
  places: Place[]
  truncated: boolean
  limits: {
    maxNodes: number
    maxEdges: number
    returnedNodes: number
    returnedEdges: number
  }
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}

export interface SourceDeletionImpact {
  citations: number
  people: number
  organizations: number
  careers: number
  personTitles: number
  relationships: number
  events: number
  attachmentLinks: number
}

export interface ProjectSummary {
  people: number
  relationships: number
  events: number
  sources: number
  attachments: number
  attachmentBytes: number
  updatedAt: string
  lastBackupAt: string
}

export type PersonMergeSide = 'auto' | 'keep' | 'remove'
export type RelationshipMergeField = 'start' | 'end' | 'placeId' | 'notes'

export interface RelationshipConflictChoice {
  relationshipIds: [UUID, UUID]
  fields: Partial<Record<RelationshipMergeField, UUID>>
}

export interface PersonMergeChoices {
  sex?: PersonMergeSide
  status?: PersonMergeSide
  avatarUrl?: PersonMergeSide
  birth?: PersonMergeSide
  death?: PersonMergeSide
  birthPlaceId?: PersonMergeSide
  deathPlaceId?: PersonMergeSide
  biography?: PersonMergeSide
  notes?: PersonMergeSide
  /** Omit to preserve every distinct name from both records. */
  retainedNameValues?: string[]
  /** Omit to preserve every source association from both records. */
  retainedSourceIds?: UUID[]
  retainedRelationshipIds?: UUID[]
  retainedEventIds?: UUID[]
  retainedCitationIds?: UUID[]
  retainedAttachmentLinkIds?: UUID[]
  relationshipConflictChoices?: RelationshipConflictChoice[]
}

export interface PersonMergeInput {
  keepPersonId: UUID
  removePersonId: UUID
  choices: PersonMergeChoices
}

export interface PersonMergeSummary {
  removedPeople: number
  rewiredRelationships: number
  removedRelationships: number
  rewiredEvents: number
  rewiredCitations: number
  rewiredAttachmentLinks: number
}

export interface PersonMergeResult {
  snapshot: Snapshot
  retainedPerson: Person
  removedPersonId: UUID
  summary: PersonMergeSummary
  issues: DataIssue[]
}

export interface DuplicateCandidate {
  leftPersonId: UUID
  rightPersonId: UUID
  score: number
  reasons: string[]
  conflicts: string[]
}

export interface CleanupImpact {
  unusedAttachmentIds: UUID[]
  unusedAttachmentBytes: number
  unusedSourceIds: UUID[]
}

export interface CleanupInput {
  removeUnusedAttachments: boolean
  removeSourceIds: UUID[]
  rebuildSearchIndex: boolean
}

export interface CleanupResult {
  snapshot: Snapshot
  removedAttachments: number
  removedSources: number
  searchIndexRebuilt: boolean
  issues: DataIssue[]
}

export interface RestoreResult {
  safetySnapshot: Snapshot
  issues: DataIssue[]
}

export interface BranchloomRepository {
  listProjects(): Promise<Project[]>
  createProject(input: Pick<Project, 'name' | 'description'>): Promise<Project>
  getProject(projectId: UUID): Promise<Project>
  updateProject(projectId: UUID, patch: Partial<Project>): Promise<Project>
  deleteProject(projectId: UUID): Promise<void>
  getProjectSummary(projectId: UUID): Promise<ProjectSummary>
  listPeople(projectId: UUID, query: PersonQuery): Promise<Page<Person>>
  getBoundedFamilySlice(
    projectId: UUID,
    centerPersonId: UUID,
    query: BoundedFamilySliceQuery,
  ): Promise<BoundedFamilySlice>
  getTreeFamilySlice(
    projectId: UUID,
    centerPersonId: UUID,
    query: BoundedFamilySliceQuery,
  ): Promise<BoundedFamilySlice>
  getPerson(personId: UUID): Promise<Person>
  savePerson(person: Person): Promise<Person>
  softDeletePerson(personId: UUID): Promise<void>
  listOrganizations(projectId: UUID): Promise<Organization[]>
  saveOrganization(organization: Organization): Promise<Organization>
  deleteOrganization(organizationId: UUID): Promise<void>
  listCareers(projectId: UUID, personId?: UUID): Promise<CareerRecord[]>
  saveCareer(career: CareerRecord): Promise<CareerRecord>
  saveOrganizationWithCareer(
    organization: Organization,
    career: CareerRecord,
  ): Promise<{ organization: Organization; career: CareerRecord }>
  deleteCareer(careerId: UUID): Promise<void>
  listPersonTitles(projectId: UUID, personId?: UUID): Promise<PersonTitle[]>
  savePersonTitle(title: PersonTitle): Promise<PersonTitle>
  deletePersonTitle(titleId: UUID): Promise<void>
  listRelationships(projectId: UUID): Promise<Relationship[]>
  getRelationship(projectId: UUID, relationshipId: UUID): Promise<Relationship>
  saveRelationship(relationship: Relationship): Promise<Relationship>
  deleteRelationship(relationshipId: UUID): Promise<void>
  savePersonWithRelationship(
    person: Person,
    relationship: Relationship,
  ): Promise<{ person: Person; relationship: Relationship }>
  listEvents(projectId: UUID): Promise<FamilyEvent[]>
  saveEvent(event: FamilyEvent): Promise<FamilyEvent>
  deleteEvent(eventId: UUID): Promise<void>
  listPlaces(projectId: UUID): Promise<Place[]>
  savePlace(place: Place): Promise<Place>
  deletePlace(placeId: UUID): Promise<void>
  listSources(projectId: UUID): Promise<Source[]>
  saveSource(source: Source): Promise<Source>
  getSourceDeletionImpact(sourceId: UUID): Promise<SourceDeletionImpact>
  deleteSource(sourceId: UUID): Promise<void>
  listCitations(projectId: UUID): Promise<Citation[]>
  saveCitation(citation: Citation): Promise<Citation>
  saveCitationWithAttachmentLinks(citation: Citation, attachmentIds: UUID[]): Promise<Citation>
  deleteCitation(citationId: UUID): Promise<void>
  listAttachments(projectId: UUID): Promise<Attachment[]>
  saveAttachment(attachment: Attachment): Promise<Attachment>
  locateAttachment(attachmentId: UUID): Promise<Attachment>
  deleteAttachment(attachmentId: UUID): Promise<void>
  listAttachmentLinks(projectId: UUID): Promise<AttachmentLink[]>
  saveAttachmentLink(link: AttachmentLink): Promise<AttachmentLink>
  listSnapshots(projectId: UUID): Promise<Snapshot[]>
  createSnapshot(projectId: UUID, reason: Snapshot['reason'], note: string): Promise<Snapshot>
  mergePeople(input: PersonMergeInput): Promise<PersonMergeResult>
  listDuplicateCandidates(projectId: UUID): Promise<DuplicateCandidate[]>
  inspectProject(projectId: UUID): Promise<DataIssue[]>
  getCleanupImpact(projectId: UUID): Promise<CleanupImpact>
  cleanupProject(projectId: UUID, input: CleanupInput): Promise<CleanupResult>
  restoreSnapshot(snapshotId: UUID): Promise<RestoreResult>
  resetDemo(): Promise<void>
  getHistoryState(): HistoryState
  undo(): Promise<void>
  redo(): Promise<void>
}
