import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createAppRouter } from '../../app/router'
import { useSessionStore } from '../../app/stores/session'
import type {
  Attachment,
  AttachmentLink,
  BranchloomRepository,
  CareerRecord,
  Person,
} from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import DeletePersonDialog from './components/DeletePersonDialog.vue'
import CareerEditorDrawer from './components/CareerEditorDrawer.vue'
import PersonDetailPanel from './components/PersonDetailPanel.vue'
import PersonEditorDrawer from './components/PersonEditorDrawer.vue'
import PersonDetailView from './views/PersonDetailView.vue'
import PersonEditView from './views/PersonEditView.vue'

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

function makeRepository() {
  return new BrowserPrototypeRepository({
    storage: new MemoryStorage(),
    clock: () => new Date('2030-01-02T03:04:05.000Z'),
    idFactory: (() => {
      let next = 0
      return () => `editor-id-${++next}`
    })(),
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

async function mountEditor(options: {
  repository?: BranchloomRepository
  person?: Person
} = {}) {
  const repository = options.repository ?? makeRepository()
  const [project] = await repository.listProjects()
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.openProject(project!)
  const wrapper = mount(PersonEditorDrawer, {
    attachTo: document.body,
    props: {
      open: true,
      projectId: project!.id,
      person: options.person,
    } as { open: boolean; projectId: string; person: Person },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await nextTick()
  return { wrapper, repository, project: project!, session }
}

async function mountDetail(repository: BranchloomRepository, path: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter('memory')
  await router.push(path)
  const wrapper = mount(PersonDetailView, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await router.isReady()
  return { wrapper, router, session: useSessionStore(pinia) }
}

async function mountPersonEdit(repository: BranchloomRepository, person: Person) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const project = (await repository.listProjects())[0]!
  useSessionStore(pinia).openProject(project)
  const router = createAppRouter('memory')
  await router.push(`/project/${person.projectId}/people/${person.id}/edit`)
  const wrapper = mount(PersonEditView, {
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

async function mountCareerEditor(
  repository = makeRepository(),
  career?: CareerRecord,
) {
  const project = (await repository.listProjects())[0]!
  const person = await repository.getPerson('person-lin-hai')
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.openProject(project)
  const wrapper = mount(CareerEditorDrawer, {
    attachTo: document.body,
    props: {
      open: true,
      projectId: project.id,
      personId: person.id,
      ...(career ? { career } : {}),
    },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await flushPromises()
  return { wrapper, repository, project, person, session }
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('person editor', () => {
  it('creates a valid person from a trimmed name only and reports save transitions', async () => {
    const base = makeRepository()
    const save = deferred<Person>()
    const savePerson = vi.fn((person: Person) => save.promise.then(() => base.savePerson(person)))
    const repository = proxyRepository(base, { savePerson })
    const { wrapper, project, session } = await mountEditor({ repository })

    await wrapper.get('input[name="primaryName"]').setValue('  林岚  ')
    await wrapper.get('button[name="保存"]').trigger('click')
    expect(session.saveStatus).toBe('saving')
    expect(savePerson).toHaveBeenCalledTimes(1)
    const submitted = savePerson.mock.calls[0]![0]
    expect(submitted).toMatchObject({
      projectId: project.id,
      names: [{ value: '林岚', type: 'personal' }],
      sex: 'unknown',
      status: 'unknown',
      biography: '',
      notes: '',
    })
    expect(submitted).not.toHaveProperty('sourceIds')

    save.resolve(submitted)
    await flushPromises()
    expect(session.saveStatus).toBe('saved')
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('normalizes multiple names to exactly one primary name', async () => {
    const { wrapper } = await mountEditor()
    await wrapper.get('input[name="primaryName"]').setValue('林岚')
    await wrapper.get('button[name="添加姓名"]').trigger('click')
    await wrapper.findAll('input[name="personName"]')[0]!.setValue('阿岚')
    await wrapper.get('button[aria-label="设为主姓名：阿岚"]').trigger('click')
    await wrapper.get('button[name="添加姓名"]').trigger('click')
    await wrapper.findAll('input[name="personName"]')[1]!.setValue('Lan Lin')
    await wrapper.get('button[name="保存"]').trigger('click')
    await flushPromises()

    const saved = wrapper.emitted<Person[]>('saved')![0]![0]
    expect(saved.names.filter(({ primary }) => primary)).toHaveLength(1)
    expect(saved.names.find(({ primary }) => primary)?.value).toBe('阿岚')
  })

  it('keeps courtesy names and art names semantic while changing only the primary display pointer', async () => {
    const { wrapper, repository } = await mountEditor()
    await wrapper.get('input[name="primaryName"]').setValue('苏轼')
    await wrapper.get('button[name="添加姓名"]').trigger('click')
    await wrapper.findAll('input[name="personName"]')[0]!.setValue('子瞻')
    await wrapper.findAll('select[aria-label^="姓名类型"]')[0]!.setValue('courtesy')
    await wrapper.get('button[name="添加姓名"]').trigger('click')
    await wrapper.findAll('input[name="personName"]')[1]!.setValue('东坡居士')
    await wrapper.findAll('select[aria-label^="姓名类型"]')[1]!.setValue('art')
    await wrapper.get('button[aria-label="设为主姓名：东坡居士"]').trigger('click')
    await wrapper.get('button[name="保存"]').trigger('click')
    await flushPromises()

    const saved = wrapper.emitted<Person[]>('saved')![0]![0]
    expect(saved.names).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '子瞻', type: 'courtesy' }),
      expect.objectContaining({ value: '东坡居士', type: 'art' }),
    ]))
    expect(saved.names.find(({ primary }) => primary)?.value).toBe('东坡居士')
    expect((await repository.listPeople(saved.projectId, {
      page: 1,
      pageSize: 50,
      sort: 'name',
      search: '子瞻',
    })).items.map(({ id }) => id)).toContain(saved.id)
  })

  it('persists structured name details and removes an embedded name without a name id', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-lin-hai')
    const { wrapper } = await mountEditor({ repository, person })
    await flushPromises()

    const primaryField = (selector: string) =>
      wrapper.get('details[data-name-details="name-editor-0"]').get(selector)
    await primaryField('#name-editor-0-family-name').setValue(' 林 ')
    await primaryField('#name-editor-0-given-name').setValue(' 海 ')
    await primaryField('#name-editor-0-valid-from').setValue('1980')
    await primaryField('#name-editor-0-notes').setValue('户籍姓名')

    await wrapper.get('button[aria-label="移除姓名：海叔"]').trigger('click')
    const dialog = wrapper.get('[role="dialog"]')
    expect(dialog.text()).toContain('不会留下 name-id')
    await dialog.get('button[name="确认移除姓名"]').trigger('click')
    await wrapper.get('button[name="保存"]').trigger('click')
    await flushPromises()

    const saved = await repository.getPerson(person.id)
    expect(saved.names.some(({ value }) => value === '海叔')).toBe(false)
    expect(saved.names.find(({ primary }) => primary)).toMatchObject({
      familyName: '林',
      givenName: '海',
      validFrom: { display: '1980', precision: 'exact' },
      notes: '户籍姓名',
    })
  })

  it('creates an ancient office and its new organization in one save', async () => {
    const { wrapper, repository, person, session } = await mountCareerEditor()
    await wrapper.get('select[name="careerCategory"]').setValue('civil_office')
    await wrapper.get('input[name="newOrganizationName"]').setValue('杭州州府')
    await wrapper.get('#career-new-organization-type').setValue('imperial_court')
    await wrapper.get('#career-new-organization-aliases').setValue('临安府、杭州府')
    await wrapper.get('#career-new-organization-place').setValue('place-quanzhou')
    await wrapper.get('#career-new-organization-from').setValue('北宋')
    await wrapper.get('#career-new-organization-notes').setValue('机构沿革待考')
    const organizationSource = wrapper.find(
      '.career-editor__new-organization input[type="checkbox"]',
    )
    if (organizationSource.exists()) await organizationSource.setValue(true)
    await wrapper.get('input[name="careerPosition"]').setValue('通判')
    await wrapper.get('input[name="careerRegime"]').setValue('北宋')
    await wrapper.get('input[name="careerRank"]').setValue('从六品')
    await wrapper.get('input[name="careerStart"]').setValue('熙宁四年')
    await wrapper.get('input[name="careerEnd"]').setValue('熙宁七年')
    await wrapper.get('button[name="保存履历"]').trigger('click')
    await flushPromises()

    expect(session.saveStatus).toBe('saved')
    const saved = wrapper.emitted<unknown[]>('saved')![0]![0] as { id: string }
    const careers = await repository.listCareers(person.projectId, person.id)
    expect(careers.find(({ id }) => id === saved.id)).toMatchObject({
      category: 'civil_office',
      positionTitle: '通判',
      regime: '北宋',
      rankOrGrade: '从六品',
      start: { display: '熙宁四年', precision: 'unknown' },
    })
    expect(await repository.listOrganizations(person.projectId)).toContainEqual(
      expect.objectContaining({
        name: '杭州州府',
        type: 'imperial_court',
        aliases: ['临安府', '杭州府'],
        placeId: 'place-quanzhou',
        validFrom: { display: '北宋', precision: 'unknown' },
        notes: '机构沿革待考',
      }),
    )
  })

  it('shows career evidence impact before atomically deleting a career', async () => {
    const repository = makeRepository()
    const career = (await repository.listCareers('project-demo-family', 'person-lin-hai'))[0]!
    const sourceId = (await repository.listSources(career.projectId))[0]!.id
    const attachmentId = (await repository.listAttachments(career.projectId))[0]!.id
    await repository.saveCitation({
      id: 'citation-career-delete-impact',
      projectId: career.projectId,
      sourceId,
      targetType: 'career',
      targetId: career.id,
      notes: '',
    })
    await repository.saveAttachmentLink({
      id: 'attachment-career-delete-impact',
      projectId: career.projectId,
      attachmentId,
      targetType: 'citation',
      targetId: 'citation-career-delete-impact',
    })
    const { wrapper } = await mountCareerEditor(repository, career)
    await wrapper.get('button[name="删除履历"]').trigger('click')

    const dialog = wrapper.findAll('[role="dialog"]')
      .find((candidate) => candidate.text().includes('删除这条履历'))!
    expect(dialog.text()).toContain('1 条引用')
    expect(dialog.text()).toContain('1 个附件')
    await dialog.get('button[name="确认删除履历"]').trigger('click')
    await flushPromises()

    expect(await repository.listCareers(career.projectId, career.personId)).not.toContainEqual(
      expect.objectContaining({ id: career.id }),
    )
    expect(await repository.listCitations(career.projectId)).not.toContainEqual(
      expect.objectContaining({ id: 'citation-career-delete-impact' }),
    )
    expect(await repository.listAttachmentLinks(career.projectId)).not.toContainEqual(
      expect.objectContaining({ id: 'attachment-career-delete-impact' }),
    )
  })

  it('keeps local avatar upload and notes visible while grouping optional name details accessibly', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-lin-hai')
    const { wrapper } = await mountEditor({ repository, person })

    const avatar = wrapper.get('input[name="avatarFile"]')
    const notes = wrapper.get('textarea[name="notes"]')
    expect(avatar.attributes('type')).toBe('file')
    expect(avatar.attributes('accept')).toBe('image/*')
    expect(wrapper.find('input[name="avatarUrl"]').exists()).toBe(false)
    expect(avatar.element.closest('details')).toBeNull()
    expect(notes.element.closest('details')).toBeNull()

    const detailsDisclosure = wrapper.get(
      'details[data-name-details="name-editor-0"]',
    )
    expect(detailsDisclosure.get('summary').text()).toContain('更多姓名资料')
    expect(detailsDisclosure.find('#name-editor-0-context').exists()).toBe(true)
    expect(wrapper.find('input[name="nameLanguage"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('文字形式')
  })

  it('keeps page actions beside the avatar and applies avatar, birthplace, and album changes on save', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-chen-fang')
    const { wrapper, router } = await mountPersonEdit(repository, person)

    const heading = wrapper.get('.person-editor__page-heading')
    expect(heading.get('#person-edit-title').text()).toBe('编辑陈芳')
    expect(heading.get('button[name="取消"]')).toBeTruthy()
    expect(heading.get('button[name="保存"]')).toBeTruthy()
    expect(wrapper.text()).toContain('人物相册')
    expect(wrapper.get('select[name="birthPlaceId"]')).toBeTruthy()

    const overviewTab = wrapper.get('button[role="tab"]#person-edit-tab-overview')
    const lifeTab = wrapper.get('button[role="tab"]#person-edit-tab-life')
    const eventsTab = wrapper.get('button[role="tab"]#person-edit-tab-events')
    const materialsTab = wrapper.get('button[role="tab"]#person-edit-tab-materials')
    expect(wrapper.findAll('.person-editor__module-nav button[role="tab"]').map((tab) => tab.text()))
      .toEqual(['人物概览', '生平轨迹', '资料与相册', '事件'])
    expect(overviewTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-edit-life').attributes('style')).toContain('display: none')
    expect(wrapper.get('#person-edit-materials').attributes('style')).toContain('display: none')
    expect(wrapper.get('#person-edit-events').attributes('style')).toContain('display: none')

    await lifeTab.trigger('click')
    expect(lifeTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-edit-life').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#person-edit-panel-overview').attributes('style')).toContain('display: none')

    await eventsTab.trigger('click')
    expect(eventsTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-edit-events').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#person-edit-events').text()).toContain('事件记录')
    expect(wrapper.get('button[name="新建人物事件"]').classes()).toContain('base-button--secondary')
    await wrapper.get('button[aria-label="编辑事件：林海与陈芳离异"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编辑事件')
    expect(wrapper.get('input[name="eventTitle"]').element).toHaveProperty('value', '林海与陈芳离异')
    await wrapper.get('button[aria-label="关闭事件编辑器"]').trigger('click')

    await materialsTab.trigger('click')
    expect(materialsTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-edit-materials').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#person-edit-life').attributes('style')).toContain('display: none')
    expect(router.currentRoute.value.hash).toBe('')

    const avatar = wrapper.get('input[name="avatarFile"]')
    const avatarFile = new File([new Uint8Array([137, 80, 78, 71])], 'chen-avatar.png', {
      type: 'image/png',
    })
    Object.defineProperty(avatar.element, 'files', { configurable: true, value: [avatarFile] })
    await avatar.trigger('change')
    await vi.waitFor(() => expect(heading.get('img').attributes('src')).toContain('data:image/png;base64,'))
    expect((await repository.getPerson(person.id)).avatarUrl).toBeUndefined()

    const album = wrapper.get('input[name="albumFiles"]')
    const albumFile = new File([new Uint8Array([137, 80, 78, 71, 1])], 'family-photo.png', {
      type: 'image/png',
    })
    Object.defineProperty(album.element, 'files', { configurable: true, value: [albumFile] })
    await album.trigger('change')
    await vi.waitFor(() => expect(wrapper.get('.person-editor__photo--staged').text()).toContain('待保存'))

    await overviewTab.trigger('click')
    await wrapper.get('select[name="birthPlaceId"]').setValue('place-xiamen')
    await heading.get('button[name="保存"]').trigger('click')
    await flushPromises()

    await vi.waitFor(async () => {
      const persisted = await repository.getPerson(person.id)
      expect(persisted.birthPlaceId).toBe('place-xiamen')
      expect(persisted.avatarUrl).toContain('data:image/png;base64,')
    })
    const mediaLinks = (await repository.listAttachmentLinks(person.projectId)).filter((link) =>
      link.targetType === 'person' && link.targetId === person.id && link.role === 'media')
    expect(mediaLinks).toHaveLength(1)
    const mediaAttachment = (await repository.listAttachments(person.projectId))
      .find(({ id }) => id === mediaLinks[0]!.attachmentId)
    expect(mediaAttachment).toMatchObject({ name: 'family-photo.png', mimeType: 'image/png' })
    expect(mediaAttachment?.previewUrl).toContain('data:image/png;base64,')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))
  })

  it('removes legacy language and script fields when saving a person', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-lin-hai')
    const legacyPerson = {
      ...person,
      names: person.names.map((name) => ({ ...name, language: 'zh-CN', script: 'Hans' })),
    } as Person
    const { wrapper } = await mountEditor({ repository, person: legacyPerson })

    await wrapper.get('textarea[name="notes"]').setValue('默认可见的整理备注')
    await wrapper.get('button[name="保存"]').trigger('click')
    await flushPromises()

    const persisted = await repository.getPerson(person.id)
    expect(persisted.names.every((name) => !('language' in name) && !('script' in name))).toBe(true)
    expect(persisted.notes).toBe('默认可见的整理备注')
  })

  it('shows sex, avatar, and notes directly in person details', async () => {
    const repository = makeRepository()
    const source = await repository.getPerson('person-lin-hai')
    const person: Person = {
      ...source,
      avatarUrl: 'https://example.invalid/lin-hai.jpg',
      notes: '核对过的整理备注',
    }
    const wrapper = mount(PersonDetailPanel, { props: { person } })
    mountedWrappers.push(wrapper)

    expect(wrapper.get('img').attributes('src')).toBe(person.avatarUrl)
    expect(wrapper.get('img').attributes('alt')).toBe('林海的头像')
    expect(wrapper.get('[data-person-sex]').text()).toContain('男性')
    expect(wrapper.text()).toContain('林海')
    expect(wrapper.text()).toContain('海叔')
    expect(wrapper.get('.person-detail-panel__header button[name="编辑人物"]')).toBeTruthy()
    expect(wrapper.get('.person-detail-panel__header button[name="删除人物"]')).toBeTruthy()
    expect(wrapper.get('.person-detail-panel__commands').attributes('aria-label')).toBe('人物操作')
    expect(wrapper.get('button[name="编辑人物"]').classes()).toContain('person-detail-panel__action--edit')
    expect(wrapper.get('button[name="删除人物"]').classes()).toContain('person-detail-panel__action--delete')
    expect(wrapper.get('.person-detail-panel__action-divider').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.person-detail-panel__module-nav').attributes('aria-label')).toBe('人物档案模块')
    expect(wrapper.get('.person-detail-panel__workspace')).toBeTruthy()
    expect(wrapper.find('footer.person-detail-panel__actions').exists()).toBe(false)

    const overviewTab = wrapper.get('button[role="tab"]#person-detail-tab-overview')
    const lifeTab = wrapper.get('button[role="tab"]#person-detail-tab-life')
    const eventsTab = wrapper.get('button[role="tab"]#person-detail-tab-events')
    const materialsTab = wrapper.get('button[role="tab"]#person-detail-tab-materials')
    expect(wrapper.findAll('.person-detail-panel__module-nav button[role="tab"]').map((tab) => tab.text()))
      .toEqual(['人物概览', '生平轨迹', '资料与相册', '事件'])
    expect(overviewTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-life-track').attributes('style')).toContain('display: none')
    expect(wrapper.get('#person-materials').attributes('style')).toContain('display: none')
    expect(wrapper.get('#person-events').attributes('style')).toContain('display: none')

    await lifeTab.trigger('click')
    expect(lifeTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-life-track').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#person-overview').attributes('style')).toContain('display: none')
    const notes = wrapper.get('[data-person-notes]')
    expect(notes.text()).toContain('核对过的整理备注')
    expect(notes.element.closest('details')).toBeNull()

    await eventsTab.trigger('click')
    expect(eventsTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-events').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#person-life-track').attributes('style')).toContain('display: none')

    await materialsTab.trigger('click')
    expect(materialsTab.attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#person-materials').attributes('style')).not.toContain('display: none')
    expect(wrapper.get('#person-life-track').attributes('style')).toContain('display: none')
  })

  it('provides an accessible avatar fallback when no image is available', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-lin-hai')
    const wrapper = mount(PersonDetailPanel, { props: { person } })
    mountedWrappers.push(wrapper)

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[role="img"]').attributes('aria-label')).toBe('林海暂无头像')
  })

  it('shows person album thumbnails and opens an image preview', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-lin-hai')
    const attachment: Attachment = {
      id: 'attachment-person-photo',
      projectId: person.projectId,
      name: '林海青年照.png',
      mimeType: 'image/png',
      size: 128,
      previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
      contentHash: 'photo-hash',
      missing: false,
    }
    const link: AttachmentLink = {
      id: 'attachment-link-person-photo',
      projectId: person.projectId,
      attachmentId: attachment.id,
      targetType: 'person',
      targetId: person.id,
      role: 'media',
    }
    const wrapper = mount(PersonDetailPanel, {
      attachTo: document.body,
      props: { person, attachments: [attachment], attachmentLinks: [link] },
      global: { stubs: { Teleport: true } },
    })
    mountedWrappers.push(wrapper)

    await wrapper.get('button[role="tab"]#person-detail-tab-materials').trigger('click')
    const thumbnail = wrapper.get('button[aria-label="预览照片：林海青年照.png"]')
    expect(thumbnail.get('img').attributes('src')).toBe(attachment.previewUrl)
    await thumbnail.trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('林海青年照.png')
    expect(wrapper.get('.person-detail-panel__photo-preview').attributes('src')).toBe(attachment.previewUrl)
  })

  it('aggregates related events, citations, and attachments in person details', async () => {
    const repository = makeRepository()
    const person = await repository.getPerson('person-lin-hai')
    const { wrapper } = await mountDetail(
      repository,
      `/project/${person.projectId}/people/${person.id}`,
    )
    await flushPromises()

    await wrapper.get('button[role="tab"]#person-detail-tab-events').trigger('click')
    const events = wrapper.get('[data-person-events]')
    expect(events.text()).toContain('林海出生')
    expect(events.get('a[href*="event-hai-birth"]').attributes('href')).toContain(
      '/timeline?eventId=event-hai-birth',
    )
    expect(events.get('button[aria-label="编辑事件：林海出生"]')).toBeTruthy()
    expect(events.get('button[name="新建人物事件"]').classes()).toContain('base-button--secondary')

    await events.get('button[aria-label="编辑事件：林海出生"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编辑事件')
    expect(wrapper.get('input[name="eventTitle"]').element).toHaveProperty('value', '林海出生')
    await wrapper.get('button[aria-label="关闭事件编辑器"]').trigger('click')

    await events.get('button[name="新建人物事件"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('新建事件')
    expect((wrapper.get('input[type="checkbox"][value="person-lin-hai"]').element as HTMLInputElement).checked).toBe(true)
    const evidence = wrapper.get('[data-person-evidence]')
    expect(evidence.text()).toContain('林氏族谱民国抄本')
    expect(evidence.text()).toContain('族谱第18页.jpg')
    expect(evidence.text()).toContain('文件可用')
    const relationships = wrapper.get('[data-person-relationships]')
    expect(relationships.get('[aria-label="推导关系摘要"]').text()).toContain('孙辈')
    expect(relationships.get('[aria-label="推导关系摘要"]').text()).toContain('林宇')
  })

  it('shows a non-blocking warning when death is earlier than birth', async () => {
    const { wrapper } = await mountEditor()
    await wrapper.get('input[name="primaryName"]').setValue('林岚')
    await wrapper.get('input[name="birthDate"]').setValue('2000-01-01')
    await wrapper.get('input[name="deathDate"]').setValue('1999-12-31')

    expect(wrapper.get('[role="status"][data-life-date-warning]').text()).toContain('死亡日期早于出生日期')
    expect(wrapper.get('button[name="保存"]').attributes('disabled')).toBeUndefined()
  })

  it('keeps an unnamed draft open with an inline validation error', async () => {
    const { wrapper, session } = await mountEditor()
    await wrapper.get('button[name="保存"]').trigger('click')

    expect(wrapper.get('[role="alert"]').text()).toContain('至少填写一个姓名')
    expect(wrapper.get('[role="dialog"]')).toBeTruthy()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(session.saveStatus).toBe('saved')
  })

  it('keeps the accessible drawer open and shows persistent failure details', async () => {
    const base = makeRepository()
    const repository = proxyRepository(base, {
      savePerson: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    })
    const { wrapper, session } = await mountEditor({ repository })
    await wrapper.get('input[name="primaryName"]').setValue('林岚')
    await wrapper.get('button[name="保存"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('保存失败')
    expect(wrapper.get('[role="alert"] details').text()).toContain('quota exceeded')
    expect(wrapper.get('[role="dialog"]')).toBeTruthy()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(session.saveStatus).toBe('failed')
  })

  it('ignores a duplicate submit while the first save is pending', async () => {
    const base = makeRepository()
    const pending = deferred<Person>()
    const savePerson = vi.fn((_person: Person) => pending.promise)
    const repository = proxyRepository(base, { savePerson })
    const { wrapper } = await mountEditor({ repository })
    await wrapper.get('input[name="primaryName"]').setValue('林岚')

    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    expect(savePerson).toHaveBeenCalledOnce()

    pending.resolve(savePerson.mock.calls[0]![0])
    await flushPromises()
  })

  it.each([
    ['close button', async (wrapper: Awaited<ReturnType<typeof mountEditor>>['wrapper']) => {
      await wrapper.get('button[aria-label="关闭人物编辑器"]').trigger('click')
    }],
    ['backdrop', async (wrapper: Awaited<ReturnType<typeof mountEditor>>['wrapper']) => {
      await wrapper.get('.base-drawer__backdrop').trigger('click')
    }],
    ['Escape', async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await nextTick()
    }],
    ['cancel button', async (wrapper: Awaited<ReturnType<typeof mountEditor>>['wrapper']) => {
      await wrapper.get('button[name="取消"]').trigger('click')
    }],
  ])('confirms dirty data before closing through %s', async (_path, requestClose) => {
    const { wrapper } = await mountEditor()
    await wrapper.get('input[name="primaryName"]').setValue('未保存的人物')
    await requestClose(wrapper)
    await nextTick()

    expect(wrapper.get('[role="dialog"][aria-labelledby$="dialog-title"]').text()).toContain('放弃未保存的修改')
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('button[name="继续编辑"]').trigger('click')
    expect(wrapper.get('input[name="primaryName"]')).toBeTruthy()
  })

  it('previews relationship, event, and citation impact and deletes only after confirmation', async () => {
    const base = makeRepository()
    const person = await base.getPerson('person-lin-hai')
    const softDeletePerson = vi.fn(base.softDeletePerson.bind(base))
    const repository = proxyRepository(base, { softDeletePerson })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${person.projectId}/people/${person.id}`)
    const wrapper = mount(PersonDetailView, {
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

    await wrapper.get('button[name="删除人物"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.getComponent(DeletePersonDialog)
    const relationships = (await base.listRelationships(person.projectId))
      .filter(({ fromPersonId, toPersonId }) => fromPersonId === person.id || toPersonId === person.id).length
    const events = (await base.listEvents(person.projectId))
      .filter(({ participantIds }) => participantIds.includes(person.id)).length
    const citations = (await base.listCitations(person.projectId))
      .filter(({ targetType, targetId }) => targetType === 'person' && targetId === person.id).length
    expect(dialog.text()).toContain(`关系 ${relationships} 条`)
    expect(dialog.text()).toContain(`事件 ${events} 条`)
    expect(dialog.text()).toContain(`引用 ${citations} 条`)
    expect(softDeletePerson).not.toHaveBeenCalled()

    await dialog.get('button[name="确认删除"]').trigger('click')
    await flushPromises()
    expect(softDeletePerson).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-people'))
  })

  it('ignores stale person loads after the route changes', async () => {
    const base = makeRepository()
    const first = await base.getPerson('person-lin-hai')
    const second = await base.getPerson('person-lin-chen')
    const firstRequest = deferred<Person>()
    const secondRequest = deferred<Person>()
    const repository = proxyRepository(base, {
      getPerson: vi.fn((id: string) => id === first.id ? firstRequest.promise : secondRequest.promise),
    })
    const { wrapper, router } = await mountDetail(
      repository,
      `/project/${first.projectId}/people/${first.id}`,
    )

    await router.push(`/project/${second.projectId}/people/${second.id}`)
    secondRequest.resolve(second)
    await flushPromises()
    expect(wrapper.get('h1').text()).toContain('林晨')

    firstRequest.resolve(first)
    await flushPromises()
    expect(wrapper.get('h1').text()).toContain('林晨')
  })

  it('rejects a person returned for a different project route', async () => {
    const base = makeRepository()
    const person = await base.getPerson('person-lin-hai')
    const otherProject = await base.createProject({ name: '另一项目', description: '' })
    const { wrapper } = await mountDetail(
      base,
      `/project/${otherProject.id}/people/${person.id}`,
    )
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('人物不属于当前项目')
    expect(wrapper.findComponent(PersonDetailPanel).exists()).toBe(false)
  })

  it('keeps delete errors visible and does not leave the person route', async () => {
    const base = makeRepository()
    const person = await base.getPerson('person-lin-hai')
    const repository = proxyRepository(base, {
      softDeletePerson: vi.fn().mockRejectedValue(new Error('delete denied')),
    })
    const { wrapper, router, session } = await mountDetail(
      repository,
      `/project/${person.projectId}/people/${person.id}`,
    )
    await flushPromises()
    await wrapper.get('button[name="删除人物"]').trigger('click')
    await flushPromises()
    await wrapper.get('button[name="确认删除"]').trigger('click')
    await flushPromises()

    expect(wrapper.getComponent(DeletePersonDialog).text()).toContain('delete denied')
    expect(router.currentRoute.value.name).toBe('person-detail')
    expect(session.saveStatus).toBe('failed')
  })

  it('blocks deletion when impact counts cannot be loaded', async () => {
    const base = makeRepository()
    const person = await base.getPerson('person-lin-hai')
    const softDeletePerson = vi.fn(base.softDeletePerson.bind(base))
    const repository = proxyRepository(base, {
      listRelationships: vi.fn().mockRejectedValue(new Error('impact unavailable')),
      softDeletePerson,
    })
    const { wrapper } = await mountDetail(
      repository,
      `/project/${person.projectId}/people/${person.id}`,
    )
    await flushPromises()
    await wrapper.get('button[name="删除人物"]').trigger('click')
    await flushPromises()

    expect(wrapper.getComponent(DeletePersonDialog).text()).toContain('impact unavailable')
    expect(wrapper.get('button[name="确认删除"]').attributes('disabled')).toBeDefined()
    expect(softDeletePerson).not.toHaveBeenCalled()
  })
})
