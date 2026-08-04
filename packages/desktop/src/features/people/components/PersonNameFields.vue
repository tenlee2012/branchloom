<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { parseGenealogyDate } from '../../../shared/domain/date'
import {
  editablePersonNameTypes,
  personNameTypeLabels,
} from '../../../shared/domain/personNames'
import type { PersonName } from '../../../shared/domain/types'

const props = defineProps<{
  names: PersonName[]
}>()
const emit = defineEmits<{
  'update:names': [names: PersonName[]]
}>()

const pendingRemovalId = ref('')
type EditorName = PersonName & { id: string }
const editorNames = computed<EditorName[]>(() => props.names.map((name, index) => ({
  ...name,
  id: `name-editor-${index}`,
})))
const primaryName = computed(() =>
  editorNames.value.find(({ primary }) => primary) ?? editorNames.value[0],
)
const otherNames = computed(() => editorNames.value.filter(({ id }) => id !== primaryName.value?.id))

function indexFromEditorId(id: string): number {
  return Number(id.slice('name-editor-'.length))
}

function updateName(id: string | undefined, patch: Partial<PersonName>) {
  if (!id) return
  const index = indexFromEditorId(id)
  emit('update:names', props.names.map((name, current) => current === index ? { ...name, ...patch } : name))
}

function removeOptionalField(id: string, field: keyof PersonName, value: string) {
  const trimmed = value.trim()
  if (trimmed) {
    updateName(id, { [field]: trimmed })
    return
  }
  const index = indexFromEditorId(id)
  emit('update:names', props.names.map((name, current) => {
    if (current !== index) return name
    const next = { ...name }
    delete next[field]
    return next
  }))
}

function updateNameDate(id: string, field: 'validFrom' | 'validTo', value: string) {
  const text = value.trim()
  if (text) {
    updateName(id, { [field]: parseGenealogyDate(text) })
    return
  }
  const index = indexFromEditorId(id)
  emit('update:names', props.names.map((name, current) => {
    if (current !== index) return name
    const next = { ...name }
    delete next[field]
    return next
  }))
}

function addName() {
  emit('update:names', [
    ...props.names,
    { value: '', type: 'alias', primary: false, notes: '' },
  ])
}

function setPrimary(id: string) {
  const index = indexFromEditorId(id)
  emit('update:names', props.names.map((name, current) => ({
    ...name,
    primary: current === index,
  })))
}

const pendingRemoval = computed(() =>
  editorNames.value.find(({ id }) => id === pendingRemovalId.value))

function requestRemoveName(id: string) {
  pendingRemovalId.value = id
}

function removeName() {
  const id = pendingRemovalId.value
  if (!id) return
  const index = indexFromEditorId(id)
  const removedPrimary = props.names[index]?.primary === true
  const next = props.names.filter((_name, current) => current !== index)
  emit('update:names', removedPrimary && next[0]
    ? next.map((name, current) => ({ ...name, primary: current === 0 }))
    : next)
  pendingRemovalId.value = ''
}
</script>

