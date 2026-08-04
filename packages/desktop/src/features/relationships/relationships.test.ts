import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createAppRouter } from '../../app/router'
import { useSessionStore } from '../../app/stores/session'
import type {
  BranchloomRepository,
  ParentRelation,
  ParentRelationship,
  PartnerRelation,
  PartnerRelationship,
  Person,
  Relationship,
} from '../../shared/domain/types'
import { BrowserPrototypeRepository } from '../../shared/repository/BrowserPrototypeRepository'
import { branchloomRepositoryKey } from '../../shared/repository/injection'
import type { PrototypeStorage } from '../../shared/repository/storage'
import PersonDetailView from '../people/views/PersonDetailView.vue'
import QuickAddRelativeDialog from './components/QuickAddRelativeDialog.vue'
import RelationshipEditor from './components/RelationshipEditor.vue'
import RelationshipLegend from './components/RelationshipLegend.vue'
import {
  parentRelationshipOptions,
  partnerRelationshipOptions,
  relationshipDisplayLabel,
} from './composables/useRelationshipEditor'

const PROJECT_ID = 'project-demo-family'
const mountedWrappers: Array<{ unmount(): void }> = []

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
    clock: () => new Date('2032-03-04T05:06:07.000Z'),
    idFactory: () => `relationship-id-${++id}`,
  })
}

