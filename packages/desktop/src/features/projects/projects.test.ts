import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { createAppRouter } from '../../app/router'
import type { BranchloomRepository, Project } from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import { BrowserRecentProjectLocations } from './model/recentProjectLocations'

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
    clock: () => '2026-07-18T08:00:00.000Z',
    idFactory: () => 'project-created-from-home',
  })
}

function overrideListProjects(
  repository: BranchloomRepository,
  listProjects: BranchloomRepository['listProjects'],
): BranchloomRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'listProjects') return listProjects
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function overrideCreateProject(
  repository: BranchloomRepository,
  createProject: BranchloomRepository['createProject'],
): BranchloomRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'createProject') return createProject
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function mountProjects(
  path: '/' | '/new',
  repository: BranchloomRepository = makeRepository(),
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter('memory')
  await router.push(path)
  const wrapper = mount(App, {
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
  return { wrapper, router, repository }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('project entry', () => {
  it('opens the latest project tree instead of the retired promotional home', async () => {
    const { wrapper, router } = await mountProjects('/')

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))
    expect(router.currentRoute.value.params.projectId).toBe('project-demo-family')
    expect(wrapper.find('.home-view').exists()).toBe(false)
    expect(wrapper.get('nav[aria-label="项目导航"]')).toBeTruthy()

    wrapper.unmount()
  })

  it('opens project creation when the repository is empty', async () => {
    const repository = overrideListProjects(makeRepository(), async () => [])
    const { wrapper, router } = await mountProjects('/', repository)

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('new-project'))
    expect(wrapper.get('h1').text()).toContain('从一个名字开始')

    wrapper.unmount()
  })

  it('records project creation as a recent local project', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T10:30:00.000Z'))
    try {
      const repository = makeRepository()
      const [project] = await repository.listProjects()
      const locations = new BrowserRecentProjectLocations(window.localStorage)

      locations.record(project!)

      expect(locations.list()[0]?.lastOpenedAt).toBe('2026-07-18T10:30:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('new project flow', () => {
  it('requires a project name after trimming whitespace', async () => {
    const { wrapper, router } = await mountProjects('/new')

    await wrapper.get('input[name="name"]').setValue('   ')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('#new-project-name-error').text()).toContain('请输入项目名称')
    expect(wrapper.get('input[name="name"]').attributes('aria-invalid')).toBe('true')
    expect(router.currentRoute.value.name).toBe('new-project')

    wrapper.unmount()
  })

  it('saves the optional description and enters the new project tree', async () => {
    const { wrapper, router, repository } = await mountProjects('/new')

    await wrapper.get('input[name="name"]').setValue('  周氏家庭档案  ')
    await wrapper.get('textarea[name="description"]').setValue('  整理祖辈迁居与家书  ')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists() ? wrapper.get('[role="alert"]').text() : '').toBe('')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))
    expect(router.currentRoute.value.params.projectId).toBe('project-created-from-home')
    const projects: Project[] = await repository.listProjects()
    expect(projects.find(({ id }) => id === 'project-created-from-home')).toMatchObject({
      name: '周氏家庭档案',
      description: '整理祖辈迁居与家书',
    })

    wrapper.unmount()
  })

  it('shows a fallback when project creation fails with an empty error', async () => {
    const repository = overrideCreateProject(makeRepository(), async () => {
      throw new Error('   ')
    })
    const { wrapper, router } = await mountProjects('/new', repository)

    await wrapper.get('input[name="name"]').setValue('不会静默失败的家谱')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('项目未能建立，请重试')
    expect(router.currentRoute.value.name).toBe('new-project')

    wrapper.unmount()
  })
})