<template>
  <fieldset class="person-name-fields">
    <div class="person-name-fields__heading">
      <div>
        <legend>姓名与称谓</legend>
        <p>主显示名与“名、字、号”等类型分别保存。</p>
      </div>
      <BaseButton name="添加姓名" variant="secondary" size="sm" @click="addName">
        添加姓名
      </BaseButton>
    </div>

    <article v-if="primaryName" class="person-name-fields__card person-name-fields__card--primary">
      <div class="person-name-fields__badge">主显示名</div>
      <div class="person-name-fields__row">
        <BaseField id="person-primary-name" label="主姓名" required>
          <template #default="field">
            <input
              id="person-primary-name"
              name="primaryName"
              :value="primaryName.value"
              :aria-describedby="field.describedBy"
              required
              autocomplete="name"
              @input="updateName(primaryName.id, { value: ($event.target as HTMLInputElement).value })"
            />
          </template>
        </BaseField>
        <BaseField :id="`${primaryName.id}-type`" label="姓名类型">
          <BaseSelectControl>
            <select
              :id="`${primaryName.id}-type`"
              :value="primaryName.type"
              @change="updateName(primaryName.id, { type: ($event.target as HTMLSelectElement).value as PersonName['type'] })"
            >
              <option v-for="type in editablePersonNameTypes" :key="type" :value="type">
                {{ personNameTypeLabels[type] }}
              </option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>
      <BaseField
        v-if="primaryName.type === 'custom'"
        :id="`${primaryName.id}-custom-type`"
        label="自定义类型名称"
        required
      >
        <input
          :id="`${primaryName.id}-custom-type`"
          :value="primaryName.customTypeLabel ?? ''"
          @input="removeOptionalField(primaryName.id, 'customTypeLabel', ($event.target as HTMLInputElement).value)"
        />
      </BaseField>
      <details class="person-name-fields__details" :data-name-details="primaryName.id">
        <summary>更多姓名资料</summary>
        <div class="person-name-fields__details-grid">
          <BaseField :id="`${primaryName.id}-context`" label="使用场景">
            <input
              :id="`${primaryName.id}-context`"
              :value="primaryName.context ?? ''"
              @input="removeOptionalField(primaryName.id, 'context', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${primaryName.id}-family-name`" label="姓氏（辅助字段）">
            <input
              :id="`${primaryName.id}-family-name`"
              :value="primaryName.familyName ?? ''"
              @input="removeOptionalField(primaryName.id, 'familyName', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${primaryName.id}-given-name`" label="名字（辅助字段）">
            <input
              :id="`${primaryName.id}-given-name`"
              :value="primaryName.givenName ?? ''"
              @input="removeOptionalField(primaryName.id, 'givenName', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${primaryName.id}-valid-from`" label="开始使用时间">
            <input
              :id="`${primaryName.id}-valid-from`"
              :value="primaryName.validFrom?.display ?? ''"
              @input="updateNameDate(primaryName.id, 'validFrom', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${primaryName.id}-valid-to`" label="结束使用时间">
            <input
              :id="`${primaryName.id}-valid-to`"
              :value="primaryName.validTo?.display ?? ''"
              @input="updateNameDate(primaryName.id, 'validTo', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
        </div>
        <BaseField :id="`${primaryName.id}-notes`" label="姓名备注">
          <textarea
            :id="`${primaryName.id}-notes`"
            :value="primaryName.notes"
            rows="2"
            @input="updateName(primaryName.id, { notes: ($event.target as HTMLTextAreaElement).value })"
          />
        </BaseField>
      </details>
    </article>

    <article v-for="name in otherNames" :key="name.id" class="person-name-fields__card">
      <div class="person-name-fields__row">
        <BaseField :id="`${name.id}-value`" label="名称">
          <input
            :id="`${name.id}-value`"
            name="personName"
            :value="name.value"
            @input="updateName(name.id, { value: ($event.target as HTMLInputElement).value })"
          />
        </BaseField>
        <BaseField :id="`${name.id}-type`" label="类型">
          <BaseSelectControl>
            <select
              :id="`${name.id}-type`"
              :value="name.type"
              :aria-label="`姓名类型：${name.value || '未填写'}`"
              @change="updateName(name.id, { type: ($event.target as HTMLSelectElement).value as PersonName['type'] })"
            >
              <option v-for="type in editablePersonNameTypes" :key="type" :value="type">
                {{ personNameTypeLabels[type] }}
              </option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>
      <BaseField v-if="name.type === 'custom'" :id="`${name.id}-custom-type`" label="自定义类型名称" required>
        <input
          :id="`${name.id}-custom-type`"
          :value="name.customTypeLabel ?? ''"
          @input="removeOptionalField(name.id, 'customTypeLabel', ($event.target as HTMLInputElement).value)"
        />
      </BaseField>
      <div class="person-name-fields__actions">
        <BaseButton
          variant="ghost"
          size="sm"
          :aria-label="`设为主姓名：${name.value || '未填写姓名'}`"
          @click="setPrimary(name.id)"
        >设为主显示名</BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          :aria-label="`移除姓名：${name.value || '未填写姓名'}`"
          @click="requestRemoveName(name.id)"
        >移除</BaseButton>
      </div>
      <details class="person-name-fields__details" :data-name-details="name.id">
        <summary>使用场景与更多姓名资料</summary>
        <div class="person-name-fields__details-grid">
          <BaseField :id="`${name.id}-context`" label="使用场景">
            <input
              :id="`${name.id}-context`"
              :value="name.context ?? ''"
              @input="removeOptionalField(name.id, 'context', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${name.id}-family-name`" label="姓氏（辅助字段）">
            <input
              :id="`${name.id}-family-name`"
              :value="name.familyName ?? ''"
              @input="removeOptionalField(name.id, 'familyName', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${name.id}-given-name`" label="名字（辅助字段）">
            <input
              :id="`${name.id}-given-name`"
              :value="name.givenName ?? ''"
              @input="removeOptionalField(name.id, 'givenName', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${name.id}-valid-from`" label="开始使用时间">
            <input
              :id="`${name.id}-valid-from`"
              :value="name.validFrom?.display ?? ''"
              @input="updateNameDate(name.id, 'validFrom', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
          <BaseField :id="`${name.id}-valid-to`" label="结束使用时间">
            <input
              :id="`${name.id}-valid-to`"
              :value="name.validTo?.display ?? ''"
              @input="updateNameDate(name.id, 'validTo', ($event.target as HTMLInputElement).value)"
            />
          </BaseField>
        </div>
        <BaseField :id="`${name.id}-notes`" label="姓名备注">
          <textarea
            :id="`${name.id}-notes`"
            :value="name.notes"
            rows="2"
            @input="updateName(name.id, { notes: ($event.target as HTMLTextAreaElement).value })"
          />
        </BaseField>
      </details>
    </article>
  </fieldset>

  <BaseDialog
    :open="Boolean(pendingRemoval)"
    :title="`移除姓名“${pendingRemoval?.value || '未填写姓名'}”？`"
    description="移除会在保存人物时生效。姓名不是独立资源，不会留下 name-id。"
    close-label="保留姓名"
    @close="pendingRemovalId = ''"
  >
    <div class="person-name-fields__remove-dialog">
      <p>人物至少需要保留一个姓名；移除主姓名时，第一条剩余姓名会成为主姓名。</p>
      <div>
        <BaseButton variant="secondary" @click="pendingRemovalId = ''">保留姓名</BaseButton>
        <BaseButton
          name="确认移除姓名"
          variant="danger"
          @click="removeName"
        >确认移除</BaseButton>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.person-name-fields { display: grid; gap: var(--space-3); margin: 0; padding: 0; border: 0; }
