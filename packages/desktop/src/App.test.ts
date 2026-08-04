import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import { createAppRouter } from './app/router'
import { BrowserPrototypeRepository } from './shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from './shared/repository/injection'
import type { PrototypeStorage } from './shared/repository/storage'

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

describe('App', () => {
  it('uses the latest project tree as the root experience', async () => {
    const router = createAppRouter('memory')
    await router.push('/')
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), router],
        provide: {
          [branchloomRepositoryKey as symbol]: new BrowserPrototypeRepository({
            storage: new MemoryStorage(),
          }),
        },
      },
    })
    await router.isReady()
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('project-tree'))
    expect(wrapper.find('.prototype-notice').exists()).toBe(false)
    expect(router.currentRoute.value).toMatchObject({
      name: 'project-tree',
      params: { projectId: 'project-demo-family' },
    })
    expect(wrapper.get('nav[aria-label="项目导航"]')).toBeTruthy()
    wrapper.unmount()
  })
})
