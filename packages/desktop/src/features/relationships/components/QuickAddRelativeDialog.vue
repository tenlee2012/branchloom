<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import type {
  ParentRelation,
  PartnerRelation,
  Person,
  Relationship,
} from '../../../shared/domain/types'
import { getPrimaryName } from '../../../shared/domain/personNames'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  createRelationshipId,
  parentRelationshipOptions,
  partnerRelationshipOptions,
  relationshipDisplayLabel,
} from '../composables/useRelationshipEditor'

type QuickRelativePreset = 'parent' | 'partner' | 'child' | 'custom'

const props = withDefaults(defineProps<{
  open: boolean
  projectId: string
  person: Person
  preset?: QuickRelativePreset
}>(), { preset: 'custom' })
const emit = defineEmits<{
  close: []
  saved: [person: Person, relationship: Relationship, additionalRelationships?: Relationship[]]
}>()
const repository = useBranchloomRepository()
const session = useSessionStore()
const relativeName = ref('')
const category = ref<Relationship['category']>('parent')
const parentType = ref<ParentRelation | ''>('')
const partnerType = ref<PartnerRelation | ''>('')
const direction = ref<'relative-is-parent' | 'current-is-parent'>('relative-is-parent')
const currentParentOnly = '__current-parent-only__'
const additionalParentId = ref('')
const additionalParentType = ref<ParentRelation | ''>('')
const additionalParentError = ref('')
const additionalParentTypeError = ref('')
const parentCandidates = ref<Array<{ person: Person; label: string }>>([])
const loadingParents = ref(false)
const parentLoadFailure = ref('')
let parentRequest = 0
const saving = ref(false)
const validationError = ref('')
const relationshipTypeError = ref('')
const saveFailure = ref('')
const confirmClose = ref(false)
const baseline = ref('')
const dirty = computed(() => draftFingerprint() !== baseline.value)
const typeOptions = computed(() => category.value === 'parent'
  ? parentRelationshipOptions
  : partnerRelationshipOptions)
const personName = computed(() => getPrimaryName(props.person))
const addingChild = computed(() => category.value === 'parent' && direction.value === 'current-is-parent')
const additionalParent = computed(() => parentCandidates.value.find(({ person }) => person.id === additionalParentId.value)?.person)
const dialogTitle = computed(() => {
  if (props.preset === 'parent') return `为${personName.value}添加父母`
  if (props.preset === 'partner') return `为${personName.value}添加伴侣`
  if (props.preset === 'child') return `为${personName.value}添加子女`
  return '添加人物与关系'
})
const dialogDescription = computed(() => props.preset === 'custom'
  ? '创建一个新人物，并设置其与当前人物的关系。'
  : '快捷项已带入关系方向，请补充姓名并确认关系性质。')

watch(() => [props.open, props.person.id, props.projectId, props.preset] as const, ([open]) => {
  if (open) reset()
  else confirmClose.value = false
}, { immediate: true })

watch(() => [props.open && addingChild.value, props.person.id, props.projectId] as const, ([active]) => {
  parentRequest += 1
  parentCandidates.value = []
  additionalParentId.value = ''
  additionalParentType.value = ''
  additionalParentError.value = ''
  additionalParentTypeError.value = ''
  parentLoadFailure.value = ''
  loadingParents.value = false
  if (active) void loadParentCandidates()
}, { immediate: true })

watch(additionalParentId, () => {
  additionalParentType.value = ''
  additionalParentError.value = ''
  additionalParentTypeError.value = ''
})

onBeforeUnmount(() => { parentRequest += 1 })

