<script setup lang="ts">
import { t } from '../../../shared/i18n'
import { computed, ref, watch } from 'vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { DuplicateCandidate, Person, UUID } from '../../../shared/domain/types'

const props = defineProps<{
  people: Person[]
  candidates: DuplicateCandidate[]
}>()
const emit = defineEmits<{
  merge: [keepPersonId: UUID, removePersonId: UUID]
  'not-duplicate': [leftPersonId: UUID, rightPersonId: UUID]
  defer: [leftPersonId: UUID, rightPersonId: UUID]
}>()

const dismissed = ref(new Set<string>())
const personById = computed(() => new Map(props.people.map((person) => [person.id, person])))
const candidates = computed(() => props.candidates
  .filter((candidate) => !dismissed.value.has(pairKey(candidate.leftPersonId, candidate.rightPersonId))))

watch(() => props.candidates.map(({ leftPersonId, rightPersonId, score }) => `${leftPersonId}:${rightPersonId}:${score}`).join('|'), () => {
  dismissed.value = new Set()
})

function pairKey(left: UUID, right: UUID): string {
  return [left, right].sort().join('\0')
}

function name(personId: UUID): string {
  const person = personById.value.get(personId)
  return person ? getPrimaryName(person) : personId
}

function dismiss(left: UUID, right: UUID) {
  dismissed.value = new Set([...dismissed.value, pairKey(left, right)])
  emit('not-duplicate', left, right)
}

function defer(left: UUID, right: UUID) {
  dismissed.value = new Set([...dismissed.value, pairKey(left, right)])
  emit('defer', left, right)
}
</script>

<template>
  <section class="duplicate-candidates" aria-labelledby="duplicate-candidates-title">
    <header>
      <div>
        <h2 id="duplicate-candidates-title">{{ t('重复人物候选') }}</h2>
        <p>{{ t('候选仅供人工核对，不会自动合并。') }}</p>
      </div>
      <span>{{ t('{0} 组', [candidates.length]) }}</span>
    </header>

    <p v-if="candidates.length === 0" class="empty">{{ t('暂无重复候选') }}</p>
    <article v-for="candidate in candidates" :key="pairKey(candidate.leftPersonId, candidate.rightPersonId)">
      <div class="candidate-heading">
        <strong>{{ name(candidate.leftPersonId) }}</strong>
        <span aria-hidden="true">⇄</span>
        <strong>{{ name(candidate.rightPersonId) }}</strong>
        <b>{{ t('{0} 分', [candidate.score]) }}</b>
      </div>
      <p>{{ candidate.reasons.join(' · ') }}</p>
      <p v-if="candidate.conflicts.length" class="conflicts">{{ t('冲突：{0}', [candidate.conflicts.join(' · ')]) }}</p>
      <div class="actions">
        <button
          type="button"
          :name="t('合并候选人 {0} {1}', [candidate.leftPersonId, candidate.rightPersonId])"
          @click="emit('merge', candidate.leftPersonId, candidate.rightPersonId)"
        > {{ t('进入合并') }} </button>
        <button
          type="button"
          :name="t('标记非重复 {0} {1}', [candidate.leftPersonId, candidate.rightPersonId])"
          @click="dismiss(candidate.leftPersonId, candidate.rightPersonId)"
        > {{ t('不是重复人物') }} </button>
        <button
          type="button"
          :name="t('稍后处理 {0} {1}', [candidate.leftPersonId, candidate.rightPersonId])"
          @click="defer(candidate.leftPersonId, candidate.rightPersonId)"
        > {{ t('稍后处理') }} </button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.duplicate-candidates { display: grid; gap: 12px; }
header, .candidate-heading, .actions { display: flex; align-items: center; gap: 10px; }
header { justify-content: space-between; }
h2, p { margin: 0; }
header p, article p { color: var(--color-text-muted, #667085); font-size: 13px; }
.conflicts { color: var(--color-danger, #b42318); }
article { border: 1px solid var(--color-border, #d9dee8); border-radius: 12px; padding: 14px; display: grid; gap: 10px; }
.candidate-heading b { margin-left: auto; color: #2563eb; }
.actions { justify-content: flex-end; }
button { border: 1px solid #c9d1de; border-radius: 8px; background: white; padding: 7px 11px; cursor: pointer; }
.empty { border: 1px dashed #c9d1de; border-radius: 12px; padding: 24px; text-align: center; }
</style>
