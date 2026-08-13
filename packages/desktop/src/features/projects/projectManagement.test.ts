import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App.vue'
import { createAppRouter } from '../../app/router'
import { useSessionStore } from '../../app/stores/session'
import type { BranchloomRepository } from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'

const localAttachmentMocks = vi.hoisted(() => ({
  refreshNativeRepository: vi.fn(() => Promise.resolve(false)),
  setLocalAttachment: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../shared/repository/TauriRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/repository/TauriRepository')>()
  return {
    ...actual,
    refreshNativeRepository: localAttachmentMocks.refreshNativeRepository,
    setLocalAttachment: localAttachmentMocks.setLocalAttachment,
  }
})

const PROJECT_ID = 'project-demo-family'
const mountedWrappers: VueWrapper[] = []

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
    idFactory: () => `project-management-${++id}`,
  })
}

async function mountManagement(
  path: string,
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
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await router.isReady()
  await flushPromises()
  return { wrapper, router, session: useSessionStore(pinia) }
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
  localAttachmentMocks.refreshNativeRepository.mockClear()
  localAttachmentMocks.setLocalAttachment.mockClear()
  document.body.innerHTML = ''
})

describe('project overview', () => {
  it('shows every required project count, storage size, modification time, and backup time', async () => {
    const { wrapper } = await mountManagement(`/project/${PROJECT_ID}/manage/overview`)

    expect(wrapper.get('h1').text()).toBe('项目概览')
    const stats = wrapper.get('[aria-label="项目统计"]')
    expect(stats.text()).toContain('12')
    expect(stats.text()).toContain('人物')
    expect(stats.text()).toContain('13')
    expect(stats.text()).toContain('关系')
    expect(stats.text()).toContain('8')
    expect(stats.text()).toContain('事件')
    expect(stats.text()).toContain('5')
    expect(stats.text()).toContain('来源')
    expect(stats.text()).toContain('4')
    expect(stats.text()).toContain('附件')
    expect(stats.text()).toContain('9.0 MB')
    expect(wrapper.get('time[data-field="updatedAt"]').attributes('datetime'))
      .toBe('2026-06-18T09:30:00.000Z')
    expect(wrapper.get('time[data-field="lastBackupAt"]').attributes('datetime'))
      .toBe('2026-06-18T09:00:00.000Z')
    expect(wrapper.get('a[aria-label="打开项目设置"]').attributes('href'))
      .toBe(`/project/${PROJECT_ID}/manage/settings`)
  })
})

