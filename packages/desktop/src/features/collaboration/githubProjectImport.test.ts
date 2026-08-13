import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { GithubSyncGateway } from '../../shared/githubSync'
import GithubProjectImportPanel from './components/GithubProjectImportPanel.vue'
import githubProjectImportViewSource from './views/GithubProjectImportView.vue?raw'

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
      placeholderProjectId: 'project-placeholder',
      owner: 'family-owner',
      repository: 'family-tree',
      branch: 'main',
      token: 'replacement-token',
    })
    expect(wrapper.find('input[name="githubImportToken"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('远端李氏家谱')
  })

  it('does not expose repository fields in the browser preview', () => {
    const wrapper = mount(GithubProjectImportPanel, {
      props: { gateway: gateway({ available: () => false }) },
    })

    expect(wrapper.text()).toContain('GitHub 项目导入仅在桌面端可用')
    expect(wrapper.find('input[name="githubImportToken"]').exists()).toBe(false)
  })
})

describe('GitHub project import layout', () => {
  it('switches the import view to one column before the home content area can clip it', () => {
    expect(githubProjectImportViewSource).toMatch(
      /@media \(max-width: 60rem\)\s*{\s*\.github-import-view\s*{\s*grid-template-columns: 1fr;/,
    )
  })
})