function proxyRepository(
  repository: BranchloomRepository,
  overrides: Partial<BranchloomRepository>,
): BranchloomRepository {
  return new Proxy(repository, {
    get(target, property) {
      const override = overrides[property as keyof BranchloomRepository]
      if (override) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function minimalPerson(id: string, name: string): Person {
  return {
    id,
    projectId: PROJECT_ID,
    names: [{ value: name, type: 'personal', primary: true }],
    sex: 'unknown',
    status: 'unknown',
    biography: '',
    notes: '',
    sourceIds: [],
    updatedAt: '2032-03-04T05:06:07.000Z',
  }
}

function parentRelationship(
  id: string,
  fromPersonId: string,
  toPersonId: string,
  type: ParentRelation = 'biological',
): ParentRelationship {
  return {
    id,
    projectId: PROJECT_ID,
    category: 'parent',
    type,
    fromPersonId,
    toPersonId,
    notes: '',
    sourceIds: [],
  }
}

function partnerRelationship(type: PartnerRelation): PartnerRelationship {
  return {
    id: `partner-${type}`,
    projectId: PROJECT_ID,
    category: 'partner',
    type,
    fromPersonId: 'person-lin-hai',
    toPersonId: 'person-chen-fang',
    notes: '',
    sourceIds: [],
  }
}

async function mountRelationshipEditor(
  repository: BranchloomRepository = makeRepository(),
  relationship?: Relationship,
  personId = 'person-lin-hai',
) {
  const person = await repository.getPerson(personId)
  const pinia = createPinia()
  setActivePinia(pinia)
  useSessionStore(pinia).openProject(await repository.getProject(PROJECT_ID))
  const wrapper = mount(RelationshipEditor, {
    attachTo: document.body,
    props: {
      open: true,
      projectId: PROJECT_ID,
      person,
      ...(relationship ? { relationship } : {}),
    },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await flushPromises()
  return { wrapper, repository, session: useSessionStore(pinia) }
}

async function mountQuickAdd(repository: BranchloomRepository = makeRepository()) {
  const person = await repository.getPerson('person-lin-hai')
  const pinia = createPinia()
  setActivePinia(pinia)
  useSessionStore(pinia).openProject(await repository.getProject(PROJECT_ID))
  const wrapper = mount(QuickAddRelativeDialog, {
    attachTo: document.body,
    props: { open: true, projectId: PROJECT_ID, person },
    global: {
      plugins: [pinia],
      provide: { [branchloomRepositoryKey as symbol]: repository },
      stubs: { Teleport: true },
    },
  })
  mountedWrappers.push(wrapper)
  await nextTick()
  return { wrapper, repository, session: useSessionStore(pinia) }
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('relationship vocabulary and inverse labels', () => {
  it('exposes every approved parent and partner relationship type', () => {
    expect(parentRelationshipOptions.map(({ value }) => value)).toEqual([
      'biological', 'adoptive', 'step', 'guardian',
    ])
    expect(partnerRelationshipOptions.map(({ value }) => value)).toEqual([
      'engaged', 'married', 'partner', 'separated', 'divorced',
    ])

    const legend = mount(RelationshipLegend)
    mountedWrappers.push(legend)
    for (const option of [...parentRelationshipOptions, ...partnerRelationshipOptions]) {
      expect(legend.text()).toContain(option.label)
    }
  })

  it('describes parent relationships from each endpoint and partner types symmetrically', () => {
    const labels: Record<ParentRelation, [string, string]> = {
      biological: ['亲生子女', '亲生父母'],
      adoptive: ['养子女', '养父母'],
      step: ['继子女', '继父母'],
      guardian: ['被监护人', '监护人'],
    }
    for (const [type, expected] of Object.entries(labels) as Array<[ParentRelation, [string, string]]>) {
      const relationship = parentRelationship(`parent-${type}`, 'parent', 'child', type)
      expect(relationshipDisplayLabel(relationship, 'parent')).toBe(expected[0])
      expect(relationshipDisplayLabel(relationship, 'child')).toBe(expected[1])
    }

    const partnerLabels: Record<PartnerRelation, string> = {
      engaged: '订婚伴侣',
      married: '配偶',
      partner: '事实伴侣',
      separated: '分居伴侣',
      divorced: '前配偶',
    }
    for (const [type, expected] of Object.entries(partnerLabels) as Array<[PartnerRelation, string]>) {
      expect(relationshipDisplayLabel(partnerRelationship(type), 'person-lin-hai')).toBe(expected)
      expect(relationshipDisplayLabel(partnerRelationship(type), 'person-chen-fang')).toBe(expected)
    }
  })

  it('distinguishes explicitly recorded fathers and mothers by sex', () => {
    const father = { ...minimalPerson('father', '父亲'), sex: 'male' as const }
    const mother = { ...minimalPerson('mother', '母亲'), sex: 'female' as const }

    expect(relationshipDisplayLabel(
      parentRelationship('biological-father', father.id, 'child'),
      'child',
      father,
    )).toBe('亲生父亲')
    expect(relationshipDisplayLabel(
      parentRelationship('biological-mother', mother.id, 'child'),
      'child',
      mother,
    )).toBe('亲生母亲')
    expect(relationshipDisplayLabel(
      parentRelationship('adoptive-father', father.id, 'child', 'adoptive'),
      'child',
      father,
    )).toBe('养父')
    expect(relationshipDisplayLabel(
      parentRelationship('adoptive-mother', mother.id, 'child', 'adoptive'),
      'child',
      mother,
    )).toBe('养母')
  })
})

describe('relationship editor validation', () => {
  it('blocks a self relationship with an explained accessible error', async () => {
    const { wrapper } = await mountRelationshipEditor()
    await wrapper.get('select[name="relativePersonId"]').setValue('person-lin-hai')

    const feedback = wrapper.get('[data-relationship-feedback][role="alert"]')
    expect(feedback.text()).toContain('不能成为自己的父母或监护人')
    expect(wrapper.get('button[name="保存关系"]').attributes('disabled')).toBeDefined()
  })

  it('blocks biological and adoptive ancestor cycles but permits non-lineage parent types', async () => {
    const { wrapper } = await mountRelationshipEditor()
    await wrapper.get('select[name="relativePersonId"]').setValue('person-lin-chen')
    await wrapper.get('select[name="direction"]').setValue('relative-is-parent')

    expect(wrapper.get('[data-relationship-feedback][role="alert"]').text()).toContain('祖先循环')
    expect(wrapper.get('button[name="保存关系"]').attributes('disabled')).toBeDefined()

    await wrapper.get('select[name="relationshipType"]').setValue('adoptive')
    expect(wrapper.get('[data-relationship-feedback][role="alert"]').text()).toContain('祖先循环')

    await wrapper.get('select[name="relationshipType"]').setValue('step')
    expect(wrapper.find('[data-relationship-feedback][role="alert"]').exists()).toBe(false)
    expect(wrapper.get('button[name="保存关系"]').attributes('disabled')).toBeUndefined()
  })

  it('shows duplicate edges as a non-blocking warning and saves only once on double submit', async () => {
    const base = makeRepository()
    let resolveSave!: (relationship: Relationship) => void
    const pending = new Promise<Relationship>((resolve) => { resolveSave = resolve })
    const saveRelationship = vi.fn((relationship: Relationship) => pending.then(() => base.saveRelationship(relationship)))
    const repository = proxyRepository(base, { saveRelationship })
    const { wrapper } = await mountRelationshipEditor(repository)
    await wrapper.get('select[name="relativePersonId"]').setValue('person-lin-chen')
    await wrapper.get('select[name="direction"]').setValue('current-is-parent')

    const feedback = wrapper.get('[data-relationship-feedback][role="status"]')
    expect(feedback.text()).toContain('已存在相同类型')
    const submit = wrapper.get('button[name="保存关系"]')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')
    await submit.trigger('click')
    expect(saveRelationship).toHaveBeenCalledTimes(1)

    resolveSave(saveRelationship.mock.calls[0]![0])
    await flushPromises()
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('prefills and updates an existing relationship without losing identity, sources, or history', async () => {
    const repository = makeRepository()
    const before = await repository.listRelationships(PROJECT_ID)
    const existing = before.find(({ id }) => id === 'relationship-hai-fang')!
    const { wrapper } = await mountRelationshipEditor(repository, existing)

    expect(wrapper.get('select[name="category"]').element).toHaveProperty('value', 'partner')
    expect(wrapper.get('select[name="relativePersonId"]').element).toHaveProperty('value', 'person-chen-fang')
    expect(wrapper.get('select[name="relationshipType"]').element).toHaveProperty('value', 'divorced')
    expect(wrapper.get('input[name="startDate"]').element).toHaveProperty('value', '1986')
    expect(wrapper.get('input[name="endDate"]').element).toHaveProperty('value', '约 1992')
    expect(wrapper.find('[data-relationship-feedback]').exists()).toBe(false)

    await wrapper.get('select[name="relationshipType"]').setValue('separated')
    await wrapper.get('input[name="startDate"]').setValue('1990-01-02')
    await wrapper.get('input[name="endDate"]').setValue('1993')
    await wrapper.get('select[name="placeId"]').setValue('place-quanzhou')
    await wrapper.get('textarea[name="notes"]').setValue('双方确认的分居记录')
    await wrapper.get('button[name="保存关系"]').trigger('click')
    await flushPromises()

    const after = await repository.listRelationships(PROJECT_ID)
    expect(after).toHaveLength(before.length)
    const saved = after.find(({ id }) => id === existing.id)!
    expect(saved).toMatchObject({
      id: existing.id,
      projectId: existing.projectId,
      category: 'partner',
      type: 'separated',
      start: { display: '1990-01-02' },
      end: { display: '1993' },
      placeId: 'place-quanzhou',
      notes: '双方确认的分居记录',
      sourceIds: existing.sourceIds,
    })

    await repository.undo()
    expect((await repository.listRelationships(PROJECT_ID)).find(({ id }) => id === existing.id))
      .toEqual(existing)
    await repository.redo()
    expect((await repository.listRelationships(PROJECT_ID)).find(({ id }) => id === existing.id))
      .toEqual(saved)
  })

  it('closes an unchanged existing relationship directly but confirms after a real edit', async () => {
    const repository = makeRepository()
    const existing = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === 'relationship-hai-fang')!
    const unchanged = await mountRelationshipEditor(repository, existing)
    await unchanged.wrapper.get('button[aria-label="关闭关系编辑器"]').trigger('click')
    expect(unchanged.wrapper.emitted('close')).toHaveLength(1)
    expect(unchanged.wrapper.text()).not.toContain('放弃未保存的关系？')

    const changed = await mountRelationshipEditor(repository, existing)
    await changed.wrapper.get('textarea[name="notes"]').setValue('尚未保存')
    await changed.wrapper.get('button[aria-label="关闭关系编辑器"]').trigger('click')
    expect(changed.wrapper.emitted('close')).toBeUndefined()
    expect(changed.wrapper.text()).toContain('放弃未保存的关系？')
  })

  it('preserves untouched structured date precision when editing another field', async () => {
    const repository = makeRepository()
    const existing = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === 'relationship-hai-fang')!
    const { wrapper } = await mountRelationshipEditor(repository, existing)
    await wrapper.get('textarea[name="notes"]').setValue('只修改备注')
    await wrapper.get('button[name="保存关系"]').trigger('click')
    await flushPromises()

    const saved = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === existing.id)!
    expect(saved.start).toEqual(existing.start)
    expect(saved.end).toEqual(existing.end)
    expect(saved.sourceIds).toEqual(existing.sourceIds)
  })

  it('preserves stored partner endpoints when editing from the to-person detail', async () => {
    const repository = makeRepository()
    const existing = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === 'relationship-hai-fang')!
    expect(existing.toPersonId).toBe('person-chen-fang')
    const { wrapper } = await mountRelationshipEditor(repository, existing, existing.toPersonId)

    await wrapper.get('input[name="startDate"]').setValue('1987')
    await wrapper.get('textarea[name="notes"]').setValue('从关系另一端补充的记录')
    await wrapper.get('button[name="保存关系"]').trigger('click')
    await flushPromises()

    const saved = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === existing.id)!
    expect([saved.fromPersonId, saved.toPersonId]).toEqual([
      existing.fromPersonId,
      existing.toPersonId,
    ])
    expect(saved).toMatchObject({
      start: { display: '1987' },
      notes: '从关系另一端补充的记录',
    })

    await repository.undo()
    expect((await repository.listRelationships(PROJECT_ID)).find(({ id }) => id === existing.id))
      .toEqual(existing)
    await repository.redo()
    expect((await repository.listRelationships(PROJECT_ID)).find(({ id }) => id === existing.id))
      .toEqual(saved)
  })

  it('uses the explicit direction when changing an existing partner to a parent relationship', async () => {
    const repository = makeRepository()
    const existing = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === 'relationship-hai-fang')!
    const { wrapper } = await mountRelationshipEditor(repository, existing, existing.toPersonId)

    await wrapper.get('select[name="category"]').setValue('parent')
    await wrapper.get('select[name="relationshipType"]').setValue('step')
    await wrapper.get('select[name="direction"]').setValue('current-is-parent')
    await wrapper.get('button[name="保存关系"]').trigger('click')
    await flushPromises()

    const saved = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === existing.id)!
    expect(saved).toMatchObject({
      category: 'parent',
      type: 'step',
      fromPersonId: existing.toPersonId,
      toPersonId: existing.fromPersonId,
      sourceIds: existing.sourceIds,
    })
  })

  it('keeps a to-side current person in place while replacing the other partner', async () => {
    const repository = makeRepository()
    const existing = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === 'relationship-hai-fang')!
    const { wrapper } = await mountRelationshipEditor(repository, existing, existing.toPersonId)
    await wrapper.get('select[name="relativePersonId"]').setValue('person-liu-ming')
    await wrapper.get('textarea[name="notes"]').setValue('陈芳确认的新关系对象')
    await wrapper.get('button[name="保存关系"]').trigger('click')
    await flushPromises()

    const saved = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === existing.id)!
    expect([saved.fromPersonId, saved.toPersonId]).toEqual([
      'person-liu-ming',
      existing.toPersonId,
    ])

    await repository.undo()
    expect((await repository.listRelationships(PROJECT_ID)).find(({ id }) => id === existing.id))
      .toEqual(existing)
    await repository.redo()
    expect((await repository.listRelationships(PROJECT_ID)).find(({ id }) => id === existing.id))
      .toEqual(saved)
  })

  it('keeps a from-side current person in place while replacing the other partner', async () => {
    const repository = makeRepository()
    const existing = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === 'relationship-hai-fang')!
    const { wrapper } = await mountRelationshipEditor(repository, existing, existing.fromPersonId)
    await wrapper.get('select[name="relativePersonId"]').setValue('person-liu-ming')
    await wrapper.get('button[name="保存关系"]').trigger('click')
    await flushPromises()

    const saved = (await repository.listRelationships(PROJECT_ID))
      .find(({ id }) => id === existing.id)!
    expect([saved.fromPersonId, saved.toPersonId]).toEqual([
      existing.fromPersonId,
      'person-liu-ming',
    ])
  })
})

