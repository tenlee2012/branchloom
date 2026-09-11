import { DOMWrapper, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.vue'
import { createAppRouter } from './router'
import { useSessionStore } from './stores/session'
import { branchloomRepositoryKey } from '../shared/repository/injection'
import { BrowserPrototypeRepository } from '../shared/repository/BrowserPrototypeRepository'
import { NATIVE_STATE_REFRESHED_EVENT, PROJECT_DATA_CHANGED_EVENT } from '../shared/repository/TauriRepository'
import type { PrototypeStorage } from '../shared/repository/storage'
import type { BranchloomRepository, DataIssue, Project } from '../shared/domain/types'
import { BrowserRecentProjectLocations } from '../features/projects/model/recentProjectLocations'
import * as runtimeCapabilities from '../shared/runtimeCapabilities'

const tauriWindowMocks = vi.hoisted(() => ({
  setTitle: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => tauriWindowMocks,
}))

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function overrideGetProject(
  repository: BranchloomRepository,
  getProject: BranchloomRepository['getProject'],
): BranchloomRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'getProject') return getProject
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function mountShell(path: string, repository: BranchloomRepository = makeRepository()) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter('memory')
  await router.push(path)

  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      stubs: { transition: false },
      plugins: [pinia, router],
      provide: {
        [branchloomRepositoryKey as symbol]: repository,
      },
    },
  })
  await router.isReady()
  await flushPromises()

  return { wrapper, router, repository, session: useSessionStore(pinia) }
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => { vi.unstubAllGlobals() })

function useMobileViewport() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(max-width: 48rem)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
}

function mobileMenu() {
  return new DOMWrapper(document.body).get('[role="dialog"][aria-label="项目菜单"]')
}

