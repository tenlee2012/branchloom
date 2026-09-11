import { onScopeDispose, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { BranchloomRepository, Person, Relationship } from '../../../shared/domain/types'

/** Load the project independently of the bounded, visible tree. Publish only complete reads. */
export function useKinshipFamily(repository: BranchloomRepository, projectId: MaybeRefOrGetter<string>) {
  const people = shallowRef<Person[]>([])
  const relationships = shallowRef<Relationship[]>([])
  const state = ref<'loading' | 'ready' | 'error'>('loading')
  const error = ref('')
  const loadedCount = ref(0)
  const incomplete = ref(false)
  let latestRequest = 0

  async function reload() {
    const request = ++latestRequest
    const scope = toValue(projectId)
    const active = () => request === latestRequest && scope === toValue(projectId)
    state.value = 'loading'
    error.value = ''
    loadedCount.value = 0
    incomplete.value = false
    people.value = []
    relationships.value = []
    if (!scope) return
    try {
      const [first, relations] = await Promise.all([
        repository.listPeople(scope, { page: 1, pageSize: 250, sort: 'name' }),
        repository.listRelationships(scope),
      ])
      if (!active()) return
      const collected = [...first.items]
      loadedCount.value = collected.length
      let page = 1
      while (collected.length < first.total) {
        const next = await repository.listPeople(scope, { page: ++page, pageSize: first.pageSize, sort: 'name' })
        if (!active()) return
        if (!next.items.length || next.total !== first.total || next.pageSize !== first.pageSize) {
          throw new Error('人物资料在读取期间发生变化，请重新读取。')
        }
        collected.push(...next.items)
        loadedCount.value = collected.length
      }
      if (collected.length !== first.total || new Set(collected.map(({ id }) => id)).size !== first.total) {
        throw new Error('人物资料未能完整读取，请重试。')
      }
      const scopedPeople = collected.filter((person) => person.projectId === scope && !person.deletedAt)
      const scopedRelations = relations.filter((relation) => relation.projectId === scope)
      const ids = new Set(scopedPeople.map(({ id }) => id))
      incomplete.value = scopedRelations.some(({ fromPersonId, toPersonId }) => !ids.has(fromPersonId) || !ids.has(toPersonId))
      people.value = scopedPeople
      relationships.value = scopedRelations
      state.value = 'ready'
    } catch (cause) {
      if (!active()) return
      error.value = cause instanceof Error ? cause.message : '人物与关系资料暂时无法读取。'
      state.value = 'error'
    }
  }

  watch(() => toValue(projectId), reload, { immediate: true })
  onScopeDispose(() => { latestRequest += 1 })
  return { people, relationships, state, error, loadedCount, incomplete, reload }
}
