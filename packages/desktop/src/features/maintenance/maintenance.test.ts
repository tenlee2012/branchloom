import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import type { BranchloomRepository, PrototypeState } from '../../shared/domain/types'
import { createDemoState } from '../../shared/fixtures/demoState'
import { findDuplicateNameEvidence } from '../../shared/domain/duplicateInspection'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import {
  PROTOTYPE_STORAGE_KEY,
  SNAPSHOT_PAYLOADS_STORAGE_KEY,
  type PrototypeStorage,
} from '../../shared/repository/storage'
import CleanupDialog from './components/CleanupDialog.vue'
import IssueList from './components/IssueList.vue'
import RestoreDialog from './components/RestoreDialog.vue'
import SnapshotDialog from './components/SnapshotDialog.vue'
import {
  advanceLongTask,
  canCancelLongTask,
  cancelLongTask,
  completeLongTask,
  createLongTaskState,
  failLongTask,
  startLongTask,
} from './model/longTasks'
import SourcesView from '../sources/views/SourcesView.vue'
import TimelineView from '../timeline/views/TimelineView.vue'
import TreeView from '../tree/views/TreeView.vue'
import ChecksView from './views/ChecksView.vue'
import HistoryView from './views/HistoryView.vue'

const PROJECT_ID = 'project-demo-family'
const mounted: Array<{ unmount(): void }> = []

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()
  failSetWhen?: (key: string) => unknown
  get length() { return this.values.size }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) {
    const failure = this.failSetWhen?.(key)
    if (failure) throw failure
    this.values.set(key, value)
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function makeRepository(storage = new MemoryStorage()) {
  let id = 0
  return {
    storage,
    repository: new BrowserPrototypeRepository({
      storage,
      clock: () => new Date('2038-09-10T11:12:13.000Z'),
      idFactory: () => `maintenance-id-${++id}`,
    }),
  }
}

function makeCorruptInspectionRepository() {
  const storage = new MemoryStorage()
  const state = createDemoState()
  const person = state.people.find(({ id }) => id === 'person-lin-chen')!
  person.birth = { display: '1988', start: '1988', end: '1988', precision: 'exact' }
  person.death = { display: '1980', start: '1980', end: '1980', precision: 'exact' }
  person.birthPlaceId = 'place-does-not-exist'
  const incompletePerson = state.people.find(({ id }) => id === 'person-lin-chen-candidate')!
  incompletePerson.birth = { display: '无法辨认', precision: 'unknown' }
  state.events.push({
    id: 'event-before-life', projectId: PROJECT_ID, type: 'other', title: '年代可疑事件',
    date: { display: '1900', start: '1900', end: '1900', precision: 'exact' },
    participantIds: ['person-lin-chen'], sourceIds: [], notes: '',
  })
  state.attachments.push({
    id: 'attachment-damaged', projectId: PROJECT_ID, name: '损坏影像.jpg', mimeType: 'image/jpeg',
    size: 8, contentHash: '', missing: false,
  })
  state.relationships.push(
    { id: 'relationship-self-inspection', projectId: PROJECT_ID, category: 'parent', type: 'biological', fromPersonId: 'person-lin-hai', toPersonId: 'person-lin-hai', notes: '', sourceIds: [] },
    { id: 'relationship-cycle-a', projectId: PROJECT_ID, category: 'parent', type: 'biological', fromPersonId: 'person-lin-chen', toPersonId: 'person-lin-hai', notes: '', sourceIds: [] },
  )
  storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state))
  return new BrowserPrototypeRepository({ storage })
}