describe('project settings', () => {
  it('places GitHub synchronization in the standalone collaboration workspace', async () => {
    const settings = await mountManagement(`/project/${PROJECT_ID}/manage/settings`)
    expect(settings.wrapper.find('.github-sync').exists()).toBe(false)

    const history = await mountManagement(`/project/${PROJECT_ID}/manage/history`)
    expect(history.wrapper.find('.github-sync').exists()).toBe(false)

    const collaboration = await mountManagement(`/project/${PROJECT_ID}/collaboration-sync`)
    expect(collaboration.wrapper.get('.github-sync h1').text()).toBe('协作同步')
    expect(collaboration.wrapper.text()).toContain('GitHub 同步仅在桌面端可用')
  })

  it('renames without changing the stable id or the center person', async () => {
    const repository = makeRepository()
    const before = await repository.getProject(PROJECT_ID)
    const updateProject = vi.spyOn(repository, 'updateProject')
    const { wrapper, session } = await mountManagement(
      `/project/${PROJECT_ID}/manage/settings`,
      repository,
    )

    await wrapper.get('input[name="projectName"]').setValue('  林家迁徙档案  ')
    await wrapper.get('textarea[name="projectDescription"]').setValue(' 新的项目说明 ')
    await wrapper.get('button[name="保存项目设置"]').trigger('click')
    await flushPromises()

    const saved = await repository.getProject(PROJECT_ID)
    expect(saved).toMatchObject({
      id: before.id,
      createdAt: before.createdAt,
      name: '林家迁徙档案',
      description: '新的项目说明',
      defaultPersonId: before.defaultPersonId,
      backupSchedule: before.backupSchedule,
    })
    expect(updateProject).toHaveBeenCalledWith(PROJECT_ID, {
      name: '林家迁徙档案',
      description: '新的项目说明',
    })
    expect(session.currentProjectName).toBe('林家迁徙档案')
    expect(session.saveStatus).toBe('saved')
    expect(wrapper.text()).not.toContain('本地备份策略')
    const cover = wrapper.get('input[name="projectCoverFile"]')
    expect(cover.attributes('type')).toBe('file')
    expect(cover.attributes('accept')).toBe('image/*')
    expect(cover.element.closest('.base-field')?.classList.contains('project-settings__field--wide')).toBe(true)
    expect(wrapper.find('input[name="projectCoverUrl"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('默认中心人物')
    expect(wrapper.find('[name="defaultPersonId"]').exists()).toBe(false)
    expect(wrapper.find('.project-settings__prototype').exists()).toBe(false)
  })

  it('previews a selected cover immediately but stores it only after saving', async () => {
    const repository = makeRepository()
    const before = await repository.getProject(PROJECT_ID)
    const { wrapper } = await mountManagement(
      `/project/${PROJECT_ID}/manage/settings`,
      repository,
    )
    const cover = wrapper.get('input[name="projectCoverFile"]')
    const file = new File(['project-cover'], 'zhao-song-cover.png', { type: 'image/png' })
    Object.defineProperty(cover.element, 'files', { configurable: true, value: [file] })

    await cover.trigger('change')
    await vi.waitFor(() => expect(wrapper.get('.project-settings__cover-picker img').attributes('src'))
      .toContain('data:image/png;base64,'))

    expect(wrapper.get('.project-settings__cover-staged').text()).toContain('zhao-song-cover.png · 待保存')
    expect(localAttachmentMocks.setLocalAttachment).not.toHaveBeenCalled()
    expect((await repository.getProject(PROJECT_ID)).coverUrl).toBe(before.coverUrl)

    await wrapper.get('button[name="保存项目设置"]').trigger('click')
    await flushPromises()

    expect(localAttachmentMocks.setLocalAttachment).toHaveBeenCalledWith(
      PROJECT_ID,
      'project',
      PROJECT_ID,
      'cover',
      file,
    )
    expect(localAttachmentMocks.refreshNativeRepository).toHaveBeenCalledWith(repository, true)
    expect(wrapper.find('.project-settings__cover-staged').exists()).toBe(false)
  })

  it('requires the exact project name before deleting the current project', async () => {
    const repository = makeRepository()
    const project = await repository.getProject(PROJECT_ID)
    const { wrapper, router } = await mountManagement(
      `/project/${PROJECT_ID}/manage/settings`,
      repository,
    )

    await wrapper.get('button[name="删除当前项目"]').trigger('click')
    const dialog = wrapper.get('[role="dialog"]')
    expect(dialog.text()).toContain('将被永久删除')
    const confirm = dialog.get('button[name="确认删除当前项目"]')
    expect(confirm.attributes('disabled')).toBeDefined()
    await dialog.get('input[name="deleteProjectConfirmation"]').setValue(`${project.name} `)
    expect(confirm.attributes('disabled')).toBeDefined()
    await dialog.get('input[name="deleteProjectConfirmation"]').setValue(project.name)
    const enabledDelete = wrapper.get('button[name="确认删除当前项目"]')
    expect(enabledDelete.attributes('disabled')).toBeUndefined()
    await enabledDelete.trigger('click')
    await flushPromises()

    await expect(repository.getProject(PROJECT_ID)).rejects.toThrow('Project')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('new-project'))
  })

  it('does not expose fixture reset controls in project settings', async () => {
    const { wrapper } = await mountManagement(`/project/${PROJECT_ID}/manage/settings`)
    expect(wrapper.find('button[name="重置演示数据"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('原型能力')
  })
})
