import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import {
  githubError,
  type GithubOperationProgress,
  type GithubProjectImportPreview,
  type GithubSyncGateway,
} from '../../shared/githubSync'
import GithubProjectImportPanel from './components/GithubProjectImportPanel.vue'
import githubProjectImportPanelSource from './components/GithubProjectImportPanel.vue?raw'
import githubProjectImportViewSource from './views/GithubProjectImportView.vue?raw'

const globalStyles = readFileSync(resolve(process.cwd(), 'src/app/styles/base.css'), 'utf8')

function gateway(overrides: Partial<GithubSyncGateway> = {}): GithubSyncGateway {
  return {
    available: () => true,
    connection: vi.fn(async () => null),
    connect: vi.fn(async () => ({ repositoryExisted: true, privateRepositoryCreated: false })),
    preview: vi.fn(async () => ({
      changedLocal: false,
      willPush: false,
      conflicts: [],
      fingerprint: 'sync.v2.preview',
    })),
    apply: vi.fn(async () => ({
      status: 'upToDate',
      changedLocal: false,
      baselineUpdated: true,
    })),
    previewImport: vi.fn(async (input) => ({
      projectId: 'project-remote',
      projectName: '远端李氏家谱',
      projectDescription: '家人共同维护的档案',
      commit: 'commit-remote',
      recordCounts: { people: 12, relationships: 8, attachments: 3 },
      replacesProjectId: input.placeholderProjectId,
      alreadyExists: false,
      fingerprint: 'github-import.v1.preview',
    })),
    applyImport: vi.fn(async (input) => ({
      projectId: 'project-remote',
      replacedProjectId: input.placeholderProjectId,
      baselineUpdated: true,
      credentialStored: true,
      warnings: [],
    })),
    ...overrides,
  }
}