async function loadParentCandidates() {
  const request = ++parentRequest
  const personId = props.person.id
  const projectId = props.projectId
  loadingParents.value = true
  parentLoadFailure.value = ''
  try {
    const relationships = await repository.listRelationships(projectId)
    const labelsByPerson = new Map<string, Set<string>>()
    for (const relationship of relationships) {
      if (relationship.projectId !== projectId || relationship.category !== 'partner'
        || (relationship.fromPersonId !== personId && relationship.toPersonId !== personId)) continue
      const relativeId = relationship.fromPersonId === personId ? relationship.toPersonId : relationship.fromPersonId
      if (relativeId === personId) continue
      const labels = labelsByPerson.get(relativeId) ?? new Set<string>()
      labels.add(relationshipDisplayLabel(relationship, personId))
      labelsByPerson.set(relativeId, labels)
    }
    const people = await Promise.all([...labelsByPerson.keys()].map((id) => repository.getPerson(id)))
    if (request !== parentRequest) return
    parentCandidates.value = people
      .filter((person) => person.projectId === projectId && !person.deletedAt)
      .map((person) => ({ person, label: `${getPrimaryName(person)}（${[...labelsByPerson.get(person.id)!].join('、')}）` }))
      .sort((left, right) => getPrimaryName(left.person).localeCompare(getPrimaryName(right.person), 'zh-CN')
        || left.person.id.localeCompare(right.person.id))
  } catch (error) {
    if (request !== parentRequest) return
    parentLoadFailure.value = error instanceof Error ? error.message : '另一位家长的候选资料无法读取'
  } finally {
    if (request === parentRequest) loadingParents.value = false
  }
}

function reset() {
  relativeName.value = ''
  category.value = props.preset === 'partner' ? 'partner' : 'parent'
  parentType.value = ''
  partnerType.value = ''
  direction.value = props.preset === 'child' ? 'current-is-parent' : 'relative-is-parent'
  additionalParentId.value = ''
  additionalParentType.value = ''
  additionalParentError.value = ''
  additionalParentTypeError.value = ''
  validationError.value = ''
  relationshipTypeError.value = ''
  saveFailure.value = ''
  baseline.value = draftFingerprint()
}

function draftFingerprint(): string {
  return JSON.stringify({
    relativeName: relativeName.value,
    category: category.value,
    parentType: parentType.value,
    partnerType: partnerType.value,
    direction: direction.value,
    additionalParentId: addingChild.value ? additionalParentId.value : '',
    additionalParentType: addingChild.value ? additionalParentType.value : '',
  })
}

function requestClose() {
  if (saving.value) return
  if (dirty.value) confirmClose.value = true
  else emit('close')
}

function discardAndClose() {
  confirmClose.value = false
  reset()
  emit('close')
}

function createDrafts(name: string): { person: Person; relationship: Relationship } {
  const personId = createRelationshipId('person')
  const person: Person = {
    id: personId,
    projectId: props.projectId,
    names: [{ value: name, type: 'personal', primary: true, notes: '' }],
    sex: 'unknown',
    status: 'unknown',
    biography: '',
    notes: '',
    sourceIds: [],
    updatedAt: new Date().toISOString(),
  }
  const relationshipId = createRelationshipId('relationship')
  if (category.value === 'partner') {
    if (!partnerType.value) throw new Error('请选择关系性质。')
    return {
      person,
      relationship: {
        id: relationshipId,
        projectId: props.projectId,
        category: 'partner',
        type: partnerType.value,
        fromPersonId: props.person.id,
        toPersonId: personId,
        notes: '',
        sourceIds: [],
      },
    }
  }
  if (!parentType.value) throw new Error('请选择关系性质。')
  return {
    person,
    relationship: {
      id: relationshipId,
      projectId: props.projectId,
      category: 'parent',
      type: parentType.value,
      fromPersonId: direction.value === 'relative-is-parent' ? personId : props.person.id,
      toPersonId: direction.value === 'relative-is-parent' ? props.person.id : personId,
      notes: '',
      sourceIds: [],
    },
  }
}

