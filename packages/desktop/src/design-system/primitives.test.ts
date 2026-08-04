import { mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import BaseButton from './BaseButton.vue'
import BaseDialog from './BaseDialog.vue'
import BaseDrawer from './BaseDrawer.vue'
import BaseField from './BaseField.vue'
import EmptyState from './EmptyState.vue'
import StatusBadge from './StatusBadge.vue'

const tokensCss = readFileSync('src/app/styles/tokens.css', 'utf8')

const mountedWrappers: VueWrapper[] = []

function mountAttached(component: Parameters<typeof mount>[0], options?: Parameters<typeof mount>[1]) {
  const wrapper = mount(component, { ...options, attachTo: document.body })
  mountedWrappers.push(wrapper)
  return wrapper
}

function dispatchTab(shiftKey = false) {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
  )
}

function readHexToken(name: string) {
  const declaration = tokensCss
    .split(';')
    .find((candidate) => candidate.includes(`${name}:`))
  const match = declaration?.match(/#[0-9a-f]{6}/i)
  if (!match?.[0]) throw new Error(`Missing hex color token: ${name}`)
  return match[0]
}

function relativeLuminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )

  if (!channels || channels.length !== 3) throw new Error(`Invalid hex color: ${hex}`)
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

afterEach(() => {
  mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('BaseButton', () => {
  it('defaults to a safe button type and emits clicks', async () => {
    const wrapper = mount(BaseButton, { slots: { default: '保存' } })

    expect(wrapper.get('button').attributes('type')).toBe('button')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('does not emit while disabled', async () => {
    const wrapper = mount(BaseButton, {
      props: { disabled: true },
      slots: { default: '保存' },
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('does not emit while loading', async () => {
    const wrapper = mount(BaseButton, {
      props: { loading: true },
      slots: { default: '保存' },
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('exposes loading state without replacing its accessible text', () => {
    const wrapper = mount(BaseButton, {
      props: { loading: true },
      slots: { default: '保存人物' },
    })

    expect(wrapper.get('button').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('button').text()).toContain('保存人物')
  })
})

describe('BaseField', () => {
  it('connects its label, hint and error to a scoped input slot', () => {
    const wrapper = mount(BaseField, {
      props: {
        id: 'name',
        label: '姓名',
        hint: '填写谱系中的常用姓名',
        error: '姓名不能为空',
        required: true,
      },
      slots: {
        default: ({ describedBy, invalid, required }) =>
          h('input', {
            id: 'name',
            'aria-describedby': describedBy,
            'aria-invalid': invalid,
            required,
          }),
      },
    })

    expect(wrapper.get('label').attributes('for')).toBe('name')
    expect(wrapper.get('#name-hint').text()).toBe('填写谱系中的常用姓名')
    expect(wrapper.get('#name-error').attributes('role')).toBe('alert')
    expect(wrapper.get('#name-error').text()).toBe('姓名不能为空')
    expect(wrapper.get('input').attributes('aria-describedby')).toBe('name-hint name-error')
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('input').attributes()).toHaveProperty('required')
  })

  it('omits descriptions and invalid state when neither hint nor error exists', () => {
    const wrapper = mount(BaseField, {
      props: { id: 'place', label: '地点' },
      slots: {
        default: ({ describedBy, invalid }) =>
          h('input', {
            id: 'place',
            'aria-describedby': describedBy,
            'aria-invalid': invalid,
          }),
      },
    })

    expect(wrapper.get('input').attributes('aria-describedby')).toBeUndefined()
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('false')
  })

  it('renders a label action outside of the form label', () => {
    const wrapper = mount(BaseField, {
      props: { id: 'token', label: 'Token' },
      slots: {
        default: () => h('input', { id: 'token' }),
        'label-action': () => h('button', { type: 'button' }, '?'),
      },
    })

    expect(wrapper.get('.base-field__label-row > button').text()).toBe('?')
    expect(wrapper.get('label').find('button').exists()).toBe(false)
  })
})

describe('BaseDialog', () => {
  it('renders modal dialog semantics and focuses its close button when opened', async () => {
    mountAttached(BaseDialog, {
      props: { open: true, title: '删除人物', description: '此操作会影响已有关系。' },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    const titleId = dialog?.getAttribute('aria-labelledby')
    const descriptionId = dialog?.getAttribute('aria-describedby')
    expect(document.getElementById(titleId ?? '')?.textContent).toBe('删除人物')
    expect(document.getElementById(descriptionId ?? '')?.textContent).toBe('此操作会影响已有关系。')
    expect(document.activeElement).toBe(dialog?.querySelector('button[aria-label="关闭"]'))
  })

  it('can hide the header close button while keeping an explicit dialog action focusable', async () => {
    mountAttached(BaseDialog, {
      props: { open: true, title: '恢复历史版本', showClose: false },
      slots: { default: '<button name="cancel">取消恢复</button>' },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector('button[aria-label="关闭"]')).toBeNull()
    expect(document.activeElement).toBe(dialog.querySelector('button[name="cancel"]'))
  })

  it('emits close for Escape and backdrop clicks, but not content clicks', async () => {
    const wrapper = mount(BaseDialog, {
      props: { open: true, title: '确认操作' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)

    document.body.querySelector<HTMLElement>('.base-dialog__surface')?.click()
    expect(wrapper.emitted('close')).toHaveLength(1)

    document.body.querySelector<HTMLElement>('.base-dialog__backdrop')?.click()
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('restores focus after the open prop becomes false', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开确认框'
    document.body.append(trigger)
    trigger.focus()

    const wrapper = mount(BaseDialog, {
      props: { open: true, title: '确认操作' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await nextTick()
    await wrapper.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(trigger)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('contains forward, reverse and escaped focus within the top modal', async () => {
    const outsideButton = document.createElement('button')
    outsideButton.textContent = '背景操作'
    document.body.append(outsideButton)

    mountAttached(BaseDialog, {
      props: { open: true, title: '焦点测试' },
      slots: { default: '<button data-test="confirm">确认</button>' },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.base-dialog__surface')!
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button')
    expect(buttons).toHaveLength(2)

    buttons[1]!.focus()
    dispatchTab()
    expect(document.activeElement).toBe(buttons[0])

    buttons[0]!.focus()
    dispatchTab(true)
    expect(document.activeElement).toBe(buttons[1])

    outsideButton.focus()
    dispatchTab()
    expect(document.activeElement).toBe(buttons[0])
  })

  it('excludes negative-tabindex and hidden descendants from the focus boundary', async () => {
    const outsideButton = document.createElement('button')
    outsideButton.textContent = '背景操作'
    document.body.append(outsideButton)

    mountAttached(BaseDialog, {
      props: { open: true, title: '可见性测试' },
      slots: {
        default: `
          <button data-test="negative" tabindex="-1">跳出顺序</button>
          <button data-test="last">末尾操作</button>
          <button data-test="display-none" style="display: none">直接隐藏</button>
          <div hidden><button data-test="hidden-ancestor">hidden 祖先</button></div>
          <div inert><button data-test="inert-ancestor">inert 祖先</button></div>
          <div style="visibility: hidden">
            <button data-test="visibility-ancestor">visibility 祖先</button>
          </div>
        `,
      },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.base-dialog__surface')!
    const firstButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
    const lastButton = dialog.querySelector<HTMLButtonElement>('[data-test="last"]')!

    lastButton.focus()
    dispatchTab()
    expect(document.activeElement).toBe(firstButton)

    firstButton.focus()
    dispatchTab(true)
    expect(document.activeElement).toBe(lastButton)

    outsideButton.focus()
    dispatchTab()
    expect(document.activeElement).toBe(firstButton)

    for (const selector of [
      '[data-test="negative"]',
      '[data-test="display-none"]',
      '[data-test="hidden-ancestor"]',
      '[data-test="inert-ancestor"]',
      '[data-test="visibility-ancestor"]',
    ]) {
      const excludedButton = dialog.querySelector<HTMLButtonElement>(selector)!
      excludedButton.focus()
      dispatchTab()
      expect(document.activeElement, selector).toBe(firstButton)
    }
  })

  it('keeps opacity-zero controls in the intentional focus order', async () => {
    mountAttached(BaseDialog, {
      props: { open: true, title: '透明控件测试' },
      slots: {
        default: '<button data-test="transparent" style="opacity: 0">透明操作</button>',
      },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.base-dialog__surface')!
    const firstButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
    const transparentButton = dialog.querySelector<HTMLButtonElement>('[data-test="transparent"]')!

    firstButton.focus()
    dispatchTab(true)
    expect(document.activeElement).toBe(transparentButton)

    transparentButton.focus()
    dispatchTab()
    expect(document.activeElement).toBe(firstButton)
  })

  it('includes a top-level editable region in the focus boundary', async () => {
    mountAttached(BaseDialog, {
      props: { open: true, title: '可编辑区测试' },
      slots: {
        default: '<div contenteditable="true" data-test="editable">编辑区</div>',
      },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.base-dialog__surface')!
    const closeButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
    const editable = dialog.querySelector<HTMLElement>('[data-test="editable"]')!

    closeButton.focus()
    dispatchTab(true)
    expect(document.activeElement).toBe(editable)

    editable.focus()
    dispatchTab()
    expect(document.activeElement).toBe(closeButton)
  })

  it('includes a top-level plaintext-only editable region in the focus boundary', async () => {
    mountAttached(BaseDialog, {
      props: { open: true, title: '纯文本编辑区测试' },
      slots: {
        default:
          '<div contenteditable="plaintext-only" data-test="plaintext-editable">纯文本编辑区</div>',
      },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.base-dialog__surface')!
    const closeButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
    const editable = dialog.querySelector<HTMLElement>('[data-test="plaintext-editable"]')!

    closeButton.focus()
    dispatchTab(true)
    expect(document.activeElement).toBe(editable)

    editable.focus()
    dispatchTab()
    expect(document.activeElement).toBe(closeButton)
  })

  it('respects explicit and inherited contenteditable focus boundaries', async () => {
    mountAttached(BaseDialog, {
      props: { open: true, title: '可编辑区边界测试' },
      slots: {
        default: `
          <div contenteditable="plaintext-only" data-test="plaintext">纯文本编辑区</div>
          <div contenteditable="true" data-test="editable-parent">
            父编辑区
            <div contenteditable="true" data-test="nested-editable">嵌套隐式编辑区</div>
            <div contenteditable="true" tabindex="0" data-test="nested-tab-zero">
              嵌套显式编辑区
            </div>
          </div>
          <div contenteditable="false" data-test="not-editable">不可编辑区</div>
          <div contenteditable="true" tabindex="-1" data-test="negative-editable">
            跳出顺序的编辑区
          </div>
        `,
      },
    })
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.base-dialog__surface')!
    const closeButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!
    const nestedTabZero = dialog.querySelector<HTMLElement>('[data-test="nested-tab-zero"]')!

    closeButton.focus()
    dispatchTab(true)
    expect(document.activeElement).toBe(nestedTabZero)

    for (const selector of [
      '[data-test="nested-editable"]',
      '[data-test="not-editable"]',
      '[data-test="negative-editable"]',
    ]) {
      const excludedEditable = dialog.querySelector<HTMLElement>(selector)!
      excludedEditable.focus()
      expect(document.activeElement, `${selector} focus precondition`).toBe(excludedEditable)
      dispatchTab()
      expect(document.activeElement, selector).toBe(closeButton)
    }
  })

  it('isolates the application root and restores its original state after closing', async () => {
    const appRoot = document.createElement('main')
    appRoot.id = 'app'
    appRoot.setAttribute('aria-hidden', 'false')
    document.body.append(appRoot)

    const wrapper = mount(BaseDialog, {
      props: { open: true, title: '隔离测试' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await nextTick()

    expect(appRoot.hasAttribute('inert')).toBe(true)
    expect(appRoot.getAttribute('aria-hidden')).toBe('true')

    await wrapper.setProps({ open: false })
    await nextTick()

    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(appRoot.getAttribute('aria-hidden')).toBe('false')
  })

  it('cleans global isolation and keyboard handling when unmounted while open', async () => {
    const appRoot = document.createElement('main')
    appRoot.id = 'app'
    document.body.append(appRoot)

    const wrapper = mount(BaseDialog, {
      props: { open: true, title: '卸载测试' },
      attachTo: document.body,
    })
    await nextTick()
    expect(appRoot.hasAttribute('inert')).toBe(true)

    wrapper.unmount()
    await nextTick()
    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(appRoot.hasAttribute('aria-hidden')).toBe(false)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('does not register a stale overlay during a rapid open and close', async () => {
    const appRoot = document.createElement('main')
    appRoot.id = 'app'
    document.body.append(appRoot)

    const wrapper = mount(BaseDialog, {
      props: { open: false, title: '快速开关测试' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)

    const opening = wrapper.setProps({ open: true })
    const closing = wrapper.setProps({ open: false })
    await Promise.all([opening, closing])
    await nextTick()

    expect(appRoot.hasAttribute('inert')).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})

describe('BaseDrawer', () => {
  it('keeps an inline drawer in the page flow without isolating the app', async () => {
    const appRoot = document.createElement('main')
    appRoot.id = 'inline-drawer-app'
    document.body.append(appRoot)
    const wrapper = mount(BaseDrawer, {
      props: { open: true, inline: true, title: '研究视图' },
      attachTo: appRoot,
    })
    mountedWrappers.push(wrapper)
    await nextTick()

    const drawer = wrapper.get('.base-drawer__surface')
    expect(drawer.attributes('role')).toBe('region')
    expect(drawer.attributes('aria-modal')).toBeUndefined()
    expect(appRoot.hasAttribute('inert')).toBe(false)
    expect(appRoot.getAttribute('aria-hidden')).toBeNull()
  })

  it('uses modal dialog semantics with an accessible close button', async () => {
    mountAttached(BaseDrawer, {
      props: { open: true, title: '编辑人物', closeLabel: '关闭人物编辑' },
    })
    await nextTick()

    const drawer = document.body.querySelector<HTMLElement>('.base-drawer__surface')
    expect(drawer?.getAttribute('role')).toBe('dialog')
    expect(drawer?.getAttribute('aria-modal')).toBe('true')
    expect(drawer?.querySelector('button')?.getAttribute('aria-label')).toBe('关闭人物编辑')
  })

  it('emits close when Escape is pressed', async () => {
    const wrapper = mountAttached(BaseDrawer, {
      props: { open: true, title: '编辑人物' },
    })
    await nextTick()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('restores focus and stops listening after it closes', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开编辑抽屉'
    document.body.append(trigger)
    trigger.focus()

    const wrapper = mount(BaseDrawer, {
      props: { open: true, title: '编辑人物' },
      attachTo: document.body,
    })
    mountedWrappers.push(wrapper)
    await nextTick()
    await wrapper.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(trigger)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('defers Escape handling to a dialog stacked above it', async () => {
    const drawer = mount(BaseDrawer, {
      props: { open: true, title: '人物编辑' },
      attachTo: document.body,
    })
    mountedWrappers.push(drawer)
    await nextTick()

    const dialog = mount(BaseDialog, {
      props: { open: true, title: '确认保存' },
      attachTo: document.body,
    })
    mountedWrappers.push(dialog)
    await nextTick()

    const drawerBackdrop = document.body.querySelector<HTMLElement>('.base-drawer__backdrop')!
    expect(drawerBackdrop.hasAttribute('inert')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(dialog.emitted('close')).toHaveLength(1)
    expect(drawer.emitted('close')).toBeUndefined()

    await dialog.setProps({ open: false })
    await nextTick()
    expect(drawerBackdrop.hasAttribute('inert')).toBe(false)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drawer.emitted('close')).toHaveLength(1)
  })

  it('preserves the page focus return chain when a lower overlay unmounts first', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开人物编辑'
    document.body.append(trigger)
    trigger.focus()

    const drawer = mount(BaseDrawer, {
      props: { open: true, title: '人物编辑' },
      slots: { default: '<button data-test="drawer-action">抽屉操作</button>' },
      attachTo: document.body,
    })
    await nextTick()
    const drawerAction = document.body.querySelector<HTMLButtonElement>('[data-test="drawer-action"]')!
    drawerAction.focus()

    const dialog = mount(BaseDialog, {
      props: { open: true, title: '确认保存' },
      attachTo: document.body,
    })
    mountedWrappers.push(dialog)
    await nextTick()

    drawer.unmount()
    await nextTick()
    expect(drawerAction.isConnected).toBe(false)

    await dialog.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(trigger)
  })
})

describe('StatusBadge', () => {
  it('renders its tone and slot content', () => {
    const wrapper = mount(StatusBadge, {
      props: { tone: 'success' },
      slots: { default: '已保存' },
    })

    expect(wrapper.classes()).toContain('status-badge--success')
    expect(wrapper.text()).toBe('已保存')
  })

  it('keeps neutral text contrast at or above 4.5 to 1', () => {
    const foreground = readHexToken('--color-muted')
    const background = readHexToken('--color-muted-surface')

    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('EmptyState', () => {
  it('renders title, description, illustration and actions', () => {
    const wrapper = mount(EmptyState, {
      props: { title: '还没有人物', description: '从添加第一位家庭成员开始。' },
      slots: {
        default: '<span data-test="illustration">家谱插图</span>',
        actions: '<button>添加人物</button>',
      },
    })

    expect(wrapper.get('h2').text()).toBe('还没有人物')
    expect(wrapper.text()).toContain('从添加第一位家庭成员开始。')
    expect(wrapper.get('[data-test="illustration"]').text()).toBe('家谱插图')
    expect(wrapper.get('button').text()).toBe('添加人物')
  })
})