describe('GitHub project import panel', () => {
  it('previews and imports a GitHub project directly from the home flow', async () => {
    const syncGateway = gateway()
    const wrapper = mount(GithubProjectImportPanel, {
      props: { gateway: syncGateway },
    })

    await wrapper.get('input[name="githubImportOwner"]').setValue('family-owner')
    await wrapper.get('input[name="githubImportRepository"]').setValue('family-tree')
    await wrapper.get('input[name="githubImportToken"]').setValue('session-token')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(syncGateway.previewImport).toHaveBeenCalledWith({
      operationId: expect.any(String),
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: 'session-token',
    })
    expect(wrapper.text()).toContain('远端李氏家谱')
    expect(wrapper.text()).toContain('12 / 8 / 3')

    await wrapper.get('button[name="确认导入 GitHub 项目"]').trigger('click')
    await flushPromises()

    expect(syncGateway.applyImport).toHaveBeenCalledWith({
      operationId: expect.any(String),
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: 'session-token',
      expectedFingerprint: 'github-import.v1.preview',
    })
    expect(wrapper.emitted('imported')?.[0]?.[0]).toMatchObject({ projectId: 'project-remote' })
  })

  it('covers an empty placeholder directly after the import preview', async () => {
    const syncGateway = gateway()
    const wrapper = mount(GithubProjectImportPanel, {
      props: {
        gateway: syncGateway,
        placeholderProjectId: 'project-placeholder',
        initialOwner: 'family-owner',
        initialRepository: 'family-tree',
      },
    })

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(syncGateway.previewImport).toHaveBeenCalledWith({
      operationId: expect.any(String),
      placeholderProjectId: 'project-placeholder',
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: '',
    })
    expect(wrapper.find('input[name="confirmGithubBlankReplacement"]').exists()).toBe(false)
    expect(wrapper.get('button[name="确认导入 GitHub 项目"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('将直接覆盖当前空白项目')
    expect(wrapper.get('button[name="确认导入 GitHub 项目"]').text()).toContain('覆盖当前空白项目')

    await wrapper.get('button[name="确认导入 GitHub 项目"]').trigger('click')
    await flushPromises()

    expect(syncGateway.applyImport).toHaveBeenCalledWith(expect.objectContaining({
      placeholderProjectId: 'project-placeholder',
      expectedFingerprint: 'github-import.v1.preview',
    }))
    expect(wrapper.emitted('imported')?.[0]?.[0]).toMatchObject({
      projectId: 'project-remote',
      replacedProjectId: 'project-placeholder',
    })
  })

  it('automatically previews a connected repository and only asks for a token when the saved credential fails', async () => {
    const previewImport = vi
      .fn<GithubSyncGateway['previewImport']>()
      .mockRejectedValueOnce(new Error('没有找到已保存的 GitHub Token，请重新输入并连接仓库'))
      .mockResolvedValueOnce({
        projectId: 'project-remote',
        projectName: '远端李氏家谱',
        projectDescription: '',
        commit: 'commit-remote',
        recordCounts: { people: 12 },
        replacesProjectId: 'project-placeholder',
        alreadyExists: false,
        fingerprint: 'github-import.v1.preview',
      })
    const wrapper = mount(GithubProjectImportPanel, {
      props: {
        gateway: gateway({ previewImport }),
        placeholderProjectId: 'project-placeholder',
        initialOwner: 'family-owner',
        initialRepository: 'family-tree',
        autoPreview: true,
      },
    })

    await flushPromises()

    expect(previewImport).toHaveBeenNthCalledWith(1, {
      operationId: expect.any(String),
      placeholderProjectId: 'project-placeholder',
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: '',
    })
    expect(wrapper.find('input[name="githubImportOwner"]').exists()).toBe(false)
    expect(wrapper.get('input[name="githubImportToken"]').attributes('required')).toBeDefined()

    await wrapper.get('input[name="githubImportToken"]').setValue('replacement-token')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(previewImport).toHaveBeenNthCalledWith(2, {
      operationId: expect.any(String),
      placeholderProjectId: 'project-placeholder',
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: 'replacement-token',
    })
    expect(wrapper.find('input[name="githubImportToken"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('远端李氏家谱')
  })

  it('shows live repository progress and releases the shared listener', async () => {
    let finishPreview!: (preview: GithubProjectImportPreview) => void
    let progressHandler!: (progress: GithubOperationProgress) => void
    const unsubscribe = vi.fn()
    const previewImport = vi.fn<GithubSyncGateway['previewImport']>(() => new Promise((resolve) => {
      finishPreview = resolve
    }))
    const subscribeProgress = vi.fn<NonNullable<GithubSyncGateway['subscribeProgress']>>(async (handler) => {
      progressHandler = handler
      return unsubscribe
    })
    const wrapper = mount(GithubProjectImportPanel, {
      props: { gateway: gateway({ previewImport, subscribeProgress }) },
    })
    await flushPromises()

    await wrapper.get('input[name="githubImportOwner"]').setValue('family-owner')
    await wrapper.get('input[name="githubImportRepository"]').setValue('family-tree')
    await wrapper.get('input[name="githubImportToken"]').setValue('session-token')
    await wrapper.get('form').trigger('submit')

    const operationId = previewImport.mock.calls[0]?.[0].operationId
    expect(operationId).toEqual(expect.any(String))
    progressHandler({
      operationId: operationId!,
      projectId: 'github-import',
      operation: 'previewImport',
      phase: 'downloading-files',
      message: '正在读取 GitHub 资料 6 / 12…',
      completed: 6,
      total: 12,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.github-import__progress').attributes('role')).toBe('status')
    expect(wrapper.text()).toContain('正在整理仓库资料')
    expect(wrapper.text()).toContain('正在读取 GitHub 资料 6 / 12')
    expect(wrapper.text()).toContain('6 / 12')
    expect(wrapper.get('.github-import__progress-track > span').attributes('style')).toContain('50%')

    finishPreview({
      projectId: 'project-remote',
      projectName: '远端李氏家谱',
      projectDescription: '',
      commit: 'commit-remote',
      recordCounts: { people: 12 },
      alreadyExists: false,
      fingerprint: 'github-import.v1.preview',
    })
    await flushPromises()
    expect(wrapper.find('.github-import__progress').exists()).toBe(false)

    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not expose repository fields in the browser preview', () => {
    const wrapper = mount(GithubProjectImportPanel, {
      props: { gateway: gateway({ available: () => false }) },
    })

    expect(wrapper.text()).toContain('GitHub 项目导入仅在桌面端可用')
    expect(wrapper.find('input[name="githubImportToken"]').exists()).toBe(false)
  })

  it('explains that mobile tokens are retained only for the current app session', () => {
    const wrapper = mount(GithubProjectImportPanel, {
      props: { gateway: gateway(), mobileRuntime: true },
    })

    expect(wrapper.text()).toContain('Token 只在本次 App 运行期间保留')
    expect(wrapper.text()).not.toContain('导入后保存在系统安全凭据中')
  })

  it('turns a transport failure with a long blob URL into a concise retry message', () => {
    const failure = githubError(
      new Error('remote operation failed: error sending request for url (https://api.github.com/repos/family/archive/git/blobs/very-long-sha)'),
      '无法读取 GitHub 项目。',
    )

    expect(failure).toBe('读取 GitHub 时网络连接中断，应用已自动重试；请确认网络稳定后再次尝试。')
    expect(failure).not.toContain('https://')
  })
})

describe('GitHub project import layout', () => {
  it('switches the import view to one column before the home content area can clip it', () => {
    expect(githubProjectImportViewSource).toMatch(
      /@media \(max-width: 60rem\)\s*{\s*\.github-import-view\s*{\s*grid-template-columns: 1fr;/,
    )
  })

  it('globally contains long text without widening the app viewport', () => {
    expect(globalStyles).toMatch(/html,\s*body,\s*#app\s*{[^}]*overflow-x:\s*hidden;/s)
    expect(globalStyles).toMatch(/body\s*{[^}]*overflow-wrap:\s*anywhere;/s)
  })

  it('uses a compact responsive progress card for desktop and mobile import', () => {
    expect(githubProjectImportPanelSource).toContain('github-import__progress-track')
    expect(githubProjectImportPanelSource).toMatch(/\.github-import__progress\s*{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s)
    expect(githubProjectImportPanelSource).toMatch(/@media \(max-width: 38rem\)[\s\S]*\.github-import__progress-heading/)
  })
})
