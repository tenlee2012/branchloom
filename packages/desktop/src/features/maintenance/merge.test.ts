import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../app/stores/session'
import type {
  AttachmentLink,
  BranchloomRepository,
  Citation,
  FamilyEvent,
  Person,
  Relationship,
} from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import * as relationshipsDomain from '../../shared/domain/relationships'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import {
  PROTOTYPE_STORAGE_KEY,
  SNAPSHOT_PAYLOADS_STORAGE_KEY,
  type PrototypeStorage,
} from '../../shared/repository/storage'
import DuplicateCandidates from './components/DuplicateCandidates.vue'
import MergeWizard from './components/MergeWizard.vue'
import { createPersonMergePreview } from './model/mergePeople'

const PROJECT_ID = 'project-demo-family'
const mountedWrappers: Array<{ unmount(): void }> = []

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()
  failSetWhen?: (key: string) => unknown
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) {
    const failure = this.failSetWhen?.(key)
    if (failure) throw failure
    this.values.set(key, value)
  }
}

function makeRepository(storage = new MemoryStorage()) {
  let id = 0
  return {
    storage,
    repository: new BrowserPrototypeRepository({
      storage,
      clock: () => new Date('2037-08-09T10:11:12.000Z'),
      idFactory: () => `merge-id-${++id}`,
    }),
  }
}

function person(id: string, name: string, patch: Partial<Person> = {}): Person {
  return {
    id,
    projectId: PROJECT_ID,
    names: [{ value: name, type: 'personal', primary: true }],
    sex: 'female',
    status: 'living',
    birth: { display: '1988-04-12', start: '1988-04-12', end: '1988-04-12', precision: 'exact' },
    death: { display: '未知', precision: 'unknown' },
    biography: '',
    notes: '',
    sourceIds: ['source-family-register'],
    updatedAt: '2030-01-01T00:00:00.000Z',
    ...patch,
  }
}

function relationship(
  id: string,
  fromPersonId: string,
  toPersonId: string,
  category: 'parent' | 'partner' = 'parent',
): Relationship {
  return category === 'parent'
    ? { id, projectId: PROJECT_ID, category, type: 'biological', fromPersonId, toPersonId, notes: '', sourceIds: [] }
    : { id, projectId: PROJECT_ID, category, type: 'married', fromPersonId, toPersonId, notes: '', sourceIds: [] }
}

