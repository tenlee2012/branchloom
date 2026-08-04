import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { createAppRouter } from '../../app/router'
import type {
  BranchloomRepository,
  Page,
  Person,
  PersonQuery,
} from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import PeopleView from './views/PeopleView.vue'

const schedulerKey = Symbol.for('branchloom.peopleSearchScheduler')

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

function makeRepository() {
  return new BrowserPrototypeRepository({ storage: new MemoryStorage() })
}

function observePeopleQueries(repository: BranchloomRepository) {
  const listPeople = vi.fn(repository.listPeople.bind(repository))
  const proxy = new Proxy(repository, {
    get(target, property) {
      if (property === 'listPeople') return listPeople
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { repository: proxy, listPeople }
}

function overridePeopleQuery(
  repository: BranchloomRepository,
  listPeople: (projectId: string, query: PersonQuery) => Promise<Page<Person>>,
) {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'listPeople') return listPeople
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

interface TestScheduler {
  schedule(callback: () => void, delay: number): () => void
}

async function mountPeople(options: {
  path?: string
  repository?: BranchloomRepository
  scheduler?: TestScheduler
} = {}) {
  const repository = options.repository ?? makeRepository()
  const [project] = await repository.listProjects()
  const projectId = project!.id
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter('memory')
  await router.push(options.path ?? `/project/${projectId}/people`)
  const provide: Record<symbol, unknown> = {
    [branchloomRepositoryKey as symbol]: repository,
  }
  if (options.scheduler) provide[schedulerKey] = options.scheduler

  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router],
      provide,
    },
  })
  await router.isReady()
  await flushPromises()
  return { wrapper, router, projectId, repository }
}