describe('application shell', () => {
  it('forwards the root experience into the latest project tree', async () => {
    const { wrapper, router } = await mountShell('/')

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))
    expect(wrapper.find('nav[aria-label="项目导航"]').exists()).toBe(true)
    expect(wrapper.get('button[name="刷新资料"]').text()).toContain('刷新资料')
    expect(wrapper.find('.prototype-notice').exists()).toBe(false)

    wrapper.unmount()
  })

  it.each(['/new', '/project/project-demo-family/manage/overview'])(
    'returns from GitHub import to %s through a single header back button',
    async (origin) => {
      const { wrapper, router } = await mountShell(origin)
      await router.push('/github-import')
      await flushPromises()

      const header = wrapper.get('.home-layout__header')
      const back = header.get('button[aria-label="返回上一页"]')
      expect(header.element.firstElementChild).toBe(back.element)
      expect(wrapper.findAll('.page-back-link')).toHaveLength(1)
      expect(wrapper.find('.home-layout__main .page-back-link').exists()).toBe(false)
      expect(header.find('a[aria-label="Branchloom 首页"]').exists()).toBe(false)
      expect(header.find('a[aria-label="从 GitHub 导入项目"]').exists()).toBe(false)
      expect(header.find('button[name="刷新资料"]').exists()).toBe(false)
      expect(wrapper.find('.github-import-view__intro .icon-tabler-brand-github').exists()).toBe(false)
      expect(wrapper.get('h1').text()).toBe('从 GitHub 导入')

      await back.trigger('click')
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe(origin))
      await flushPromises()
      expect(wrapper.find('button[name="刷新资料"]').exists()).toBe(origin === '/new')

      wrapper.unmount()
    },
  )

  it('provides a working back fallback when GitHub import is opened directly', async () => {
    const { wrapper, router } = await mountShell('/github-import')
    const back = wrapper.get('.home-layout__header button[aria-label="返回"]')

    await back.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))

    wrapper.unmount()
  })

  it('shows all project destinations and marks the current page accessibly', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const inspectionIssues: DataIssue[] = [
      { id: 'issue-one', severity: 'warning', code: 'test-one', message: '问题一', targetType: 'person', targetId: 'person-one', origin: 'derived' },
      { id: 'issue-two', severity: 'warning', code: 'test-two', message: '问题二', targetType: 'person', targetId: 'person-two', origin: 'derived' },
    ]
    const inspectProject = vi.spyOn(repository, 'inspectProject').mockResolvedValue(inspectionIssues)
    const { wrapper } = await mountShell(`/project/${project!.id}/people`, repository)
    const navigation = wrapper.get('nav[aria-label="项目导航"]')

    for (const label of ['家谱树', '人物', '查称呼', '时间线', '资料来源']) {
      expect(navigation.get(`a[aria-label="${label}"]`).text()).toContain(label)
    }
    expect(wrapper.get('nav[aria-label="项目管理导航"] a[aria-label="项目管理"]').text())
      .toContain('项目管理')
    const projectLinks = wrapper.findAll('nav[aria-label="项目管理导航"] a')
    expect(projectLinks.map((link) => link.attributes('aria-label')))
      .toEqual(['项目管理', '协作同步', '数据检查'])
    expect(wrapper.get('a[aria-label="协作同步"]').attributes('href'))
      .toBe(`/project/${project!.id}/collaboration-sync`)
    const checksLink = wrapper.get('nav[aria-label="项目管理导航"] a[aria-label="数据检查"]')
    await vi.waitFor(() => expect(checksLink.get('.app-sidebar__badge').text()).toBe('2'))
    expect(checksLink.get('.app-sidebar__badge').attributes('aria-label')).toBe('2 个问题')
    expect(checksLink.text()).not.toContain('已保存 · 今天 15:42')
    expect(inspectProject).toHaveBeenCalledWith(project!.id)
    expect(wrapper.find('.app-sidebar__saved').exists()).toBe(false)
    expect(navigation.get('a[aria-label="人物"]').attributes('aria-current')).toBe('page')
    expect(navigation.get('a[aria-label="家谱树"]').attributes('aria-current')).toBeUndefined()
    await wrapper.get('[aria-label="切换项目"]').trigger('click')
    expect(wrapper.get('nav[aria-label="项目列表"]').text()).toContain(project!.name)
    expect(wrapper.get('.app-sidebar__new-project').attributes('href'))
      .toBe(`/project/${project!.id}/manage/new`)
    expect(wrapper.get('a[aria-label="从 GitHub 导入项目"]').attributes('href'))
      .toBe('/github-import')
    expect(wrapper.find('[aria-label="打开项目菜单"]').exists()).toBe(false)

    expect(wrapper.find('button[aria-label="打开菜单"]').exists()).toBe(false)
    expect(wrapper.find('.mobile-project-navigation').exists()).toBe(false)

    inspectProject.mockResolvedValue([])
    window.dispatchEvent(new Event(PROJECT_DATA_CHANGED_EVENT))
    await vi.waitFor(() => expect(checksLink.find('.app-sidebar__badge').exists()).toBe(false))

    wrapper.unmount()
  })

  it('keeps AI tools inside the shared project shell and preserves project context', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(
      `/project/${project!.id}/people`,
      repository,
    )

    const aiToolsLink = wrapper.get('.app-sidebar__footer a[href$="/ai-tools"]')
    expect(aiToolsLink.attributes('href')).toBe(`/project/${project!.id}/ai-tools`)

    await aiToolsLink.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-ai-tools'))
    await flushPromises()

    expect(wrapper.get('.project-layout')).toBeTruthy()
    expect(wrapper.get('nav[aria-label="项目导航"]')).toBeTruthy()
    expect(wrapper.get('.app-sidebar__project-switcher summary strong').text()).toBe(project!.name)
    expect(wrapper.get('.app-sidebar__footer a[aria-current="page"]').text()).toContain('AI 工具')
    expect(wrapper.get('#ai-tools-title').text()).toBe('AI 工具')

    wrapper.unmount()
  })

  it('reaches collaboration and another project through the mobile project destination', async () => {
    useMobileViewport()
    const repository = makeRepository()
    const [first] = await repository.listProjects()
    const second = await repository.createProject({ name: '移动端第二份家谱', description: '' })
    const { wrapper, router, session } = await mountShell(`/project/${first!.id}/tree`, repository)

    const openProjectPage = async () => {
      await wrapper.get('button[aria-label="打开菜单"]').trigger('click')
      await flushPromises()
      await mobileMenu().get('a[aria-label="项目管理"]').trigger('click')
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-overview'))
      await flushPromises()
      expect(wrapper.get('.app-topbar').find('button[name="刷新资料"]').exists()).toBe(false)
    }
    await openProjectPage()
    await wrapper.get('a[aria-label="打开协作同步"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-collaboration-sync'))
    await flushPromises()
    expect(wrapper.find('.app-topbar button[name="刷新资料"]').exists()).toBe(true)

    await openProjectPage()
    const switcher = wrapper.get<HTMLDetailsElement>('.project-switcher')
    switcher.element.open = true
    await switcher.trigger('toggle')
    await flushPromises()
    await switcher.get(`a[aria-label="打开项目：${second.name}"]`).trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.params.projectId).toBe(second.id))
    await flushPromises()
    expect(session.currentProjectName).toBe(second.name)
    expect(wrapper.find('.app-topbar button[name="刷新资料"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens a modal mobile menu, traps keyboard focus and returns focus on Escape', async () => {
    useMobileViewport()
    const { wrapper, router } = await mountShell('/project/project-demo-family/people')
    const trigger = wrapper.get<HTMLButtonElement>('button[aria-label="打开菜单"]')
    trigger.element.focus()
    await trigger.trigger('click')
    await flushPromises()
    const menu = mobileMenu()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(menu.attributes('aria-modal')).toBe('true')
    expect(menu.get('a[aria-label="人物"]').attributes('aria-current')).toBe('page')
    expect(wrapper.element.closest('[inert]')).not.toBeNull()
    expect(menu.get('[aria-label="关闭菜单"]').element).toBe(document.activeElement)
    const settings = menu.get<HTMLAnchorElement>('a[href$="/manage/settings"]')
    settings.element.focus()
    await settings.trigger('keydown', { key: 'Tab' })
    expect(menu.get('[aria-label="关闭菜单"]').element).toBe(document.activeElement)
    await menu.trigger('keydown', { key: 'Escape' })
    await vi.waitFor(() => expect(document.querySelector('[aria-label="项目菜单"]')).toBeNull())
    expect(trigger.element).toBe(document.activeElement)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.element.closest('[inert]')).toBeNull()
    expect(router.currentRoute.value.path).toBe('/project/project-demo-family/people')
    wrapper.unmount()
  })

  it('uses Back to dismiss the menu and closes it when selecting the current destination', async () => {
    useMobileViewport()
    const path = '/project/project-demo-family/people'
    const { wrapper, router } = await mountShell(path)
    const trigger = wrapper.get('button[aria-label="打开菜单"]')
    await trigger.trigger('click')
    await flushPromises()
    expect(mobileMenu().attributes('aria-modal')).toBe('true')
    window.history.back()
    await vi.waitFor(() => expect(document.querySelector('[aria-label="项目菜单"]')).toBeNull())
    expect(router.currentRoute.value.path).toBe(path)
    await trigger.trigger('click')
    await flushPromises()
    await mobileMenu().get('a[aria-label="人物"]').trigger('click')
    await vi.waitFor(() => expect(window.history.state?.branchloomNavigationDrawer).toBeUndefined())
    expect(document.querySelector('[aria-label="项目菜单"]')).toBeNull()
    expect(router.currentRoute.value.path).toBe(path)
    wrapper.unmount()
  })

  it('keeps native mobile navigation in a drawer on wide screens and hides unavailable AI tools', async () => {
    const capabilities = vi.spyOn(runtimeCapabilities, 'loadRuntimeCapabilities').mockResolvedValue({
      mobile: true, aiTools: false, scheduledSync: false,
    })
    const { wrapper } = await mountShell('/project/project-demo-family/people')
    try {
      expect(wrapper.find('.project-layout--compact').exists()).toBe(true)
      await wrapper.get('button[aria-label="打开菜单"]').trigger('click')
      await flushPromises()
      expect(mobileMenu().find('.app-sidebar--mobile').exists()).toBe(true)
      expect(mobileMenu().find('a[href$="/ai-tools"]').exists()).toBe(false)
      await mobileMenu().get('button[aria-label="关闭菜单"]').trigger('click')
      await vi.waitFor(() => expect(window.history.state?.branchloomNavigationDrawer).toBeUndefined())
    } finally {
      wrapper.unmount()
      capabilities.mockRestore()
    }
  })

  it('preserves a detail page return target across same-page navigation entries', async () => {
    const origin = '/project/project-demo-family/people?search=林晨'
    const { wrapper, router } = await mountShell(origin)
    await router.push('/project/project-demo-family/people/person-lin-chen')
    const detailPath = router.currentRoute.value.fullPath
    await router.push({ path: detailPath, force: true })
    await flushPromises()
    expect(router.currentRoute.value.meta.previousFullPath).toBe(origin)
    expect(wrapper.find('.app-topbar button[aria-label="返回上一页"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('uses the same shell for the global AI tools route', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell('/ai-tools', repository)

    expect(router.currentRoute.value.name).toBe('ai-tools')
    expect(wrapper.get('.project-layout')).toBeTruthy()
    expect(wrapper.get('nav[aria-label="项目导航"]')).toBeTruthy()
    expect(wrapper.get('.app-sidebar__project-switcher summary strong').text()).toBe(project!.name)
    expect(wrapper.get('.app-sidebar__footer a[aria-current="page"]').text()).toContain('AI 工具')
    expect(wrapper.get('#ai-tools-title').text()).toBe('AI 工具')

    wrapper.unmount()
  })

  it('redirects AI routes away from mobile runtimes', async () => {
    const capabilities = async () => ({
      mobile: true,
      aiTools: false,
      scheduledSync: false,
    })
    const router = createAppRouter('memory', capabilities)

    await router.push('/project/project-demo-family/ai-tools')
    expect(router.currentRoute.value.name).toBe('project-tree')

    await router.push('/ai-tools')
    expect(router.currentRoute.value.name).toBe('home')
  })

  it('records each successfully opened project as the most recent project', async () => {
    const repository = makeRepository()
    const [first] = await repository.listProjects()
    const second = await repository.createProject({ name: '第二个家谱', description: '' })
    const { wrapper, router } = await mountShell(`/project/${first!.id}/tree`, repository)
    const locations = new BrowserRecentProjectLocations(window.localStorage)

    expect(locations.list()[0]?.projectId).toBe(first!.id)
    await router.push(`/project/${second.id}/tree`)
    await flushPromises()
    expect(locations.list()[0]?.projectId).toBe(second.id)

    wrapper.unmount()
  })

  it('moves the primary tree actions into the topbar without duplicating status or toolbar buttons', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(`/project/${project!.id}/tree`, repository)
    const actions = wrapper.get('.app-topbar__actions')
    const dragSurface = wrapper.get('.app-topbar__drag-surface')

    expect(actions.attributes('aria-label')).toBe('家谱树操作')
    expect(dragSurface.attributes()).toHaveProperty('data-tauri-drag-region')
    expect(dragSurface.attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('.draggable-window-title').exists()).toBe(false)
    expect(actions.find('.app-topbar__save-announcement').exists()).toBe(false)
    expect(actions.find('.app-topbar__issues').exists()).toBe(false)
    expect(actions.get('button[name="刷新资料"]').text()).toContain('刷新资料')
    expect(actions.get('button[name="适应画布"]').text()).toContain('适应画布')
    expect(actions.get('button[name="添加人物"]').text()).toContain('添加人物')
    expect(wrapper.find('.tree-toolbar button[name="适应视图"]').exists()).toBe(false)
    expect(wrapper.find('.tree-toolbar button[name="打开添加人物与关系对话框"]').exists()).toBe(false)

    await actions.get('button[name="添加人物"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('person-new'))
    expect(wrapper.get('#person-edit-title').text()).toBe('新建人物')
    expect(wrapper.find('.base-drawer__surface').exists()).toBe(false)

    wrapper.unmount()
  })

  it('keeps manual refresh on data pages and retains contextual back navigation', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(
      `/project/${project!.id}/people`,
      repository,
    )
    const primaryPaths = [
      ['people', true],
      ['timeline', true],
      ['sources', true],
      ['collaboration-sync', true],
      ['manage/overview', false],
    ] as const

    for (const [path, hasRefresh] of primaryPaths) {
      await router.push(`/project/${project!.id}/${path}`)
      await flushPromises()
      const topbar = wrapper.get('.app-topbar')
      expect(topbar.find('button[name="刷新资料"]').exists()).toBe(hasRefresh)
      expect(topbar.find('.page-back-link').exists()).toBe(false)
    }

    const secondaryPaths = [
      'manage/checks',
      'manage/settings',
    ]

    for (const path of secondaryPaths) {
      await router.push(`/project/${project!.id}/${path}`)
      await flushPromises()

      const topbar = wrapper.get('.app-topbar')
      expect(topbar.get('button[name="刷新资料"]').text()).toContain('刷新资料')
      expect(topbar.find('.app-topbar__drag-surface').exists()).toBe(false)
      expect(topbar.find('.page-back-link').exists()).toBe(true)
    }

    wrapper.unmount()
  })

  it('uses content modes without allowing project pages to bypass the shared shell', () => {
    const router = createAppRouter('memory')
    const projectRoutes = router.getRoutes()
      .filter((route) => route.path.startsWith('/project/:projectId'))

    expect(projectRoutes.every((route) => !('contentOnly' in route.meta))).toBe(true)
    expect(router.resolve('/project/project-demo-family/tree').meta.workspaceMode).toBe('canvas')
    expect(router.resolve('/project/project-demo-family/collaboration-sync').meta.workspaceMode)
      .toBe('management')
  })

  it('opens the kinship page from a person, preserves its shell and selection on refresh, and returns to that person', async () => {
    const detailPath = '/project/project-demo-family/people/person-lin-chen'
    const { wrapper, router } = await mountShell(detailPath)
    await wrapper.get('button[name="查称呼"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-kinship'))
    await flushPromises()
    expect(router.currentRoute.value.query.from).toBe('person-lin-chen')
    expect(wrapper.get('h1').text()).toBe('查称呼')
    expect(wrapper.find('.app-topbar button[name="刷新资料"]').exists()).toBe(true)
    expect(wrapper.get('nav[aria-label="项目导航"] a[aria-label="查称呼"]').attributes('aria-current')).toBe('page')
    await router.replace({ query: { ...router.currentRoute.value.query, to: 'person-lin-hai' } })
    await flushPromises()
    expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('爸爸')
    window.dispatchEvent(new Event(NATIVE_STATE_REFRESHED_EVENT))
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.get('[data-kinship-direction="forward"]').text()).toContain('爸爸'))
    const back = wrapper.get('.app-topbar a[aria-label="返回人物详情"]')
    expect(back.attributes('href')).toBe(detailPath)
    await back.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(detailPath))
    wrapper.unmount()
  })

  it.each(['https://example.com', '/project/foreign/people/person-foreign', '/project/project-demo-family/manage/settings'])(
    'ignores an out-of-scope kinship return target: %s', async (returnTo) => {
      const { wrapper } = await mountShell(`/project/project-demo-family/kinship?returnTo=${encodeURIComponent(returnTo)}`)
      expect(wrapper.get('.app-topbar a[aria-label="返回人物列表"]').attributes('href')).toBe('/project/project-demo-family/people')
      expect(wrapper.find('a[aria-label="返回人物详情"]').exists()).toBe(false)
      wrapper.unmount()
    },
  )

  it('keeps the project shell visible throughout project creation tasks', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(
      `/project/${project!.id}/manage/overview`,
      repository,
    )

    expect(wrapper.get('.project-overview__create').attributes('href'))
      .toBe(`/project/${project!.id}/manage/new`)
    await wrapper.get('.project-overview__create').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-new'))
    await flushPromises()
    expect(wrapper.get('nav[aria-label="项目管理导航"] a[aria-label="项目管理"]')).toBeTruthy()
    expect(wrapper.get('nav[aria-label="项目管理导航"] a[aria-label="数据检查"]')).toBeTruthy()
    expect(wrapper.get('h1').text()).toContain('从一个名字开始')
    expect(wrapper.get('a[aria-label="返回当前项目家谱树"]').attributes('href'))
      .toBe(`/project/${project!.id}/tree`)

    const topbar = wrapper.get('.app-topbar')
    expect(topbar.find('button[name="刷新资料"]').exists()).toBe(false)
    const back = topbar.get('a[aria-label="返回项目管理"]')
    expect(back.attributes('href')).toBe(`/project/${project!.id}/manage/overview`)
    await back.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-overview'))
    await flushPromises()
    expect(wrapper.get('.app-topbar').find('button[name="刷新资料"]').exists()).toBe(false)

    await wrapper.get('.project-overview__create').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-new'))
    await flushPromises()
    await wrapper.get('a[aria-label="返回当前项目家谱树"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))

    wrapper.unmount()
  })

  it('declares an explicit parent for every secondary and tertiary route', () => {
    const router = createAppRouter('memory')
    const expectedParents = [
      ['/import/gedcom', 'home', '返回首页'],
      ['/github-import', 'home', '返回'],
      ['/project/project-demo-family/people/person-demo-1', 'project-people', '返回人物列表'],
      ['/project/project-demo-family/people/person-demo-1/edit', 'person-detail', '返回人物详情'],
      ['/project/project-demo-family/kinship', 'project-people', '返回人物列表'],
      ['/project/project-demo-family/manage/new', 'project-overview', '返回项目管理'],
      ['/project/project-demo-family/manage/exchange', 'project-overview', '返回项目管理'],
      ['/project/project-demo-family/manage/history', 'project-overview', '返回项目管理'],
      ['/project/project-demo-family/manage/checks', 'project-overview', '返回项目管理'],
      ['/project/project-demo-family/manage/settings', 'project-overview', '返回项目管理'],
    ] as const

    for (const [path, name, label] of expectedParents) {
      expect(router.resolve(path).meta.parent).toMatchObject({ name, label })
    }
  })

  it('moves the parent button into the topbar and the page title into the window title', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(
      `/project/${project!.id}/manage/settings`,
      repository,
    )
    const main = wrapper.get('.project-layout__main')
    const back = wrapper.get('a[aria-label="返回项目管理"]')

    expect(wrapper.get('.app-topbar__context').element.firstElementChild).toBe(back.element)
    expect(main.find('.page-back-link').exists()).toBe(false)
    expect(wrapper.find('.app-topbar__page-title').exists()).toBe(false)
    expect(document.title).toBe('项目设置 · 有谱')
    expect(back.attributes('href')).toBe(`/project/${project!.id}/manage/overview`)

    await back.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-overview'))
    expect(wrapper.get('.app-topbar').find('button[name="刷新资料"]').exists()).toBe(false)
    expect(wrapper.find('.app-topbar .page-back-link').exists()).toBe(false)
    expect(document.title).toBe('项目概览 · 有谱')

    wrapper.unmount()
  })

  it('returns from a person detail page to the person list', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(
      `/project/${project!.id}/people/person-demo-1`,
      repository,
    )

    const back = wrapper.get('button[aria-label="返回人物列表"]')
    expect(wrapper.find('.app-topbar__page-title').exists()).toBe(false)
    expect(document.title).toBe('人物详情 · 有谱')

    await back.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-people'))

    wrapper.unmount()
  })

  it('reserves aria-current for exact destinations while highlighting their sections', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    const { wrapper, router } = await mountShell(
      `/project/${project!.id}/people/person-demo-1`,
      repository,
    )
    const navigation = wrapper.get('nav[aria-label="项目导航"]')
    const people = navigation.get('a[aria-label="人物"]')

    expect(people.attributes('aria-current')).toBeUndefined()
    expect(people.classes()).toContain('app-sidebar__link--active')

    await router.push(`/project/${project!.id}/manage/history`)
    await flushPromises()
    const manage = wrapper.get('nav[aria-label="项目管理导航"] a[aria-label="项目管理"]')
    expect(manage.attributes('aria-current')).toBeUndefined()
    expect(manage.classes()).toContain('app-sidebar__link--active')

    await router.push(`/project/${project!.id}/collaboration-sync`)
    await flushPromises()
    const collaboration = wrapper.get('nav[aria-label="项目管理导航"] a[aria-label="协作同步"]')
    expect(collaboration.attributes('aria-current')).toBe('page')
    expect(collaboration.classes()).toContain('app-sidebar__link--active')
    expect(manage.classes()).not.toContain('app-sidebar__link--active')

    wrapper.unmount()
  })

  it('ignores an older project request that resolves after a newer route', async () => {
    const repository = makeRepository()
    const [first] = await repository.listProjects()
    const second = await repository.createProject({ name: '第二个家谱', description: '' })
    const firstRequest = deferred<Project>()
    const secondRequest = deferred<Project>()
    const delayedRepository = overrideGetProject(repository, (projectId) => {
      return projectId === first!.id ? firstRequest.promise : secondRequest.promise
    })
    const { wrapper, router } = await mountShell(
      `/project/${first!.id}/tree`,
      delayedRepository,
    )

    expect(wrapper.find('nav[aria-label="项目导航"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="正在载入项目"]').text()).toContain('正在载入')

    await router.push(`/project/${second.id}/tree`)
    await flushPromises()
    secondRequest.resolve(second)
    await flushPromises()
    expect(wrapper.get('.app-sidebar__project-switcher summary strong').text()).toBe(second.name)

    firstRequest.resolve(first!)
    await flushPromises()
    expect(wrapper.get('.app-sidebar__project-switcher summary strong').text()).toBe(second.name)

    wrapper.unmount()
  })

  it('renders a recoverable error instead of an invalid project shell', async () => {
    const repository = overrideGetProject(makeRepository(), async () => {
      throw new Error('项目不存在')
    })
    const { wrapper } = await mountShell('/project/missing-project/tree', repository)

    expect(wrapper.find('nav[aria-label="项目导航"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('无法打开这个项目')
    expect(wrapper.get('a[aria-label="返回 Branchloom 首页"]').attributes('href')).toBe('/')

    wrapper.unmount()
  })

  it('drives repository undo and redo without rendering topbar status', async () => {
    const repository = makeRepository()
    const [original] = await repository.listProjects()
    await repository.updateProject(original!.id, { name: '刚刚修改的家谱' })

    const { wrapper, session } = await mountShell(
      `/project/${original!.id}/people`,
      repository,
    )
    await session.refreshHistory(repository)
    await flushPromises()

    expect(wrapper.find('.app-topbar [aria-label="保存状态"]').exists()).toBe(false)
    expect(wrapper.find('.app-topbar__issues').exists()).toBe(false)
    const undo = wrapper.get('button[aria-label="撤销最近修改"]')
    const redo = wrapper.get('button[aria-label="重做最近修改"]')
    expect(undo.attributes('disabled')).toBeUndefined()
    expect(redo.attributes('disabled')).toBeDefined()

    await undo.trigger('click')
    await flushPromises()
    await expect(repository.getProject(original!.id)).resolves.toMatchObject({
      name: original!.name,
    })
    expect(redo.attributes('disabled')).toBeUndefined()

    await redo.trigger('click')
    await flushPromises()
    await expect(repository.getProject(original!.id)).resolves.toMatchObject({
      name: '刚刚修改的家谱',
    })

    wrapper.unmount()
  })

  it('records a failed undo without restoring the removed topbar announcement', async () => {
    const repository = makeRepository()
    const [project] = await repository.listProjects()
    await repository.updateProject(project!.id, { description: '待撤销' })
    const { wrapper, session } = await mountShell(
      `/project/${project!.id}/people`,
      repository,
    )
    await session.refreshHistory(repository)
    repository.failNextWrite(new Error('模拟保存失败，请稍后重试'))

    await wrapper.get('button[aria-label="撤销最近修改"]').trigger('click')
    await flushPromises()

    expect(session.saveStatus).toBe('failed')
    expect(session.saveError).toContain('Injected write failure for branchloom.prototype.v1')
    expect(wrapper.find('.app-topbar [role="alert"]').exists()).toBe(false)

    wrapper.unmount()
  })
})