function withOverride(repository: BranchloomRepository, patch: Partial<BranchloomRepository>): BranchloomRepository {
  return new Proxy(repository, {
    get(target, property) {
      const override = patch[property as keyof BranchloomRepository]
      if (override) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function mountWithRoute(component: Parameters<typeof mount>[0], repository: BranchloomRepository, path: string, props: Record<string, unknown> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/project/:projectId/manage/checks', component: ChecksView },
      { path: '/project/:projectId/manage/history', component: HistoryView },
      { path: '/project/:projectId/manage/exchange', component: { template: '<p>exchange</p>' } },
      { path: '/project/:projectId/manage/settings', component: { template: '<p>settings</p>' } },
      { path: '/project/:projectId/people/:personId', component: { template: '<p>person</p>' } },
      { path: '/project/:projectId/tree', component: { template: '<p>tree</p>' } },
      { path: '/project/:projectId/timeline', component: { template: '<p>timeline</p>' } },
      { path: '/project/:projectId/sources', component: { template: '<p>sources</p>' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(component, {
    attachTo: document.body,
    props,
    global: { plugins: [router], provide: { [branchloomRepositoryKey as symbol]: repository }, stubs: { Teleport: true } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('project inspection', () => {
  it('detects every specified structural, historical and integrity issue with correct severity', async () => {
    const issues = await makeCorruptInspectionRepository().inspectProject(PROJECT_ID)
    const codes = issues.map(({ code }) => code)
    expect(codes).toEqual(expect.arrayContaining([
      'self-parent', 'ancestor-cycle', 'death-before-birth', 'event-outside-lifespan',
      'missing-attachment', 'damaged-attachment', 'unused-source', 'possible-duplicate',
      'incomplete-date', 'missing-place',
    ]))
    expect(issues.filter(({ code }) => ['self-parent', 'ancestor-cycle'].includes(code)).every(({ severity }) => severity === 'error')).toBe(true)
    expect(issues.filter(({ code }) => ['death-before-birth', 'event-outside-lifespan', 'incomplete-date', 'missing-place'].includes(code)).every(({ severity }) => severity === 'warning')).toBe(true)
  })

  it('groups severity and exposes a navigation target for every issue type', async () => {
    const repository = makeCorruptInspectionRepository()
    const issues = await repository.inspectProject(PROJECT_ID)
    const { wrapper } = await mountWithRoute(IssueList, repository, `/project/${PROJECT_ID}/manage/checks`, { projectId: PROJECT_ID, issues })

    expect(wrapper.get('[aria-label="结构错误"]').text()).toContain('人物不能成为自己的父母')
    expect(wrapper.get('[aria-label="警告"]').text()).toContain('日期')
    expect(wrapper.findAll('a').length).toBeGreaterThanOrEqual(5)
    expect(wrapper.findAll('a').every((link) => link.text().includes('查看资料'))).toBe(true)
  })

  it('compares legal one-sided exact, year, month and range boundaries without missing lifespan warnings', async () => {
    const storage = new MemoryStorage()
    const state = createDemoState()
    const person = state.people.find(({ id }) => id === 'person-lin-hai')!
    person.birth = { display: '1962', start: '1962', precision: 'exact' }
    person.death = { display: '2020-05', end: '2020-05', precision: 'range' }
    state.events.push(
      { id: 'event-before-one-sided', projectId: PROJECT_ID, type: 'other', title: '出生前', date: { display: '1961-12', end: '1961-12', precision: 'exact' }, participantIds: [person.id], sourceIds: [], notes: '' },
      { id: 'event-after-one-sided', projectId: PROJECT_ID, type: 'other', title: '死亡后', date: { display: '2020-06', start: '2020-06', precision: 'range' }, participantIds: [person.id], sourceIds: [], notes: '' },
    )
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state))
    const repository = new BrowserPrototypeRepository({ storage })
    const outsideIds = (await repository.inspectProject(PROJECT_ID))
      .filter(({ code }) => code === 'event-outside-lifespan')
      .map(({ targetId }) => targetId)
    expect(outsideIds).toEqual(expect.arrayContaining(['event-before-one-sided', 'event-after-one-sided']))
  })

  it('drops stale derived issues after repair and ignores sources used only by soft-deleted people', async () => {
    const { repository } = makeRepository()
    await repository.locateAttachment('attachment-missing-letter')
    expect((await repository.inspectProject(PROJECT_ID)).some(({ code, targetId }) => code === 'missing-attachment' && targetId === 'attachment-missing-letter')).toBe(false)

    await repository.saveSource({ id: 'source-deleted-only', projectId: PROJECT_ID, title: '仅软删除人物使用', type: 'other', notes: '' })
    const person = await repository.getPerson('person-lin-hai')
    await repository.savePerson({
      ...person,
      sourceIds: [...(person.sourceIds ?? []), 'source-deleted-only'],
    })
    await repository.softDeletePerson(person.id)
    expect((await repository.inspectProject(PROJECT_ID)).some(({ code, targetId }) => code === 'unused-source' && targetId === 'source-deleted-only')).toBe(true)
    expect((await repository.getCleanupImpact(PROJECT_ID)).unusedSourceIds).toContain('source-deleted-only')
  })

  it('keeps distinct birth/death date and place reasons for the same person with unique stable ids', async () => {
    const storage = new MemoryStorage()
    const state = createDemoState()
    const person = state.people.find(({ id }) => id === 'person-lin-hai')!
    person.birth = { display: '出生日期难辨', precision: 'unknown' }
    person.death = { display: '死亡日期难辨', precision: 'unknown' }
    person.birthPlaceId = 'missing-birth-place'
    person.deathPlaceId = 'missing-death-place'
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state))
    const issues = await new BrowserPrototypeRepository({ storage }).inspectProject(PROJECT_ID)
    const dateIssues = issues.filter(({ code, targetId }) => code === 'incomplete-date' && targetId === person.id)
    const placeIssues = issues.filter(({ code, targetId }) => code === 'missing-place' && targetId === person.id)
    expect(dateIssues).toHaveLength(2)
    expect(dateIssues.map(({ message }) => message)).toEqual(expect.arrayContaining([expect.stringContaining('出生'), expect.stringContaining('死亡')]))
    expect(placeIssues).toHaveLength(2)
    expect(placeIssues.map(({ message }) => message)).toEqual(expect.arrayContaining([expect.stringContaining('出生'), expect.stringContaining('死亡')]))
    expect(new Set([...dateIssues, ...placeIssues].map(({ id }) => id)).size).toBe(4)
  })

  it('accepts three-digit historical years without reporting incomplete dates', async () => {
    const storage = new MemoryStorage()
    const state = createDemoState()
    const person = state.people.find(({ id }) => id === 'person-lin-hai')!
    person.birth = { display: '927-03-21', start: '927-03-21', precision: 'exact' }
    person.death = { display: '976-11-14', end: '976-11-14', precision: 'exact' }
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state))

    const issues = await new BrowserPrototypeRepository({ storage }).inspectProject(PROJECT_ID)

    expect(issues.filter(({ code, targetId }) => code === 'incomplete-date' && targetId === person.id))
      .toEqual([])
  })

  it('buckets duplicate names with one name read per person instead of pairwise comparisons', () => {
    let nameReads = 0
    const base = createDemoState().people[0]!
    const people = Array.from({ length: 2_000 }, (_, index) => {
      const value = `同名-${Math.floor(index / 2)}`
      const person = { ...base, id: `large-${String(index).padStart(4, '0')}` }
      Object.defineProperty(person, 'names', {
        enumerable: true,
        get() { nameReads += 1; return [{ id: `name-${index}`, value, type: 'personal', primary: true as const }] },
      })
      return person
    })
    const evidence = findDuplicateNameEvidence(people)
    expect(evidence).toHaveLength(2_000)
    expect(nameReads).toBe(2_000)
    expect(evidence.slice(0, 2)).toEqual([
      { personId: 'large-0000', normalizedName: '同名-0', displayName: '同名-0', bucketSize: 2 },
      { personId: 'large-0001', normalizedName: '同名-0', displayName: '同名-0', bucketSize: 2 },
    ])
  })

  it('chooses duplicate display names and targets deterministically regardless of input order', () => {
    const base = createDemoState().people[0]!
    const people = [
      { ...base, id: 'person-b', names: [{ value: 'alice', type: 'personal' as const, primary: true }] },
      { ...base, id: 'person-a', names: [{ value: 'Alice', type: 'personal' as const, primary: true }] },
    ]
    const expected = [
      { personId: 'person-a', normalizedName: 'alice', displayName: 'Alice', bucketSize: 2 },
      { personId: 'person-b', normalizedName: 'alice', displayName: 'Alice', bucketSize: 2 },
    ]

    expect(findDuplicateNameEvidence(people)).toEqual(expected)
    expect(findDuplicateNameEvidence([...people].reverse())).toEqual(expected)
  })
})

describe('maintenance target navigation', () => {
  it.each([
    ['relationship', 'relationship-guoqiang-hai', TreeView, 'data-located-relationship-id'],
    ['event', 'event-family-reunion', TimelineView, 'data-located-event-id'],
    ['source', 'source-family-register', SourcesView, 'data-located-source-id'],
    ['attachment', 'attachment-missing-letter', SourcesView, 'data-located-attachment-id'],
  ] as const)('navigates from a %s issue and visibly locates its target', async (targetType, targetId, targetView, locatedAttribute) => {
    const { repository } = makeRepository()
    const issue = { id: `issue-${targetId}`, severity: 'warning' as const, code: 'test', message: '定位测试', targetType, targetId }
    const issueHost = defineComponent({ setup: () => () => h(IssueList, { projectId: PROJECT_ID, issues: [issue] }) })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: `/project/:projectId/manage/checks`, component: issueHost },
      { path: `/project/:projectId/tree`, component: targetView },
      { path: `/project/:projectId/timeline`, component: targetView },
      { path: `/project/:projectId/sources`, component: targetView },
    ] })
    await router.push(`/project/${PROJECT_ID}/manage/checks`); await router.isReady()
    const wrapper = mount(RouterView, {
      attachTo: document.body,
      global: {
        plugins: [router, createPinia()],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { FamilyGraph: true, TreeToolbar: true, PersonPreviewDrawer: true, QuickAddRelativeDialog: true, EventEditorDrawer: true, TimelineGroup: true, SourceEditorDrawer: true, CitationEditor: true, BaseDialog: true },
      },
    })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.get('a').trigger('click')
    await flushPromises()
    const located = wrapper.get(`[${locatedAttribute}="${targetId}"]`)
    expect(located.text()).toContain(targetId)
  })
})

