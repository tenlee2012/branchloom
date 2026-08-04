import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../app/router'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { BranchloomRepository } from '../../shared/domain/types'
import type { PrototypeStorage } from '../../shared/repository/storage'
import { createDemoState } from '../../shared/fixtures/demoState'
import { buildVisibleGraph } from './model/buildVisibleGraph'
import {
  buildFamilyAwarePositions,
  buildCytoscapeElements,
  createNodeTapController,
  familyGraphStylesheet,
} from './composables/useFamilyGraph'
import FamilyGraph from './components/FamilyGraph.vue'
import QuickAddRelativeDialog from '../relationships/components/QuickAddRelativeDialog.vue'
import TreeView from './views/TreeView.vue'

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const wrappers: Array<{ unmount(): void }> = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

async function mountTree(
  query = '',
  warningThreshold = 80,
  providedRepository?: BranchloomRepository,
) {
  const repository = providedRepository ?? new BrowserPrototypeRepository({ storage: new MemoryStorage() })
  const router = createAppRouter('memory')
  await router.push(`/project/project-demo-family/tree${query}`)
  await router.isReady()
  const fit = vi.fn()
  const relayout = vi.fn()
  const zoomIn = vi.fn()
  const zoomOut = vi.fn()
  const zoomTo = vi.fn()
  const wrapper = mount(TreeView, {
    attachTo: document.body,
    props: { warningThreshold },
    global: {
      plugins: [createPinia(), router],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: {
        FamilyGraph: {
          name: 'FamilyGraph',
          props: ['graph', 'density', 'selectedPersonId'],
          emits: ['node-click', 'node-double-click', 'zoom-change'],
          template: '<div data-testid="family-graph"><button aria-label="选择林晨" @click="$emit(\'node-click\', \'person-lin-chen\')">选中林晨</button><button aria-label="选择陈芳" @click="$emit(\'node-click\', \'person-chen-fang\')">选中陈芳</button><button aria-label="设林晨为中心" @click="$emit(\'node-double-click\', \'person-lin-chen\')">设为中心</button></div>',
          methods: { fit, relayout, zoomIn, zoomOut, zoomTo },
        },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, repository, fit, relayout, zoomIn, zoomOut, zoomTo }
}

describe('TreeView', () => {
  it('loads the default center and honors a personId jump target from the route', async () => {
    const defaults = await mountTree()
    expect(defaults.wrapper.text()).toContain('中心人物：林海')
    defaults.wrapper.unmount()
    const jumped = await mountTree('?personId=person-lin-chen')
    expect(jumped.wrapper.text()).toContain('中心人物：林晨')
  })

  it('prompts the user to configure a default center when the project has people but no default', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    await repository.updateProject('project-demo-family', { defaultPersonId: undefined })

    const { wrapper } = await mountTree('', 80, repository)
    const status = wrapper.get('[role="status"]')

    expect(status.text()).toContain('尚未设置中心人物')
    expect(status.text()).toContain('请前往人物列表选择一位中心人物')
    const peopleLink = status.get('a')
    expect(peopleLink.text()).toBe('前往人物列表设置')
    expect(peopleLink.attributes('href')).toBe('/project/project-demo-family/people')
  })

  it('loads a bounded family slice instead of the project-wide relationship collection', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const getTreeFamilySlice = vi.spyOn(repository, 'getTreeFamilySlice')
    const listPeople = vi.spyOn(repository, 'listPeople')
    const listRelationships = vi.spyOn(repository, 'listRelationships')

    await mountTree('', 80, repository)

    expect(getTreeFamilySlice).toHaveBeenCalledWith('project-demo-family', 'person-lin-hai', {
      generationsUp: 2,
      generationsDown: 2,
    })
    expect(listPeople).toHaveBeenCalledWith('project-demo-family', {
      page: 1,
      pageSize: 100,
      sort: 'name',
    })
    expect(listRelationships).not.toHaveBeenCalled()
  })

  it('migrates the legacy person query to canonical personId without losing the center', async () => {
    const { wrapper, router } = await mountTree('?person=person-chen-fang')
    expect(wrapper.text()).toContain('中心人物：陈芳')
    await vi.waitFor(() => expect(router.currentRoute.value.query.personId).toBe('person-chen-fang'))
    expect(router.currentRoute.value.query.person).toBeUndefined()
  })

  it('opens preview on click and changes center on double click', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const getTreeFamilySlice = vi.spyOn(repository, 'getTreeFamilySlice')
    const { wrapper, router } = await mountTree('', 80, repository)
    await wrapper.get('button[aria-label="选择林晨"]').trigger('click')
    expect(document.body.textContent).toContain('林晨的人物预览')
    expect(document.body.textContent).toContain('添加人物')

    await wrapper.get('button[aria-label="设林晨为中心"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('中心人物：林晨')
    expect(router.currentRoute.value.query.personId).toBe('person-lin-chen')
    expect(getTreeFamilySlice).toHaveBeenLastCalledWith('project-demo-family', 'person-lin-chen', {
      generationsUp: 2,
      generationsDown: 2,
    })
  })

  it('opens the selected person edit page from the preview header', async () => {
    const { wrapper, router } = await mountTree()
    await wrapper.get('button[aria-label="选择林晨"]').trigger('click')

    const editLink = wrapper.get('a[aria-label="编辑人物：林晨"]')
    await editLink.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-edit'))

    expect(router.currentRoute.value.params).toMatchObject({
      projectId: 'project-demo-family',
      personId: 'person-lin-chen',
    })
    expect(router.currentRoute.value.query.returnTo)
      .toBe('/project/project-demo-family/tree?previewPersonId=person-lin-chen')
  })

  it('opens the selected person detail page from the preview header', async () => {
    const { wrapper, router } = await mountTree()
    await wrapper.get('button[aria-label="选择林晨"]').trigger('click')

    expect(wrapper.get('article.person-preview').text()).toContain('亲生父亲')
    expect(wrapper.get('article.person-preview').text()).toContain('亲生母亲')
    await wrapper.get('a[aria-label="查看人物详情：林晨"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-detail'))

    expect(router.currentRoute.value.params).toMatchObject({
      projectId: 'project-demo-family',
      personId: 'person-lin-chen',
    })
  })

  it('restores the person preview from the tree route and clears it when closed', async () => {
    const { wrapper, router } = await mountTree(
      '?personId=person-lin-hai&previewPersonId=person-lin-chen',
    )

    expect(wrapper.get('a[aria-label="编辑人物：林晨"]')).toBeTruthy()
    await wrapper.get('button[aria-label="关闭人物预览"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.previewPersonId).toBeUndefined()
    expect(wrapper.find('a[aria-label="编辑人物：林晨"]').exists()).toBe(false)
  })

  it('uses the selected person as center when switching to ancestor or descendant mode', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const getTreeFamilySlice = vi.spyOn(repository, 'getTreeFamilySlice')
    const { wrapper, router } = await mountTree('', 80, repository)

    await wrapper.get('button[aria-label="选择林晨"]').trigger('click')
    await wrapper.get('select[name="treeMode"]').setValue('ancestors')
    await flushPromises()

    expect(wrapper.text()).toContain('中心人物：林晨')
    expect(router.currentRoute.value.query.personId).toBe('person-lin-chen')
    expect(getTreeFamilySlice).toHaveBeenLastCalledWith('project-demo-family', 'person-lin-chen', {
      generationsUp: 2,
      generationsDown: 0,
    })

    await wrapper.get('button[aria-label="选择陈芳"]').trigger('click')
    await wrapper.get('select[name="treeMode"]').setValue('descendants')
    await flushPromises()

    expect(wrapper.text()).toContain('中心人物：陈芳')
    expect(router.currentRoute.value.query.personId).toBe('person-chen-fang')
    expect(getTreeFamilySlice).toHaveBeenLastCalledWith('project-demo-family', 'person-chen-fang', {
      generationsUp: 0,
      generationsDown: 2,
    })
  })

  it('consumes a relationship locator when the user chooses a new center', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const getRelationship = vi.spyOn(repository, 'getRelationship')
    const listRelationships = vi.spyOn(repository, 'listRelationships')
    const { wrapper, router } = await mountTree('?relationshipId=relationship-guoqiang-hai', 80, repository)
    expect(wrapper.text()).toContain('已定位关系')
    expect(getRelationship).toHaveBeenCalledWith('project-demo-family', 'relationship-guoqiang-hai')
    expect(listRelationships).not.toHaveBeenCalled()

    await wrapper.get('button[aria-label="设林晨为中心"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.relationshipId).toBeUndefined()
    expect(router.currentRoute.value.query.relationship).toBeUndefined()
    expect(wrapper.text()).not.toContain('已定位关系')
  })

  it('searches the repository for jump targets outside the initial directory page', async () => {
    const base = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const distant = {
      ...(await base.getPerson('person-lin-hai')),
      id: 'person-distant',
      names: [{ value: '远房人物', type: 'personal', primary: true as const }],
    }
    const listPeople = vi.fn(async (projectId: string, query: Parameters<BranchloomRepository['listPeople']>[1]) => {
      if (query.search === '远房') {
        return { items: [distant], total: 1, page: 1, pageSize: query.pageSize }
      }
      return base.listPeople(projectId, query)
    }) as BranchloomRepository['listPeople']
    const repository = new Proxy(base, {
      get(target, property) {
        if (property === 'listPeople') return listPeople
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as BranchloomRepository

    const { wrapper } = await mountTree('', 80, repository)
    await wrapper.get('input[aria-label="搜索跳转人物"]').setValue('远房')
    await flushPromises()

    expect(listPeople).toHaveBeenLastCalledWith('project-demo-family', {
      page: 1,
      pageSize: 100,
      search: '远房',
      sort: 'name',
    })
    expect(wrapper.get('select[name="personJump"]').text()).toContain('远房人物')
  })

  it('controls mode, generations, density, collapse, fit and relayout accessibly', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const getTreeFamilySlice = vi.spyOn(repository, 'getTreeFamilySlice')
    const { wrapper, fit, relayout, zoomIn, zoomOut, zoomTo } = await mountTree('', 80, repository)
    await wrapper.get('select[name="treeMode"]').setValue('combined')
    await wrapper.get('input[name="generationsUp"]').setValue('1')
    await wrapper.get('input[name="generationsDown"]').setValue('8')
    await flushPromises()
    expect(getTreeFamilySlice).toHaveBeenLastCalledWith('project-demo-family', 'person-lin-hai', {
      generationsUp: 1,
      generationsDown: 8,
    })
    await wrapper.get('input[name="showDates"]').setValue(false)
    await wrapper.get('input[name="showNames"]').setValue(true)
    await wrapper.get('button[aria-label="选择林晨"]').trigger('click')
    document.querySelector<HTMLButtonElement>('button[name="收起林晨分支"]')!.click()
    await flushPromises()
    ;(wrapper.vm as unknown as { fitCanvas(): void }).fitCanvas()
    await wrapper.get('button[name="重新布局"]').trigger('click')
    await wrapper.get('button[aria-label="放大"]').trigger('click')
    wrapper.getComponent({ name: 'FamilyGraph' }).vm.$emit('zoomChange', 1.2)
    await wrapper.get('button[aria-label="缩小"]').trigger('click')
    await wrapper.get('input[aria-label="缩放百分比"]').setValue('125')
    wrapper.getComponent({ name: 'FamilyGraph' }).vm.$emit('zoomChange', 1.25)
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('已收起 1 个分支')
    expect(wrapper.getComponent({ name: 'FamilyGraph' }).props('density')).toMatchObject({
      dates: false,
      names: true,
    })
    expect(fit).toHaveBeenCalledOnce()
    expect(relayout).toHaveBeenCalledOnce()
    expect(zoomIn).toHaveBeenCalledOnce()
    expect(zoomOut).toHaveBeenCalledOnce()
    expect(zoomTo).toHaveBeenCalledWith(1.25)
    expect((wrapper.get('input[aria-label="缩放百分比"]').element as HTMLInputElement).value).toBe('125')
  })

  it('opens the Task9 quick-add dialog from the selected person and refreshes after save', async () => {
    const { wrapper, repository } = await mountTree()
    await wrapper.get('button[aria-label="选择林晨"]').trigger('click')
    document.querySelector<HTMLButtonElement>('button[name="添加人物"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('创建一个新人物，并设置其与当前人物的关系。')
    expect(wrapper.getComponent(QuickAddRelativeDialog).props('open')).toBe(true)
    const input = document.querySelector<HTMLInputElement>('#quick-relative-name')!
    input.value = '林小满'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('button[name="添加并关联"]')!.click()
    await flushPromises()
    const saved = await repository.listPeople('project-demo-family', {
      search: '林小满', page: 1, pageSize: 10, sort: 'name',
    })
    expect(saved.items).toHaveLength(1)
    expect(wrapper.getComponent(QuickAddRelativeDialog).props('open')).toBe(false)
    expect(wrapper.getComponent({ name: 'FamilyGraph' }).props('graph').nodes)
      .toContainEqual(expect.objectContaining({ primaryName: '林小满' }))
  })

  it('opens the full-page person creator from the exposed topbar action', async () => {
    const { wrapper, router } = await mountTree()
    const push = vi.spyOn(router, 'push')

    ;(wrapper.vm as unknown as { addPerson(): void }).addPerson()

    expect(push).toHaveBeenCalledWith({
      name: 'person-new',
      params: { projectId: 'project-demo-family' },
    })
  })

  it('keeps a child quick-added from a direct partner visible in the refreshed graph', async () => {
    const { wrapper } = await mountTree()
    await wrapper.get('button[aria-label="选择陈芳"]').trigger('click')
    document.querySelector<HTMLButtonElement>('button[name="添加人物"]')!.click()
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('#quick-relative-name')!
    input.value = '陈小禾'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const direction = document.querySelector<HTMLSelectElement>('select[name="direction"]')!
    direction.value = 'current-is-parent'
    direction.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('button[name="添加并关联"]')!.click()
    await flushPromises()

    expect(wrapper.getComponent({ name: 'FamilyGraph' }).props('graph').nodes)
      .toContainEqual(expect.objectContaining({ primaryName: '陈小禾', generation: 1 }))
  })

  it('shows accessible loading, error, missing-center, and threshold warning states', async () => {
    const missing = await mountTree('?personId=missing')
    expect(missing.wrapper.get('[role="status"]').text()).toContain('没有找到中心人物')

    missing.wrapper.unmount()
    const threshold = await mountTree('', 2)
    expect(threshold.wrapper.get('[role="alert"]').text()).toContain('缩小显示范围')

    threshold.wrapper.unmount()
    const base = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const failing = new Proxy(base, {
      get(target, property) {
        if (property === 'getTreeFamilySlice') return vi.fn().mockRejectedValue(new Error('关系索引损坏'))
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as BranchloomRepository
    const errored = await mountTree('', 80, failing)
    expect(errored.wrapper.get('[role="alert"]').text()).toContain('关系索引损坏')
  })

  it('explains every supported relationship type in the tree legend', async () => {
    const { wrapper } = await mountTree()
    const legendElement = wrapper.get('[aria-label="关系图例"]')
    const legend = legendElement.text()
    for (const label of ['亲生', '收养', '继亲', '监护', '订婚', '婚姻', '事实伴侣', '分居', '离异']) {
      expect(legend).toContain(label)
    }
    expect(legendElement.find('i.married').attributes('aria-hidden')).toBe('true')
    expect(legendElement.find('i.biological').attributes('aria-hidden')).toBe('true')
    expect(legendElement.find('i.adoptive').attributes('aria-hidden')).toBe('true')
  })
})

describe('FamilyGraph lifecycle', () => {
  it('destroys a late async graph runtime and never updates after unmount', async () => {
    const runtime = { destroy: vi.fn(), update: vi.fn(), fit: vi.fn(), relayout: vi.fn() }
    let resolveRuntime!: (value: typeof runtime) => void
    const create = vi.fn(() => new Promise<typeof runtime>((resolve) => { resolveRuntime = resolve }))
    const wrapper = mount(FamilyGraph, {
      props: {
        graph: { status: 'ready', nodes: [], edges: [], thresholdExceeded: false, warningThreshold: 80 },
        density: { avatars: true, dates: true, places: true, relationships: true },
        adapter: { create },
      },
    })
    wrapper.unmount()
    resolveRuntime(runtime)
    await flushPromises()
    expect(runtime.destroy).toHaveBeenCalledOnce()
    expect(runtime.update).not.toHaveBeenCalled()
  })

  it('wires graph callbacks, updates a live runtime, and destroys it on unmount', async () => {
    const runtime = { destroy: vi.fn(), update: vi.fn(), focus: vi.fn(), fit: vi.fn(), relayout: vi.fn() }
    const create = vi.fn().mockResolvedValue(runtime)
    const graph = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const wrapper = mount(FamilyGraph, {
      props: {
        graph,
        selectedPersonId: '',
        density: { avatars: true, dates: true, places: true, relationships: true },
        adapter: { create },
      },
    })
    await flushPromises()
    const callbacks = create.mock.calls[0]![0]
    callbacks.onNodeClick('person-lin-chen')
    callbacks.onNodeDoubleClick('person-lin-chen')
    callbacks.onZoomChange(1.25)
    expect(wrapper.emitted('nodeClick')).toEqual([['person-lin-chen']])
    expect(wrapper.emitted('nodeDoubleClick')).toEqual([['person-lin-chen']])
    expect(wrapper.emitted('zoomChange')).toEqual([[1.25]])

    await wrapper.setProps({ density: { avatars: false, dates: true, places: true, relationships: true } })
    expect(runtime.update).toHaveBeenCalled()
    await wrapper.setProps({ selectedPersonId: 'person-lin-chen' })
    expect(runtime.focus).toHaveBeenLastCalledWith('person-lin-chen')
    wrapper.unmount()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('applies the latest graph and density after an async adapter finishes creating', async () => {
    const runtime = { destroy: vi.fn(), update: vi.fn(), fit: vi.fn(), relayout: vi.fn() }
    let resolveRuntime!: (value: typeof runtime) => void
    const create = vi.fn(() => new Promise<typeof runtime>((resolve) => { resolveRuntime = resolve }))
    const first = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'ancestors', generationsUp: 1, generationsDown: 0,
      collapsedPersonIds: new Set(),
    })
    const latest = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-chen', mode: 'descendants', generationsUp: 0, generationsDown: 1,
      collapsedPersonIds: new Set(),
    })
    const latestDensity = { avatars: false, dates: false, places: true, relationships: false }
    const wrapper = mount(FamilyGraph, {
      props: {
        graph: first,
        density: { avatars: true, dates: true, places: true, relationships: true },
        adapter: { create },
      },
    })
    await wrapper.setProps({ graph: latest, density: latestDensity })
    expect(runtime.update).not.toHaveBeenCalled()
    resolveRuntime(runtime)
    await flushPromises()
    expect(runtime.update).toHaveBeenCalledWith(latest, latestDensity)
    wrapper.unmount()
  })

  it('destroys a live runtime exactly once and shows an error when update throws', async () => {
    const runtime = {
      destroy: vi.fn(),
      update: vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error('布局更新失败') }),
      fit: vi.fn(), relayout: vi.fn(),
    }
    const graph = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const wrapper = mount(FamilyGraph, {
      props: {
        graph, density: { avatars: true, dates: true, places: true, relationships: true },
        adapter: { create: vi.fn().mockResolvedValue(runtime) },
      },
    })
    await flushPromises()
    await wrapper.setProps({ density: { avatars: false, dates: true, places: true, relationships: true } })
    expect(wrapper.get('[role="alert"]').text()).toContain('布局更新失败')
    expect(runtime.destroy).toHaveBeenCalledOnce()
    await wrapper.setProps({ density: { avatars: false, dates: false, places: true, relationships: true } })
    expect(runtime.update).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('destroys a pending-created runtime once when its latest update throws', async () => {
    const runtime = {
      destroy: vi.fn(), update: vi.fn(() => { throw new Error('初始图更新失败') }),
      fit: vi.fn(), relayout: vi.fn(),
    }
    let resolveRuntime!: (value: typeof runtime) => void
    const create = vi.fn(() => new Promise<typeof runtime>((resolve) => { resolveRuntime = resolve }))
    const graph = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const wrapper = mount(FamilyGraph, {
      props: {
        graph, density: { avatars: true, dates: true, places: true, relationships: true }, adapter: { create },
      },
    })
    resolveRuntime(runtime)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('初始图更新失败')
    expect(runtime.destroy).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })
})

describe('Cytoscape graph presentation', () => {
  it('keeps partner groups adjacent instead of allowing marriage lines to cross unrelated people', () => {
    const source = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const [first, second, third] = source.nodes.slice(0, 3)
    const graph = {
      ...source,
      nodes: [
        { ...first!, id: 'partner-a', generation: 0 },
        { ...second!, id: 'unrelated-m', generation: 0 },
        { ...third!, id: 'lineage-z', generation: 0 },
      ],
      edges: [{
        id: 'marriage-a-z', source: 'partner-a', target: 'lineage-z', label: '婚姻',
        lineStyle: 'solid' as const, category: 'partner' as const, type: 'married' as const,
      }],
    }

    const positions = buildFamilyAwarePositions(graph)
    const order = graph.nodes
      .slice()
      .sort((left, right) => positions.get(left.id)!.x - positions.get(right.id)!.x)
      .map(({ id }) => id)
    expect(Math.abs(order.indexOf('partner-a') - order.indexOf('lineage-z'))).toBe(1)
  })

  it('joins two explicitly recorded biological parents before connecting their child', () => {
    const source = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const [fatherNode, unrelatedNode, motherNode, childNode] = source.nodes.slice(0, 4)
    const graph = {
      ...source,
      nodes: [
        { ...fatherNode!, id: 'father-a', generation: 0 },
        { ...unrelatedNode!, id: 'unrelated-m', generation: 0 },
        { ...motherNode!, id: 'mother-z', generation: 0 },
        { ...childNode!, id: 'child', generation: 1 },
      ],
      edges: [
        {
          id: 'father-child', source: 'father-a', target: 'child', label: '亲生',
          lineStyle: 'solid' as const, category: 'parent' as const, type: 'biological' as const,
        },
        {
          id: 'mother-child', source: 'mother-z', target: 'child', label: '亲生',
          lineStyle: 'solid' as const, category: 'parent' as const, type: 'biological' as const,
        },
      ],
    }

    const positions = buildFamilyAwarePositions(graph)
    const parentOrder = graph.nodes
      .filter(({ generation }) => generation === 0)
      .sort((left, right) => positions.get(left.id)!.x - positions.get(right.id)!.x)
      .map(({ id }) => id)
    expect(Math.abs(parentOrder.indexOf('father-a') - parentOrder.indexOf('mother-z'))).toBe(1)

    const rendered = buildCytoscapeElements(graph, {
      avatars: false, dates: false, places: false, relationships: true,
    })
    const junction = rendered.find(({ group, data }) => group === 'nodes' && data?.junction === 'yes')
    expect(junction).toBeDefined()
    const familyEdges = rendered.filter(({ group, data }) => group === 'edges' && data?.familyId === junction!.data!.id)
    expect(familyEdges.filter(({ data }) => data?.familyRole === 'parent').map(({ data }) => data?.source).sort())
      .toEqual(['father-a', 'mother-z'])
    expect(familyEdges.find(({ data }) => data?.familyRole === 'child')?.data?.target).toBe('child')
  })

  it('does not invent a second biological parent from a spouse when only one parent is recorded', () => {
    const source = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const parent = source.nodes[0]!
    const spouse = source.nodes[1]!
    const child = source.nodes[2]!
    const graph = {
      ...source,
      nodes: [
        { ...parent, id: 'recorded-parent', generation: 0 },
        { ...spouse, id: 'spouse', generation: 0 },
        { ...child, id: 'child', generation: 1 },
      ],
      edges: [
        {
          id: 'parent-child', source: 'recorded-parent', target: 'child', label: '亲生',
          lineStyle: 'solid' as const, category: 'parent' as const, type: 'biological' as const,
        },
        {
          id: 'marriage', source: 'recorded-parent', target: 'spouse', label: '婚姻',
          lineStyle: 'solid' as const, category: 'partner' as const, type: 'married' as const,
        },
      ],
    }

    const rendered = buildCytoscapeElements(graph, {
      avatars: false, dates: false, places: false, relationships: true,
    })
    expect(rendered.some(({ group, data }) => group === 'nodes' && data?.junction === 'yes')).toBe(false)
    expect(rendered.find(({ data }) => data?.id === 'parent-child')?.data)
      .toMatchObject({ source: 'recorded-parent', target: 'child' })
  })

  it('provides distinct focused and muted styles for selected-person relationship context', () => {
    expect(familyGraphStylesheet.find(({ selector }) => selector === 'edge.is-focused')).toBeDefined()
    expect(familyGraphStylesheet.find(({ selector }) => selector === 'edge.is-muted')).toBeDefined()
    expect(familyGraphStylesheet.find(({ selector }) => selector === 'node.is-focused')).toBeDefined()
    expect(familyGraphStylesheet.find(({ selector }) => selector === 'node.is-muted')).toBeDefined()
  })

  it('does not evaluate person avatar data for family junction nodes', () => {
    const personStyle = familyGraphStylesheet.find(({ selector }) => selector === 'node[isPerson = "yes"]')
    const junctionStyle = familyGraphStylesheet.find(({ selector }) => selector === 'node[junction = "yes"]')

    expect(personStyle).toMatchObject({ style: { 'background-image': 'data(avatar)' } })
    expect(junctionStyle).toMatchObject({ style: { 'background-image': 'none' } })
    expect(familyGraphStylesheet.find(({ selector }) => selector === 'node')?.style)
      .not.toHaveProperty('background-image')
  })

  it('shows courtesy and art names only when requested and independently controls avatars', () => {
    const state = createDemoState()
    const person = state.people.find(({ id }) => id === 'person-lin-hai')!
    person.names.push(
      { value: '云舟', type: 'courtesy', primary: false },
      { value: '望潮居士', type: 'art', primary: false },
    )
    const graph = buildVisibleGraph(state, {
      centerPersonId: person.id,
      mode: 'combined',
      generationsUp: 2,
      generationsDown: 2,
      collapsedPersonIds: new Set(),
    })

    const namesVisible = buildCytoscapeElements(graph, {
      avatars: false,
      dates: false,
      places: false,
      relationships: false,
      names: true,
    }).find(({ group, data }) => group === 'nodes' && data?.id === person.id)!
    expect(namesVisible.data?.label).toContain('字 云舟 · 号 望潮居士')
    expect(namesVisible.data?.avatar).toBe('')

    const namesHidden = buildCytoscapeElements(graph, {
      avatars: true,
      dates: false,
      places: false,
      relationships: false,
      names: false,
    }).find(({ group, data }) => group === 'nodes' && data?.id === person.id)!
    expect(namesHidden.data?.label).toBe('林海')
    expect(namesHidden.data?.avatar).toBeTruthy()
  })

  it('keeps each relationship type in edge data and gives all nine a unique visual signature', () => {
    const graph = buildVisibleGraph(createDemoState(), {
      centerPersonId: 'person-lin-hai', mode: 'combined', generationsUp: 2, generationsDown: 2,
      collapsedPersonIds: new Set(),
    })
    const allTypes = ['biological', 'adoptive', 'step', 'guardian', 'engaged', 'married', 'partner', 'separated', 'divorced'] as const
    graph.edges = allTypes.map((type, index) => ({
      id: `edge-${type}`, source: graph.nodes[0]!.id, target: graph.nodes[1]!.id,
      label: type, lineStyle: 'solid', category: index < 4 ? 'parent' : 'partner', type,
    }))
    const edges = buildCytoscapeElements(graph, {
      avatars: false, dates: false, places: false, relationships: false,
    }).filter(({ group }) => group === 'edges')
    expect(edges.map(({ data }) => [data?.type, data?.label])).toEqual(allTypes.map((type) => [type, '']))

    const signatures = allTypes.map((type) => {
      const rule = familyGraphStylesheet.find(({ selector }) => selector === `edge[type = "${type}"]`)
      expect(rule).toBeDefined()
      return JSON.stringify(rule!.style)
    })
    expect(new Set(signatures).size).toBe(allTypes.length)
  })

  it('keeps independent click timers per node, recognizes same-node double click, and clears on destroy', async () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    const onDoubleClick = vi.fn()
    const taps = createNodeTapController({ onClick, onDoubleClick })
    taps.tap('person-a')
    taps.tap('person-b')
    await vi.advanceTimersByTimeAsync(220)
    expect(onClick.mock.calls).toEqual([['person-a'], ['person-b']])

    taps.tap('person-c')
    taps.tap('person-c')
    expect(onDoubleClick).toHaveBeenCalledWith('person-c')
    await vi.advanceTimersByTimeAsync(220)
    expect(onClick).not.toHaveBeenCalledWith('person-c')

    taps.tap('person-d')
    taps.destroy()
    await vi.runAllTimersAsync()
    expect(onClick).not.toHaveBeenCalledWith('person-d')
    vi.useRealTimers()
  })
})
