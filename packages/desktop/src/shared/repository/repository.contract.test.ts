import { describe, expect, it } from 'vitest'
import type {
  Attachment,
  AttachmentLink,
  BranchloomRepository,
  CareerRecord,
  Citation,
  FamilyEvent,
  Person,
  PersonQuery,
  Place,
  Organization,
  Relationship,
  Source,
} from './BranchloomRepository'
import { createDemoState } from '../fixtures/demoState'
import { BrowserPrototypeRepository } from './BrowserPrototypeRepository'
import {
  RepositoryError,
  SNAPSHOT_PAYLOADS_STORAGE_KEY,
  type PrototypeStorage,
} from './storage'

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value))
  }
}

interface RepositoryContext {
  repository: BrowserPrototypeRepository
  storage: MemoryStorage
  reopen(): BrowserPrototypeRepository
}

type MakeContext = () => RepositoryContext

const defaultQuery: PersonQuery = {
  page: 1,
  pageSize: 50,
  sort: 'name',
}

function expectCode(error: unknown, code: RepositoryError['code']): boolean {
  expect(error).toBeInstanceOf(RepositoryError)
  expect((error as RepositoryError).code).toBe(code)
  return true
}

export function repositoryContract(name: string, makeContext: MakeContext): void {
  describe(`${name} repository contract`, () => {
    it('loads demo data and never leaks returned references', async () => {
      const { repository } = makeContext()

      const projects = await repository.listProjects()
      const people = await repository.listPeople(projects[0]!.id, defaultQuery)
      expect(projects).toHaveLength(1)
      expect(people.total).toBe(12)

      projects[0]!.name = 'mutated result'
      people.items[0]!.names[0]!.value = 'mutated name'
      expect((await repository.listProjects())[0]!.name).toBe('林家四代家庭档案')
      expect((await repository.listPeople('project-demo-family', defaultQuery)).items[0]!.names[0]!.value)
        .not.toBe('mutated name')
    })

    it('creates and updates projects with stable ids, trimmed text and generated timestamps', async () => {
      const { repository } = makeContext()

      const created = await repository.createProject({ name: '  新项目  ', description: '  描述  ' })
      expect(created).toMatchObject({
        id: 'generated-1',
        name: '新项目',
        description: '描述',
        createdAt: '2030-01-02T03:04:05.000Z',
        updatedAt: '2030-01-02T03:04:05.000Z',
      })
      expect((await repository.listPeople(created.id, defaultQuery)).total).toBe(0)
      expect(await repository.getProjectSummary(created.id)).toMatchObject({
        updatedAt: '2030-01-02T03:04:05.000Z',
        lastBackupAt: '',
      })

      const updated = await repository.updateProject(created.id, {
        id: 'replacement-id',
        createdAt: '1999-01-01T00:00:00.000Z',
        name: '  新名称  ',
        description: '  新描述  ',
      })
      expect(updated.id).toBe(created.id)
      expect(updated.createdAt).toBe(created.createdAt)
      expect(updated.name).toBe('新名称')
      expect(updated.description).toBe('新描述')

      await expect(repository.createProject({ name: '   ', description: '' }))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.updateProject(created.id, { name: ' ' }))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))
    })

    it('deletes one project and all of its scoped browser data without affecting other projects', async () => {
      const { repository, storage } = makeContext()
      const other = await repository.createProject({ name: '保留的项目', description: '' })
      await repository.createSnapshot(other.id, 'manual', '删除前的跨项目快照')

      await repository.deleteProject('project-demo-family')

      await expect(repository.getProject('project-demo-family'))
        .rejects.toSatisfy((error) => expectCode(error, 'not-found'))
      expect(await repository.listProjects()).toEqual([expect.objectContaining({ id: other.id })])
      expect((await repository.listPeople(other.id, defaultQuery)).total).toBe(0)
      await expect(repository.listPeople('project-demo-family', defaultQuery))
        .rejects.toSatisfy((error) => expectCode(error, 'not-found'))
      expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })

      const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY) ?? '{}') as Record<string, {
        projects: Array<{ id: string }>
        people: Array<{ projectId: string }>
        relationships: Array<{ projectId: string }>
        events: Array<{ projectId: string }>
        places: Array<{ projectId: string }>
        sources: Array<{ projectId: string }>
        citations: Array<{ projectId: string }>
        attachments: Array<{ projectId: string }>
        attachmentLinks: Array<{ projectId: string }>
        snapshots: Array<{ projectId: string }>
      }>
      for (const payload of Object.values(payloads)) {
        expect(payload.projects.some(({ id }) => id === 'project-demo-family')).toBe(false)
        for (const collection of [
          payload.people,
          payload.relationships,
          payload.events,
          payload.places,
          payload.sources,
          payload.citations,
          payload.attachments,
          payload.attachmentLinks,
          payload.snapshots,
        ]) {
          expect(collection.some(({ projectId }) => projectId === 'project-demo-family')).toBe(false)
        }
      }
    })

    it('keeps project data and history intact when browser project deletion persistence fails', async () => {
      const { repository } = makeContext()
      await repository.updateProject('project-demo-family', { name: '删除前名称' })
      const beforeProject = await repository.getProject('project-demo-family')
      const beforeSummary = await repository.getProjectSummary('project-demo-family')
      const beforeHistory = repository.getHistoryState()
      repository.failNextWrite(new Error('disk full'))

      await expect(repository.deleteProject('project-demo-family'))
        .rejects.toSatisfy((error) => expectCode(error, 'storage'))
      expect(await repository.getProject('project-demo-family')).toEqual(beforeProject)
      expect(await repository.getProjectSummary('project-demo-family')).toEqual(beforeSummary)
      expect(repository.getHistoryState()).toEqual(beforeHistory)
    })

    it('upserts and lists every supported entity in stable project-scoped order', async () => {
      const { repository } = makeContext()
      const demo = createDemoState()
      const projectId = demo.projects[0]!.id

      const person: Person = {
        ...demo.people[0]!,
        id: 'person-new',
        names: [{ value: '新增人物', type: 'personal', primary: true }],
      }
      const place: Place = { id: 'place-new', projectId, name: '新地点', aliases: [], notes: '' }
      const source: Source = { id: 'source-new', projectId, title: '新来源', type: 'other', notes: '' }
      await repository.savePlace(place)
      await repository.saveSource(source)
      await repository.savePerson(person)

      const relationship: Relationship = {
        id: 'relationship-new', projectId, category: 'partner', type: 'partner',
        fromPersonId: 'person-new', toPersonId: demo.people[1]!.id, notes: '', sourceIds: ['source-new'],
      }
      const event: FamilyEvent = {
        id: 'event-new', projectId, type: 'other', title: '新增事件',
        date: { display: '2030', start: '2030', end: '2030', precision: 'exact' },
        placeId: 'place-new', participantIds: ['person-new'], sourceIds: ['source-new'], notes: '',
      }
      await repository.saveRelationship(relationship)
      await repository.saveEvent(event)

      const citation: Citation = {
        id: 'citation-new', projectId, sourceId: 'source-new', targetType: 'event',
        targetId: 'event-new', notes: '',
      }
      const attachment: Attachment = {
        id: 'attachment-new', projectId, name: 'new.pdf', mimeType: 'application/pdf',
        size: 42, contentHash: 'sha256:new', missing: false,
      }
      await repository.saveCitation(citation)
      await repository.saveAttachment(attachment)
      const link: AttachmentLink = {
        id: 'link-new', projectId, attachmentId: 'attachment-new', targetType: 'citation',
        targetId: 'citation-new',
      }
      await repository.saveAttachmentLink(link)

      expect((await repository.listPeople(projectId, defaultQuery)).items.some(({ id }) => id === person.id)).toBe(true)
      expect((await repository.listPlaces(projectId)).at(-1)).toEqual(place)
      expect((await repository.listSources(projectId)).at(-1)).toEqual(source)
      expect((await repository.listRelationships(projectId)).at(-1)).toEqual(relationship)
      expect(await repository.getRelationship(projectId, relationship.id)).toEqual(relationship)
      expect((await repository.listEvents(projectId)).at(-1)).toEqual(event)
      expect((await repository.listCitations(projectId)).at(-1)).toEqual(citation)
      expect((await repository.listAttachments(projectId)).at(-1)).toEqual(attachment)
      expect((await repository.listAttachmentLinks(projectId)).at(-1)).toEqual(link)

      const changed = { ...source, title: '更新后的来源' }
      await repository.saveSource(changed)
      const sources = await repository.listSources(projectId)
      expect(sources.filter(({ id }) => id === source.id)).toEqual([changed])
    })

    it('persists writes across repository instances', async () => {
      const { repository, reopen } = makeContext()
      const created = await repository.createProject({ name: '持久项目', description: '' })

      expect((await reopen().getProject(created.id)).name).toBe('持久项目')
    })

    it('sorts projects by newest update and uses id as a stable tie breaker', async () => {
      const { repository } = makeContext()
      await repository.createProject({ name: 'first generated', description: '' })
      await repository.createProject({ name: 'second generated', description: '' })

      expect((await repository.listProjects()).map(({ id }) => id)).toEqual([
        'generated-1',
        'generated-2',
        'project-demo-family',
      ])
    })

    it('searches names, notes, places and related events case-insensitively', async () => {
      const { repository } = makeContext()
      const projectId = 'project-demo-family'
      const linHai = await repository.getPerson('person-lin-hai')
      await repository.savePerson({
        ...linHai,
        biography: `${linHai.biography} Mechanical designer.`,
        names: [
          ...linHai.names,
          { value: '静川', type: 'courtesy', primary: false },
        ],
      })
      await repository.saveEvent({
        id: 'event-search-custom-type',
        projectId,
        type: '乡试中式',
        title: '需要查找的记录',
        date: { display: '日期未知', precision: 'unknown' },
        participantIds: ['person-lin-hai'],
        participantRoles: { 'person-lin-hai': '主考官' },
        sourceIds: [],
        notes: '',
      })

      expect((await repository.listPeople(projectId, { ...defaultQuery, search: '海叔' })).items.map(({ id }) => id))
        .toContain('person-lin-hai')
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: '字' })).items.map(({ id }) => id))
        .toContain('person-lin-hai')
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: 'MECHANICAL' })).items.map(({ id }) => id))
        .toContain('person-lin-hai')
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: '泉州市' })).items.map(({ id }) => id))
        .toContain('person-lin-hai')
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: '具体登记日期待补' })).items.map(({ id }) => id))
        .toEqual(expect.arrayContaining(['person-lin-hai', 'person-chen-fang']))
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: '乡试中式' })).items.map(({ id }) => id))
        .toContain('person-lin-hai')
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: '主考官' })).items.map(({ id }) => id))
        .toContain('person-lin-hai')
      expect((await repository.listPeople(projectId, { ...defaultQuery, search: 'MECHANICAL' })).items.map(({ id }) => id))
        .toEqual(['person-lin-hai'])
    })

    it('implements all person filters, stable sorts and one-based pagination', async () => {
      const { repository } = makeContext()
      const projectId = 'project-demo-family'
      const demo = createDemoState()
      await repository.savePerson({ ...demo.people[0]!, avatarUrl: '/avatar.jpg' })

      expect((await repository.listPeople(projectId, { ...defaultQuery, status: 'unknown' })).items.every(({ status }) => status === 'unknown')).toBe(true)
      expect((await repository.listPeople(projectId, { ...defaultQuery, sex: 'nonbinary' })).items.map(({ id }) => id)).toEqual(['person-lin-yu'])
      expect((await repository.listPeople(projectId, { ...defaultQuery, hasAvatar: true })).items.map(({ id }) => id)).toContain(demo.people[0]!.id)
      expect((await repository.listPeople(projectId, { ...defaultQuery, hasAvatar: false })).items.some(({ avatarUrl }) => Boolean(avatarUrl))).toBe(false)
      expect((await repository.listPeople(projectId, { ...defaultQuery, hasSources: false })).items.map(({ id }) => id)).toContain('person-lin-chen-candidate')
      expect((await repository.listPeople(projectId, { ...defaultQuery, hasBirth: true })).items.every(({ birth }) => Boolean(birth))).toBe(true)
      expect((await repository.listPeople(projectId, { ...defaultQuery, hasDeath: true })).items.every(({ death }) => Boolean(death))).toBe(true)
      expect((await repository.listPeople(projectId, { ...defaultQuery, hasIssues: true })).items.map(({ id }) => id)).toContain('person-lin-chen-candidate')

      const byUpdated = await repository.listPeople(projectId, { ...defaultQuery, sort: 'updatedAt' })
      expect(byUpdated.items[0]!.updatedAt >= byUpdated.items[1]!.updatedAt).toBe(true)
      const byBirth = await repository.listPeople(projectId, { ...defaultQuery, sort: 'birth' })
      expect(byBirth.items.at(-1)!.birth?.precision).toBe('unknown')
      const page = await repository.listPeople(projectId, { ...defaultQuery, page: 2, pageSize: 5 })
      expect(page).toMatchObject({ total: 12, page: 2, pageSize: 5 })
      expect(page.items).toHaveLength(5)

      for (const query of [
        { ...defaultQuery, page: 0 },
        { ...defaultQuery, page: 1.5 },
        { ...defaultQuery, pageSize: -1 },
      ]) {
        await expect(repository.listPeople(projectId, query))
          .rejects.toSatisfy((error) => expectCode(error, 'validation'))
      }
    })

    it('soft deletes people from queries while preserving records for recovery', async () => {
      const { repository } = makeContext()

      await repository.softDeletePerson('person-lin-hai')
      expect((await repository.getPerson('person-lin-hai')).deletedAt).toBe('2030-01-02T03:04:05.000Z')
      expect((await repository.listPeople('project-demo-family', { ...defaultQuery, search: '海叔' })).items).toEqual([])
    })

    it('rejects structural relationship errors but allows warnings', async () => {
      const { repository } = makeContext()
      const demo = createDemoState()
      const selfParent: Relationship = {
        ...demo.relationships[0]!,
        id: 'relationship-self',
        fromPersonId: 'person-lin-hai',
        toPersonId: 'person-lin-hai',
      }
      await expect(repository.saveRelationship(selfParent))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))

      const duplicate: Relationship = { ...demo.relationships[0]!, id: 'relationship-duplicate' }
      await expect(repository.saveRelationship(duplicate)).resolves.toEqual(duplicate)
    })

    it('persists participant roles only for people attached to the event', async () => {
      const { repository, reopen } = makeContext()
      const source = createDemoState().events[0]!
      const saved = await repository.saveEvent({
        ...source,
        id: 'event-with-participant-roles',
        participantIds: ['person-lin-hai', 'person-lin-hai', 'person-chen-fang'],
        participantRoles: {
          'person-lin-hai': ' 讲述者 ',
          'person-chen-fang': '记录者',
          'person-not-attached': '旁观者',
        },
      })

      expect(saved.participantIds).toEqual(['person-lin-hai', 'person-chen-fang'])
      expect(saved.participantRoles).toEqual({
        'person-lin-hai': '讲述者',
        'person-chen-fang': '记录者',
      })
      expect((await reopen().listEvents(saved.projectId)).find(({ id }) => id === saved.id))
        .toEqual(saved)
    })

    it('deletes relationships, events, citations and unused places without leaving dangling links', async () => {
      const { repository } = makeContext()
      const demo = createDemoState()
      const projectId = 'project-demo-family'
      const sourceId = demo.sources[0]!.id
      const attachmentId = demo.attachments[0]!.id
      const relationshipId = demo.relationships[0]!.id
      const eventId = demo.events[0]!.id

      await repository.saveCitation({
        id: 'citation-delete-relationship',
        projectId,
        sourceId,
        targetType: 'relationship',
        targetId: relationshipId,
        notes: '',
      })
      await repository.saveAttachmentLink({
        id: 'link-delete-relationship-citation',
        projectId,
        attachmentId,
        targetType: 'citation',
        targetId: 'citation-delete-relationship',
      })
      await repository.deleteRelationship(relationshipId)
      expect((await repository.listRelationships(projectId)).some(({ id }) => id === relationshipId)).toBe(false)
      expect((await repository.listCitations(projectId)).some(({ id }) => id === 'citation-delete-relationship')).toBe(false)
      expect((await repository.listAttachmentLinks(projectId))
        .some(({ targetId }) => targetId === 'citation-delete-relationship')).toBe(false)

      await repository.saveCitation({
        id: 'citation-delete-event',
        projectId,
        sourceId,
        targetType: 'event',
        targetId: eventId,
        notes: '',
      })
      await repository.deleteEvent(eventId)
      expect((await repository.listEvents(projectId)).some(({ id }) => id === eventId)).toBe(false)
      expect((await repository.listCitations(projectId)).some(({ id }) => id === 'citation-delete-event')).toBe(false)

      await repository.saveCitation({
        id: 'citation-delete-directly',
        projectId,
        sourceId,
        targetType: 'person',
        targetId: demo.people[0]!.id,
        notes: '',
      })
      await repository.saveAttachmentLink({
        id: 'link-delete-direct-citation',
        projectId,
        attachmentId,
        targetType: 'citation',
        targetId: 'citation-delete-directly',
      })
      await repository.deleteCitation('citation-delete-directly')
      expect((await repository.listCitations(projectId)).some(({ id }) => id === 'citation-delete-directly')).toBe(false)
      expect((await repository.listAttachmentLinks(projectId))
        .some(({ targetId }) => targetId === 'citation-delete-directly')).toBe(false)

      const place: Place = {
        id: 'place-unused',
        projectId,
        name: '待删除地点',
        aliases: [],
        notes: '',
      }
      await repository.savePlace(place)
      await repository.deletePlace(place.id)
      expect((await repository.listPlaces(projectId)).some(({ id }) => id === place.id)).toBe(false)
      await expect(repository.deletePlace(demo.places[0]!.id))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))
    })

    it('rejects cross-project id takeovers and invalid typed foreign keys', async () => {
      const { repository } = makeContext()
      const demo = createDemoState()
      const other = await repository.createProject({ name: '其他项目', description: '' })

      await expect(repository.savePerson({ ...demo.people[0]!, projectId: other.id }))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.savePlace({ ...demo.places[0]!, id: 'place-self', parentId: 'place-self' }))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.savePlace({ ...demo.places[0]!, id: 'place-orphan', parentId: 'missing-place' }))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.saveCitation({
        ...demo.citations[0]!, id: 'citation-bad-source', sourceId: 'missing-source',
      })).rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.saveCitation({
        ...demo.citations[0]!, id: 'citation-bad-target', targetId: 'missing-person',
      })).rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.saveAttachmentLink({
        ...demo.attachmentLinks[0]!, id: 'link-bad-attachment', attachmentId: 'missing-attachment',
      })).rejects.toSatisfy((error) => expectCode(error, 'validation'))
      await expect(repository.saveAttachmentLink({
        ...demo.attachmentLinks[0]!, id: 'link-bad-target', targetType: 'event', targetId: 'person-lin-hai',
      })).rejects.toSatisfy((error) => expectCode(error, 'validation'))
    })

    it('summarizes active project records and attachment bytes', async () => {
      const { repository } = makeContext()
      await repository.softDeletePerson('person-lin-hai')

      expect(await repository.getProjectSummary('project-demo-family')).toMatchObject({
        people: 11,
        relationships: 13,
        events: 8,
        sources: 5,
        attachments: 4,
        attachmentBytes: 9413120,
        updatedAt: '2026-06-18T09:30:00.000Z',
        lastBackupAt: '2026-06-18T09:00:00.000Z',
      })
    })

    it('inspects known, life-date, missing-attachment and unused-source issues without duplicates', async () => {
      const { repository } = makeContext()
      const demo = createDemoState()
      await repository.savePerson({
        ...demo.people[0]!,
        id: 'person-invalid-dates',
        names: [{ value: '日期错误', type: 'personal', primary: true }],
        birth: { display: '2000', start: '2000', end: '2000', precision: 'exact' },
        death: { display: '1990', start: '1990', end: '1990', precision: 'exact' },
      })

      const issues = await repository.inspectProject('project-demo-family')
      expect(issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
        'missing-attachment', 'unused-source', 'death-before-birth', 'possible-duplicate',
      ]))
      expect(new Set(issues.map(({ id }) => id)).size).toBe(issues.length)
    })

    it('creates restorable snapshots and makes restored state visible to new instances', async () => {
      const { repository, reopen } = makeContext()
      await repository.updateProject('project-demo-family', { name: '快照状态' })
      const snapshot = await repository.createSnapshot('project-demo-family', 'manual', '  保存点  ')
      expect(snapshot).toMatchObject({
        id: 'generated-1',
        createdAt: '2030-01-02T03:04:05.000Z',
        note: '保存点',
        summary: { people: 12, relationships: 13, events: 8 },
      })

      await repository.updateProject('project-demo-family', { name: '快照之后' })
      await repository.restoreSnapshot(snapshot.id)
      expect((await repository.getProject('project-demo-family')).name).toBe('快照状态')
      expect((await reopen().getProject('project-demo-family')).name).toBe('快照状态')
    })

    it('restores only the snapshot project and leaves every other project unchanged', async () => {
      const { repository } = makeContext()
      const other = await repository.createProject({ name: '其他项目初始', description: '' })
      await repository.updateProject('project-demo-family', { name: '目标快照状态' })
      const snapshot = await repository.createSnapshot('project-demo-family', 'manual', 'project scoped')

      await repository.updateProject('project-demo-family', { name: '目标后续状态' })
      await repository.updateProject(other.id, { name: '其他项目后续状态' })
      await repository.restoreSnapshot(snapshot.id)

      expect((await repository.getProject('project-demo-family')).name).toBe('目标快照状态')
      expect((await repository.getProject(other.id)).name).toBe('其他项目后续状态')
    })

    it('restores fixed demo snapshots and reset returns the exact fixture', async () => {
      const { repository } = makeContext()
      await repository.updateProject('project-demo-family', { name: 'changed' })
      await repository.restoreSnapshot('snapshot-import')
      expect(await repository.getProject('project-demo-family')).toEqual(createDemoState().projects[0])
      expect((await repository.listPeople('project-demo-family', defaultQuery)).total).toBe(10)
      expect(await repository.listRelationships('project-demo-family')).toHaveLength(10)
      expect(await repository.listEvents('project-demo-family')).toHaveLength(6)
      await expect(repository.getPerson('person-xu-an'))
        .rejects.toSatisfy((error) => expectCode(error, 'not-found'))

      await repository.restoreSnapshot('snapshot-merge')
      expect((await repository.listPeople('project-demo-family', defaultQuery)).total).toBe(11)
      expect(await repository.listRelationships('project-demo-family')).toHaveLength(12)
      expect(await repository.listEvents('project-demo-family')).toHaveLength(7)
      expect((await repository.getPerson('person-xu-an')).id).toBe('person-xu-an')

      await repository.restoreSnapshot('snapshot-manual')
      expect((await repository.listPeople('project-demo-family', defaultQuery)).total).toBe(12)
      expect(await repository.listRelationships('project-demo-family')).toHaveLength(13)
      expect(await repository.listEvents('project-demo-family')).toHaveLength(8)

      await repository.createProject({ name: 'extra', description: '' })
      await repository.resetDemo()
      expect(await repository.listProjects()).toEqual(createDemoState().projects)
      expect(await repository.listSnapshots('project-demo-family')).toEqual(createDemoState().snapshots)
      await expect(repository.restoreSnapshot('missing-snapshot'))
        .rejects.toSatisfy((error) => expectCode(error, 'not-found'))
    })

    it('supports bounded instance-local undo and redo with redo invalidation', async () => {
      const { repository, reopen } = makeContext()
      expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })

      await repository.updateProject('project-demo-family', { name: 'first' })
      expect(repository.getHistoryState()).toEqual({ canUndo: true, canRedo: false })
      await repository.undo()
      expect((await repository.getProject('project-demo-family')).name).toBe('林家四代家庭档案')
      expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: true })
      await repository.redo()
      expect((await repository.getProject('project-demo-family')).name).toBe('first')

      await repository.undo()
      await repository.updateProject('project-demo-family', { name: 'replacement' })
      expect(repository.getHistoryState()).toEqual({ canUndo: true, canRedo: false })
      await expect(repository.redo()).rejects.toSatisfy((error) => expectCode(error, 'not-found'))
      expect(reopen().getHistoryState()).toEqual({ canUndo: false, canRedo: false })
    })

    it('persists searchable modern and ancient careers with protected organization hierarchy', async () => {
      const { repository, reopen } = makeContext()
      const projectId = 'project-demo-family'
      const organization: Organization = {
        id: 'organization-song-court',
        projectId,
        name: '北宋朝廷',
        type: 'imperial_court',
        aliases: ['宋廷'],
        notes: '',
        sourceIds: ['source-local-gazetteer'],
      }
      const career: CareerRecord = {
        id: 'career-hangzhou-tongpan',
        projectId,
        personId: 'person-lin-hai',
        category: 'civil_office',
        organizationId: organization.id,
        positionTitle: '杭州通判',
        regime: '北宋',
        rankOrGrade: '从六品',
        appointmentType: '任职',
        jurisdictionPlaceId: 'place-quanzhou',
        start: { display: '熙宁四年', start: '1071', end: '1071', precision: 'exact' },
        end: { display: '熙宁七年', start: '1074', end: '1074', precision: 'exact' },
        status: 'former',
        description: '',
        notes: '',
        sourceIds: ['source-local-gazetteer'],
      }

      const saved = await repository.saveOrganizationWithCareer(organization, career)
      expect(saved).toEqual({ organization, career })
      expect(await repository.listCareers(projectId, career.personId)).toContainEqual(career)
      expect((await repository.listPeople(projectId, {
        ...defaultQuery,
        search: '宋廷',
      })).items.map(({ id }) => id)).toContain(career.personId)
      expect((await repository.listPeople(projectId, {
        ...defaultQuery,
        search: '杭州通判',
      })).items.map(({ id }) => id)).toContain(career.personId)
      await expect(repository.deleteOrganization(organization.id))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))

      const reopened = reopen()
      expect(await reopened.listOrganizations(projectId)).toContainEqual(organization)
      expect(await reopened.listCareers(projectId, career.personId)).toContainEqual(career)

      await reopened.saveCitation({
        id: 'citation-career',
        projectId,
        sourceId: 'source-local-gazetteer',
        targetType: 'career',
        targetId: career.id,
        notes: '',
      })
      await reopened.saveAttachmentLink({
        id: 'attachment-link-career',
        projectId,
        attachmentId: createDemoState().attachments[0]!.id,
        targetType: 'career',
        targetId: career.id,
      })
      await reopened.deleteCareer(career.id)
      expect(await reopened.listCitations(projectId)).not.toContainEqual(
        expect.objectContaining({ id: 'citation-career' }),
      )
      expect(await reopened.listAttachmentLinks(projectId)).not.toContainEqual(
        expect.objectContaining({ id: 'attachment-link-career' }),
      )
      await expect(reopened.deleteOrganization(organization.id)).resolves.toBeUndefined()
    })

    it('rejects invalid current careers and cyclic organization parents', async () => {
      const { repository } = makeContext()
      const projectId = 'project-demo-family'
      const first: Organization = {
        id: 'organization-first',
        projectId,
        name: '第一机构',
        type: 'company',
        aliases: [],
        notes: '',
        sourceIds: [],
      }
      const second: Organization = {
        ...first,
        id: 'organization-second',
        name: '第二机构',
        parentId: first.id,
      }
      await repository.saveOrganization(first)
      await repository.saveOrganization(second)
      await expect(repository.saveOrganization({ ...first, parentId: second.id }))
        .rejects.toSatisfy((error) => expectCode(error, 'validation'))

      await expect(repository.saveCareer({
        id: 'career-invalid-current',
        projectId,
        personId: 'person-lin-hai',
        category: 'employment',
        positionTitle: '工程师',
        status: 'current',
        end: { display: '2024', start: '2024', end: '2024', precision: 'exact' },
        description: '',
        notes: '',
        sourceIds: [],
      })).rejects.toSatisfy((error) => expectCode(error, 'validation'))
    })

    it('keeps conferred titles separate from names and careers through the repository boundary', async () => {
      const { repository, reopen } = makeContext()
      const title = {
        id: 'person-title-duke',
        projectId: 'project-demo-family',
        personId: 'person-lin-hai',
        type: 'nobility' as const,
        value: '东坡郡公',
        start: { display: '元丰年间', precision: 'unknown' as const },
        placeId: 'place-quanzhou',
        grantedByPersonId: 'person-lin-guoqiang',
        notes: '用于验证身份称号模型边界。',
        sourceIds: ['source-local-gazetteer'],
      }

      await expect(repository.savePersonTitle(title)).resolves.toEqual(title)
      expect(await repository.listPersonTitles(title.projectId, title.personId)).toEqual([title])
      expect((await repository.getPerson(title.personId)).names.map(({ value }) => value))
        .not.toContain(title.value)
      expect((await repository.listCareers(title.projectId, title.personId))
        .map(({ positionTitle }) => positionTitle)).not.toContain(title.value)
      expect(await reopen().listPersonTitles(title.projectId, title.personId)).toEqual([title])
      await repository.deletePersonTitle(title.id)
      expect(await repository.listPersonTitles(title.projectId, title.personId)).toEqual([])

      await expect(repository.savePersonTitle({
        ...title,
        id: 'person-title-custom-invalid',
        type: 'custom',
        customTypeLabel: ' ',
      })).rejects.toSatisfy((error) => expectCode(error, 'validation'))
    })

    it('includes organizations, careers, and conferred titles in source deletion impact and cleanup', async () => {
      const { repository } = makeContext()
      const projectId = 'project-demo-family'
      const sourceId = 'source-local-gazetteer'
      const organization: Organization = {
        id: 'organization-source-impact',
        projectId,
        name: '来源影响机构',
        type: 'government',
        aliases: [],
        notes: '',
        sourceIds: [sourceId],
      }
      const career: CareerRecord = {
        id: 'career-source-impact',
        projectId,
        personId: 'person-lin-hai',
        category: 'civil_office',
        organizationId: organization.id,
        positionTitle: '来源影响官职',
        status: 'former',
        description: '',
        notes: '',
        sourceIds: [sourceId],
      }
      await repository.saveOrganization(organization)
      await repository.saveCareer(career)
      await repository.savePersonTitle({
        id: 'title-source-impact',
        projectId,
        personId: 'person-lin-hai',
        type: 'conferred-title',
        value: '来源影响封号',
        notes: '',
        sourceIds: [sourceId],
      })

      expect(await repository.getSourceDeletionImpact(sourceId)).toMatchObject({
        organizations: 1,
        careers: 1,
        personTitles: 1,
      })
      await repository.deleteSource(sourceId)

      expect(await repository.listOrganizations(projectId)).toContainEqual({
        ...organization,
        sourceIds: [],
      })
      expect(await repository.listCareers(projectId, 'person-lin-hai')).toContainEqual({
        ...career,
        sourceIds: [],
      })
      expect(await repository.listPersonTitles(projectId, 'person-lin-hai')).toContainEqual({
        id: 'title-source-impact',
        projectId,
        personId: 'person-lin-hai',
        type: 'conferred-title',
        value: '来源影响封号',
        notes: '',
        sourceIds: [],
      })
    })

    it('bounds ordinary history to the latest one hundred writes', async () => {
      const { repository } = makeContext()
      for (let index = 1; index <= 101; index += 1) {
        await repository.updateProject('project-demo-family', { name: `version-${index}` })
      }
      for (let index = 0; index < 100; index += 1) await repository.undo()

      expect((await repository.getProject('project-demo-family')).name).toBe('version-1')
      await expect(repository.undo()).rejects.toSatisfy((error) => expectCode(error, 'not-found'))
    })
  })
}

repositoryContract('browser prototype', () => {
  const storage = new MemoryStorage()
  let nextId = 0
  const makeRepository = () => new BrowserPrototypeRepository({
    storage,
    clock: () => new Date('2030-01-02T03:04:05.000Z'),
    idFactory: () => `generated-${++nextId}`,
  })
  return { repository: makeRepository(), storage, reopen: makeRepository }
})
