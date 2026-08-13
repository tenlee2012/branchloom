import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGithubSyncStore } from '../../app/stores/githubSync'
import type {
  GithubConnectionStatus,
  GithubOperationProgress,
  GithubSyncGateway,
  GithubSyncInitializationStrategy,
  GithubSyncPreview,
} from '../../shared/githubSync'
import GithubSyncPanel from './components/GithubSyncPanel.vue'

const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../shared/externalLinks', () => ({ openExternalUrl }))

const PROJECT_ID = 'project-demo-family'
const wrappers: VueWrapper[] = []

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn(),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function gateway(overrides: Partial<GithubSyncGateway> = {}): GithubSyncGateway {
  return {
    available: () => true,
    connection: vi.fn(async () => null),
    connect: vi.fn(async () => ({
      repositoryExisted: true,
      privateRepositoryCreated: false,
    })),
    preview: vi.fn(async () => ({
      pulledCommit: 'remote-commit',
      changedLocal: false,
      willPush: true,
      conflicts: [],
      fingerprint: 'sync.v1.preview',
    })),
    apply: vi.fn(async () => ({
      status: 'synchronized',
      pulledCommit: 'remote-commit',
      pushedCommit: 'pushed-commit',
      changedLocal: false,
    })),
    previewImport: vi.fn(async () => ({
      projectId: 'project-remote',
      projectName: '远端家谱',
      projectDescription: '',
      commit: 'remote-commit',
      recordCounts: {},
      replacesProjectId: PROJECT_ID,
      alreadyExists: false,
      fingerprint: 'github-import.v1.preview',
    })),
    applyImport: vi.fn(async () => ({
      projectId: 'project-remote',
      replacedProjectId: PROJECT_ID,
      baselineUpdated: true,
      credentialStored: true,
      warnings: [],
    })),
    ...overrides,
  }
}

function mountPanel(syncGateway: GithubSyncGateway) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(GithubSyncPanel, {
    attachTo: document.body,
    props: { projectId: PROJECT_ID, gateway: syncGateway },
    global: { plugins: [pinia], stubs: { Teleport: true } },
  })
  wrappers.push(wrapper)
  return { wrapper, store: useGithubSyncStore(pinia) }
}

async function openConnectionSettings(wrapper: VueWrapper) {
  if (wrapper.find('input[name="githubOwner"]').exists()) return
  await wrapper.get('.github-sync__page-heading button[name="打开连接设置"]').trigger('click')
  await wrapper.vm.$nextTick()
}