function proxyRepository(
  repository: BranchloomRepository,
  overrides: Partial<BranchloomRepository>,
): BranchloomRepository {
  return new Proxy(repository, {
    get(target, property) {
      const override = overrides[property as keyof BranchloomRepository]
      if (override) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function projectContext(repository: BranchloomRepository) {
  const [peoplePage, relationships, events, citations, attachmentLinks, attachments, places, sources] = await Promise.all([
    repository.listPeople(PROJECT_ID, { page: 1, pageSize: 100, sort: 'name' }),
    repository.listRelationships(PROJECT_ID),
    repository.listEvents(PROJECT_ID),
    repository.listCitations(PROJECT_ID),
    repository.listAttachmentLinks(PROJECT_ID),
    repository.listAttachments(PROJECT_ID),
    repository.listPlaces(PROJECT_ID),
    repository.listSources(PROJECT_ID),
  ])
  return { people: peoplePage.items, relationships, events, citations, attachmentLinks, attachments, places, sources }
}

async function mountWizard(repository: BranchloomRepository, keepPersonId: string, removePersonId: string) {
  const context = await projectContext(repository)
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.openProject(await repository.getProject(PROJECT_ID))
  const wrapper = mount(MergeWizard, {
    attachTo: document.body,
    props: { open: true, keepPersonId, removePersonId, ...context },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await flushPromises()
  return { wrapper, context, session }
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('pure person merge preview', () => {
  it('preserves names and sources, applies per-field choices, rewires every reference and removes self/duplicate edges', () => {
    const keep = person('keep', '林晨', { sex: 'female', notes: '保留备注', sourceIds: ['source-family-register'] })
    const remove = person('remove', '林辰', {
      names: [
        { value: '林辰', type: 'personal', primary: true },
        { value: '晨晨', type: 'alias', primary: false },
      ],
      sex: 'nonbinary', notes: '合并备注', sourceIds: ['source-oral-history'],
    })
    const other = person('other', '其他人')
    const relationships = [
      relationship('self-after-merge', 'keep', 'remove', 'partner'),
      relationship('duplicate-a', 'keep', 'other'),
      relationship('duplicate-b', 'remove', 'other'),
      relationship('rewire-parent', 'other', 'remove'),
    ]
    const events: FamilyEvent[] = [{
      id: 'event', projectId: PROJECT_ID, type: 'custom', title: '同场事件',
      date: { display: '2000', start: '2000', end: '2000', precision: 'exact' },
      participantIds: ['keep', 'remove', 'other'], sourceIds: [], notes: '',
    }]
    const citations: Citation[] = [
      { id: 'citation', projectId: PROJECT_ID, sourceId: 'source-family-register', targetType: 'person', targetId: 'remove', notes: '' },
      { id: 'citation-duplicate-relationship', projectId: PROJECT_ID, sourceId: 'source-family-register', targetType: 'relationship', targetId: 'duplicate-b', notes: '' },
      { id: 'citation-self-relationship', projectId: PROJECT_ID, sourceId: 'source-family-register', targetType: 'relationship', targetId: 'self-after-merge', notes: '' },
    ]
    const attachmentLinks: AttachmentLink[] = [
      { id: 'link', projectId: PROJECT_ID, attachmentId: 'attachment-reunion-photo', targetType: 'person', targetId: 'remove' },
      { id: 'link-duplicate-relationship', projectId: PROJECT_ID, attachmentId: 'attachment-register-scan', targetType: 'relationship', targetId: 'duplicate-b' },
      { id: 'link-self-relationship', projectId: PROJECT_ID, attachmentId: 'attachment-interview-audio', targetType: 'relationship', targetId: 'self-after-merge' },
    ]
    const input = { keepPersonId: 'keep', removePersonId: 'remove', choices: { sex: 'remove' as const, notes: 'remove' as const } }
    const context = {
      people: [keep, remove, other], relationships, events, citations, attachmentLinks,
      issues: [
        { id: 'stale-remove-issue', severity: 'warning' as const, code: 'old', message: '旧记录问题', targetType: 'person' as const, targetId: 'remove' },
        { id: 'keep-issue', severity: 'info' as const, code: 'keep', message: '保留记录问题', targetType: 'person' as const, targetId: 'keep' },
        { id: 'rewired-relation-issue', severity: 'warning' as const, code: 'old-endpoint', message: '旧端点问题', targetType: 'relationship' as const, targetId: 'rewire-parent' },
        { id: 'collapsed-relation-issue', severity: 'warning' as const, code: 'old-duplicate', message: '旧重复问题', targetType: 'relationship' as const, targetId: 'duplicate-b' },
      ],
    }
    const before = structuredClone(context)
    const preview = createPersonMergePreview(context, input)

    expect(context).toEqual(before)
    expect(preview.people.map(({ id }) => id)).toEqual(['keep', 'other'])
    expect(preview.retainedPerson).toMatchObject({ id: 'keep', sex: 'nonbinary', notes: '合并备注' })
    expect(preview.retainedPerson.names.map(({ value }) => value)).toEqual(['林晨', '林辰', '晨晨'])
    expect(preview.retainedPerson.sourceIds).toEqual(['source-family-register', 'source-oral-history'])
    expect(preview.relationships).toHaveLength(2)
    expect(preview.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'duplicate-a', fromPersonId: 'keep', toPersonId: 'other' }),
      expect.objectContaining({ id: 'rewire-parent', fromPersonId: 'other', toPersonId: 'keep' }),
    ]))
    expect(preview.events[0]?.participantIds).toEqual(['keep', 'other'])
    expect(preview.citations.map(({ targetType, targetId }) => [targetType, targetId])).toEqual([
      ['person', 'keep'], ['relationship', 'duplicate-a'], ['person', 'keep'],
    ])
    expect(preview.attachmentLinks.map(({ targetType, targetId }) => [targetType, targetId])).toEqual([
      ['person', 'keep'], ['relationship', 'duplicate-a'], ['person', 'keep'],
    ])
    expect(preview.issues).toEqual([expect.objectContaining({ id: 'keep-issue', targetId: 'keep' })])
    expect(preview.summary).toMatchObject({ removedPeople: 1, rewiredRelationships: 2, removedRelationships: 2, rewiredEvents: 1, rewiredCitations: 3, rewiredAttachmentLinks: 3 })
  })

  it('allows explicitly discarding names and sources while keeping at least one name', () => {
    const keep = person('keep', '林晨', { sourceIds: ['source-family-register'] })
    const remove = person('remove', '林辰', { sourceIds: ['source-oral-history'] })
    const preview = createPersonMergePreview(
      { people: [keep, remove], relationships: [], events: [], citations: [], attachmentLinks: [] },
      {
        keepPersonId: 'keep', removePersonId: 'remove',
        choices: { retainedNameValues: ['林辰'], retainedSourceIds: ['source-oral-history'] },
      },
    )
    expect(preview.retainedPerson.names.map(({ value }) => value)).toEqual(['林辰'])
    expect(preview.retainedPerson.sourceIds).toEqual(['source-oral-history'])
  })

  it('automatically preserves a unique remove-side single value without overriding a real conflict', () => {
    const keep = person('keep', '林晨', {
      avatarUrl: undefined, death: undefined, deathPlaceId: undefined, notes: '', biography: '保留简介',
    })
    const remove = person('remove', '林辰', {
      avatarUrl: '/remove.jpg', death: { display: '2050', start: '2050', end: '2050', precision: 'exact' },
      deathPlaceId: 'place-shanghai', notes: '唯一备注', biography: '冲突简介',
    })
    const preview = createPersonMergePreview(
      { people: [keep, remove], relationships: [], events: [], citations: [], attachmentLinks: [] },
      { keepPersonId: 'keep', removePersonId: 'remove', choices: { biography: 'keep' } },
    )
    expect(preview.retainedPerson).toMatchObject({
      avatarUrl: '/remove.jpg', death: remove.death, deathPlaceId: 'place-shanghai',
      notes: '唯一备注', biography: '保留简介',
    })
  })

  it('requires an explicit keep/remove choice for every true single-value conflict', () => {
    const keep = person('keep', '林晨', { biography: '保留侧简介' })
    const remove = person('remove', '林辰', { biography: '合并侧简介' })
    const context = { people: [keep, remove], relationships: [], events: [], citations: [], attachmentLinks: [] }
    expect(() => createPersonMergePreview(context, {
      keepPersonId: 'keep', removePersonId: 'remove', choices: { biography: 'auto' },
    })).toThrow('Person merge requires an explicit choice for conflicting field: biography')
    expect(() => createPersonMergePreview(context, {
      keepPersonId: 'keep', removePersonId: 'remove', choices: {},
    })).toThrow('Person merge requires an explicit choice for conflicting field: biography')
  })

  it('supports explicit discard of relationships, events, citations and attachment associations', () => {
    const keep = person('keep', '林晨')
    const remove = person('remove', '林辰')
    const other = person('other', '他人')
    const context = {
      people: [keep, remove, other],
      relationships: [relationship('relation-remove', 'remove', 'other')],
      events: [{
        id: 'event-remove', projectId: PROJECT_ID, type: 'custom', title: '待舍弃关联',
        date: { display: '2000', start: '2000', end: '2000', precision: 'exact' as const },
        participantIds: ['remove', 'other'], sourceIds: [], notes: '',
      }],
      citations: [{
        id: 'citation-remove', projectId: PROJECT_ID, sourceId: 'source-family-register',
        targetType: 'person' as const, targetId: 'remove', notes: '',
      }],
      attachmentLinks: [
        { id: 'link-remove', projectId: PROJECT_ID, attachmentId: 'attachment-reunion-photo', targetType: 'person' as const, targetId: 'remove' },
        { id: 'link-citation', projectId: PROJECT_ID, attachmentId: 'attachment-register-scan', targetType: 'citation' as const, targetId: 'citation-remove' },
      ],
    }
    const preview = createPersonMergePreview(context, {
      keepPersonId: 'keep', removePersonId: 'remove',
      choices: {
        retainedRelationshipIds: [], retainedEventIds: [], retainedCitationIds: [], retainedAttachmentLinkIds: [],
      },
    })
    expect(preview.relationships).toEqual([])
    expect(preview.events[0]?.participantIds).toEqual(['other'])
    expect(preview.citations).toEqual([])
    expect(preview.attachmentLinks).toEqual([])
    expect(preview.summary.removedRelationships).toBe(1)
  })

  it('maps evidence from an explicitly discarded duplicate relationship to its retained equivalent', () => {
    const keep = person('keep', '林晨')
    const remove = person('remove', '林辰')
    const other = person('other', '他人')
    const relationships = [
      relationship('relation-kept', 'keep', 'other'),
      relationship('relation-discarded-duplicate', 'remove', 'other'),
    ]
    const citations: Citation[] = [{
      id: 'citation-relationship', projectId: PROJECT_ID, sourceId: 'source-family-register',
      targetType: 'relationship', targetId: 'relation-discarded-duplicate', notes: '',
    }]
    const attachmentLinks: AttachmentLink[] = [{
      id: 'link-relationship', projectId: PROJECT_ID, attachmentId: 'attachment-register-scan',
      targetType: 'relationship', targetId: 'relation-discarded-duplicate',
    }]
    const preview = createPersonMergePreview(
      { people: [keep, remove, other], relationships, events: [], citations, attachmentLinks },
      {
        keepPersonId: 'keep', removePersonId: 'remove',
        choices: {
          retainedRelationshipIds: ['relation-kept'],
          retainedCitationIds: ['citation-relationship'],
          retainedAttachmentLinkIds: ['link-relationship'],
        },
      },
    )
    expect(preview.citations).toEqual([expect.objectContaining({ targetType: 'relationship', targetId: 'relation-kept' })])
    expect(preview.attachmentLinks).toEqual([expect.objectContaining({ targetType: 'relationship', targetId: 'relation-kept' })])
  })

  it('cascades an explicitly discarded unique relationship to its citations and attachments', () => {
    const keep = person('keep', '林晨')
    const remove = person('remove', '林辰')
    const other = person('other', '他人')
    const preview = createPersonMergePreview({
      people: [keep, remove, other],
      relationships: [relationship('unique-relation', 'remove', 'other')], events: [],
      citations: [{
        id: 'unique-citation', projectId: PROJECT_ID, sourceId: 'source-family-register',
        targetType: 'relationship', targetId: 'unique-relation', notes: '',
      }],
      attachmentLinks: [
        { id: 'direct-link', projectId: PROJECT_ID, attachmentId: 'attachment-register-scan', targetType: 'relationship', targetId: 'unique-relation' },
        { id: 'citation-link', projectId: PROJECT_ID, attachmentId: 'attachment-reunion-photo', targetType: 'citation', targetId: 'unique-citation' },
      ],
    }, {
      keepPersonId: 'keep', removePersonId: 'remove',
      choices: {
        retainedRelationshipIds: [], retainedCitationIds: ['unique-citation'],
        retainedAttachmentLinkIds: ['direct-link', 'citation-link'],
      },
    })
    expect(preview.relationships).toEqual([])
    expect(preview.citations).toEqual([])
    expect(preview.attachmentLinks).toEqual([])
    expect(preview.summary.removedRelationships).toBe(1)
  })

  it('requires field choices and collapses conflicting relationship metadata without loss', () => {
    const keep = person('keep', '林晨')
    const remove = person('remove', '林辰')
    const other = person('other', '他人')
    const first = {
      ...relationship('relation-a', 'keep', 'other'),
      start: { display: '2000', start: '2000', end: '2000', precision: 'exact' as const },
      placeId: 'place-xiamen', notes: '第一份关系记录', sourceIds: ['source-family-register'],
    }
    const second = {
      ...relationship('relation-b', 'remove', 'other'),
      start: { display: '2010', start: '2010', end: '2010', precision: 'exact' as const },
      placeId: 'place-shanghai', notes: '第二份关系记录', sourceIds: ['source-oral-history'],
    }
    expect(() => createPersonMergePreview(
      { people: [keep, remove, other], relationships: [first, second], events: [], citations: [], attachmentLinks: [] },
      { keepPersonId: 'keep', removePersonId: 'remove', choices: {} },
    )).toThrow('Relationship merge requires explicit choices for relation-a / relation-b: start, placeId, notes')
    const preview = createPersonMergePreview(
      { people: [keep, remove, other], relationships: [first, second], events: [], citations: [], attachmentLinks: [] },
      {
        keepPersonId: 'keep', removePersonId: 'remove',
        choices: { relationshipConflictChoices: [{
          relationshipIds: ['relation-a', 'relation-b'],
          fields: { start: 'relation-b', placeId: 'relation-a', notes: 'relation-b' },
        }] },
      },
    )
    expect(preview.relationships).toHaveLength(1)
    expect(preview.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'relation-a', start: second.start, placeId: 'place-xiamen', notes: '第二份关系记录',
        sourceIds: ['source-family-register', 'source-oral-history'],
      }),
    ]))
  })

  it('detects an ancestor cycle from the complete graph even when duplicate warnings mask every edge', () => {
    const graph = [
      relationship('a-1', 'one', 'two'), relationship('a-2', 'one', 'two'),
      relationship('b-1', 'two', 'one'), relationship('b-2', 'two', 'one'),
    ]
    expect(graph.every((candidate) => relationshipsDomain.validateRelationship(candidate, graph)?.code === 'duplicate-relationship')).toBe(true)
    expect((relationshipsDomain as unknown as { hasAncestorCycle(items: Relationship[]): boolean }).hasAncestorCycle(graph)).toBe(true)
  })

  it('checks a very deep valid lineage without exhausting the JavaScript call stack', () => {
    const graph = Array.from({ length: 12_000 }, (_, index) =>
      relationship(`deep-${index}`, `person-${index}`, `person-${index + 1}`))

    expect(relationshipsDomain.hasAncestorCycle(graph)).toBe(false)
  })
})

