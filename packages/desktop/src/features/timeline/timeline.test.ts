import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../app/router'
import { useSessionStore } from '../../app/stores/session'
import type {
  BranchloomRepository,
  FamilyEvent,
  GenealogyDate,
  Person,
  Source,
} from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import EventEditorDrawer from './components/EventEditorDrawer.vue'
import PlaceManager from './components/PlaceManager.vue'
import {
  eventTypeLabel,
  expandIsoBoundary,
  findLifespanWarnings,
  formatEventDate,
  groupEvents,
} from './model/groupEvents'
import TimelineView from './views/TimelineView.vue'

const PROJECT_ID = 'project-demo-family'
const mountedWrappers: Array<{ unmount(): void }> = []

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

function makeRepository(): BrowserPrototypeRepository {
  let id = 0
  return new BrowserPrototypeRepository({
    storage: new MemoryStorage(),
    clock: () => new Date('2034-05-06T07:08:09.000Z'),
    idFactory: () => `timeline-id-${++id}`,
  })
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function event(id: string, date: GenealogyDate, overrides: Partial<FamilyEvent> = {}): FamilyEvent {
  return {
    id,
    projectId: PROJECT_ID,
    type: 'residence',
    title: id,
    date,
    participantIds: ['person-lin-hai'],
    sourceIds: [],
    notes: '',
    ...overrides,
  }
}

async function mountEditor(options: {
  repository?: BranchloomRepository
  event?: FamilyEvent
  people?: Person[]
  sources?: Source[]
} = {}) {
  const repository = options.repository ?? makeRepository()
  const people = options.people ?? [
    await repository.getPerson('person-lin-hai'),
    await repository.getPerson('person-lin-chen'),
  ]
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.openProject(await repository.getProject(PROJECT_ID))
  const wrapper = mount(EventEditorDrawer, {
    attachTo: document.body,
    props: {
      open: true,
      projectId: PROJECT_ID,
      people,
      sources: options.sources ?? [],
      ...(options.event ? { event: options.event } : {}),
    },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await flushPromises()
  return { wrapper, repository, session }
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('timeline grouping', () => {
  it('orders exact, about, before, after, and range dates while keeping unknown dates last', () => {
    const input = [
      event('unknown', { display: '年代不详', precision: 'unknown' }),
      event('after', { display: '2004 年以后', start: '2004', precision: 'after' }),
      event('range', { display: '1991—1993', start: '1991', end: '1993', precision: 'range' }),
      event('exact', { display: '1988-04-12', start: '1988-04-12', end: '1988-04-12', precision: 'exact' }),
      event('before', { display: '1980 年以前', end: '1980', precision: 'before' }),
      event('about', { display: '约 1995', start: '1994', end: '1996', precision: 'about' }),
    ]

    const result = groupEvents(input)
    expect(result.groups.map(({ label }) => label)).toEqual([
      '1980 年', '1988 年', '1991 年', '1994 年', '2004 年', '日期未知',
    ])
    expect(result.groups.flatMap(({ events }) => events.map(({ id }) => id))).toEqual([
      'before', 'exact', 'range', 'about', 'after', 'unknown',
    ])
    expect(result.groups.at(-1)).toMatchObject({ key: 'unknown', unknown: true })
  })

  it('filters participants and types before grouping with deterministic tie ordering', () => {
    const sameDate = { display: '2001', start: '2001', end: '2001', precision: 'exact' } as const
    const result = groupEvents([
      event('z', sameDate, { type: 'education', title: '乙', participantIds: ['p-1'] }),
      event('a', sameDate, { type: 'education', title: '甲', participantIds: ['p-1'] }),
      event('other-person', sameDate, { type: 'education', participantIds: ['p-2'] }),
      event('other-type', sameDate, { type: 'occupation', participantIds: ['p-1'] }),
    ], { participantId: 'p-1', eventType: 'education' })

    expect(result.groups[0]?.events.map(({ id }) => id)).toEqual(['a', 'z'])
  })

  it('pages expanded fixtures by groups without returning every group at once', () => {
    const fixtures = Array.from({ length: 4_000 }, (_, index) => event(
      `event-${String(index).padStart(4, '0')}`,
      {
        display: String(1000 + index),
        start: String(1000 + index),
        end: String(1000 + index),
        precision: 'exact',
      },
    ))

    const result = groupEvents(fixtures, { page: 2, pageSize: 40 })
    expect(result.totalGroups).toBe(4_000)
    expect(result.groups).toHaveLength(40)
    expect(result.groups[0]?.label).toBe('1040 年')
    expect(result.totalPages).toBe(100)
  })

  it('labels built-in and custom event types without hiding the custom value', () => {
    expect(eventTypeLabel('birth')).toBe('出生')
    expect(eventTypeLabel('accession')).toBe('即位')
    expect(eventTypeLabel('military_campaign')).toBe('军事行动')
    expect(eventTypeLabel('name_change')).toBe('改名')
    expect(eventTypeLabel('family-award')).toBe('family-award')
  })

  it('puts malformed date boundaries in the unknown final group', () => {
    const result = groupEvents([
      event('valid', { display: '', start: '2024-03', end: '2024-03', precision: 'exact' }),
      event('malformed', { display: '错误日期', start: '2024foo', end: '2024foo', precision: 'exact' }),
    ])

    expect(result.groups.map(({ key }) => key)).toEqual(['2024', 'unknown'])
    expect(result.groups.at(-1)?.events.map(({ id }) => id)).toEqual(['malformed'])
  })

  it.each([
    [{ display: '原始日期文字', start: '2000', end: '2000', precision: 'exact' } as GenealogyDate, '原始日期文字'],
    [{ display: '', start: '2000-02-03', end: '2000-02-03', precision: 'exact' } as GenealogyDate, '2000-02-03'],
    [{ display: '', start: '1999', end: '2001', precision: 'about' } as GenealogyDate, '约 1999—2001'],
    [{ display: '', end: '1980', precision: 'before' } as GenealogyDate, '1980 以前'],
    [{ display: '', start: '2020-06', precision: 'after' } as GenealogyDate, '2020-06 以后'],
    [{ display: '', start: '1991', end: '1993', precision: 'range' } as GenealogyDate, '1991—1993'],
    [{ display: '', precision: 'unknown' } as GenealogyDate, '日期未知'],
  ])('formats event date semantics without inventing a date: %j', (date, expected) => {
    expect(formatEventDate(date)).toBe(expected)
  })

  it('expands partial ISO boundaries to their earliest and latest possible dates', () => {
    expect(expandIsoBoundary('2020')).toEqual({ lower: '2020-01-01', upper: '2020-12-31' })
    expect(expandIsoBoundary('2020-02')).toEqual({ lower: '2020-02-01', upper: '2020-02-29' })
    expect(expandIsoBoundary('2020-02-03')).toEqual({ lower: '2020-02-03', upper: '2020-02-03' })
    expect(expandIsoBoundary('2020foo')).toBeUndefined()
  })
})

describe('place management', () => {
  it('creates, edits and removes an unused place through the timeline workspace', async () => {
    const repository = makeRepository()
    const pinia = createPinia()
    setActivePinia(pinia)
    useSessionStore(pinia).openProject(await repository.getProject(PROJECT_ID))
    const wrapper = mount(PlaceManager, {
      attachTo: document.body,
      props: {
        open: true,
        projectId: PROJECT_ID,
        places: await repository.listPlaces(PROJECT_ID),
      },
      global: {
        plugins: [pinia],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)

    await wrapper.findAll('button').find((button) => button.text() === '新建地点')!.trigger('click')
    await wrapper.get('input[name="placeName"]').setValue('新建地点')
    await wrapper.get('input[name="placeAliases"]').setValue('旧称；别称')
    await wrapper.get('textarea[name="placeNotes"]').setValue('地点备注')
    await wrapper.get('button[name="保存地点"]').trigger('click')
    await flushPromises()

    const created = (await repository.listPlaces(PROJECT_ID)).find(({ name }) => name === '新建地点')
    expect(created).toMatchObject({ aliases: ['旧称', '别称'], notes: '地点备注' })

    await wrapper.setProps({ places: await repository.listPlaces(PROJECT_ID) })
    await wrapper.get('select[name="placeRecord"]').setValue(created!.id)
    await wrapper.get('button[name="删除地点"]').trigger('click')
    await wrapper.get('button[name="确认删除地点"]').trigger('click')
    await flushPromises()
    expect((await repository.listPlaces(PROJECT_ID)).some(({ id }) => id === created!.id)).toBe(false)
  })
})

describe('lifespan warnings', () => {
  it('warns only for events definitely outside a participant lifespan', () => {
    const person: Person = {
      id: 'p-1',
      projectId: PROJECT_ID,
      names: [{ value: '林岚', type: 'personal', primary: true }],
      sex: 'unknown',
      status: 'deceased',
      birth: { display: '1980', start: '1980', end: '1980', precision: 'exact' },
      death: { display: '2020', start: '2020', end: '2020', precision: 'exact' },
      biography: '',
      notes: '',
      sourceIds: [],
      updatedAt: '2034-05-06T07:08:09.000Z',
    }

    expect(findLifespanWarnings(event('early', {
      display: '1970', start: '1970', end: '1970', precision: 'exact',
    }, { participantIds: [person.id] }), [person])[0]).toContain('出生前')
    expect(findLifespanWarnings(event('late', {
      display: '2030 年以后', start: '2030', precision: 'after',
    }, { participantIds: [person.id] }), [person])[0]).toContain('死亡后')
    expect(findLifespanWarnings(event('unknown', {
      display: '不详', precision: 'unknown',
    }, { participantIds: [person.id] }), [person])).toEqual([])
  })
})

describe('event editor', () => {
  it('creates a custom event in the current project with structured dates', async () => {
    const { wrapper, repository, session } = await mountEditor()
    await wrapper.get('select[name="eventType"]').setValue('__custom__')
    await wrapper.get('input[name="customEventType"]').setValue('family-award')
    await wrapper.get('input[name="eventTitle"]').setValue(' 家庭荣誉获奖 ')
    await wrapper.get('select[name="datePrecision"]').setValue('range')
    await wrapper.get('input[name="dateDisplay"]').setValue('2001—2002 年间')
    await wrapper.get('input[name="dateStart"]').setValue('2001')
    await wrapper.get('input[name="dateEnd"]').setValue('2002')
    await wrapper.get('input[value="person-lin-hai"]').setValue(true)
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    const saved = wrapper.emitted<FamilyEvent[]>('saved')?.[0]?.[0]
    expect(saved).toMatchObject({
      projectId: PROJECT_ID,
      type: 'family-award',
      title: '家庭荣誉获奖',
      date: {
        display: '2001—2002 年间',
        start: '2001',
        end: '2002',
        precision: 'range',
      },
      participantIds: ['person-lin-hai'],
      sourceIds: [],
    })
    expect(session.saveStatus).toBe('saved')
    expect((await repository.listEvents(PROJECT_ID)).some(({ id }) => id === saved?.id)).toBe(true)
  })

  it('edits without changing identity, sources, project scope, or structured date semantics', async () => {
    const base = makeRepository()
    const existing = (await base.listEvents(PROJECT_ID))[4]!
    const saveEvent = vi.fn(base.saveEvent.bind(base))
    const { wrapper } = await mountEditor({ repository: proxyRepository(base, { saveEvent }), event: existing })
    await wrapper.get('input[name="eventTitle"]').setValue('修订后的事件')
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    const submitted = saveEvent.mock.calls[0]![0]
    expect(submitted.id).toBe(existing.id)
    expect(submitted.projectId).toBe(PROJECT_ID)
    expect(submitted.sourceIds).toEqual(existing.sourceIds)
    expect(submitted.date).toEqual(existing.date)
  })

  it('lets an event select and persist project sources and participant roles', async () => {
    const base = makeRepository()
    const sources = await base.listSources(PROJECT_ID)
    const saveEvent = vi.fn(base.saveEvent.bind(base))
    const { wrapper } = await mountEditor({
      repository: proxyRepository(base, { saveEvent }),
      sources,
    })
    await wrapper.get('input[name="eventTitle"]').setValue('有来源的家庭事件')
    await wrapper.get('input[name="dateDisplay"]').setValue('2005')
    await wrapper.get('input[name="dateStart"]').setValue('2005')
    await wrapper.get('input[name="dateEnd"]').setValue('2005')
    await wrapper.get('input[value="person-lin-hai"]').setValue(true)
    await wrapper.get('input[aria-label="林海的事件角色"]').setValue(' 讲述者 ')
    await wrapper.get(`input[value="${sources[0]!.id}"]`).setValue(true)
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    expect(saveEvent).toHaveBeenCalledOnce()
    expect(saveEvent.mock.calls[0]![0].sourceIds).toEqual([sources[0]!.id])
    expect(saveEvent.mock.calls[0]![0].participantRoles).toEqual({
      'person-lin-hai': '讲述者',
    })
    expect((await base.listEvents(PROJECT_ID)).at(-1)?.participantRoles).toEqual({
      'person-lin-hai': '讲述者',
    })
  })

  it('requires explicit confirmation before saving an outside-lifespan warning', async () => {
    const base = makeRepository()
    const saveEvent = vi.fn(base.saveEvent.bind(base))
    const person = await base.getPerson('person-lin-chen')
    const { wrapper } = await mountEditor({ repository: proxyRepository(base, { saveEvent }), people: [person] })
    await wrapper.get('input[name="eventTitle"]').setValue('出生前的记录')
    await wrapper.get('input[name="dateDisplay"]').setValue('1900')
    await wrapper.get('input[name="dateStart"]').setValue('1900')
    await wrapper.get('input[name="dateEnd"]').setValue('1900')
    await wrapper.get('input[value="person-lin-chen"]').setValue(true)
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    expect(saveEvent).not.toHaveBeenCalled()
    expect(wrapper.get('[role="dialog"]').text()).toContain('出生前')
    await wrapper.get('button[name="确认并保存事件"]').trigger('click')
    await flushPromises()
    expect(saveEvent).toHaveBeenCalledOnce()
  })

  it('keeps failures visible, keeps the drawer open, and ignores duplicate submits', async () => {
    const base = makeRepository()
    const pending = deferred<FamilyEvent>()
    const saveEvent = vi.fn((_event: FamilyEvent) => pending.promise)
    const { wrapper, session } = await mountEditor({ repository: proxyRepository(base, { saveEvent }) })
    await wrapper.get('input[name="eventTitle"]').setValue('待保存事件')
    await wrapper.get('select[name="datePrecision"]').setValue('unknown')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    expect(saveEvent).toHaveBeenCalledOnce()
    expect(session.saveStatus).toBe('saving')
    pending.resolve(saveEvent.mock.calls[0]![0])
    await flushPromises()

    const failedRepository = proxyRepository(base, {
      saveEvent: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    })
    const failure = await mountEditor({ repository: failedRepository })
    await failure.wrapper.get('input[name="eventTitle"]').setValue('失败事件')
    await failure.wrapper.get('select[name="datePrecision"]').setValue('unknown')
    await failure.wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()
    expect(failure.wrapper.get('[role="alert"]').text()).toContain('quota exceeded')
    expect(failure.wrapper.get('[role="dialog"]')).toBeTruthy()
    expect(failure.session.saveStatus).toBe('failed')
  })

  it('confirms dirty close and does not discard before confirmation', async () => {
    const { wrapper } = await mountEditor()
    await wrapper.get('input[name="eventTitle"]').setValue('未保存事件')
    await wrapper.get('button[aria-label="关闭事件编辑器"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[role="dialog"]').some((dialog) => dialog.text().includes('放弃未保存的事件修改'))).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it.each([
    ['exact', '2001', '2001', '2001'],
    ['about', '1999', '2001', '约 1999—2001'],
    ['before', '', '1980', '1980 以前'],
    ['after', '2020', '', '2020 以后'],
    ['range', '1991', '1993', '1991—1993'],
    ['unknown', '', '', '日期未知'],
  ] as const)('generates a canonical %s display when the editor display is empty', async (
    precision,
    start,
    end,
    expected,
  ) => {
    const { wrapper } = await mountEditor()
    await wrapper.get('input[name="eventTitle"]').setValue(`${precision} 日期事件`)
    await wrapper.get('select[name="datePrecision"]').setValue(precision)
    if (start) await wrapper.get('input[name="dateStart"]').setValue(start)
    if (end) await wrapper.get('input[name="dateEnd"]').setValue(end)
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted<FamilyEvent[]>('saved')?.[0]?.[0].date.display).toBe(expected)
  })

  it('rejects malformed non-empty ISO boundaries before repository save', async () => {
    const base = makeRepository()
    const saveEvent = vi.fn(base.saveEvent.bind(base))
    const { wrapper } = await mountEditor({ repository: proxyRepository(base, { saveEvent }) })
    await wrapper.get('input[name="eventTitle"]').setValue('畸形日期事件')
    await wrapper.get('input[name="dateStart"]').setValue('2024foo')
    await wrapper.get('input[name="dateEnd"]').setValue('2024')
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    expect(saveEvent).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('有效的 ISO 日期')
  })

  it.each([
    ['2025', '2020'],
    ['2020-03-02', '2020-03-01'],
  ])('blocks a definitely reversed range from %s to %s', async (start, end) => {
    const base = makeRepository()
    const saveEvent = vi.fn(base.saveEvent.bind(base))
    const { wrapper } = await mountEditor({ repository: proxyRepository(base, { saveEvent }) })
    await wrapper.get('input[name="eventTitle"]').setValue('逆序范围事件')
    await wrapper.get('select[name="datePrecision"]').setValue('range')
    await wrapper.get('input[name="dateStart"]').setValue(start)
    await wrapper.get('input[name="dateEnd"]').setValue(end)
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    expect(saveEvent).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('开始边界晚于结束边界')
  })

  it('allows a partial range whose possible boundaries overlap', async () => {
    const base = makeRepository()
    const saveEvent = vi.fn(base.saveEvent.bind(base))
    const { wrapper } = await mountEditor({ repository: proxyRepository(base, { saveEvent }) })
    await wrapper.get('input[name="eventTitle"]').setValue('重叠范围事件')
    await wrapper.get('select[name="datePrecision"]').setValue('range')
    await wrapper.get('input[name="dateStart"]').setValue('2020-12')
    await wrapper.get('input[name="dateEnd"]').setValue('2020')
    await wrapper.get('button[name="保存事件"]').trigger('click')
    await flushPromises()

    expect(saveEvent).toHaveBeenCalledOnce()
    expect(saveEvent.mock.calls[0]?.[0].date.display).toBe('2020-12—2020')
  })
})

describe('timeline view', () => {
  it('loads project events, filters by participant, and navigates to event and person details', async () => {
    const base = makeRepository()
    const listEvents = vi.fn(base.listEvents.bind(base))
    const repository = proxyRepository(base, { listEvents })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/timeline`)
    const wrapper = mount(TimelineView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    await router.isReady()
    await flushPromises()

    expect(listEvents).toHaveBeenCalledWith(PROJECT_ID)
    expect(wrapper.text()).toContain('林海出生')
    await wrapper.get('select[name="participantFilter"]').setValue('person-lin-yu')
    expect(wrapper.text()).toContain('林宇出生')
    expect(wrapper.text()).not.toContain('林海出生')

    await wrapper.get('button[aria-label="编辑事件：林宇出生"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编辑事件')
    await wrapper.get('button[aria-label="关闭事件编辑器"]').trigger('click')
    await wrapper.get('a[aria-label="打开人物详情：林宇"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))
    expect(router.currentRoute.value).toMatchObject({
      name: 'person-detail',
      params: { projectId: PROJECT_ID, personId: 'person-lin-yu' },
    })
  })

  it('paginates all active project people for filters and new events even when no events exist', async () => {
    const base = makeRepository()
    const first = await base.getPerson('person-lin-hai')
    const second = await base.getPerson('person-lin-chen')
    const duplicate = { ...first, names: [{ ...first.names[0]!, value: '不应覆盖第一页姓名' }] }
    const foreign = { ...second, id: 'foreign-person', projectId: 'another-project' }
    const deleted = { ...second, id: 'deleted-person', deletedAt: '2034-01-01T00:00:00.000Z' }
    const listPeople = vi.fn(async (_projectId: string, query: { page: number; pageSize: number }) => ({
      items: query.page === 1 ? [first] : [duplicate, second, foreign, deleted],
      total: 101,
      page: query.page,
      pageSize: query.pageSize,
    }))
    const repository = proxyRepository(base, {
      listEvents: vi.fn().mockResolvedValue([]),
      listPeople: listPeople as BranchloomRepository['listPeople'],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/timeline`)
    const wrapper = mount(TimelineView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    await router.isReady()
    await flushPromises()

    expect(listPeople.mock.calls.map(([, query]) => query.page)).toEqual([1, 2])
    const filterText = wrapper.get('select[name="participantFilter"]').text()
    expect(filterText).toContain('林海')
    expect(filterText).toContain('林晨')
    expect(filterText).not.toContain('不应覆盖第一页姓名')
    expect(filterText).not.toContain('foreign-person')
    await wrapper.get('button[name="新建事件"]').trigger('click')
    const participantLabels = wrapper.findAll('.event-editor__participants label').map((label) => label.text())
    expect(participantLabels).toEqual(['林海', '林晨'])
  })

  it('uses the adapter page size to load every frozen page when the adapter caps requests', async () => {
    const base = makeRepository()
    const source = await base.getPerson('person-lin-hai')
    const listPeople = vi.fn(async (_projectId: string, query: { page: number }) => ({
      items: [{ ...source, id: `capped-${query.page}` }],
      total: 101,
      page: query.page,
      pageSize: 50,
    }))
    const repository = proxyRepository(base, {
      listEvents: vi.fn().mockResolvedValue([]),
      listPeople: listPeople as BranchloomRepository['listPeople'],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/timeline`)
    const wrapper = mount(TimelineView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    await router.isReady()
    await flushPromises()

    expect(listPeople.mock.calls.map(([, query]) => query.page)).toEqual([1, 2, 3])
    expect(wrapper.findAll('select[name="participantFilter"] option')).toHaveLength(4)
  })

  it('freezes max pages from the first response instead of chasing later total growth', async () => {
    const base = makeRepository()
    const source = await base.getPerson('person-lin-hai')
    const listPeople = vi.fn(async (_projectId: string, query: { page: number }) => ({
      items: [{ ...source, id: `growth-${query.page}` }],
      total: query.page === 1 ? 50 : 10_000,
      page: query.page,
      pageSize: 25,
    }))
    const repository = proxyRepository(base, {
      listEvents: vi.fn().mockResolvedValue([]),
      listPeople: listPeople as BranchloomRepository['listPeople'],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/timeline`)
    const wrapper = mount(TimelineView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    await router.isReady()
    await flushPromises()

    expect(listPeople.mock.calls.map(([, query]) => query.page)).toEqual([1, 2])
  })

  it('terminates when a repeated page adds no new active person IDs', async () => {
    const base = makeRepository()
    const source = await base.getPerson('person-lin-hai')
    const listPeople = vi.fn(async (_projectId: string, query: { page: number }) => ({
      items: [source],
      total: 1_000,
      page: query.page,
      pageSize: 10,
    }))
    const repository = proxyRepository(base, {
      listEvents: vi.fn().mockResolvedValue([]),
      listPeople: listPeople as BranchloomRepository['listPeople'],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/timeline`)
    const wrapper = mount(TimelineView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    await router.isReady()
    await flushPromises()

    expect(listPeople.mock.calls.map(([, query]) => query.page)).toEqual([1, 2])
  })
})