describe('atomic quick-add relative workflow', () => {
  it('persists one valid minimal person and its relationship as one history entry', async () => {
    const repository = makeRepository()
    const beforePeople = await repository.listPeople(PROJECT_ID, {
      page: 1, pageSize: 100, sort: 'name',
    })
    const beforeRelationships = await repository.listRelationships(PROJECT_ID)
    const person = minimalPerson('person-new-relative', '林岚')
    const relationship = parentRelationship(
      'relationship-new-relative',
      'person-lin-hai',
      person.id,
      'adoptive',
    )

    await repository.savePersonWithRelationship(person, relationship)
    expect(await repository.getPerson(person.id)).toEqual(person)
    expect(await repository.listRelationships(PROJECT_ID)).toContainEqual(relationship)
    expect(repository.getHistoryState()).toEqual({ canUndo: true, canRedo: false })

    await repository.undo()
    await expect(repository.getPerson(person.id)).rejects.toMatchObject({ code: 'not-found' })
    expect(await repository.listRelationships(PROJECT_ID)).toHaveLength(beforeRelationships.length)
    expect((await repository.listPeople(PROJECT_ID, { page: 1, pageSize: 100, sort: 'name' })).total)
      .toBe(beforePeople.total)

    await repository.redo()
    expect(await repository.getPerson(person.id)).toEqual(person)
    expect(await repository.listRelationships(PROJECT_ID)).toContainEqual(relationship)
  })

  it('leaves no orphan or history entry when atomic persistence fails', async () => {
    const repository = makeRepository()
    await repository.updateProject(PROJECT_ID, { name: 'redo target' })
    await repository.undo()
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: true })
    const beforeRelationships = await repository.listRelationships(PROJECT_ID)
    const beforePeople = await repository.listPeople(PROJECT_ID, {
      page: 1, pageSize: 100, sort: 'name',
    })
    const person = minimalPerson('person-failed-relative', '失败人物')
    const relationship = parentRelationship(
      'relationship-failed-relative',
      person.id,
      'person-lin-hai',
      'guardian',
    )
    repository.failNextWrite(new Error('quota exceeded'))

    await expect(repository.savePersonWithRelationship(person, relationship))
      .rejects.toMatchObject({ code: 'storage' })
    await expect(repository.getPerson(person.id)).rejects.toMatchObject({ code: 'not-found' })
    expect(await repository.listRelationships(PROJECT_ID)).toEqual(beforeRelationships)
    expect((await repository.listPeople(PROJECT_ID, { page: 1, pageSize: 100, sort: 'name' })).total)
      .toBe(beforePeople.total)
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: true })

    await repository.redo()
    expect((await repository.getProject(PROJECT_ID)).name).toBe('redo target')
    await expect(repository.getPerson(person.id)).rejects.toMatchObject({ code: 'not-found' })
    expect(await repository.listRelationships(PROJECT_ID)).toEqual(beforeRelationships)
  })

  it('creates a relative through the dialog and keeps an accessible failure open', async () => {
    const base = makeRepository()
    const savePersonWithRelationship = vi.fn().mockRejectedValue(new Error('quota exceeded'))
    const repository = proxyRepository(base, { savePersonWithRelationship })
    const { wrapper, session } = await mountQuickAdd(repository)
    await wrapper.get('input[name="relativeName"]').setValue('  林岚  ')
    await wrapper.get('select[name="relationshipType"]').setValue('guardian')
    await wrapper.get('button[name="添加并关联"]').trigger('click')
    await flushPromises()

    expect(savePersonWithRelationship).toHaveBeenCalledTimes(1)
    const [person, relationship] = savePersonWithRelationship.mock.calls[0]!
    expect(person).toMatchObject({
      projectId: PROJECT_ID,
      names: [{ value: '林岚', type: 'personal' }],
      sex: 'unknown',
      status: 'unknown',
      biography: '',
      notes: '',
      sourceIds: [],
    })
    expect(relationship).toMatchObject({
      projectId: PROJECT_ID,
      category: 'parent',
      type: 'guardian',
      fromPersonId: person.id,
      toPersonId: 'person-lin-hai',
    })
    expect(wrapper.get('[role="alert"]').text()).toContain('添加失败')
    expect(wrapper.get('[role="alert"]').text()).toContain('quota exceeded')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(session.saveStatus).toBe('failed')
  })

  it('guards against double submit and confirms closing a dirty draft', async () => {
    const base = makeRepository()
    let resolveSave!: (value: { person: Person; relationship: Relationship }) => void
    const pending = new Promise<{ person: Person; relationship: Relationship }>((resolve) => {
      resolveSave = resolve
    })
    const savePersonWithRelationship = vi.fn((_person: Person, _relationship: Relationship) => pending)
    const repository = proxyRepository(base, { savePersonWithRelationship })
    const { wrapper } = await mountQuickAdd(repository)
    await wrapper.get('input[name="relativeName"]').setValue('林岚')
    const submit = wrapper.get('button[name="添加并关联"]')
    await submit.trigger('click')
    await submit.trigger('click')
    expect(savePersonWithRelationship).toHaveBeenCalledTimes(1)

    const [person, relationship] = savePersonWithRelationship.mock.calls[0]!
    resolveSave({ person, relationship })
    await flushPromises()
    expect(wrapper.emitted('saved')).toHaveLength(1)

    const second = await mountQuickAdd()
    await second.wrapper.get('input[name="relativeName"]').setValue('未保存')
    await second.wrapper.get('button[aria-label="关闭添加人物与关系"]').trigger('click')
    expect(second.wrapper.text()).toContain('放弃未保存的人物与关系？')
    expect(second.wrapper.emitted('close')).toBeUndefined()
  })

  it('closes an untouched quick-add directly', async () => {
    const { wrapper } = await mountQuickAdd()
    await wrapper.get('button[aria-label="关闭添加人物与关系"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('放弃未保存的人物与关系？')
  })

  it('confirms category-only changes through the dialog close button', async () => {
    const { wrapper } = await mountQuickAdd()
    await wrapper.get('select[name="category"]').setValue('partner')
    await wrapper.get('button[aria-label="关闭添加人物与关系"]').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.text()).toContain('放弃未保存的人物与关系？')
  })

  it('confirms type-only changes through the cancel button', async () => {
    const { wrapper } = await mountQuickAdd()
    await wrapper.get('select[name="relationshipType"]').setValue('adoptive')
    await wrapper.get('button[name="取消"]').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.text()).toContain('放弃未保存的人物与关系？')
  })

  it('confirms direction-only changes through Escape', async () => {
    const { wrapper } = await mountQuickAdd()
    await wrapper.get('select[name="direction"]').setValue('current-is-parent')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.text()).toContain('放弃未保存的人物与关系？')
  })
})