describe('atomic repository merge', () => {
  it('rejects unresolved person conflicts without state, snapshot or history writes', async () => {
    const { repository, storage } = makeRepository()
    await repository.savePerson(person('conflict-copy', '林海副本'))
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    const beforeHistory = repository.getHistoryState()
    await expect(repository.mergePeople({ keepPersonId: 'person-lin-hai', removePersonId: 'conflict-copy', choices: {} }))
      .rejects.toThrow('Person merge requires an explicit choice for conflicting field: sex')
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect(repository.getHistoryState()).toEqual(beforeHistory)
  })

  it('rejects unresolved relationship metadata conflicts without writes', async () => {
    const { repository, storage } = makeRepository()
    await repository.savePerson(person('relation-keep', '甲'))
    await repository.savePerson(person('relation-remove', '甲副本'))
    await repository.savePerson(person('relation-other', '乙'))
    await repository.saveRelationship({ ...relationship('relation-left', 'relation-keep', 'relation-other'), notes: '左侧证据' })
    await repository.saveRelationship({ ...relationship('relation-right', 'relation-remove', 'relation-other'), notes: '右侧证据' })
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    await expect(repository.mergePeople({ keepPersonId: 'relation-keep', removePersonId: 'relation-remove', choices: {} }))
      .rejects.toThrow('Relationship merge requires explicit choices for relation-left / relation-right: notes')
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
  })
  it('rejects a merge-created ancestor cycle before any state, snapshot or history write', async () => {
    const { repository, storage } = makeRepository()
    await repository.savePerson(person('cycle-keep', '甲'))
    await repository.savePerson(person('cycle-remove', '甲副本'))
    await repository.savePerson(person('cycle-other', '乙'))
    await repository.saveRelationship(relationship('cycle-down', 'cycle-keep', 'cycle-other'))
    await repository.saveRelationship(relationship('cycle-up', 'cycle-other', 'cycle-remove'))
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    const beforeHistory = repository.getHistoryState()

    await expect(repository.mergePeople({ keepPersonId: 'cycle-keep', removePersonId: 'cycle-remove', choices: {} }))
      .rejects.toThrow(/祖先|cycle/i)
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect(repository.getHistoryState()).toEqual(beforeHistory)
  })

  it('removes persisted inspection issues that belonged to the removed record', async () => {
    const { repository, storage } = makeRepository()
    await repository.mergePeople({
      keepPersonId: 'person-lin-chen',
      removePersonId: 'person-lin-chen-candidate',
      choices: { birth: 'keep', biography: 'keep', notes: 'keep' },
    })

    const persisted = JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY)!)
    expect(persisted.issues.some(({ targetType, targetId }: { targetType: string; targetId: string }) =>
      targetType === 'person' && targetId === 'person-lin-chen-candidate')).toBe(false)
  })

  it('creates a restorable pre-merge snapshot, applies one undoable replacement and returns inspection summary', async () => {
    const { repository } = makeRepository()
    const duplicate = person('person-lin-hai-copy', '林海副本', {
      sex: 'unknown', sourceIds: ['source-family-website'], notes: '重复记录',
    })
    await repository.savePerson(duplicate)
    await repository.saveRelationship(relationship('relationship-copy-parent', 'person-lin-guoqiang', duplicate.id))
    await repository.saveEvent({
      id: 'event-copy', projectId: PROJECT_ID, type: 'custom', title: '副本事件',
      date: { display: '2020', start: '2020', end: '2020', precision: 'exact' },
      participantIds: [duplicate.id], sourceIds: [], notes: '',
    })
    await repository.saveCitation({
      id: 'citation-copy', projectId: PROJECT_ID, sourceId: 'source-family-register',
      targetType: 'person', targetId: duplicate.id, notes: '',
    })
    await repository.saveAttachmentLink({
      id: 'attachment-link-copy', projectId: PROJECT_ID, attachmentId: 'attachment-reunion-photo',
      targetType: 'person', targetId: duplicate.id,
    })
    const snapshotsBefore = await repository.listSnapshots(PROJECT_ID)

    const result = await repository.mergePeople({
      keepPersonId: 'person-lin-hai', removePersonId: duplicate.id,
      choices: { sex: 'keep', birth: 'keep', notes: 'remove' },
    })

    expect(result.snapshot).toMatchObject({ reason: 'merge', summary: expect.objectContaining({ people: 13 }) })
    expect(result.retainedPerson).toMatchObject({ id: 'person-lin-hai', notes: '重复记录' })
    expect(result.retainedPerson.updatedAt).toBe('2037-08-09T10:11:12.000Z')
    expect(result.issues).toEqual(await repository.inspectProject(PROJECT_ID))
    await expect(repository.getPerson(duplicate.id)).rejects.toThrow('not found')
    expect((await repository.listRelationships(PROJECT_ID)).some(({ fromPersonId, toPersonId }) =>
      fromPersonId === duplicate.id || toPersonId === duplicate.id)).toBe(false)
    expect((await repository.listEvents(PROJECT_ID)).find(({ id }) => id === 'event-copy')?.participantIds).toEqual(['person-lin-hai'])
    expect((await repository.listCitations(PROJECT_ID)).find(({ id }) => id === 'citation-copy')?.targetId).toBe('person-lin-hai')
    expect((await repository.listAttachmentLinks(PROJECT_ID)).find(({ id }) => id === 'attachment-link-copy')?.targetId).toBe('person-lin-hai')
    expect(await repository.listSnapshots(PROJECT_ID)).toHaveLength(snapshotsBefore.length + 1)
    expect(repository.getHistoryState()).toEqual({ canUndo: true, canRedo: false })

    await repository.restoreSnapshot(result.snapshot.id)
    expect((await repository.getPerson('person-lin-hai')).updatedAt).not.toBe('2037-08-09T10:11:12.000Z')
    expect((await repository.getPerson(duplicate.id)).id).toBe(duplicate.id)
    expect((await repository.listCitations(PROJECT_ID)).find(({ id }) => id === 'citation-copy')?.targetId).toBe(duplicate.id)
  })

  it('recomputes relationship inspection issues from the current graph', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('inspect-parent', '父'))
    await repository.savePerson(person('inspect-child', '子'))
    await repository.saveRelationship(relationship('inspect-duplicate-a', 'inspect-parent', 'inspect-child'))
    await repository.saveRelationship(relationship('inspect-duplicate-b', 'inspect-parent', 'inspect-child'))
    expect(await repository.inspectProject(PROJECT_ID)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate-relationship', targetType: 'relationship' }),
    ]))
  })

  it('rolls back state, snapshot sidecar and history when the atomic main-state write fails', async () => {
    const { repository, storage } = makeRepository()
    await repository.savePerson(person('duplicate', '林海'))
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    const historyBefore = repository.getHistoryState()
    storage.failSetWhen = (key) => key === PROTOTYPE_STORAGE_KEY ? new Error('disk full') : undefined

    await expect(repository.mergePeople({
      keepPersonId: 'person-lin-hai', removePersonId: 'duplicate', choices: { sex: 'keep', birth: 'keep' },
    }))
      .rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect((await repository.getPerson('duplicate')).id).toBe('duplicate')
    expect(repository.getHistoryState()).toEqual(historyBefore)
  })
})

