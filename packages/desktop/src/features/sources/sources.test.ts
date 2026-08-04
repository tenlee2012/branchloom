import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../app/router'
import { useSessionStore } from '../../app/stores/session'
import type {
  Attachment,
  BranchloomRepository,
  Citation,
  Source,
} from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import AttachmentPanel from './components/AttachmentPanel.vue'
import CitationEditor from './components/CitationEditor.vue'
import SourceEditorDrawer from './components/SourceEditorDrawer.vue'
import SourcesView from './views/SourcesView.vue'

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
    clock: () => new Date('2035-06-07T08:09:10.000Z'),
    idFactory: () => `source-id-${++id}`,
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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function mountSourceEditor(options: {
  repository?: BranchloomRepository
  source?: Source
} = {}) {
  const repository = options.repository ?? makeRepository()
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.openProject(await repository.getProject(PROJECT_ID))
  const wrapper = mount(SourceEditorDrawer, {
    attachTo: document.body,
    props: {
      open: true,
      projectId: PROJECT_ID,
      ...(options.source ? { source: options.source } : {}),
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

async function mountCitationEditor(options: {
  repository?: BranchloomRepository
  citation?: Citation
} = {}) {
  const repository = options.repository ?? makeRepository()
  const [sources, citations, attachments, attachmentLinks, relationships, events, peoplePage] = await Promise.all([
    repository.listSources(PROJECT_ID),
    repository.listCitations(PROJECT_ID),
    repository.listAttachments(PROJECT_ID),
    repository.listAttachmentLinks(PROJECT_ID),
    repository.listRelationships(PROJECT_ID),
    repository.listEvents(PROJECT_ID),
    repository.listPeople(PROJECT_ID, { page: 1, pageSize: 100, sort: 'name' }),
  ])
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.openProject(await repository.getProject(PROJECT_ID))
  const wrapper = mount(CitationEditor, {
    attachTo: document.body,
    props: {
      open: true,
      projectId: PROJECT_ID,
      sources,
      attachments,
      attachmentLinks,
      relationships,
      events,
      people: peoplePage.items,
      ...(options.citation ? { citation: options.citation } : {}),
    },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await flushPromises()
  return { wrapper, repository, session, sources, citations, attachments }
}

async function mountSourcesView(repository: BranchloomRepository, path = `/project/${PROJECT_ID}/sources`) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter('memory')
  await router.push(path)
  const wrapper = mount(SourcesView, {
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
  return { wrapper, router }
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('source editor', () => {
  it('creates every structured source field and preserves custom typed date semantics', async () => {
    const { wrapper, repository, session } = await mountSourceEditor()
    await wrapper.get('input[name="sourceTitle"]').setValue('  侨批档案  ')
    await wrapper.get('select[name="sourceType"]').setValue('archive')
    await wrapper.get('input[name="sourceAuthor"]').setValue(' 林岚 ')
    await wrapper.get('input[name="sourceRepository"]').setValue(' 福建省档案馆 ')
    await wrapper.get('select[name="datePrecision"]').setValue('about')
    await wrapper.get('input[name="dateDisplay"]').setValue('民国二十五年前后')
    await wrapper.get('input[name="dateStart"]').setValue('1935')
    await wrapper.get('input[name="dateEnd"]').setValue('1937')
    await wrapper.get('input[name="sourceUrl"]').setValue('https://example.test/archive')
    await wrapper.get('input[name="sourceReferenceCode"]').setValue(' FJ-1936-8 ')
    await wrapper.get('textarea[name="sourceNotes"]').setValue(' 原始装订册 ')
    await wrapper.get('button[name="保存来源"]').trigger('click')
    await flushPromises()

    const saved = wrapper.emitted<Source[]>('saved')?.[0]?.[0]
    expect(saved).toMatchObject({
      projectId: PROJECT_ID,
      title: '侨批档案',
      type: 'archive',
      author: '林岚',
      repository: '福建省档案馆',
      url: 'https://example.test/archive',
      referenceCode: 'FJ-1936-8',
      date: {
        display: '民国二十五年前后',
        start: '1935',
        end: '1937',
        precision: 'about',
      },
      notes: '原始装订册',
    })
    expect((await repository.listSources(PROJECT_ID)).find(({ id }) => id === saved?.id)).toEqual(saved)
    expect(session.saveStatus).toBe('saved')
  })

  it('rejects non-http URLs without writing and accepts http URLs', async () => {
    const { wrapper, repository } = await mountSourceEditor()
    const before = await repository.listSources(PROJECT_ID)
    await wrapper.get('input[name="sourceTitle"]').setValue('网页资料')
    await wrapper.get('select[name="sourceType"]').setValue('web')
    await wrapper.get('input[name="sourceUrl"]').setValue('file:///tmp/private.html')
    await wrapper.get('button[name="保存来源"]').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toContain('http:// 或 https://')
    expect(await repository.listSources(PROJECT_ID)).toEqual(before)

    await wrapper.get('input[name="sourceUrl"]').setValue('http://example.test/source')
    await wrapper.get('button[name="保存来源"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted<Source[]>('saved')?.[0]?.[0]?.url).toBe('http://example.test/source')
  })

  it('rejects a definitely reversed source date range', async () => {
    const { wrapper, repository } = await mountSourceEditor()
    const before = await repository.listSources(PROJECT_ID)
    await wrapper.get('input[name="sourceTitle"]').setValue('日期倒置的档案')
    await wrapper.get('select[name="datePrecision"]').setValue('range')
    await wrapper.get('input[name="dateStart"]').setValue('2001')
    await wrapper.get('input[name="dateEnd"]').setValue('1999-12-31')
    await wrapper.get('button[name="保存来源"]').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('开始边界晚于结束边界')
    expect(await repository.listSources(PROJECT_ID)).toEqual(before)
  })

  it('edits a source in place without changing its stable id or typed date', async () => {
    const repository = makeRepository()
    const source = (await repository.listSources(PROJECT_ID)).find(({ id }) => id === 'source-family-register')!
    const { wrapper } = await mountSourceEditor({ repository, source })
    await wrapper.get('input[name="sourceTitle"]').setValue('林氏族谱馆藏抄本')
    await wrapper.get('input[name="sourceRepository"]').setValue('新馆藏机构')
    await wrapper.get('button[name="保存来源"]').trigger('click')
    await flushPromises()

    const saved = wrapper.emitted<Source[]>('saved')?.[0]?.[0]
    expect(saved?.id).toBe(source.id)
    expect(saved?.date).toEqual(source.date)
    expect((await repository.listSources(PROJECT_ID)).filter(({ id }) => id === source.id)).toEqual([
      expect.objectContaining({ title: '林氏族谱馆藏抄本', repository: '新馆藏机构' }),
    ])
  })

  it('keeps dirty edits open, prevents double saves, and exposes persistent save failures', async () => {
    const base = makeRepository()
    const pending = deferred<Source>()
    const saveSource = vi.fn(() => pending.promise)
    const { wrapper, session } = await mountSourceEditor({
      repository: proxyRepository(base, { saveSource }),
    })
    await wrapper.get('input[name="sourceTitle"]').setValue('待保存资料')
    await wrapper.get('button[aria-label="关闭来源编辑器"]').trigger('click')
    expect(wrapper.text()).toContain('放弃未保存的修改')
    await wrapper.get('button[name="继续编辑"]').trigger('click')

    const saveButton = wrapper.get('button[name="保存来源"]')
    await saveButton.trigger('click')
    await saveButton.trigger('click')
    expect(saveSource).toHaveBeenCalledTimes(1)
    expect(session.saveStatus).toBe('saving')
    pending.reject(new Error('quota exceeded'))
    await flushPromises()
    expect(session.saveStatus).toBe('failed')
    expect(wrapper.get('[role="alert"]').text()).toContain('quota exceeded')
    expect(wrapper.get('[role="dialog"]')).toBeTruthy()
  })
})

describe('citations and attachment links', () => {
  it('creates and edits locator, excerpt, accessed date, notes, target, and attachment links atomically', async () => {
    const { wrapper, repository, sources, attachments } = await mountCitationEditor()
    await wrapper.get('select[name="citationSource"]').setValue(sources[0]!.id)
    await wrapper.get('select[name="citationTargetType"]').setValue('event')
    await wrapper.get('select[name="citationTargetId"]').setValue('event-family-reunion')
    await wrapper.get('input[name="citationLocator"]').setValue(' 第 8 页 ')
    await wrapper.get('textarea[name="citationExcerpt"]').setValue(' 家人于夏日重聚。 ')
    await wrapper.get('select[name="accessedPrecision"]').setValue('before')
    await wrapper.get('input[name="accessedDisplay"]').setValue('整理前已查阅')
    await wrapper.get('input[name="accessedEnd"]').setValue('2035-06')
    await wrapper.get('textarea[name="citationNotes"]').setValue(' 待核原件 ')
    await wrapper.get(`input[value="${attachments[0]!.id}"]`).setValue(true)
    await wrapper.get('button[name="保存引用"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    const saved = wrapper.emitted<Citation[]>('saved')?.[0]?.[0]
    expect(saved).toMatchObject({
      sourceId: sources[0]!.id,
      targetType: 'event',
      targetId: 'event-family-reunion',
      locator: '第 8 页',
      excerpt: '家人于夏日重聚。',
      accessedAt: { display: '整理前已查阅', end: '2035-06', precision: 'before' },
      notes: '待核原件',
    })
    expect((await repository.listAttachmentLinks(PROJECT_ID))).toContainEqual(expect.objectContaining({
      attachmentId: attachments[0]!.id,
      targetType: 'citation',
      targetId: saved?.id,
    }))
    expect(repository.getHistoryState()).toMatchObject({ canUndo: true, canRedo: false })
    await repository.undo()
    expect((await repository.listCitations(PROJECT_ID)).some(({ id }) => id === saved?.id)).toBe(false)
    expect((await repository.listAttachmentLinks(PROJECT_ID)).some(({ targetId }) => targetId === saved?.id)).toBe(false)
  })

  it('rejects cross-project source, target, and attachment references without partial writes or history', async () => {
    const repository = makeRepository()
    const citation: Citation = {
      id: 'citation-invalid',
      projectId: PROJECT_ID,
      sourceId: 'source-family-register',
      targetType: 'person',
      targetId: 'person-lin-hai',
      notes: '',
    }
    const before = await repository.listCitations(PROJECT_ID)
    await expect(repository.saveCitationWithAttachmentLinks(citation, ['missing-attachment'])).rejects.toThrow('attachment')
    expect(await repository.listCitations(PROJECT_ID)).toEqual(before)
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })

    await expect(repository.saveCitationWithAttachmentLinks({
      ...citation,
      id: 'citation-invalid-source',
      sourceId: 'missing-source',
    }, [])).rejects.toThrow('source')
    await expect(repository.saveCitationWithAttachmentLinks({
      ...citation,
      id: 'citation-invalid-target',
      targetId: 'missing-person',
    }, [])).rejects.toThrow('Typed target')
    expect(await repository.listCitations(PROJECT_ID)).toEqual(before)
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('edits a citation and replaces its attachment links in the same undoable write', async () => {
    const repository = makeRepository()
    const citation = (await repository.listCitations(PROJECT_ID)).find(({ id }) => id === 'citation-hai-register')!
    const { wrapper } = await mountCitationEditor({ repository, citation })
    const missingAttachment = wrapper.get('input[value="attachment-missing-letter"]')
    expect((missingAttachment.element as HTMLInputElement).checked).toBe(true)
    await missingAttachment.setValue(false)
    await wrapper.get('input[name="citationLocator"]').setValue('第 19 页')
    await wrapper.get('button[name="保存引用"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted<Citation[]>('saved')?.[0]?.[0]).toMatchObject({
      id: citation.id,
      locator: '第 19 页',
    })
    expect((await repository.listAttachmentLinks(PROJECT_ID)).some(({ targetId }) => targetId === citation.id)).toBe(false)
    await repository.undo()
    expect((await repository.listCitations(PROJECT_ID)).find(({ id }) => id === citation.id)?.locator).toBe('第 18 页')
    expect((await repository.listAttachmentLinks(PROJECT_ID)).some(({ targetId }) => targetId === citation.id)).toBe(true)
  })

  it('rejects a definitely reversed citation access-date range', async () => {
    const { wrapper, repository, sources } = await mountCitationEditor()
    const before = await repository.listCitations(PROJECT_ID)
    await wrapper.get('select[name="citationSource"]').setValue(sources[0]!.id)
    await wrapper.get('select[name="citationTargetId"]').setValue('person-lin-hai')
    await wrapper.get('select[name="accessedPrecision"]').setValue('range')
    await wrapper.get('input[name="accessedStart"]').setValue('2035-06')
    await wrapper.get('input[name="accessedEnd"]').setValue('2034')
    await wrapper.get('button[name="保存引用"]').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('开始边界晚于结束边界')
    expect(await repository.listCitations(PROJECT_ID)).toEqual(before)
  })

  it('does not partially save a citation or its links when persistence fails', async () => {
    const repository = makeRepository()
    const beforeCitations = await repository.listCitations(PROJECT_ID)
    const beforeLinks = await repository.listAttachmentLinks(PROJECT_ID)
    repository.failNextWrite(new Error('disk full'))
    await expect(repository.saveCitationWithAttachmentLinks({
      id: 'citation-persistence-failure',
      projectId: PROJECT_ID,
      sourceId: 'source-family-register',
      targetType: 'person',
      targetId: 'person-lin-hai',
      notes: '',
    }, ['attachment-register-scan'])).rejects.toThrow('Injected write failure')
    expect(await repository.listCitations(PROJECT_ID)).toEqual(beforeCitations)
    expect(await repository.listAttachmentLinks(PROJECT_ID)).toEqual(beforeLinks)
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })
  })
})

describe('source research view', () => {
  it('lists all sources, searches and filters, counts citations, and links backlinks to their targets', async () => {
    const { wrapper } = await mountSourcesView(makeRepository())
    expect(wrapper.findAll('[data-source-row]')).toHaveLength(5)
    const register = wrapper.get('[data-source-id="source-family-register"]')
    expect(register.text()).toContain('2 条引用')
    expect(register.get('a[href*="people/person-lin-hai"]').text()).toContain('林海')
    expect(register.get('a[href*="relationshipId=relationship-guoqiang-hai"]').text()).toContain('亲子')

    await wrapper.get('input[name="sourceSearch"]').setValue('口述')
    expect(wrapper.findAll('[data-source-row]')).toHaveLength(1)
    await wrapper.get('select[name="sourceTypeFilter"]').setValue('book')
    expect(wrapper.findAll('[data-source-row]')).toHaveLength(0)
    await wrapper.get('input[name="sourceSearch"]').setValue('')
    expect(wrapper.findAll('[data-source-row]')).toHaveLength(1)
    expect(wrapper.text()).toContain('泉州地方志')

    await wrapper.get('button[name="编辑来源：泉州地方志：华侨与家庭"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编辑资料来源')
  })

  it('opens citation editing from a backlink and labels unused sources', async () => {
    const { wrapper } = await mountSourcesView(makeRepository())
    expect(wrapper.get('[data-source-id="source-unfiled-letter"]').text()).toContain('未使用')
    await wrapper.get('button[name="编辑引用：citation-hai-register"]').trigger('click')
    const dialog = wrapper.get('[role="dialog"]')
    expect(dialog.text()).toContain('编辑引用')
    expect((dialog.get('input[name="citationLocator"]').element as HTMLInputElement).value).toBe('第 18 页')
  })

  it('loads every active people page so source backlinks and unused status are complete', async () => {
    const base = makeRepository()
    const first = await base.getPerson('person-lin-hai')
    const second = {
      ...await base.getPerson('person-lin-chen'),
      id: 'person-second-page',
      names: [{ type: 'personal', primary: true as const, value: '第二页人物' }],
      sourceIds: ['source-unfiled-letter'],
    }
    const duplicate = { ...first, names: [{ type: 'personal', primary: true as const, value: '不应覆盖第一页姓名' }] }
    const listPeople = vi.fn(async (_projectId: string, query: { page: number; pageSize: number }) => ({
      items: query.page === 1 ? [first] : [duplicate, second],
      total: 101,
      page: query.page,
      pageSize: query.pageSize,
    }))
    const repository = proxyRepository(base, {
      listPeople: listPeople as BranchloomRepository['listPeople'],
    })
    const { wrapper } = await mountSourcesView(repository)

    expect(listPeople.mock.calls.map(([, query]) => query.page)).toEqual([1, 2])
    const source = wrapper.get('[data-source-id="source-unfiled-letter"]')
    expect(source.text()).toContain('第二页人物')
    expect(source.text()).not.toContain('未使用')
    expect(source.text()).not.toContain('不应覆盖第一页姓名')
  })

  it('shows deletion impact before confirmation and atomically removes citations, backlinks, and source references', async () => {
    const repository = makeRepository()
    const { wrapper } = await mountSourcesView(repository)
    await wrapper.get('button[name="删除来源：林氏族谱民国抄本"]').trigger('click')
    const dialog = wrapper.get('[role="dialog"]')
    expect(dialog.text()).toContain('2 条引用')
    expect(dialog.text()).toContain('人物')
    expect(dialog.text()).toContain('关系')
    expect(dialog.text()).toContain('事件')
    await dialog.get('button[name="确认删除来源"]').trigger('click')
    await flushPromises()

    expect((await repository.listSources(PROJECT_ID)).some(({ id }) => id === 'source-family-register')).toBe(false)
    expect((await repository.listCitations(PROJECT_ID)).some(({ sourceId }) => sourceId === 'source-family-register')).toBe(false)
    expect((await repository.getPerson('person-lin-hai')).sourceIds).not.toContain('source-family-register')
    expect((await repository.listEvents(PROJECT_ID)).flatMap(({ sourceIds }) => sourceIds)).not.toContain('source-family-register')
    expect((await repository.listRelationships(PROJECT_ID)).flatMap(({ sourceIds }) => sourceIds)).not.toContain('source-family-register')
    expect((await repository.listAttachmentLinks(PROJECT_ID)).some(({ targetId }) => targetId === 'citation-hai-register')).toBe(false)
  })

  it('blocks deletion until authoritative impact loads and lets the user retry a failed impact request', async () => {
    const base = makeRepository()
    const deleteSource = vi.fn(base.deleteSource.bind(base))
    const getSourceDeletionImpact = vi.fn()
      .mockRejectedValueOnce(new Error('impact unavailable'))
      .mockImplementation((sourceId: string) => base.getSourceDeletionImpact(sourceId))
    const repository = proxyRepository(base, {
      deleteSource,
      getSourceDeletionImpact: getSourceDeletionImpact as BranchloomRepository['getSourceDeletionImpact'],
    })
    const { wrapper } = await mountSourcesView(repository)

    await wrapper.get('button[name="删除来源：林氏族谱民国抄本"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[role="dialog"]')
    const confirm = dialog.get('button[name="确认删除来源"]')
    expect(dialog.get('[role="alert"]').text()).toContain('impact unavailable')
    expect(confirm.attributes('disabled')).toBeDefined()
    await confirm.trigger('click')
    expect(deleteSource).not.toHaveBeenCalled()

    await dialog.get('button[name="重新计算删除影响"]').trigger('click')
    await flushPromises()
    expect(getSourceDeletionImpact).toHaveBeenCalledTimes(2)
    const retriedDialog = wrapper.get('[role="dialog"]')
    expect(retriedDialog.find('[role="alert"]').exists()).toBe(false)
    expect(retriedDialog.get('button[name="确认删除来源"]').attributes('disabled')).toBeUndefined()
  })

  it('keeps all source data and history unchanged when confirmed deletion persistence fails', async () => {
    const repository = makeRepository()
    const before = {
      sources: await repository.listSources(PROJECT_ID),
      citations: await repository.listCitations(PROJECT_ID),
      links: await repository.listAttachmentLinks(PROJECT_ID),
    }
    repository.failNextWrite(new Error('disk full'))
    await expect(repository.deleteSource('source-family-register')).rejects.toThrow('Injected write failure')
    expect(await repository.listSources(PROJECT_ID)).toEqual(before.sources)
    expect(await repository.listCitations(PROJECT_ID)).toEqual(before.citations)
    expect(await repository.listAttachmentLinks(PROJECT_ID)).toEqual(before.links)
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('preserves filters and an unsaved source draft when only the location query changes', async () => {
    const base = makeRepository()
    const listSources = vi.spyOn(base, 'listSources')
    const repository = proxyRepository(base, { listSources })
    const { wrapper, router } = await mountSourcesView(repository)

    await wrapper.get('input[name="sourceSearch"]').setValue('林氏')
    await wrapper.get('select[name="sourceTypeFilter"]').setValue('archive')
    await wrapper.get('button[name="新建来源"]').trigger('click')
    await wrapper.get('input[name="sourceTitle"]').setValue('未保存草稿')
    const callsBeforeNavigation = listSources.mock.calls.length

    await router.push(`/project/${PROJECT_ID}/sources?source=source-family-register`)
    await flushPromises()

    expect(listSources).toHaveBeenCalledTimes(callsBeforeNavigation)
    expect((wrapper.get('input[name="sourceSearch"]').element as HTMLInputElement).value).toBe('林氏')
    expect((wrapper.get('select[name="sourceTypeFilter"]').element as HTMLSelectElement).value).toBe('archive')
    expect((wrapper.get('input[name="sourceTitle"]').element as HTMLInputElement).value).toBe('未保存草稿')
    expect(wrapper.get('[role="dialog"]').text()).toContain('新建资料来源')
    expect(wrapper.get('[role="status"]').text()).toContain('已保留草稿')
  })

  it('announces loading and provides a retryable, understandable load error', async () => {
    const base = makeRepository()
    const pending = deferred<Source[]>()
    const repository = proxyRepository(base, { listSources: vi.fn(() => pending.promise) })
    const pinia = createPinia()
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/sources`)
    const wrapper = mount(SourcesView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    expect(wrapper.get('[role="status"]').text()).toContain('正在整理')
    pending.reject(new Error('local storage unavailable'))
    await flushPromises()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('local storage unavailable')
    expect(alert.get('button').text()).toContain('重新读取')
  })
})

describe('managed local attachments', () => {
  it('always exposes the real local file picker and never offers simulated metadata', async () => {
    const repository = makeRepository()
    const wrapper = mount(AttachmentPanel, {
      props: {
        projectId: PROJECT_ID,
        attachments: await repository.listAttachments(PROJECT_ID),
        attachmentLinks: await repository.listAttachmentLinks(PROJECT_ID),
      },
      global: { provide: { [branchloomRepositoryKey as symbol]: repository } },
    })
    mountedWrappers.push(wrapper)
    expect(wrapper.text()).toContain('本地文件')
    expect(wrapper.text()).not.toContain('原型演示')
    const input = wrapper.get('input[type="file"]')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')
    await wrapper.get('button[name="选择附件"]').trigger('click')
    expect(click).toHaveBeenCalledOnce()
    expect(wrapper.emitted('changed')).toBeUndefined()
  })

  it('opens the file picker for a missing attachment, then removes metadata and links after confirmation', async () => {
    const repository = makeRepository()
    const before = (await repository.listAttachments(PROJECT_ID)).find(({ id }) => id === 'attachment-missing-letter')!
    const linksBefore = (await repository.listAttachmentLinks(PROJECT_ID)).filter(({ attachmentId }) => attachmentId === before.id)
    const wrapper = mount(AttachmentPanel, {
      props: {
        projectId: PROJECT_ID,
        attachments: await repository.listAttachments(PROJECT_ID),
        attachmentLinks: await repository.listAttachmentLinks(PROJECT_ID),
      },
      global: {
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)
    const input = wrapper.get('input[type="file"]')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')
    await wrapper.get('button[name="重新选择附件：林国强旧信.pdf"]').trigger('click')
    expect(click).toHaveBeenCalledOnce()
    const unchanged = (await repository.listAttachments(PROJECT_ID)).find(({ id }) => id === before.id)!
    expect(unchanged).toEqual(before)
    expect((await repository.listAttachmentLinks(PROJECT_ID)).filter(({ attachmentId }) => attachmentId === before.id)).toEqual(linksBefore)

    await wrapper.setProps({ attachments: await repository.listAttachments(PROJECT_ID) })
    await wrapper.get('button[name="移除附件：林国强旧信.pdf"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('附件记录和 1 处关联')
    await wrapper.get('button[name="确认移除附件"]').trigger('click')
    await flushPromises()
    expect((await repository.listAttachments(PROJECT_ID)).some(({ id }) => id === before.id)).toBe(false)
    expect((await repository.listAttachmentLinks(PROJECT_ID)).some(({ attachmentId }) => attachmentId === before.id)).toBe(false)
  })

  it('keeps the removal confirmation open and shows a fallback when persistence rejects without details', async () => {
    const base = makeRepository()
    const repository = proxyRepository(base, {
      deleteAttachment: vi.fn().mockRejectedValue(new Error('')),
    })
    const wrapper = mount(AttachmentPanel, {
      props: {
        projectId: PROJECT_ID,
        attachments: await base.listAttachments(PROJECT_ID),
        attachmentLinks: await base.listAttachmentLinks(PROJECT_ID),
      },
      global: {
        provide: { [branchloomRepositoryKey as symbol]: repository },
        stubs: { Teleport: true },
      },
    })
    mountedWrappers.push(wrapper)

    await wrapper.get('button[name="移除附件：族谱第18页.jpg"]').trigger('click')
    await wrapper.get('button[name="确认移除附件"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="dialog"]')).toBeTruthy()
    expect(wrapper.get('[role="alert"]').text()).toContain('附件元数据暂时无法更新')
  })
})