async function submit() {
  if (saving.value || (addingChild.value && (loadingParents.value || parentLoadFailure.value))) return
  const name = relativeName.value.trim()
  validationError.value = ''
  relationshipTypeError.value = ''
  additionalParentError.value = ''
  additionalParentTypeError.value = ''
  if (!name) {
    validationError.value = '请填写人物姓名。'
  }
  if (!(category.value === 'parent' ? parentType.value : partnerType.value)) {
    relationshipTypeError.value = '请选择关系性质。'
  }
  if (addingChild.value && parentCandidates.value.length) {
    if (!additionalParentId.value) {
      additionalParentError.value = '请选择另一位家长，或选择仅关联当前家长。'
    } else if (additionalParentId.value !== currentParentOnly) {
      if (!additionalParent.value) additionalParentError.value = '所选家长无法读取，请重新选择。'
      if (!additionalParentType.value) additionalParentTypeError.value = '请选择另一位家长与孩子的关系。'
    }
  }
  if (validationError.value || relationshipTypeError.value || additionalParentError.value || additionalParentTypeError.value) return
  const drafts = createDrafts(name)
  const additionalRelationships: Relationship[] = addingChild.value && additionalParent.value && additionalParentType.value
    ? [{
      id: createRelationshipId('relationship'),
      projectId: props.projectId,
      category: 'parent',
      type: additionalParentType.value,
      fromPersonId: additionalParent.value.id,
      toPersonId: drafts.person.id,
      notes: '',
      sourceIds: [],
    }]
    : []
  saving.value = true
  saveFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const saved = additionalRelationships.length
      ? await repository.savePersonWithRelationship(drafts.person, drafts.relationship, additionalRelationships)
      : await repository.savePersonWithRelationship(drafts.person, drafts.relationship)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    if (additionalRelationships.length) emit('saved', saved.person, saved.relationship, additionalRelationships)
    else emit('saved', saved.person, saved.relationship)
    emit('close')
  } catch (error) {
    const details = error instanceof Error ? error.message : '本地资料暂时无法写入'
    saveFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BaseDialog
    :open="open"
    :title="dialogTitle"
    :description="dialogDescription"
    close-label="关闭添加人物与关系"
    @close="requestClose"
  >
    <form class="quick-relative" novalidate @submit.prevent="submit">
      <BaseField id="quick-relative-name" label="姓名" required :error="validationError">
        <input
          id="quick-relative-name"
          v-model="relativeName"
          name="relativeName"
          autocomplete="off"
          required
        />
      </BaseField>

      <div class="quick-relative__grid">
        <BaseField id="quick-relative-category" label="关系大类">
          <BaseSelectControl><select id="quick-relative-category" v-model="category" name="category">
              <option value="parent">亲子与照护</option>
              <option value="partner">伴侣</option>
            </select></BaseSelectControl>
        </BaseField>
        <BaseField
          id="quick-relative-type"
          v-slot="{ describedBy, invalid }"
          label="关系性质"
          required
          :error="relationshipTypeError"
        >
          <BaseSelectControl>
            <select
              v-if="category === 'parent'"
              id="quick-relative-type"
              v-model="parentType"
              name="relationshipType"
              required
              :aria-describedby="describedBy"
              :aria-invalid="invalid || undefined"
            >
              <option value="" disabled>请选择关系性质</option>
              <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select
              v-else
              id="quick-relative-type"
              v-model="partnerType"
              name="relationshipType"
              required
              :aria-describedby="describedBy"
              :aria-invalid="invalid || undefined"
            >
              <option value="" disabled>请选择关系性质</option>
              <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>

      <BaseField v-if="category === 'parent'" id="quick-relative-direction" label="关系方向">
        <BaseSelectControl><select id="quick-relative-direction" v-model="direction" name="direction">
            <option value="relative-is-parent">新人物是当前人物的父母或监护人</option>
            <option value="current-is-parent">当前人物是新人物的父母或监护人</option>
          </select></BaseSelectControl>
      </BaseField>

      <section v-if="addingChild" class="quick-relative__parents" aria-label="子女的家长关联">
        <p v-if="loadingParents" role="status">正在读取另一位家长的候选资料…</p>
        <div v-else-if="parentLoadFailure" class="quick-relative__error" role="alert">
          <p>另一位家长的候选资料读取失败：{{ parentLoadFailure }}</p>
          <BaseButton name="重新读取家长候选" variant="secondary" @click="loadParentCandidates">重新读取</BaseButton>
        </div>
        <template v-else-if="parentCandidates.length">
          <BaseField
            id="quick-relative-additional-parent"
            v-slot="{ describedBy, invalid }"
            label="另一位家长"
            hint="请确认是否同时关联另一位家长；也可以只关联当前家长。"
            required
            :error="additionalParentError"
          >
            <BaseSelectControl>
              <select
                id="quick-relative-additional-parent"
                v-model="additionalParentId"
                name="additionalParentId"
                required
                :disabled="saving"
                :aria-describedby="describedBy"
                :aria-invalid="invalid || undefined"
              >
                <option value="" disabled>请选择另一位家长或仅关联当前家长</option>
                <option :value="currentParentOnly">仅关联当前家长</option>
                <option v-for="candidate in parentCandidates" :key="candidate.person.id" :value="candidate.person.id">{{ candidate.label }}</option>
              </select>
            </BaseSelectControl>
          </BaseField>
          <BaseField
            v-if="additionalParent"
            id="quick-relative-additional-parent-type"
            v-slot="{ describedBy, invalid }"
            label="另一位家长与孩子的关系"
            required
            :error="additionalParentTypeError"
          >
            <BaseSelectControl>
              <select
                id="quick-relative-additional-parent-type"
                v-model="additionalParentType"
                name="additionalParentType"
                required
                :disabled="saving"
                :aria-describedby="describedBy"
                :aria-invalid="invalid || undefined"
              >
                <option value="" disabled>请选择关系性质</option>
                <option v-for="option in parentRelationshipOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </BaseSelectControl>
          </BaseField>
          <p v-if="additionalParent" class="quick-relative__parent-summary" role="status">{{ personName }}和{{ getPrimaryName(additionalParent) }}都将与新子女关联。</p>
        </template>
        <p v-else class="quick-relative__parent-summary">尚无伴侣记录，将只关联当前家长。另一位家长可在孩子档案的“家庭关系”中添加。</p>
      </section>

      <div v-if="saveFailure" class="quick-relative__error" role="alert">
        <strong>添加失败，人物和关系均未写入。</strong>
        <p>{{ saveFailure }}</p>
      </div>

      <footer class="quick-relative__actions">
        <BaseButton name="取消" variant="secondary" :disabled="saving" @click="requestClose">取消</BaseButton>
        <BaseButton name="添加并关联" type="submit" :loading="saving" :disabled="addingChild && (loadingParents || Boolean(parentLoadFailure))">添加并关联</BaseButton>
      </footer>
    </form>
  </BaseDialog>

  <BaseDialog
    :open="confirmClose"
    title="放弃未保存的人物与关系？"
    description="关闭后，姓名和关系选择不会保留。"
    close-label="继续添加人物"
    @close="confirmClose = false"
  >
    <div class="quick-relative__actions">
      <BaseButton variant="secondary" @click="confirmClose = false">继续填写</BaseButton>
      <BaseButton variant="danger" @click="discardAndClose">放弃修改</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.quick-relative { display: grid; gap: var(--space-4); }
.quick-relative__grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.quick-relative input { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.quick-relative__error { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.quick-relative__error p { margin-bottom: 0; }
.quick-relative__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.quick-relative__parents { display: grid; gap: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-border); }
.quick-relative__parent-summary { margin: 0; color: var(--color-muted); font-size: .8125rem; }
@media (max-width: 28rem) { .quick-relative__grid { grid-template-columns: 1fr; } }
</style>
