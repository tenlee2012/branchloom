import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import AppNotificationCenter from './components/AppNotificationCenter.vue'
import { useNotificationsStore } from './stores/notifications'

describe('AppNotificationCenter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a success notification and dismisses it automatically', async () => {
    const wrapper = mount(AppNotificationCenter)
    const store = useNotificationsStore()

    store.push('GEDCOM 导入成功：共 3 位人物', 'success')
    await nextTick()

    const notification = wrapper.get('.notification[role="status"]')
    expect(notification.text()).toContain('成功')
    expect(notification.text()).toContain('GEDCOM 导入成功')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.notifications).toHaveLength(0)
    wrapper.unmount()
  })

  it('pauses dismissal while focused and supports manual close', async () => {
    const wrapper = mount(AppNotificationCenter)
    const store = useNotificationsStore()

    store.push('项目包导出成功：family.blp', 'success')
    await nextTick()
    const notification = wrapper.get('.notification')
    await notification.trigger('focusin')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(store.notifications).toHaveLength(1)

    await wrapper.get('.notification__dismiss').trigger('click')
    expect(store.notifications).toHaveLength(0)
    wrapper.unmount()
  })

  it('keeps only the three newest notifications', async () => {
    const wrapper = mount(AppNotificationCenter)
    const store = useNotificationsStore()

    for (const message of ['第一条', '第二条', '第三条', '第四条']) {
      store.push(message, 'info')
    }
    await nextTick()

    expect(store.notifications.map(({ message }) => message)).toEqual(['第二条', '第三条', '第四条'])
    expect(wrapper.findAll('.notification')).toHaveLength(3)
    wrapper.unmount()
  })

})
