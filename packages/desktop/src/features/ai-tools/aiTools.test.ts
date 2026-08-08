import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiToolsView from './views/AiToolsView.vue'
import type { AiToolsStatus } from '../../shared/aiTools'

const mocks = vi.hoisted(() => ({
  available: vi.fn(() => true),
  status: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}))

vi.mock('../../shared/aiTools', () => ({
  tauriAiToolsGateway: mocks,
  aiToolsError: (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback,
}))

function status(state: 'notInstalled' | 'installed' = 'notInstalled'): AiToolsStatus {
  const installed = state === 'installed'
  return {
    platform: 'darwin-arm64',
    targetTriple: 'aarch64-apple-darwin',
    desktopVersion: '0.1.1',
    contractVersion: 3,
    compatible: installed,
    pathAvailable: false,
    pathInstruction: 'export PATH="$HOME/.local/bin:$PATH"',
    cli: {
      component: 'cli',
      state,
      path: '/tmp/home/.local/bin/branchloom',
      installedVersion: installed ? '0.1.1' : undefined,
      bundledVersion: '0.1.1',
      contractVersion: installed ? 3 : undefined,
      managed: installed,
      message: installed ? 'CLI 已安装并通过校验' : '尚未安装 CLI',
    },
    skill: {
      component: 'skill',
      state,
      path: '/tmp/home/.agents/skills/branchloom',
      installedVersion: installed ? '0.1.1' : undefined,
      bundledVersion: '0.1.1',
      contractVersion: installed ? 3 : undefined,
      managed: installed,
      message: installed ? 'Skill 已安装并通过校验' : '尚未安装 Branchloom Skill',
    },
  }
}

beforeEach(() => {
  mocks.available.mockReturnValue(true)
  mocks.status.mockResolvedValue(status())
  mocks.preview.mockResolvedValue({
    planId: 'plan-one',
    action: 'install',
    warnings: [],
    changes: [
      { component: 'cli', operation: '安装', path: '/tmp/home/.local/bin/branchloom' },
      { component: 'skill', operation: '安装', path: '/tmp/home/.agents/skills/branchloom' },
    ],
  })
  mocks.apply.mockResolvedValue({ status: status('installed'), changed: ['cli', 'skill'] })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('AI tools installer', () => {
  it('does not offer filesystem installation in browser development mode', async () => {
    mocks.available.mockReturnValue(false)
    const wrapper = mount(AiToolsView)
    await flushPromises()

    expect(wrapper.text()).toContain('仅桌面版支持安装')
    expect(mocks.status).not.toHaveBeenCalled()
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })

  it('previews exact CLI and Skill targets before applying the plan', async () => {
    const wrapper = mount(AiToolsView, { attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain('安装 CLI 和 Skill')
    expect(wrapper.text()).toContain('供 AI Agent 理解并安全调用 CLI')
    await wrapper.get('.ai-tools__primary button').trigger('click')
    await flushPromises()

    expect(mocks.preview).toHaveBeenCalledWith('install', ['cli', 'skill'])
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('/tmp/home/.local/bin/branchloom')
    expect(dialog?.textContent).toContain('/tmp/home/.agents/skills/branchloom')

    const confirm = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('确认并执行'))
    expect(confirm).toBeTruthy()
    confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mocks.apply).toHaveBeenCalledWith('plan-one')
    expect(wrapper.text()).toContain('AI 工具已经可以使用')
    expect(wrapper.text()).toContain('版本兼容')
    expect(wrapper.text()).toContain('重新打开终端和 Codex 后即可使用')
    wrapper.unmount()
  })
})