async function setSessionToken(wrapper: VueWrapper, token = 'session-token') {
  await openConnectionSettings(wrapper)
  await wrapper.get('input[name="githubToken"]').setValue(token)
  await wrapper.get('button[aria-label="关闭 GitHub 连接设置"]').trigger('click')
  await wrapper.vm.$nextTick()
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0).reverse()) wrapper.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('GitHub sync panel', () => {
  it('keeps GitHub unavailable in the browser preview', async () => {
    const { wrapper } = mountPanel(gateway({ available: () => false }))
    await flushPromises()

    expect(wrapper.text()).toContain('GitHub 同步仅在桌面端可用')
    expect(wrapper.find('input[name="githubToken"]').exists()).toBe(false)
  })

  it('connects explicitly and starts the in-process hourly schedule', async () => {
    vi.useFakeTimers()
    let connection: GithubConnectionStatus | null = null
    const syncGateway = gateway({
      connection: vi.fn(async () => connection),
      connect: vi.fn(async (input) => {
        connection = {
          owner: input.owner,
          repository: input.repository,
          branch: input.branch,
          lastSyncedCommit: 'initial-commit',
          credentialStored: true,
        }
        return { repositoryExisted: false, privateRepositoryCreated: true }
      }),
    })
    const { wrapper, store } = mountPanel(syncGateway)
    await flushPromises()

    await openConnectionSettings(wrapper)
    await wrapper.get('input[name="githubOwner"]').setValue('family-owner')
    await wrapper.get('input[name="githubRepository"]').setValue('family-tree')
    await wrapper.get('input[name="githubBranch"]').setValue('main')
    await wrapper.get('input[name="githubToken"]').setValue('session-token')
    await wrapper.get('input[name="githubCreateIfMissing"]').setValue(true)
    await wrapper.get('button[name="连接 GitHub 仓库"]').trigger('click')
    await flushPromises()

    expect(syncGateway.connect).toHaveBeenCalledWith({
      operationId: expect.any(String),
      projectId: PROJECT_ID,
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: 'session-token',
      createIfMissing: true,
    })
    expect(wrapper.text()).toContain('私有仓库已创建')
    expect(wrapper.text()).toContain('family-owner/family-tree')
    expect(store.status(PROJECT_ID).enabled).toBe(true)
    expect(store.hasToken(PROJECT_ID)).toBe(true)
    expect(store.credential(PROJECT_ID)).toBe('')
    await openConnectionSettings(wrapper)
    expect(wrapper.get('input[name="githubToken"]').element).toHaveProperty('value', '')
    expect(wrapper.get('.github-sync__token-stored').text()).toBe('已安全保存')
    store.stop(PROJECT_ID)
  })

  it('uses a securely stored credential without asking for the token again', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
    })
    const { wrapper, store } = mountPanel(syncGateway)
    await flushPromises()

    await openConnectionSettings(wrapper)
    expect(wrapper.get('input[name="githubToken"]').element).toHaveProperty('value', '')
    expect(wrapper.get('.github-sync__token-mask').text()).toBe('••••••••••••••••')
    expect(wrapper.get('.github-sync__token-stored').text()).toBe('已安全保存')
    await wrapper.get('input[name="githubToken"]').setValue('replacement-token')
    expect(wrapper.find('.github-sync__token-mask').exists()).toBe(false)
    await wrapper.get('input[name="githubToken"]').setValue('')
    expect(wrapper.find('.github-sync__token-mask').exists()).toBe(true)
    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    expect(syncGateway.preview).toHaveBeenCalledWith(expect.objectContaining({ token: '' }))
    expect(wrapper.text()).toContain('同步预览已生成')
    store.stop(PROJECT_ID)
  })

  it('opens reconnection only when the stored credential cannot be loaded for a preview', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview: vi.fn(async () => {
        throw new Error('没有找到已保存的 GitHub Token，请重新输入并连接仓库')
      }),
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    expect(wrapper.find('input[name="githubToken"]').exists()).toBe(false)
    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('input[name="githubToken"]').element).toHaveProperty('value', '')
    expect(wrapper.find('.github-sync__token-mask').exists()).toBe(false)
    expect(wrapper.text()).toContain('已保存的 GitHub Token 不可用')
  })

  it('distinguishes a saved configuration from a healthy GitHub connection', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      connect: vi.fn(async () => {
        throw new Error('remote operation failed: GitHub returned 401 Unauthorized: Bad credentials')
      }),
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    expect(wrapper.get('#github-sync-state-title').text()).toBe('仓库已连接，可以同步')
    await openConnectionSettings(wrapper)
    await wrapper.get('input[name="githubToken"]').setValue('expired-token')
    await wrapper.get('button[name="连接 GitHub 仓库"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('#github-sync-state-title').text()).toBe('同步遇到问题')
    expect(wrapper.get('.github-sync__operation').text()).toContain('GitHub Token 无效或已过期')
    expect(wrapper.text()).toContain('family-owner/family-tree')
  })

  it('explains how to create tokens and links to official GitHub pages', async () => {
    const { wrapper } = mountPanel(gateway())
    await flushPromises()

    await openConnectionSettings(wrapper)
    await wrapper.get('button[aria-label="查看 GitHub token 申请帮助"]').trigger('click')
    await flushPromises()

    const dialog = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .find((candidate) => candidate.textContent?.includes('Fine-grained token'))
    expect(dialog?.textContent).toContain('Fine-grained token')
    expect(dialog?.textContent).toContain('Contents')
    expect(dialog?.textContent).toContain('Read and write')
    expect(dialog?.textContent).toContain('Classic token')
    expect(dialog?.querySelector(
      'a[href="https://github.com/settings/personal-access-tokens/new"]',
    )).not.toBeNull()
    const classicLink = Array.from(dialog?.querySelectorAll('a') ?? [])
      .find((link) => link.textContent?.includes('创建 Classic token'))
    expect(classicLink?.getAttribute('href')).toBe(
      'https://github.com/settings/tokens/new?scopes=repo&description=Branchloom',
    )

    const links = Array.from(dialog?.querySelectorAll('a') ?? [])
    for (const link of links) {
      link.click()
      await flushPromises()
    }
    expect(openExternalUrl.mock.calls).toEqual(links.map((link) => [link.href]))
  })

  it.each([
    {
      strategy: 'remote' as GithubSyncInitializationStrategy,
      buttonName: '预览使用 GitHub 版本进行首次同步',
      changedLocal: true,
      willPush: false,
      summary: 'GitHub 更新将写入本地',
    },
    {
      strategy: 'local' as GithubSyncInitializationStrategy,
      buttonName: '预览使用本地版本进行首次同步',
      changedLocal: false,
      willPush: true,
      summary: '本地更新将上传到 GitHub',
    },
  ])('initializes the first synchronization from the $strategy version only after preview and confirmation', async ({
    strategy,
    buttonName,
    changedLocal,
    willPush,
    summary,
  }) => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const initializationPreview: GithubSyncPreview = {
      pulledCommit: 'remote-commit',
      changedLocal,
      willPush,
      conflicts: [],
      fingerprint: `sync.v2.initial-${strategy}`,
    }
    const preview = vi
      .fn<GithubSyncGateway['preview']>()
      .mockRejectedValueOnce(new Error(
        'project data conflict: remote project has history but no local synchronization baseline',
      ))
      .mockResolvedValueOnce(initializationPreview)
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview,
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('#github-sync-state-title').text()).toBe('首次同步需要选择版本')
    expect(wrapper.text()).toContain('有谱不会自动覆盖任何一方')
    expect(wrapper.find('button[name="预览使用 GitHub 版本进行首次同步"]').exists()).toBe(true)
    expect(wrapper.find('button[name="预览使用本地版本进行首次同步"]').exists()).toBe(true)

    await wrapper.get(`button[name="${buttonName}"]`).trigger('click')
    await flushPromises()

    expect(preview).toHaveBeenLastCalledWith({
      operationId: expect.any(String),
      projectId: PROJECT_ID,
      token: '',
      pullOnly: false,
      resolutions: [],
      initializationStrategy: strategy,
    })
    expect(wrapper.get('#github-sync-state-title').text()).toBe('同步预览已准备好')
    expect(wrapper.text()).toContain(summary)

    await wrapper.get('button[name="确认执行 GitHub 同步"]').trigger('click')
    await flushPromises()

    expect(syncGateway.apply).toHaveBeenCalledWith({
      operationId: expect.any(String),
      projectId: PROJECT_ID,
      token: '',
      pullOnly: false,
      resolutions: [],
      initializationStrategy: strategy,
      expectedFingerprint: `sync.v2.initial-${strategy}`,
    })
  })

  it('can postpone first synchronization without writing either version', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview: vi.fn(async () => {
        throw new Error(
          'project data conflict: remote project has history but no local synchronization baseline',
        )
      }),
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()
    await wrapper.get('button[name="暂不处理首次同步"]').trigger('click')
    await flushPromises()

    expect(syncGateway.apply).not.toHaveBeenCalled()
    expect(wrapper.get('#github-sync-state-title').text()).toBe('首次同步需要选择版本')
    expect(wrapper.find('button[name="暂不处理首次同步"]').exists()).toBe(false)
  })

  it('offers to adopt a different stable GitHub project when the local project is blank', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview: vi.fn(async () => {
        throw new Error(
          'project data conflict: remote project id project-remote does not match local project id project-local',
        )
      }),
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.github-sync__operation').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('预览完整同步失败')
    expect(wrapper.get('#github-sync-state-title').text()).toBe('发现可导入的 GitHub 项目')
    expect(wrapper.get('.github-sync__hero').classes()).toContain('github-sync__hero--info')
    expect(wrapper.get('.github-sync__hero').classes()).not.toContain('github-sync__hero--danger')
    expect(wrapper.get('.github-sync__hero').text()).toContain('当前项目为空时，可以检查内容并采用仓库项目')
    expect(wrapper.find('button[name="用 GitHub 项目替换当前空白项目"]').exists()).toBe(false)
    expect(wrapper.findAll('button[name="检查并导入 GitHub 项目"]')).toHaveLength(1)
    expect(wrapper.find('button[name="预览使用 GitHub 版本进行首次同步"]').exists()).toBe(false)
    expect(syncGateway.apply).not.toHaveBeenCalled()

    await wrapper.get('.github-sync__hero-actions button[name="检查并导入 GitHub 项目"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="dialog"]').text()).toContain('用 GitHub 项目覆盖当前空白项目')
    expect(syncGateway.previewImport).toHaveBeenCalledWith({
      placeholderProjectId: PROJECT_ID,
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: '',
    })
    expect(wrapper.find('input[name="githubImportOwner"]').exists()).toBe(false)
    expect(wrapper.find('input[name="githubImportToken"]').exists()).toBe(false)
    expect(wrapper.find('input[name="confirmGithubBlankReplacement"]').exists()).toBe(false)
    expect(wrapper.get('[role="dialog"]').text()).toContain('远端家谱')
  })

  it('previews before apply and forwards the exact fingerprint', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      lastSyncedCommit: 'base-commit',
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    await setSessionToken(wrapper)
    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('同步预览')
    expect(wrapper.get('#github-sync-state-title').text()).toBe('同步预览已准备好')
    expect(syncGateway.preview).toHaveBeenCalledWith({
      operationId: expect.any(String),
      projectId: PROJECT_ID,
      token: 'session-token',
      pullOnly: false,
      resolutions: [],
    })

    await wrapper.get('button[name="确认执行 GitHub 同步"]').trigger('click')
    await flushPromises()

    expect(syncGateway.apply).toHaveBeenCalledWith({
      operationId: expect.any(String),
      projectId: PROJECT_ID,
      token: 'session-token',
      pullOnly: false,
      resolutions: [],
      expectedFingerprint: 'sync.v1.preview',
    })
    expect(wrapper.text()).toContain('GitHub 同步已完成')
  })

  it('prevents reconnect and preview requests from overlapping', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
    }
    const previewTask = deferred<GithubSyncPreview>()
    const connectTask = deferred<{ repositoryExisted: boolean, privateRepositoryCreated: boolean }>()
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      connect: vi.fn(() => connectTask.promise),
      preview: vi.fn(() => previewTask.promise),
    })
    const { wrapper, store } = mountPanel(syncGateway)
    await flushPromises()
    await setSessionToken(wrapper)

    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await wrapper.vm.$nextTick()
    await openConnectionSettings(wrapper)
    expect(wrapper.get('button[name="连接 GitHub 仓库"]').attributes('disabled')).toBeDefined()

    previewTask.resolve({
      pulledCommit: 'remote-commit',
      changedLocal: false,
      willPush: false,
      conflicts: [],
      fingerprint: 'sync.v1.preview',
    })
    await flushPromises()
    await openConnectionSettings(wrapper)
    await wrapper.get('button[name="连接 GitHub 仓库"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button[name="预览 GitHub 完整同步"]').attributes('disabled')).toBeDefined()

    connectTask.resolve({ repositoryExisted: true, privateRepositoryCreated: false })
    await flushPromises()
    store.stop(PROJECT_ID)
  })

  it('shows live background progress, elapsed time, and the final result', async () => {
    vi.useFakeTimers()
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
    }
    const previewTask = deferred<GithubSyncPreview>()
    const progressHandlers: Array<(progress: GithubOperationProgress) => void> = []
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview: vi.fn(() => previewTask.promise),
      subscribeProgress: vi.fn(async (handler) => {
        progressHandlers.push(handler)
        return () => undefined
      }),
    })
    const { wrapper, store } = mountPanel(syncGateway)
    await flushPromises()
    await setSessionToken(wrapper)

    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.github-sync__operation').text()).toContain('正在预览完整同步')
    expect(wrapper.get('.github-sync__operation').text()).toContain('正在启动完整同步预览')

    progressHandlers[0]?.({
      operationId: store.manualStatus(PROJECT_ID)!.operationId,
      projectId: PROJECT_ID,
      operation: 'previewFull',
      phase: 'fetching-remote',
      message: '正在下载 GitHub 远端资料并生成差异…',
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.github-sync__operation').text()).toContain('正在下载 GitHub 远端资料')

    await vi.advanceTimersByTimeAsync(15_000)
    expect(wrapper.get('.github-sync__operation').text()).toContain('已用时 15 秒')
    expect(wrapper.get('.github-sync__operation').text()).toContain('GitHub 响应较慢')

    previewTask.resolve({
      pulledCommit: 'remote-commit',
      changedLocal: false,
      willPush: false,
      conflicts: [],
      fingerprint: 'sync.v1.preview',
    })
    await flushPromises()
    expect(wrapper.find('.github-sync__operation').exists()).toBe(false)
    expect(wrapper.get('#github-sync-state-title').text()).toBe('同步预览已准备好')
    expect(wrapper.get('.github-sync__hero').text()).toContain('同步预览已生成')
  })

  it('requires every conflict choice and re-previews before apply', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
    }
    const conflict: GithubSyncPreview = {
      pulledCommit: 'remote-commit',
      changedLocal: true,
      willPush: false,
      fingerprint: 'conflicted',
      conflicts: [{
        path: 'data/people/pe/person-test.jsonld',
        field: '/biography',
        base: 'base',
        ours: 'local',
        theirs: 'remote',
      }],
    }
    const resolved: GithubSyncPreview = {
      pulledCommit: 'remote-commit',
      changedLocal: false,
      willPush: true,
      fingerprint: 'resolved',
      conflicts: [],
    }
    const preview = vi
      .fn<GithubSyncGateway['preview']>()
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce(resolved)
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview,
    })
    const { wrapper } = mountPanel(syncGateway)
    await flushPromises()

    await setSessionToken(wrapper)
    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    const resolve = wrapper.get('button[name="应用 GitHub 冲突选择"]')
    expect(resolve.attributes('disabled')).toBeDefined()
    await wrapper.get('.github-sync__choice select').setValue('ours')
    expect(resolve.attributes('disabled')).toBeUndefined()
    await resolve.trigger('click')
    await flushPromises()

    expect(preview).toHaveBeenLastCalledWith({
      operationId: expect.any(String),
      projectId: PROJECT_ID,
      token: 'session-token',
      pullOnly: false,
      resolutions: [{
        path: 'data/people/pe/person-test.jsonld',
        field: '/biography',
        choice: 'ours',
      }],
    })
    await wrapper.get('button[name="确认执行 GitHub 同步"]').trigger('click')
    await flushPromises()
    expect(syncGateway.apply).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.any(String),
      expectedFingerprint: 'resolved',
      resolutions: [{
        path: 'data/people/pe/person-test.jsonld',
        field: '/biography',
        choice: 'ours',
      }],
    }))
  })

  it('uses a resolved manual preview instead of falling back to stale automatic conflicts', async () => {
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
    }
    const conflict = {
      path: 'data/people/pe/person-test.jsonld',
      field: '/biography',
      base: 'base',
      ours: 'local',
      theirs: 'remote',
    }
    const preview = vi
      .fn<GithubSyncGateway['preview']>()
      .mockResolvedValueOnce({
        pulledCommit: 'remote-commit',
        changedLocal: true,
        willPush: false,
        conflicts: [conflict],
        fingerprint: 'conflicted',
      })
      .mockResolvedValueOnce({
        pulledCommit: 'remote-commit',
        changedLocal: false,
        willPush: true,
        conflicts: [],
        fingerprint: 'resolved',
      })
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview,
    })
    const { wrapper, store } = mountPanel(syncGateway)
    await flushPromises()
    store.statusByProject[PROJECT_ID] = {
      enabled: false,
      state: 'conflict',
      message: '自动同步已暂停。',
      conflicts: [conflict],
    }
    await setSessionToken(wrapper)

    await wrapper.get('button[name="处理 GitHub 冲突"]').trigger('click')
    await flushPromises()
    await wrapper.get('.github-sync__choice select').setValue('ours')
    await wrapper.get('button[name="应用 GitHub 冲突选择"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('button[name="确认执行 GitHub 同步"]').exists()).toBe(true)
    expect(wrapper.find('button[name="重新获取 GitHub 冲突预览"]').exists()).toBe(false)

    await wrapper.get('button[name="确认执行 GitHub 同步"]').trigger('click')
    await flushPromises()

    expect(syncGateway.apply).toHaveBeenCalledWith(expect.objectContaining({
      expectedFingerprint: 'resolved',
    }))
    expect(store.status(PROJECT_ID)).toMatchObject({
      enabled: false,
      state: 'idle',
      conflicts: [],
    })
  })
})