.person-name-fields__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.person-name-fields legend { font-weight: 750; }
.person-name-fields__heading p { margin: var(--space-1) 0 0; color: var(--color-muted); font-size: .8125rem; }
.person-name-fields__card { display: grid; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.person-name-fields__card--primary { border-color: var(--color-primary); background: var(--color-muted-surface); }
.person-name-fields__badge { width: fit-content; padding: .18rem var(--space-2); border-radius: 999px; background: var(--color-primary); color: white; font-size: .75rem; font-weight: 750; }
.person-name-fields__row, .person-name-fields__details-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(12rem, 15rem); gap: var(--space-3); }
.person-name-fields__details-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: var(--space-3); }
.person-name-fields__actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.person-name-fields__details { padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); }
.person-name-fields__details summary { color: var(--color-primary); font-size: .8125rem; font-weight: 700; cursor: pointer; }
.person-name-fields__sources { display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.person-name-fields__sources > span { font-size: .8125rem; font-weight: 700; }
.person-name-fields__sources label { display: flex; align-items: center; gap: var(--space-2); font-size: .8125rem; }
.person-name-fields__sources input { width: 1rem; min-height: 1rem; }
.person-name-fields input, .person-name-fields textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease; }
.person-name-fields .person-name-fields__sources input { width: 1rem; min-height: 1rem; padding: 0; }
.person-name-fields__remove-dialog { display: grid; gap: var(--space-4); }
.person-name-fields__remove-dialog p { margin: 0; }
.person-name-fields__remove-dialog > div { display: flex; justify-content: flex-end; gap: var(--space-3); }
@media (max-width: 36rem) {
  .person-name-fields__row, .person-name-fields__details-grid { grid-template-columns: 1fr; }
}
</style>