function visiblePersonNames(wrapper: Awaited<ReturnType<typeof mountPeople>>['wrapper']) {
  return wrapper.findAll('[data-person-id] [data-person-name]').map((cell) => cell.text())
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('people list', () => {
  it('renders a canonical CLI person without the retired sourceIds field', async () => {
    const base = makeRepository()
    const [project] = await base.listProjects()
    const page = await base.listPeople(project!.id, { page: 1, pageSize: 1, sort: 'name' })
    const person = structuredClone(page.items[0]!)
    delete person.sourceIds
    const repository = overridePeopleQuery(base, async (_projectId, query) => ({
      items: [person],
      total: 1,
      page: query.page,
      pageSize: query.pageSize,
    }))

    const { wrapper } = await mountPeople({ repository })

    expect(wrapper.get('.people-view__count').text()).toContain('1')
    expect(wrapper.get('table[aria-label="人物列表"]')).toBeTruthy()
    expect(visiblePersonNames(wrapper)).toEqual([person.names.find(({ primary }) => primary)!.value])
    wrapper.unmount()
  })

  it('uses the canonical personId query when locating a person in the real tree route', async () => {
    const { wrapper, router } = await mountPeople()
    await wrapper.get('a[aria-label="在家谱树中定位：陈芳"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('project-tree')
    expect(router.currentRoute.value.query).toMatchObject({ personId: 'person-chen-fang' })
    expect(router.currentRoute.value.query.person).toBeUndefined()
    expect(wrapper.text()).toContain('中心人物：陈芳')
    wrapper.unmount()
  })

  it.each([
    ['主姓名', '赵雯', ['林晨', '赵雯']],
    ['别名', '海叔', ['林海']],
    ['生平', '机械设计', ['林海']],
  ])('searches repository-backed %s text after 200 ms', async (_kind, search, expectedNames) => {
    vi.useFakeTimers()
    const observed = observePeopleQueries(makeRepository())
    const { wrapper, router } = await mountPeople({ repository: observed.repository })
    observed.listPeople.mockClear()

    await wrapper.get('input[aria-label="搜索人物"]').setValue(search)
    await vi.advanceTimersByTimeAsync(199)
    await flushPromises()
    expect(observed.listPeople).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()

    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ search, page: 1, pageSize: 5 }),
    )
    expect(visiblePersonNames(wrapper)).toEqual(expectedNames)
    expect(router.currentRoute.value.query.search).toBe(search)

    wrapper.unmount()
  })

  it('uses the injected scheduler for the 200 ms search debounce', async () => {
    const observed = observePeopleQueries(makeRepository())
    let scheduled: (() => void) | undefined
    let scheduledDelay = 0
    const cancel = vi.fn()
    const scheduler: TestScheduler = {
      schedule(callback, delay) {
        scheduled = callback
        scheduledDelay = delay
        return cancel
      },
    }
    const { wrapper } = await mountPeople({ repository: observed.repository, scheduler })
    observed.listPeople.mockClear()

    await wrapper.get('input[aria-label="搜索人物"]').setValue('晨晨')
    expect(scheduledDelay).toBe(200)
    expect(observed.listPeople).not.toHaveBeenCalled()

    scheduled?.()
    await flushPromises()
    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ search: '晨晨' }),
    )

    wrapper.unmount()
  })

  it('filters living/deceased people and source presence through the repository', async () => {
    const observed = observePeopleQueries(makeRepository())
    const { wrapper, router } = await mountPeople({ repository: observed.repository })

    await wrapper.get('select[aria-label="生存状态"]').setValue('deceased')
    await flushPromises()
    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'deceased', page: 1 }),
    )
    expect(wrapper.findAll('[data-person-status="deceased"]')).toHaveLength(2)
    expect(router.currentRoute.value.query.status).toBe('deceased')

    await wrapper.get('select[aria-label="生存状态"]').setValue('living')
    await wrapper.get('select[aria-label="来源状态"]').setValue('without')
    await flushPromises()
    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'living', hasSources: false }),
    )
    expect(wrapper.get('.people-view__state[role="status"]').text()).toContain('没有找到符合条件的人物')

    await wrapper.get('select[aria-label="生存状态"]').setValue('unknown')
    await flushPromises()
    expect(visiblePersonNames(wrapper)).toContain('林晨')
    expect(wrapper.findAll('[data-person-id]')).toHaveLength(1)

    wrapper.unmount()
  })

  it('combines advanced profile filters and restores them from the URL', async () => {
    const observed = observePeopleQueries(makeRepository())
    const { wrapper, router } = await mountPeople({ repository: observed.repository })

    await wrapper.get('select[aria-label="性别筛选"]').setValue('nonbinary')
    await wrapper.get('select[aria-label="头像状态"]').setValue('without')
    await wrapper.get('select[aria-label="出生资料状态"]').setValue('with')
    await flushPromises()

    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        sex: 'nonbinary',
        hasAvatar: false,
        hasBirth: true,
        page: 1,
      }),
    )
    expect(router.currentRoute.value.query).toMatchObject({
      sex: 'nonbinary',
      hasAvatar: 'false',
      hasBirth: 'true',
    })
    expect(visiblePersonNames(wrapper)).toEqual(['林宇'])

    await router.push(`/project/${router.currentRoute.value.params.projectId}/people?hasDeath=false&hasIssues=true`)
    await flushPromises()
    expect((wrapper.get('select[aria-label="死亡资料状态"]').element as HTMLSelectElement).value)
      .toBe('without')
    expect((wrapper.get('select[aria-label="资料问题状态"]').element as HTMLSelectElement).value)
      .toBe('with')
    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ hasDeath: false, hasIssues: true }),
    )

    wrapper.unmount()
  })

  it('changes sort order and keeps the sort in the URL', async () => {
    const observed = observePeopleQueries(makeRepository())
    const { wrapper, router } = await mountPeople({ repository: observed.repository })

    await wrapper.get('select[aria-label="排序方式"]').setValue('updatedAt')
    await flushPromises()

    expect(observed.listPeople).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ sort: 'updatedAt', pageSize: 5 }),
    )
    expect(router.currentRoute.value.query.sort).toBe('updatedAt')
    expect(visiblePersonNames(wrapper)[0]).toBe('林晨')

    wrapper.unmount()
  })

  it('renders an accessible empty state for a query with no matches', async () => {
    vi.useFakeTimers()
    const { wrapper } = await mountPeople()

    await wrapper.get('input[aria-label="搜索人物"]').setValue('不存在的人物')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()

    const empty = wrapper.get('.people-view__state[role="status"]')
    expect(empty.text()).toContain('没有找到符合条件的人物')
    expect(wrapper.find('table').exists()).toBe(false)

    wrapper.unmount()
  })

  it('uses a semantic paged table and preserves row selection', async () => {
    const { wrapper, router } = await mountPeople()

    expect(wrapper.get('table[aria-label="人物列表"]')).toBeTruthy()
    expect(wrapper.get('thead').text()).toContain('性别')
    expect(wrapper.get('thead').text()).not.toContain('当前／最近履历')
    expect(wrapper.get('thead').text()).not.toContain('来源')
    expect(wrapper.get('thead').text()).not.toContain('问题')
    expect(wrapper.find('[data-person-issues]').exists()).toBe(false)
    expect(wrapper.find('a[aria-label^="检查人物资料："]').exists()).toBe(false)
    expect(wrapper.find('tbody th small').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')).toHaveLength(5)
    expect(wrapper.get('[aria-label="分页信息"]').text()).toContain('第 1 / 3 页')

    const firstRow = wrapper.findAll('tbody tr')[0]!
    const actions = firstRow.findAll('.people-table__icon-action')
    expect(actions).toHaveLength(4)
    for (const action of actions) {
      expect(action.find('svg').exists()).toBe(true)
      expect(action.attributes('title')).toBeTruthy()
      expect(action.text()).toBe('')
    }
    const selectedName = firstRow.get('[data-person-name]').text()
    await firstRow.get('input[type="checkbox"]').setValue(true)
    expect(wrapper.get('.people-view__summary [aria-live="polite"]').text()).toContain('已选择 1 人')

    await wrapper.get('button[aria-label="下一页"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.page).toBe('2')
    expect(wrapper.get('[aria-label="分页信息"]').text()).toContain('第 2 / 3 页')
    expect(wrapper.findAll('tbody tr')).toHaveLength(5)

    await wrapper.get('button[aria-label="上一页"]').trigger('click')
    await flushPromises()
    const restored = wrapper.findAll('tbody tr').find((row) => row.text().includes(selectedName))!
    expect((restored.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)

    wrapper.unmount()
  })

  it('sets and clears the project center person from icon actions in the list', async () => {
    const { wrapper, repository, projectId } = await mountPeople()
    const currentRow = wrapper.get('[data-person-id="person-lin-hai"]')
    const nextRow = wrapper.get('[data-person-id="person-lin-chen"]')

    expect(currentRow.attributes('data-center-person')).toBe('true')
    expect(currentRow.get('button[aria-label="取消中心人物：林海"]').attributes('aria-pressed'))
      .toBe('true')

    const setCenter = nextRow.get('button[aria-label="设为中心人物：林晨"]')
    expect(setCenter.attributes('title')).toBe('设为中心人物：林晨')
    await setCenter.trigger('click')
    await flushPromises()

    expect((await repository.getProject(projectId)).defaultPersonId).toBe('person-lin-chen')
    expect(nextRow.attributes('data-center-person')).toBe('true')
    expect(nextRow.get('button[aria-label="取消中心人物：林晨"]').attributes('aria-pressed'))
      .toBe('true')
    expect(currentRow.attributes('data-center-person')).toBeUndefined()

    await nextRow.get('button[aria-label="取消中心人物：林晨"]').trigger('click')
    await flushPromises()

    expect((await repository.getProject(projectId)).defaultPersonId).toBeUndefined()
    expect(nextRow.attributes('data-center-person')).toBeUndefined()

    wrapper.unmount()
  })

  it('normalizes a direct out-of-range page to the last valid repository page', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountPeople({
      path: `/project/${project!.id}/people?page=99`,
      repository,
    })

    await vi.waitFor(() => expect(router.currentRoute.value.query.page).toBe('3'))
    await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2))

    expect(wrapper.get('[aria-label="分页信息"]').text()).toContain('第 3 / 3 页')
    expect(wrapper.get('button[aria-label="上一页"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('button[aria-label="下一页"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.people-view__state--empty').exists()).toBe(false)

    wrapper.unmount()
  })

  it('clears selected people when the reused view switches projects', async () => {
    const repository = makeRepository()
    const [firstProject] = await repository.listProjects()
    const secondProject = await repository.createProject({
      name: '第二份家族档案',
      description: '',
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${firstProject!.id}/people`)
    const wrapper = mount(PeopleView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        provide: {
          [branchloomRepositoryKey as symbol]: repository,
        },
      },
    })
    await router.isReady()
    await flushPromises()

    await wrapper.get('tbody input[type="checkbox"]').setValue(true)
    expect(wrapper.get('.people-view__summary [aria-live="polite"]').text()).toContain('已选择 1 人')

    await router.push(`/project/${secondProject.id}/people`)
    await vi.waitFor(() => expect(wrapper.find('.people-view__state--empty').exists()).toBe(true))
    expect(wrapper.get('.people-view__summary [aria-live="polite"]').text()).toContain(
      '可选择人物查看或导出资料',
    )

    wrapper.unmount()
  })

  it('opens details and locates the selected person in the family tree', async () => {
    const { wrapper, router, projectId } = await mountPeople()
    const row = wrapper.findAll('[data-person-id]')[0]!
    const personId = row.attributes('data-person-id')!

    await row.get('a[aria-label^="打开人物详情："]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))
    expect(router.currentRoute.value).toMatchObject({
      name: 'person-detail',
      params: { projectId, personId },
    })

    await router.push(`/project/${projectId}/people`)
    await flushPromises()
    const locatedRow = wrapper.get(`[data-person-id="${personId}"]`)
    await locatedRow.get('a[aria-label^="在家谱树中定位："]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(router.currentRoute.value).toMatchObject({
        name: 'project-tree',
        params: { projectId },
        query: { personId },
      })
    })

    wrapper.unmount()
  })

  it('returns person detail and edit pages to the exact previous list or detail state', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const listPath = `/project/${project!.id}/people?status=living&sort=updatedAt&page=2`
    const { wrapper, router } = await mountPeople({ path: listPath, repository })
    const row = wrapper.findAll('[data-person-id]')[0]!

    await row.get('a[aria-label^="打开人物详情："]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))
    await wrapper.get('button[aria-label="返回上一页"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(listPath))
    await flushPromises()
    expect((wrapper.get('select[aria-label="生存状态"]').element as HTMLSelectElement).value).toBe('living')
    expect((wrapper.get('select[aria-label="排序方式"]').element as HTMLSelectElement).value).toBe('updatedAt')

    const editRow = wrapper.findAll('[data-person-id]')[0]!
    await editRow.get('a[aria-label^="编辑人物："]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-edit'))
    await wrapper.get('button[aria-label="返回上一页"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(listPath))

    const detailRow = wrapper.findAll('[data-person-id]')[0]!
    await detailRow.get('a[aria-label^="打开人物详情："]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))
    const detailPath = router.currentRoute.value.fullPath
    await wrapper.get('button[name="编辑人物"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-edit'))
    await wrapper.get('button[aria-label="返回上一页"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(detailPath))

    wrapper.unmount()
  })

  it('opens list-row editing as a full page instead of a drawer', async () => {
    const { wrapper, router, projectId } = await mountPeople()
    const row = wrapper.findAll('[data-person-id]')[0]!
    const personId = row.attributes('data-person-id')!

    expect(row.find(`a[aria-label^="编辑人物："]`).exists()).toBe(true)
    expect(row.find(`button[aria-label^="删除人物："]`).exists()).toBe(true)
    await row.get(`a[aria-label^="编辑人物："]`).trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-edit'))
    await flushPromises()

    expect(router.currentRoute.value.params).toMatchObject({ projectId, personId })
    expect(wrapper.find('.person-edit-view').exists()).toBe(true)
    expect(wrapper.find('.base-drawer__surface').exists()).toBe(false)
    await wrapper.get('button[aria-label="返回上一页"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-people'))

    wrapper.unmount()
  })

  it('returns a tree-originated person editor to the same project tree', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const returnTo = `/project/${project!.id}/tree?personId=person-lin-hai&previewPersonId=person-lin-chen`
    const editPath = `/project/${project!.id}/people/person-lin-chen/edit?returnTo=${encodeURIComponent(returnTo)}`
    const { wrapper, router } = await mountPeople({ path: editPath, repository })

    await wrapper.get('button[aria-label="返回家谱树"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))

    expect(router.currentRoute.value.params.projectId).toBe(project!.id)
    expect(router.currentRoute.value.query.personId).toBe('person-lin-hai')
    expect(router.currentRoute.value.query.previewPersonId).toBe('person-lin-chen')
    expect(wrapper.get('a[aria-label="编辑人物：林晨"]')).toBeTruthy()

    await router.push({
      name: 'person-edit',
      params: { projectId: project!.id, personId: 'person-lin-hai' },
      query: { returnTo: 'https://example.com/not-allowed' },
    })
    await flushPromises()
    expect(wrapper.get('button[aria-label="返回上一页"]')).toBeTruthy()

    wrapper.unmount()
  })

  it('creates a person on the reused full-page editor and opens the saved detail page', async () => {
    const { wrapper, router, projectId, repository } = await mountPeople()

    await wrapper.get('button[name="新建人物"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-new'))

    expect(router.currentRoute.value.params).toMatchObject({ projectId })
    expect(wrapper.get('#person-edit-title').text()).toBe('新建人物')
    expect(wrapper.find('.base-drawer__surface').exists()).toBe(false)
    expect(wrapper.get('button[aria-label="返回上一页"]')).toBeTruthy()
    expect(wrapper.find('#person-edit-tab-materials').exists()).toBe(false)
    expect(wrapper.find('#person-edit-tab-events').exists()).toBe(false)

    await wrapper.get('input[name="primaryName"]').setValue('林小满')
    await wrapper.get('button[name="保存"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))
    await flushPromises()

    const personId = String(router.currentRoute.value.params.personId)
    expect(await repository.getPerson(personId)).toMatchObject({
      projectId,
      names: [expect.objectContaining({ value: '林小满', primary: true })],
    })
    expect(wrapper.get('.person-detail-panel__identity h1').text()).toContain('林小满')

    wrapper.unmount()
  })

  it('previews and confirms deletion from a person list row', async () => {
    const { wrapper, repository } = await mountPeople()
    const row = wrapper.findAll('[data-person-id]')[0]!
    const personId = row.attributes('data-person-id')!

    await row.get('button[aria-label^="删除人物："]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('确认删除')
    expect(dialog?.textContent).toContain('关系')
    dialog?.querySelector<HTMLButtonElement>('button[name="确认删除"]')?.click()
    await flushPromises()

    await expect(repository.getPerson(personId)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    expect(wrapper.find(`[data-person-id="${personId}"]`).exists()).toBe(false)

    wrapper.unmount()
  })

  it('restores query, filters, sort, and page after browser back navigation', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const initial = `/project/${project!.id}/people?status=living&hasSources=true&sort=updatedAt&page=2`
    const { wrapper, router } = await mountPeople({ path: initial, repository })

    expect((wrapper.get('select[aria-label="生存状态"]').element as HTMLSelectElement).value).toBe('living')
    expect((wrapper.get('select[aria-label="来源状态"]').element as HTMLSelectElement).value).toBe('with')
    expect((wrapper.get('select[aria-label="排序方式"]').element as HTMLSelectElement).value).toBe('updatedAt')
    expect(wrapper.get('[aria-label="分页信息"]').text()).toContain('第 2 / 2 页')

    await wrapper.get('select[aria-label="生存状态"]').setValue('deceased')
    await flushPromises()
    expect(router.currentRoute.value.query.page).toBeUndefined()
    expect(router.currentRoute.value.query.status).toBe('deceased')

    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.query.status).toBe('living'))
    await flushPromises()
    expect((wrapper.get('select[aria-label="生存状态"]').element as HTMLSelectElement).value).toBe('living')
    expect((wrapper.get('select[aria-label="来源状态"]').element as HTMLSelectElement).value).toBe('with')
    expect(wrapper.get('[aria-label="分页信息"]').text()).toContain('第 2 / 2 页')

    wrapper.unmount()
  })

  it('keeps repository failures visible and lets the user retry', async () => {
    const base = makeRepository()
    let attempts = 0
    const repository = overridePeopleQuery(base, async (projectId, query) => {
      attempts += 1
      if (attempts === 1) throw new Error('人物索引暂时不可用')
      return base.listPeople(projectId, query)
    })
    const { wrapper } = await mountPeople({ repository })

    expect(wrapper.get('[role="alert"]').text()).toContain('人物索引暂时不可用')
    await wrapper.get('button[aria-label="重试载入人物"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('table[aria-label="人物列表"]')).toBeTruthy()

    wrapper.unmount()
  })
})