describe('automatic GitHub sync', () => {
  it('updates the status copy when automatic sync is enabled and disabled', async () => {
    vi.useFakeTimers()
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const { wrapper, store } = mountPanel(gateway({
      connection: vi.fn(async () => connected),
    }))
    await flushPromises()
    const toggle = wrapper.get('button[name="切换每小时自动同步"]')

    expect(toggle.text()).toBe('开启')
    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('已开启每 60 分钟自动同步。')
    expect(toggle.text()).toBe('关闭')
    expect(wrapper.find('.github-sync__success').exists()).toBe(false)

    await toggle.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('自动同步已关闭。')
    expect(wrapper.text()).not.toContain('已开启每 60 分钟自动同步。')
    expect(toggle.text()).toBe('开启')
    expect(wrapper.find('.github-sync__success').exists()).toBe(false)
    store.stop(PROJECT_ID)
  })

  it('uses preview fingerprint and refreshes the UI after remote data changes locally', async () => {
    vi.useFakeTimers()
    const changed: GithubSyncPreview = {
      pulledCommit: 'remote-commit',
      changedLocal: true,
      willPush: false,
      fingerprint: 'automatic-preview',
      conflicts: [],
    }
    const syncGateway = gateway({
      preview: vi.fn(async () => changed),
      apply: vi.fn(async () => ({
        status: 'synchronized',
        pulledCommit: 'remote-commit',
        changedLocal: true,
      })),
    })
    const onLocalChange = vi.fn()
    const { store } = mountPanel(syncGateway)
    store.start(PROJECT_ID, 'session-token', syncGateway, 60, onLocalChange)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(syncGateway.apply).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      token: 'session-token',
      pullOnly: false,
      resolutions: [],
      expectedFingerprint: 'automatic-preview',
    })
    expect(onLocalChange).toHaveBeenCalledOnce()
    expect(store.status(PROJECT_ID).state).toBe('success')
    store.stop(PROJECT_ID)
  })

  it('pauses the schedule when a conflict needs user input', async () => {
    vi.useFakeTimers()
    const syncGateway = gateway({
      preview: vi.fn(async () => ({
        changedLocal: false,
        willPush: false,
        fingerprint: 'conflict',
        conflicts: [{
          path: 'project.jsonld',
          field: '/name',
          base: 'A',
          ours: 'B',
          theirs: 'C',
        }],
      })),
    })
    const { store } = mountPanel(syncGateway)
    store.start(PROJECT_ID, 'session-token', syncGateway, 60)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(syncGateway.apply).not.toHaveBeenCalled()
    expect(store.status(PROJECT_ID)).toMatchObject({
      enabled: false,
      state: 'conflict',
      message: '自动同步已暂停，请在“协作同步”中解决冲突。',
    })
  })

  it('keeps first synchronization as a structured blocker and opens version selection directly', async () => {
    vi.useFakeTimers()
    const connected: GithubConnectionStatus = {
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      credentialStored: true,
    }
    const syncGateway = gateway({
      connection: vi.fn(async () => connected),
      preview: vi.fn(async () => {
        throw new Error(
          'project data conflict: remote project has history but no local synchronization baseline',
        )
      }),
    })
    const { wrapper, store } = mountPanel(syncGateway)
    await flushPromises()
    store.start(PROJECT_ID, 'session-token', syncGateway, 60)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(syncGateway.apply).not.toHaveBeenCalled()
    expect(store.status(PROJECT_ID)).toMatchObject({
      enabled: false,
      state: 'initializationRequired',
      message: '自动同步已暂停，请先在“协作同步”中选择首次同步版本。',
    })
    expect(wrapper.get('#github-sync-state-title').text()).toBe('首次同步需要选择版本')
    expect(wrapper.get('button[name="切换每小时自动同步"]').text()).toBe('选择版本')

    await wrapper.get('button[name="切换每小时自动同步"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button[name="预览使用 GitHub 版本进行首次同步"]').exists()).toBe(true)
    expect(store.hasToken(PROJECT_ID)).toBe(false)
    expect(store.status(PROJECT_ID).state).toBe('initializationRequired')
  })
})
