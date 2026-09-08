import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../../app/router'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import QuickAddRelativeDialog from '../relationships/components/QuickAddRelativeDialog.vue'
import MobileFamilyExplorer from './views/MobileFamilyExplorer.vue'

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const wrappers: Array<{ unmount(): void }> = []

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

async function mountExplorer(query = '') {
  const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
  const router = createAppRouter('memory')
  await router.push(`/project/project-demo-family/tree${query}`)
  await router.isReady()
  const wrapper = mount(MobileFamilyExplorer, {
    attachTo: document.body,
    global: {
      plugins: [createPinia(), router],
      provide: { [branchloomRepositoryKey as symbol]: repository },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, repository }
}

describe('MobileFamilyExplorer', () => {
  it('loads only one generation around the default center', async () => {
    const repository = new BrowserPrototypeRepository({ storage: new MemoryStorage() })
    const getTreeFamilySlice = vi.spyOn(repository, 'getTreeFamilySlice')
    const router = createAppRouter('memory')
    await router.push('/project/project-demo-family/tree?personId=person-lin-hai')
    await router.isReady()
    const wrapper = mount(MobileFamilyExplorer, {
      global: {
        plugins: [createPinia(), router],
        provide: { [branchloomRepositoryKey as symbol]: repository },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(getTreeFamilySlice).toHaveBeenCalledWith('project-demo-family', 'person-lin-hai', {
      generationsUp: 1,
      generationsDown: 1,
    })
    expect(wrapper.get('.mobile-family-explorer__center').text()).toContain('林海')
    expect(wrapper.text()).toContain('父母与监护')
    expect(wrapper.text()).toContain('子女与被监护人')
  })

  it('changes center on one tap and keeps a reversible exploration trail', async () => {
    const { wrapper, router, repository } = await mountExplorer('?personId=person-lin-hai')
    const getTreeFamilySlice = vi.spyOn(repository, 'getTreeFamilySlice')

    await wrapper.get('button[aria-label="以林晨为中心继续探索"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.personId).toBe('person-lin-chen')
    expect(wrapper.get('.mobile-family-explorer__center').text()).toContain('林晨')
    expect(wrapper.get('.mobile-family-explorer__trail button').text()).toContain('返回 林海')
    expect(getTreeFamilySlice).toHaveBeenLastCalledWith('project-demo-family', 'person-lin-chen', {
      generationsUp: 1,
      generationsDown: 1,
    })

    await wrapper.get('.mobile-family-explorer__trail button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.personId).toBe('person-lin-hai')
    expect(wrapper.get('.mobile-family-explorer__center').text()).toContain('林海')
  })

  it('opens role-aware relative creation from each family branch', async () => {
    const { wrapper } = await mountExplorer('?personId=person-lin-hai')

    await wrapper.get('button[aria-label="为林海添加父母与监护"]').trigger('click')

    expect(wrapper.getComponent(QuickAddRelativeDialog).props()).toMatchObject({
      open: true,
      preset: 'parent',
      person: expect.objectContaining({ id: 'person-lin-hai' }),
    })
  })
})
