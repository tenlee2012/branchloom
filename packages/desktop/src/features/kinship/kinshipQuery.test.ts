import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../app/router'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { BranchloomRepository, Page, Person } from '../../shared/domain/types'
import type { PrototypeStorage } from '../../shared/repository/storage'
import KinshipView from './views/KinshipView.vue'
import KinshipPersonPicker from './components/KinshipPersonPicker.vue'

function makeRepository() {
  const values = new Map<string, string>()
  const storage: PrototypeStorage = {
    get length() { return values.size },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
    key: (index) => [...values.keys()][index] ?? null,
  }
  return new BrowserPrototypeRepository({ storage })
}

const wrappers: VueWrapper[] = []
afterEach(() => { wrappers.splice(0).forEach((wrapper) => wrapper.unmount()); vi.restoreAllMocks() })

async function mountQuery(query = '', repository: BranchloomRepository = makeRepository()) {
  const router = createAppRouter('memory')
  await router.push(`/project/project-demo-family/kinship${query}`)
  const wrapper = mount(KinshipView, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [branchloomRepositoryKey as symbol]: repository } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, repository }
}

describe('two-person kinship query', () => {
  it('shows both directions, swaps without writing data, and preserves selections in the URL', async () => {
    const repository = makeRepository()
    const savePerson = vi.spyOn(repository, 'savePerson')
    const saveRelationship = vi.spyOn(repository, 'saveRelationship')
    const { wrapper, router } = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('爸爸')
    expect(wrapper.get('[data-kinship-direction="reverse"]').text()).toContain('女儿')
    expect(wrapper.get('.kinship-view__path').text()).toContain('林晨 → 爸爸：林海')
    await wrapper.get('button[aria-label="交换两个人物"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ from: 'person-lin-hai', to: 'person-lin-chen' })
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('女儿')
    expect(savePerson).not.toHaveBeenCalled()
    expect(saveRelationship).not.toHaveBeenCalled()
    expect(wrapper.get('.kinship-view__footer a').attributes('href')).toContain('personId=person-lin-hai')
  })

  it('searches exact names before aliases, supports keyboard selection, and clears an old answer', async () => {
    const { wrapper } = await mountQuery('?from=person-lin-chen')
    const picker = wrapper.findAllComponents(KinshipPersonPicker)[1]!
    await picker.get('.kinship-picker__trigger').trigger('click')
    const search = picker.get('input[type="search"]')
    await search.setValue('赵雯')
    expect(picker.get('.kinship-picker__results button strong').text()).toBe('赵雯')
    await search.setValue('海叔')
    await search.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(picker.get('.kinship-picker__results button').element)
    await picker.get('.kinship-picker__results button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('爸爸')
    await picker.get('.kinship-picker__trigger').trigger('click')
    await picker.get('input').setValue('不存在的人物')
    expect(picker.text()).toContain('未找到匹配人物')
    await picker.get('input').trigger('keydown', { key: 'Escape' })
    expect(picker.find('.kinship-picker__popover').exists()).toBe(false)
    expect(document.activeElement).toBe(picker.get('.kinship-picker__trigger').element)
    await picker.get('.kinship-picker__trigger').trigger('click')
    await picker.findAll('.kinship-picker__text-button').at(-1)!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-kinship-direction]').exists()).toBe(false)
  })

  it('loads every people page rather than the bounded visible family', async () => {
    const repository = makeRepository()
    const listPeople = repository.listPeople.bind(repository)
    const calls = vi.spyOn(repository, 'listPeople').mockImplementation((id, query) => listPeople(id, { ...query, pageSize: 2 }))
    const slice = vi.spyOn(repository, 'getTreeFamilySlice')
    const { wrapper } = await mountQuery('?from=person-lin-chen&to=person-lin-guoqiang', repository)
    expect(calls).toHaveBeenCalledTimes(6)
    expect(slice).not.toHaveBeenCalled()
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('爷爷')
  })

  it('keeps failed later pages distinct from no relationship, and can retry', async () => {
    const repository = makeRepository()
    const listPeople = repository.listPeople.bind(repository)
    let fail = true
    vi.spyOn(repository, 'listPeople').mockImplementation((id, query) => {
      if (query.page === 2 && fail) return Promise.reject(new Error('测试读取失败'))
      return listPeople(id, { ...query, pageSize: 2 })
    })
    const { wrapper } = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(wrapper.get('[role="alert"]').text()).toContain('测试读取失败')
    expect(wrapper.text()).not.toContain('未找到关系路径')
    expect(wrapper.find('[data-kinship-direction]').exists()).toBe(false)
    fail = false
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('爸爸')
  })

  it('rejects changing or duplicate pagination results rather than deriving from partial data', async () => {
    const repository = makeRepository()
    const first = await repository.listPeople('project-demo-family', { page: 1, pageSize: 2, sort: 'name' })
    vi.spyOn(repository, 'listPeople').mockImplementation(async (_id, query) => ({ ...first, total: query.page === 1 ? 4 : 5 }))
    const { wrapper } = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(wrapper.get('[role="alert"]').text()).toContain('读取期间发生变化')
    expect(wrapper.find('[data-kinship-direction]').exists()).toBe(false)
  })

  it('discards a late project response after navigation to another project', async () => {
    const repository = makeRepository()
    const other = await repository.createProject({ name: '隔离测试家谱', description: '' })
    const original = repository.listPeople.bind(repository)
    const first = await original('project-demo-family', { page: 1, pageSize: 250, sort: 'name' })
    let resolve!: (page: Page<Person>) => void
    vi.spyOn(repository, 'listPeople').mockImplementation((id, query) => id === 'project-demo-family'
      ? new Promise((done) => { resolve = done }) : original(id, query))
    const { wrapper, router } = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(wrapper.get('[aria-busy="true"]').text()).toContain('正在读取')
    await router.push(`/project/${other.id}/kinship`)
    await flushPromises()
    expect(wrapper.text()).toContain('这个家谱还没有人物')
    resolve(first)
    await flushPromises()
    expect(wrapper.text()).not.toContain('林晨')
    expect(wrapper.text()).toContain('这个家谱还没有人物')
  })

  it('does not leak a foreign or missing person selected in the URL', async () => {
    const { wrapper } = await mountQuery('?from=foreign-person&to=person-lin-hai')
    expect(wrapper.get('[role="alert"]').text()).toContain('不属于当前项目')
    expect(wrapper.find('[data-kinship-direction]').exists()).toBe(false)
  })

  it('distinguishes disconnected people from an incomplete relationship record', async () => {
    const repository = makeRepository()
    const relations = await repository.listRelationships('project-demo-family')
    const mock = vi.spyOn(repository, 'listRelationships').mockResolvedValue([])
    const { wrapper } = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(wrapper.text()).toContain('当前资料中未找到关系路径')
    mock.mockResolvedValue([{ ...relations[0]!, fromPersonId: 'missing-person' }])
    const second = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(second.wrapper.text()).toContain('关系资料不完整，暂无法计算称呼')
    expect(second.wrapper.find('[data-kinship-direction]').exists()).toBe(false)
  })

  it('allows the same person and preserves non-biological relations', async () => {
    const { wrapper, router, repository } = await mountQuery('?from=person-lin-chen&to=person-lin-chen')
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('本人')
    expect(wrapper.text()).toContain('选中的是同一位人物')
    const relations = await repository.listRelationships('project-demo-family')
    vi.spyOn(repository, 'listRelationships').mockResolvedValue([
      { ...relations[0]!, category: 'parent', type: 'adoptive', fromPersonId: 'person-lin-hai', toPersonId: 'person-lin-chen' },
    ])
    const adopted = await mountQuery('?from=person-lin-chen&to=person-lin-hai', repository)
    expect(adopted.wrapper.get('[data-kinship-direction="forward"]').text()).toContain('养父')
    expect(adopted.wrapper.get('[data-kinship-direction="reverse"]').text()).toContain('养女')
    await router.replace({ query: {} })
  })

  it('makes every same-name result reachable beyond the initial picker limit', async () => {
    const repository = makeRepository()
    const original = (await repository.listPeople('project-demo-family', { page: 1, pageSize: 1, sort: 'name' })).items[0]!
    const people = Array.from({ length: 35 }, (_, index) => ({ ...original, id: `test-person-${index.toString().padStart(2, '0')}`, names: [{ value: '同名测试', type: 'personal' as const, primary: true }] }))
    const wrapper = mount(KinshipPersonPicker, { attachTo: document.body, props: { label: '称呼谁', modelValue: '', people } })
    wrappers.push(wrapper)
    await wrapper.get('.kinship-picker__trigger').trigger('click')
    expect(wrapper.findAll('.kinship-picker__results button')).toHaveLength(30)
    await wrapper.get('.kinship-picker__text-button').trigger('click')
    expect(wrapper.findAll('.kinship-picker__results button')).toHaveLength(35)
    await wrapper.findAll('.kinship-picker__results button').at(-1)!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['test-person-34'])
  })
})
