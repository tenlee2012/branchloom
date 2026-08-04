import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGithubSyncStore } from '../../app/stores/githubSync'
import type {
  GithubConnectionStatus,
  GithubOperationProgress,
  GithubSyncGateway,
  GithubSyncPreview,
} from '../../shared/githubSync'
import GithubSyncPanel from './components/GithubSyncPanel.vue'

const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../shared/externalLinks', () => ({ openExternalUrl }))

const PROJECT_ID = 'project-demo-family'
const wrappers: VueWrapper[] = []

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
    ...overrides,
  }
}

function mountPanel(syncGateway: GithubSyncGateway) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(GithubSyncPanel, {
    attachTo: document.body,
    props: { projectId: PROJECT_ID, gateway: syncGateway },
    global: { plugins: [pinia] },
  })
  wrappers.push(wrapper)
  return { wrapper, store: useGithubSyncStore(pinia) }
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

    expect(wrapper.text()).toContain('GitHub 同步只在 Tauri 桌面应用中可用')
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
    expect(wrapper.get('input[name="githubToken"]').element).toHaveProperty('value', 'session-token')
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

    expect(wrapper.get('.github-sync__heading .status-badge').text()).toBe('已配置')
    await wrapper.get('input[name="githubToken"]').setValue('expired-token')
    await wrapper.get('button[name="连接 GitHub 仓库"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.github-sync__heading .status-badge').text()).toBe('连接异常')
    expect(wrapper.get('.github-sync__operation').text()).toContain('GitHub Token 无效或已过期')
    expect(wrapper.text()).toContain('family-owner/family-tree')
  })

  it('explains how to create tokens and links to official GitHub pages', async () => {
    const { wrapper } = mountPanel(gateway())
    await flushPromises()

    await wrapper.get('button[aria-label="查看 GitHub token 申请帮助"]').trigger('click')
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
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

    await wrapper.get('input[name="githubToken"]').setValue('session-token')
    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('同步预览')
    expect(wrapper.get('.github-sync__heading .status-badge').text()).toBe('连接正常')
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
    await wrapper.get('input[name="githubToken"]').setValue('session-token')

    await wrapper.get('button[name="预览 GitHub 完整同步"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button[name="连接 GitHub 仓库"]').attributes('disabled')).toBeDefined()

    previewTask.resolve({
      pulledCommit: 'remote-commit',
      changedLocal: false,
      willPush: false,
      conflicts: [],
      fingerprint: 'sync.v1.preview',
    })
    await flushPromises()
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
    await wrapper.get('input[name="githubToken"]').setValue('session-token')

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
    expect(wrapper.get('.github-sync__operation').text()).toContain('预览完整同步已完成')
    expect(wrapper.get('.github-sync__operation').text()).toContain('同步预览已生成')
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

    await wrapper.get('input[name="githubToken"]').setValue('session-token')
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
    })
  })
})