describe('merge UI', () => {
  it('shows candidates, starts explicit merge and can mark a pair as not duplicate', async () => {
    const people = [person('p-a', '林晨'), person('p-b', '林晨')]
    const candidates = [{ leftPersonId: 'p-a', rightPersonId: 'p-b', score: 36, reasons: ['本名相同：林晨'], conflicts: [] }]
    const wrapper = mount(DuplicateCandidates, { props: { people, candidates } })
    mountedWrappers.push(wrapper)
    expect(wrapper.text()).toContain('林晨')
    await wrapper.get('button[name="合并候选人 p-a p-b"]').trigger('click')
    expect(wrapper.emitted('merge')?.[0]).toEqual(['p-a', 'p-b'])
    await wrapper.get('button[name="标记非重复 p-a p-b"]').trigger('click')
    expect(wrapper.emitted('not-duplicate')?.[0]).toEqual(['p-a', 'p-b'])
    expect(wrapper.text()).toContain('暂无重复候选')
  })

  it('defers a candidate explicitly and hides it for the current session', async () => {
    const people = [person('p-a', '林晨'), person('p-b', '林晨')]
    const candidates = [{ leftPersonId: 'p-a', rightPersonId: 'p-b', score: 36, reasons: ['本名相同：林晨'], conflicts: [] }]
    const wrapper = mount(DuplicateCandidates, { props: { people, candidates } })
    mountedWrappers.push(wrapper)
    await wrapper.get('button[name="稍后处理 p-a p-b"]').trigger('click')
    expect(wrapper.emitted('defer')?.[0]).toEqual(['p-a', 'p-b'])
    expect(wrapper.text()).toContain('暂无重复候选')
  })

  it('shows conflicting evidence returned by the core', () => {
    const people = [person('p-a', '林晨'), person('p-b', '林晨')]
    const candidates = [{
      leftPersonId: 'p-a', rightPersonId: 'p-b', score: 34,
      reasons: ['本名相同：林晨'], conflicts: ['死亡日期记录不同'],
    }]
    const wrapper = mount(DuplicateCandidates, { props: { people, candidates } })
    mountedWrappers.push(wrapper)

    expect(wrapper.text()).toContain('冲突：死亡日期记录不同')
  })

  it('shows side-by-side required fields, applies a field choice and reports the inspected result', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('duplicate', '林海（旧录）', {
      sex: 'unknown', status: 'unknown', birthPlaceId: 'place-xiamen',
      avatarUrl: '/unique-avatar.jpg', death: { display: '2050', start: '2050', end: '2050', precision: 'exact' },
      deathPlaceId: 'place-shanghai', notes: '旧录备注', sourceIds: ['source-family-website'],
    }))
    const { wrapper } = await mountWizard(repository, 'person-lin-hai', 'duplicate')
    for (const label of ['姓名', '性别', '生存状态', '出生', '死亡', '父母', '伴侣', '子女', '事件', '地点', '来源', '备注']) {
      expect(wrapper.text()).toContain(label)
    }
    expect(wrapper.find('select[name="choice-avatarUrl"]').exists()).toBe(false)
    expect(wrapper.find('select[name="choice-status"]').exists()).toBe(false)
    expect((wrapper.get('button[name="确认合并"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('select[name="choice-birth"]').setValue('keep')
    await wrapper.get('select[name="choice-birthPlaceId"]').setValue('keep')
    await wrapper.get('select[name="choice-notes"]').setValue('remove')
    await wrapper.get('button[name="确认合并"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('合并完成')
    expect(wrapper.text()).toContain('已创建合并前快照')
    expect((await repository.getPerson('person-lin-hai')).sex).toBe('male')
    expect((await repository.getPerson('person-lin-hai')).notes).toBe('旧录备注')
    expect((await repository.getPerson('person-lin-hai')).avatarUrl).toBe('/unique-avatar.jpg')
    expect((await repository.getPerson('person-lin-hai')).deathPlaceId).toBe('place-shanghai')
    await expect(repository.getPerson('duplicate')).rejects.toThrow()
  })

  it('displays avatar, citations and attachments and exposes per-item retention controls', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('duplicate', '林海（旧录）'))
    const { wrapper } = await mountWizard(repository, 'person-lin-hai', 'duplicate')
    for (const label of ['头像', '引用', '附件']) expect(wrapper.text()).toContain(label)
    expect(wrapper.findAll('input[name^="retain-relationship-"]').length).toBeGreaterThan(0)
    expect(wrapper.findAll('input[name^="retain-event-"]').length).toBeGreaterThan(0)
    expect(wrapper.findAll('input[name^="retain-citation-"]').length).toBeGreaterThan(0)
    expect(wrapper.findAll('input[name^="retain-attachment-"]').length).toBeGreaterThan(0)
  })

  it('does not treat an unknown genealogy date as a real UI field conflict', async () => {
    const { repository } = makeRepository()
    const keep = await repository.getPerson('person-lin-guoqiang')
    await repository.savePerson({
      ...keep,
      id: 'guoqiang-unknown-death-copy',
      names: [{ value: '林国强副本', type: 'personal', primary: true }],
      death: { display: '未知', precision: 'unknown' },
    })
    const { wrapper } = await mountWizard(repository, keep.id, 'guoqiang-unknown-death-copy')
    expect(wrapper.find('select[name="choice-death"]').exists()).toBe(false)
  })

  it('requires explicit per-field choices for conflicting duplicate relationship metadata', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('relation-keep', '甲'))
    await repository.savePerson(person('relation-remove', '甲副本'))
    await repository.savePerson(person('relation-other', '乙'))
    await repository.saveRelationship({
      ...relationship('relation-left', 'relation-keep', 'relation-other'),
      start: { display: '2000', start: '2000', end: '2000', precision: 'exact' }, notes: '左侧',
    })
    await repository.saveRelationship({
      ...relationship('relation-right', 'relation-remove', 'relation-other'),
      start: { display: '2010', start: '2010', end: '2010', precision: 'exact' }, notes: '右侧',
    })
    const { wrapper } = await mountWizard(repository, 'relation-keep', 'relation-remove')
    expect(wrapper.text()).toContain('关系字段冲突')
    expect(wrapper.text()).toContain('2000')
    expect(wrapper.text()).toContain('2010')
    expect((wrapper.get('button[name="确认合并"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('select[name="relationship-choice-start-relation-left-relation-right"]').setValue('relation-right')
    await wrapper.get('select[name="relationship-choice-notes-relation-left-relation-right"]').setValue('relation-left')
    expect((wrapper.get('button[name="确认合并"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('discovers conflicts after cumulatively merging three same-key relationships', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('triple-keep', '甲'))
    await repository.savePerson(person('triple-remove', '甲副本'))
    await repository.savePerson(person('triple-other', '乙'))
    await repository.saveRelationship(relationship('triple-base', 'triple-keep', 'triple-other'))
    await repository.saveRelationship({
      ...relationship('triple-2010', 'triple-remove', 'triple-other'),
      start: { display: '2010', start: '2010', end: '2010', precision: 'exact' },
    })
    await repository.saveRelationship({
      ...relationship('triple-2020', 'triple-remove', 'triple-other'),
      start: { display: '2020', start: '2020', end: '2020', precision: 'exact' },
    })
    const { wrapper } = await mountWizard(repository, 'triple-keep', 'triple-remove')
    expect(wrapper.text()).toContain('关系字段冲突')
    expect(wrapper.text()).toContain('2010')
    expect(wrapper.text()).toContain('2020')
    const choice = wrapper.get('select[name="relationship-choice-start-triple-2020-triple-base"]')
    await choice.setValue('triple-2020')
    expect((wrapper.get('button[name="确认合并"]').element as HTMLButtonElement).disabled).toBe(false)
    await wrapper.get('button[name="确认合并"]').trigger('click')
    await flushPromises()
    const merged = (await repository.listRelationships(PROJECT_ID)).filter(({ fromPersonId, toPersonId }) =>
      fromPersonId === 'triple-keep' && toPersonId === 'triple-other')
    expect(merged).toHaveLength(1)
    expect(merged[0]?.start?.display).toBe('2020')
  })

  it('cascades discarded relationship and citation choices to disabled attachment controls', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('cascade-keep', '甲'))
    await repository.savePerson(person('cascade-remove', '甲副本'))
    await repository.savePerson(person('cascade-other', '乙'))
    await repository.saveRelationship(relationship('cascade-relation', 'cascade-remove', 'cascade-other'))
    await repository.saveCitation({
      id: 'cascade-citation', projectId: PROJECT_ID, sourceId: 'source-family-register',
      targetType: 'relationship', targetId: 'cascade-relation', notes: '',
    })
    await repository.saveAttachmentLink({
      id: 'cascade-direct-link', projectId: PROJECT_ID, attachmentId: 'attachment-register-scan',
      targetType: 'relationship', targetId: 'cascade-relation',
    })
    await repository.saveAttachmentLink({
      id: 'cascade-citation-link', projectId: PROJECT_ID, attachmentId: 'attachment-reunion-photo',
      targetType: 'citation', targetId: 'cascade-citation',
    })
    const { wrapper } = await mountWizard(repository, 'cascade-keep', 'cascade-remove')
    await wrapper.get('input[name="retain-relationship-cascade-relation"]').setValue(false)
    const citation = wrapper.get('input[name="retain-citation-cascade-citation"]')
    const directLink = wrapper.get('input[name="retain-attachment-cascade-direct-link"]')
    const citationLink = wrapper.get('input[name="retain-attachment-cascade-citation-link"]')
    expect((citation.element as HTMLInputElement).checked).toBe(false)
    expect((citation.element as HTMLInputElement).disabled).toBe(true)
    expect((directLink.element as HTMLInputElement).checked).toBe(false)
    expect((directLink.element as HTMLInputElement).disabled).toBe(true)
    expect((citationLink.element as HTMLInputElement).checked).toBe(false)
    expect((citationLink.element as HTMLInputElement).disabled).toBe(true)
    expect(wrapper.text()).toContain('随已取消的关系或引用一并移除')
  })

  it('cascades a manually cancelled citation to its attachment links in the UI', async () => {
    const { repository } = makeRepository()
    await repository.savePerson(person('citation-keep', '甲'))
    await repository.savePerson(person('citation-remove', '甲副本'))
    await repository.saveCitation({
      id: 'manual-citation', projectId: PROJECT_ID, sourceId: 'source-family-register',
      targetType: 'person', targetId: 'citation-remove', notes: '',
    })
    await repository.saveAttachmentLink({
      id: 'manual-citation-link', projectId: PROJECT_ID, attachmentId: 'attachment-reunion-photo',
      targetType: 'citation', targetId: 'manual-citation',
    })
    const { wrapper } = await mountWizard(repository, 'citation-keep', 'citation-remove')
    await wrapper.get('input[name="retain-citation-manual-citation"]').setValue(false)
    const link = wrapper.get('input[name="retain-attachment-manual-citation-link"]')
    expect((link.element as HTMLInputElement).checked).toBe(false)
    expect((link.element as HTMLInputElement).disabled).toBe(true)
  })

  it('cancels without mutation and keeps the wizard open with a persistent error on failure', async () => {
    const { repository: base } = makeRepository()
    await base.savePerson(person('duplicate', '林海（旧录）'))
    const mergePeople = vi.fn().mockRejectedValue(new Error('merge transaction failed'))
    const repository = proxyRepository(base, { mergePeople })
    const { wrapper, session } = await mountWizard(repository, 'person-lin-hai', 'duplicate')

    await wrapper.get('button[name="取消合并"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect((await base.getPerson('duplicate')).id).toBe('duplicate')

    await wrapper.get('select[name="choice-sex"]').setValue('keep')
    await wrapper.get('select[name="choice-birth"]').setValue('keep')
    await wrapper.get('button[name="确认合并"]').trigger('click')
    await flushPromises()
    expect(mergePeople).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[role="alert"]').text()).toContain('merge transaction failed')
    expect(wrapper.get('[role="dialog"]')).toBeTruthy()
    expect(session.saveStatus).toBe('failed')
    expect((await base.getPerson('duplicate')).id).toBe('duplicate')
  })
})