describe('person detail relationship entry points', () => {
  it('shows current relationships and opens both relationship workflows in project scope', async () => {
    const repository = makeRepository()
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/people/person-lin-hai`)
    const wrapper = mount(PersonDetailView, {
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

    expect(wrapper.get('[data-person-relationships]').text()).toContain('亲生父亲')
    expect(wrapper.get('[data-person-relationships]').text()).toContain('亲生母亲')
    expect(wrapper.get('[data-person-relationships]').text()).toContain('亲生子女')
    await wrapper.get('button[name="添加已有关系"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('添加人物关系')
    await wrapper.get('button[aria-label="关闭关系编辑器"]').trigger('click')
    await wrapper.get('button[name="添加人物"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('添加人物与关系')
  })

  it('opens an existing relationship from its accessible detail action with prefilled values', async () => {
    const repository = makeRepository()
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter('memory')
    await router.push(`/project/${PROJECT_ID}/people/person-lin-hai`)
    const wrapper = mount(PersonDetailView, {
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

    await wrapper.get('button[aria-label="编辑关系：前配偶 陈芳"]').trigger('click')
    const editor = wrapper.getComponent(RelationshipEditor)
    expect(editor.props('relationship')).toMatchObject({ id: 'relationship-hai-fang' })
    expect(editor.get('select[name="relativePersonId"]').element).toHaveProperty('value', 'person-chen-fang')
    expect(editor.get('select[name="relationshipType"]').element).toHaveProperty('value', 'divorced')
  })
})
