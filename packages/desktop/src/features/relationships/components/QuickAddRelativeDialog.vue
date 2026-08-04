<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  createRelationshipId,
  parentRelationshipOptions,
  partnerRelationshipOptions,
} from '../composables/useRelationshipEditor'

const props = defineProps<{ open: boolean; projectId: string; person: Person }>()
const emit = defineEmits<{
  close: []
  saved: [person: Person, relationship: Relationship]
}>()
const repository = useBranchloomRepository()
const session = useSessionStore()
const relativeName = ref('')
const category = ref<Relationship['category']>('parent')
const parentType = ref<ParentRelation>('biological')
const partnerType = ref<PartnerRelation>('married')
const direction = ref<'relative-is-parent' | 'current-is-parent'>('relative-is-parent')
const saving = ref(false)
const validationError = ref('')
const saveFailure = ref('')
const confirmClose = ref(false)
const baseline = ref('')
const dirty = computed(() => draftFingerprint() !== baseline.value)
const typeOptions = computed(() => category.value === 'parent'
  ? parentRelationshipOptions
  : partnerRelationshipOptions)

watch(() => [props.open, props.person.id, props.projectId] as const, ([open]) => {
  if (open) reset()
  else confirmClose.value = false
}, { immediate: true })

function reset() {
  relativeName.value = ''
  category.value = 'parent'
  parentType.value = 'biological'
  partnerType.value = 'married'
  direction.value = 'relative-is-parent'
  validationError.value = ''
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
  if (saving.value) return
  const name = relativeName.value.trim()
  if (!name) {
    validationError.value = '请填写人物姓名。'
    return
  }
  const drafts = createDrafts(name)
  saving.value = true
  validationError.value = ''
  saveFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const saved = await repository.savePersonWithRelationship(drafts.person, drafts.relationship)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('saved', saved.person, saved.relationship)
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
    title="添加人物与关系"
    description="创建一个新人物，并设置其与当前人物的关系。"
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
        <BaseField id="quick-relative-type" label="关系性质">
          <BaseSelectControl>
            <select
              v-if="category === 'parent'"
              id="quick-relative-type"
              v-model="parentType"
              name="relationshipType"
            >
              <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select
              v-else
              id="quick-relative-type"
              v-model="partnerType"
              name="relationshipType"
            >
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

      <div v-if="saveFailure" class="quick-relative__error" role="alert">
        <strong>添加失败，人物和关系均未写入。</strong>
        <p>{{ saveFailure }}</p>
      </div>

      <footer class="quick-relative__actions">
        <BaseButton name="取消" variant="secondary" :disabled="saving" @click="requestClose">取消</BaseButton>
        <BaseButton name="添加并关联" type="submit" :loading="saving">添加并关联</BaseButton>
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
@media (max-width: 28rem) { .quick-relative__grid { grid-template-columns: 1fr; } }
</style>