describe('shared long-task state', () => {
  it('supports safe cancellation, locks commit, records phases/progress and preserves failure reports', () => {
    let state = startLongTask(createLongTaskState())
    expect(state).toMatchObject({ stage: 'processing', progress: 10 })
    expect(canCancelLongTask(state)).toBe(true)
    expect(cancelLongTask(state).stage).toBe('cancelled')
    state = advanceLongTask(state)
    expect(state).toMatchObject({ stage: 'processing', progress: 40 })
    state = advanceLongTask(state)
    expect(state).toMatchObject({ stage: 'committing', progress: 90 })
    expect(canCancelLongTask(state)).toBe(false)
    expect(completeLongTask(state, ['重新检查完成'])).toMatchObject({ stage: 'complete', progress: 100, report: ['重新检查完成'] })
    expect(failLongTask(state, '磁盘失败')).toMatchObject({ stage: 'failed', failureMessage: '磁盘失败', report: expect.arrayContaining(['磁盘失败']) })
  })
})

describe('cleanup transaction', () => {
  it('reports orphan attachment/source impact, snapshots first, removes only confirmed records and reinspects', async () => {
    const { repository } = makeRepository()
    await repository.saveAttachment({
      id: 'attachment-orphan', projectId: PROJECT_ID, name: '未引用扫描件.jpg', mimeType: 'image/jpeg',
      size: 4096, contentHash: 'sha256:orphan', missing: false,
    })
    const impact = await repository.getCleanupImpact(PROJECT_ID)
    expect(impact).toMatchObject({
      unusedAttachmentIds: ['attachment-orphan'], unusedAttachmentBytes: 4096,
      unusedSourceIds: ['source-unfiled-letter'],
    })

    const result = await repository.cleanupProject(PROJECT_ID, {
      removeUnusedAttachments: true,
      removeSourceIds: ['source-unfiled-letter'],
      rebuildSearchIndex: true,
    })
    expect(result.snapshot).toMatchObject({ reason: 'cleanup' })
    expect(result).toMatchObject({ removedAttachments: 1, removedSources: 1, searchIndexRebuilt: true })
    expect((await repository.listSnapshots(PROJECT_ID)).at(-1)?.id).toBe(result.snapshot.id)
    expect((await repository.listAttachments(PROJECT_ID)).some(({ id }) => id === 'attachment-orphan')).toBe(false)
    expect((await repository.listSources(PROJECT_ID)).some(({ id }) => id === 'source-unfiled-letter')).toBe(false)
    expect(result.issues).toEqual(await repository.inspectProject(PROJECT_ID))

    await repository.restoreSnapshot(result.snapshot.id)
    expect((await repository.listAttachments(PROJECT_ID)).some(({ id }) => id === 'attachment-orphan')).toBe(true)
  })

  it('rolls back cleanup state and snapshot sidecar together on failure', async () => {
    const { repository, storage } = makeRepository()
    await repository.saveAttachment({ id: 'attachment-orphan', projectId: PROJECT_ID, name: '孤立', mimeType: 'text/plain', size: 2, contentHash: 'sha256:x', missing: false })
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    storage.failSetWhen = (key) => key === PROTOTYPE_STORAGE_KEY ? new Error('disk full') : undefined
    await expect(repository.cleanupProject(PROJECT_ID, { removeUnusedAttachments: true, removeSourceIds: [], rebuildSearchIndex: true })).rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
  })

  it('shows cleanup impact and long-task progress before confirmation', async () => {
    const { repository } = makeRepository()
    await repository.saveAttachment({ id: 'attachment-orphan', projectId: PROJECT_ID, name: '孤立扫描件', mimeType: 'image/jpeg', size: 512, contentHash: 'sha256:y', missing: false })
    const wrapper = mount(CleanupDialog, { attachTo: document.body, props: { open: true, projectId: PROJECT_ID }, global: { provide: { [branchloomRepositoryKey as symbol]: repository }, stubs: { Teleport: true } } })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).toContain('孤立扫描件')
    expect(wrapper.text()).toContain('自动创建快照')
    await wrapper.get('button[name="开始清理"]').trigger('click')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('10')
    expect(wrapper.get('button[name="取消清理"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('button[name="继续清理"]').trigger('click')
    await wrapper.get('button[name="继续清理"]').trigger('click')
    expect(wrapper.get('button[name="取消清理"]').attributes('disabled')).toBeDefined()
    await flushPromises()
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(wrapper.text()).toContain('清理完成')
  })

  it('isolates delayed cleanup impact loads when the project prop changes', async () => {
    const { repository } = makeRepository()
    const [demoAttachments, demoSources] = await Promise.all([repository.listAttachments(PROJECT_ID), repository.listSources(PROJECT_ID)])
    const loadA = deferred<Awaited<ReturnType<BranchloomRepository['getCleanupImpact']>>>()
    const scoped = withOverride(repository, {
      getCleanupImpact: vi.fn((projectId: string) => projectId === 'project-a'
        ? loadA.promise
        : Promise.resolve({ unusedAttachmentIds: [], unusedAttachmentBytes: 0, unusedSourceIds: [] })),
      listAttachments: vi.fn(() => Promise.resolve(demoAttachments)),
      listSources: vi.fn(() => Promise.resolve(demoSources)),
    })
    const wrapper = mount(CleanupDialog, { attachTo: document.body, props: { open: true, projectId: 'project-a' }, global: { provide: { [branchloomRepositoryKey as symbol]: scoped }, stubs: { Teleport: true } } })
    mounted.push(wrapper)
    await wrapper.setProps({ projectId: 'project-b' }); await flushPromises()
    expect(wrapper.text()).toContain('没有未引用来源')
    loadA.resolve({ unusedAttachmentIds: ['attachment-missing-letter'], unusedAttachmentBytes: 1, unusedSourceIds: ['source-unfiled-letter'] })
    await flushPromises()
    expect(wrapper.text()).toContain('没有未引用来源')
    expect(wrapper.text()).not.toContain('林国强旧信')
  })

  it('keeps an in-flight cleanup commit locked across project changes and ignores its old result', async () => {
    const { repository } = makeRepository()
    const [demoAttachments, demoSources] = await Promise.all([repository.listAttachments(PROJECT_ID), repository.listSources(PROJECT_ID)])
    const commitA = deferred<Awaited<ReturnType<BranchloomRepository['cleanupProject']>>>()
    const cleanupProject = vi.fn(() => commitA.promise)
    const scoped = withOverride(repository, {
      getCleanupImpact: vi.fn(() => Promise.resolve({ unusedAttachmentIds: [], unusedAttachmentBytes: 0, unusedSourceIds: [] })),
      cleanupProject,
      listAttachments: vi.fn(() => Promise.resolve(demoAttachments)),
      listSources: vi.fn(() => Promise.resolve(demoSources)),
    })
    const wrapper = mount(CleanupDialog, { attachTo: document.body, props: { open: true, projectId: 'project-a' }, global: { provide: { [branchloomRepositoryKey as symbol]: scoped }, stubs: { Teleport: true } } })
    mounted.push(wrapper); await flushPromises()
    await wrapper.get('button[name="开始清理"]').trigger('click')
    await wrapper.get('button[name="继续清理"]').trigger('click')
    void wrapper.get('button[name="继续清理"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('button[name="取消清理"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ projectId: 'project-b' })
    expect(wrapper.get('button[name="取消清理"]').attributes('disabled')).toBeDefined()
    const snapshot = { ...(await repository.listSnapshots(PROJECT_ID))[0]!, projectId: 'project-a', reason: 'cleanup' as const }
    commitA.resolve({ snapshot, removedAttachments: 0, removedSources: 0, searchIndexRebuilt: true, issues: [] })
    await flushPromises()
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(cleanupProject).toHaveBeenCalledWith('project-a', expect.any(Object))
    expect(wrapper.get('button[name="开始清理"]').attributes('disabled')).toBeUndefined()
  })
})

describe('snapshots and protected restore', () => {
  it('creates a trimmed manual snapshot note and displays full history summaries', async () => {
    const { repository } = makeRepository()
    const wrapper = mount(SnapshotDialog, { attachTo: document.body, props: { open: true, projectId: PROJECT_ID }, global: { provide: { [branchloomRepositoryKey as symbol]: repository }, stubs: { Teleport: true } } })
    mounted.push(wrapper)
    await wrapper.get('textarea').setValue('  研究节点  ')
    await wrapper.get('button[name="创建手动快照"]').trigger('click')
    await flushPromises()
    expect((await repository.listSnapshots(PROJECT_ID)).at(-1)).toMatchObject({ reason: 'manual', note: '研究节点' })

    const { wrapper: history } = await mountWithRoute(HistoryView, repository, `/project/${PROJECT_ID}/manage/history`)
    expect(history.text()).toContain('研究节点')
    expect(history.text()).toContain('人物 12')
    expect(history.text()).toContain('关系 13')
    expect(history.text()).toContain('事件 8')
    expect(history.find('time').exists()).toBe(true)
  })

  it('rejects blank manual snapshot notes in both UI and repository', async () => {
    const { repository } = makeRepository()
    await expect(repository.createSnapshot(PROJECT_ID, 'manual', '   ')).rejects.toMatchObject({ code: 'validation' })
    const wrapper = mount(SnapshotDialog, { attachTo: document.body, props: { open: true, projectId: PROJECT_ID }, global: { provide: { [branchloomRepositoryKey as symbol]: repository }, stubs: { Teleport: true } } })
    mounted.push(wrapper)
    await wrapper.get('button[name="创建手动快照"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('备注')
  })

  it('creates a current-state snapshot before restore and returns post-restore inspection', async () => {
    const { repository } = makeRepository()
    await repository.updateProject(PROJECT_ID, { name: '恢复前当前状态' })
    const result = await repository.restoreSnapshot('snapshot-import')
    expect(result.safetySnapshot).toMatchObject({ reason: 'restore', note: expect.stringContaining('恢复前') })
    expect((await repository.getProject(PROJECT_ID)).name).toBe('林家四代家庭档案')
    expect(result.issues).toEqual(await repository.inspectProject(PROJECT_ID))
    await repository.restoreSnapshot(result.safetySnapshot.id)
    expect((await repository.getProject(PROJECT_ID)).name).toBe('恢复前当前状态')
  })

  it('preserves current state, snapshot payloads and history when protected restore fails', async () => {
    const { repository, storage } = makeRepository()
    await repository.updateProject(PROJECT_ID, { name: '不能丢失的当前状态' })
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    const beforeHistory = repository.getHistoryState()
    storage.failSetWhen = (key) => key === PROTOTYPE_STORAGE_KEY ? new Error('restore write failed') : undefined
    await expect(repository.restoreSnapshot('snapshot-import')).rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect(repository.getHistoryState()).toEqual(beforeHistory)
    expect((await repository.getProject(PROJECT_ID)).name).toBe('不能丢失的当前状态')
  })

  it('shows restore preview, locked commit progress and a visible failure without false success', async () => {
    const { repository } = makeRepository()
    const failed = withOverride(repository, { restoreSnapshot: vi.fn().mockRejectedValue(new Error('磁盘不可用')) })
    const wrapper = mount(RestoreDialog, { attachTo: document.body, props: { open: true, snapshot: (await repository.listSnapshots(PROJECT_ID))[0]! }, global: { provide: { [branchloomRepositoryKey as symbol]: failed }, stubs: { Teleport: true } } })
    mounted.push(wrapper)
    expect(wrapper.text()).toContain('恢复前自动创建当前状态快照')
    await wrapper.get('button[name="确认恢复"]').trigger('click')
    await wrapper.get('button[name="继续恢复"]').trigger('click')
    await wrapper.get('button[name="继续恢复"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('磁盘不可用')
    expect(wrapper.get('button[name="重试恢复"]').text()).toContain('重试')
    expect(wrapper.text()).not.toContain('恢复完成')
  })

  it('uses the active cancel action to close an idle restore dialog without a header close icon', async () => {
    const { repository } = makeRepository()
    const wrapper = mount(RestoreDialog, {
      attachTo: document.body,
      props: { open: true, snapshot: (await repository.listSnapshots(PROJECT_ID))[0]! },
      global: {
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mounted.push(wrapper)

    const cancel = wrapper.get('button[name="取消恢复"]')
    expect(cancel.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('button[aria-label="关闭"]').exists()).toBe(false)
    await cancel.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('isolates delayed history responses across project route changes and clears old restore state', async () => {
    const { repository } = makeRepository()
    let resolveA!: (snapshots: PrototypeState['snapshots']) => void
    const delayedA = new Promise<PrototypeState['snapshots']>((resolve) => { resolveA = resolve })
    const snapshotA = { ...(await repository.listSnapshots(PROJECT_ID))[0]!, projectId: 'project-a', note: '项目 A 历史' }
    const snapshotB = { ...(await repository.listSnapshots(PROJECT_ID))[1]!, projectId: 'project-b', note: '项目 B 历史' }
    const scoped = withOverride(repository, {
      listSnapshots: vi.fn((projectId: string) => projectId === 'project-a' ? delayedA : Promise.resolve([snapshotB])),
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/project/:projectId/manage/history', component: HistoryView }] })
    await router.push('/project/project-a/manage/history'); await router.isReady()
    const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router], provide: { [branchloomRepositoryKey as symbol]: scoped }, stubs: { Teleport: true } } })
    mounted.push(wrapper)
    await router.push('/project/project-b/manage/history'); await flushPromises()
    expect(wrapper.text()).toContain('项目 B 历史')
    resolveA([snapshotA]); await flushPromises()
    expect(wrapper.text()).toContain('项目 B 历史')
    expect(wrapper.text()).not.toContain('项目 A 历史')

    await router.push('/project/project-a/manage/history')
    resolveA([snapshotA]); await flushPromises()
  })

  it('closes an open restore dialog immediately when the project route changes', async () => {
    const { repository } = makeRepository()
    const demoSnapshot = (await repository.listSnapshots(PROJECT_ID))[0]!
    const scoped = withOverride(repository, {
      listSnapshots: vi.fn((projectId: string) => Promise.resolve([{ ...demoSnapshot, projectId, note: `历史 ${projectId}` }])),
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/project/:projectId/manage/history', component: HistoryView }] })
    await router.push('/project/project-a/manage/history'); await router.isReady()
    const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router], provide: { [branchloomRepositoryKey as symbol]: scoped }, stubs: { Teleport: true } } })
    mounted.push(wrapper); await flushPromises()
    await wrapper.get('button[aria-label^="恢复版本"]').trigger('click')
    expect(wrapper.text()).toContain('恢复历史版本')
    await router.push('/project/project-b/manage/history')
    expect(wrapper.text()).not.toContain('恢复历史版本')
    await flushPromises()
    expect(wrapper.text()).toContain('历史 project-b')
  })
})

describe('reachable maintenance pages', () => {
  it('loads checks from the repository and offers cleanup/history navigation', async () => {
    const { repository } = makeRepository()
    const inspect = vi.spyOn(repository, 'inspectProject')
    const { wrapper } = await mountWithRoute(ChecksView, repository, `/project/${PROJECT_ID}/manage/checks`)
    expect(wrapper.get('section[aria-label="数据检查与维护"]')).toBeTruthy()
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.get('nav[aria-label="项目管理二级导航"] a[aria-current="page"]').text())
      .toBe('数据检查')
    await wrapper.get('button[name="开始项目检查"]').trigger('click')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('10')
    expect(wrapper.get('button[name="取消项目检查"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('button[name="取消项目检查"]').trigger('click')
    expect(wrapper.text()).toContain('检查已安全取消')
    expect(inspect).not.toHaveBeenCalled()
    await wrapper.get('button[name="开始项目检查"]').trigger('click')
    await wrapper.get('button[name="继续项目检查"]').trigger('click')
    await wrapper.get('button[name="继续项目检查"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('缺失')
    expect(wrapper.get('a[href$="/manage/history"]').text()).toContain('备份与历史')
    expect(wrapper.get('button[name="打开清理项目对话框"]').text()).toContain('清理')
  })
})
