<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { Person, Relationship } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  parentRelationshipOptions,
  partnerRelationshipOptions,
  useRelationshipEditor,
} from '../composables/useRelationshipEditor'

const props = defineProps<{
  open: boolean
  projectId: string
  person: Person
  relationship?: Relationship
}>()
const emit = defineEmits<{
  close: []
  saved: [relationship: Relationship]
  deleted: [relationshipId: string]
}>()
const repository = useBranchloomRepository()
const session = useSessionStore()
const editor = useRelationshipEditor(
  repository,
  session,
  toRef(props, 'projectId'),
  toRef(props, 'person'),
  toRef(props, 'relationship'),
)
const confirmClose = ref(false)
const confirmDelete = ref(false)
const deleting = ref(false)
const deleteFailure = ref('')
const typeOptions = computed(() => editor.category.value === 'parent'
  ? parentRelationshipOptions
  : partnerRelationshipOptions)

watch(() => [props.open, props.person.id, props.projectId, props.relationship?.id] as const, ([open]) => {
  if (open) {
    editor.reset()
    void editor.load()
  } else {
    confirmClose.value = false
  }
}, { immediate: true })

function requestClose() {
  if (editor.saving.value) return
  if (editor.dirty.value) confirmClose.value = true
  else emit('close')
}

function discardAndClose() {
  confirmClose.value = false
  editor.reset()
  emit('close')
}

async function submit() {
  const saved = await editor.save()
  if (!saved) return
  emit('saved', saved)
  emit('close')
}

async function removeRelationship() {
  const relationship = props.relationship
  if (!relationship || deleting.value) return
  deleting.value = true
  deleteFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.deleteRelationship(relationship.id)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    confirmDelete.value = false
    emit('deleted', relationship.id)
    emit('close')
  } catch (error) {
    const details = error instanceof Error ? error.message : '本地关系暂时无法删除'
    deleteFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
    confirmDelete.value = false
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <BaseDialog
    :open="open"
    :title="relationship ? '编辑人物关系' : '添加人物关系'"
    description="结构性错误会被阻止；重复关系只会提醒，仍可保存。"
    close-label="关闭关系编辑器"
    @close="requestClose"
  >
    <form class="relationship-editor" novalidate @submit.prevent="submit">
      <p v-if="editor.loading.value" role="status">正在读取项目人物…</p>
      <p v-if="editor.loadFailure.value" class="relationship-editor__error" role="alert">
        读取失败：{{ editor.loadFailure.value }}
      </p>

      <BaseField id="relationship-person" label="关联人物" required>
        <BaseSelectControl>
          <select
            id="relationship-person"
            v-model="editor.relativePersonId.value"
            name="relativePersonId"
            required
          >
            <option value="">请选择人物</option>
            <option
              v-if="editor.relativePersonId.value && !editor.people.value.some(({ id }) => id === editor.relativePersonId.value)"
              :value="editor.relativePersonId.value"
            >
              正在读取已选人物…
            </option>
            <option v-for="candidate in editor.people.value" :key="candidate.id" :value="candidate.id">
              {{ getPrimaryName(candidate) }}
            </option>
          </select>
        </BaseSelectControl>
      </BaseField>

      <div class="relationship-editor__grid">
        <BaseField id="relationship-category" label="关系大类">
          <BaseSelectControl><select id="relationship-category" v-model="editor.category.value" name="category">
              <option value="parent">亲子与照护</option>
              <option value="partner">伴侣</option>
            </select></BaseSelectControl>
        </BaseField>
        <BaseField id="relationship-type" label="关系性质">
          <BaseSelectControl>
            <select
              v-if="editor.category.value === 'parent'"
              id="relationship-type"
              v-model="editor.parentType.value"
              name="relationshipType"
            >
              <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select
              v-else
              id="relationship-type"
              v-model="editor.partnerType.value"
              name="relationshipType"
            >
              <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>

      <BaseField v-if="editor.category.value === 'parent'" id="relationship-direction" label="关系方向">
        <BaseSelectControl><select id="relationship-direction" v-model="editor.direction.value" name="direction">
            <option value="relative-is-parent">对方是当前人物的父母或监护人</option>
            <option value="current-is-parent">当前人物是对方的父母或监护人</option>
          </select></BaseSelectControl>
      </BaseField>

      <div class="relationship-editor__grid">
        <BaseField id="relationship-start" label="开始日期">
          <input id="relationship-start" v-model="editor.start.value" name="startDate" />
        </BaseField>
        <BaseField id="relationship-end" label="结束日期">
          <input id="relationship-end" v-model="editor.end.value" name="endDate" />
        </BaseField>
      </div>

      <BaseField id="relationship-place" label="地点">
        <BaseSelectControl><select id="relationship-place" v-model="editor.placeId.value" name="placeId">
            <option value="">未指定</option>
            <option v-for="place in editor.places.value" :key="place.id" :value="place.id">{{ place.name }}</option>
          </select></BaseSelectControl>
      </BaseField>
      <BaseField id="relationship-notes" label="备注">
        <textarea id="relationship-notes" v-model="editor.notes.value" name="notes" rows="3" />
      </BaseField>

      <p
        v-if="editor.feedback.value"
        class="relationship-editor__feedback"
        :class="`relationship-editor__feedback--${editor.feedback.value.severity}`"
        :role="editor.feedback.value.severity === 'error' ? 'alert' : 'status'"
        data-relationship-feedback
      >
        {{ editor.feedback.value.message }}
        <span v-if="editor.feedback.value.severity === 'warning'">这是提醒，不会阻止保存。</span>
      </p>
      <div v-if="editor.saveFailure.value" class="relationship-editor__error" role="alert">
        <strong>保存失败，关系尚未写入。</strong>
        <p>{{ editor.saveFailure.value }}</p>
      </div>
      <p v-if="deleteFailure" class="relationship-editor__error" role="alert">{{ deleteFailure }}</p>

      <footer class="relationship-editor__actions">
        <BaseButton
          v-if="relationship"
          name="删除关系"
          variant="danger"
          :disabled="editor.saving.value || deleting"
          @click="confirmDelete = true"
        >删除关系</BaseButton>
        <span class="relationship-editor__spacer" />
        <BaseButton name="取消" variant="secondary" :disabled="editor.saving.value" @click="requestClose">取消</BaseButton>
        <BaseButton
          name="保存关系"
          type="submit"
          :loading="editor.saving.value"
          :disabled="!editor.candidate.value || editor.blocking.value || Boolean(editor.loadFailure.value)"
        >
          保存关系
        </BaseButton>
      </footer>
    </form>
  </BaseDialog>

  <BaseDialog
    :open="confirmDelete"
    title="删除人物关系？"
    description="删除后，依赖这段关系的引用关联也会一并清理。"
    close-label="保留关系"
    @close="confirmDelete = false"
  >
    <div class="relationship-editor__actions">
      <BaseButton variant="secondary" @click="confirmDelete = false">保留关系</BaseButton>
      <BaseButton name="确认删除关系" variant="danger" :loading="deleting" @click="removeRelationship">确认删除</BaseButton>
    </div>
  </BaseDialog>

  <BaseDialog
    :open="confirmClose"
    title="放弃未保存的关系？"
    description="关闭后，这次填写的关系资料不会保留。"
    close-label="继续编辑关系"
    @close="confirmClose = false"
  >
    <div class="relationship-editor__actions">
      <BaseButton variant="secondary" @click="confirmClose = false">继续编辑</BaseButton>
      <BaseButton variant="danger" @click="discardAndClose">放弃修改</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.relationship-editor { display: grid; gap: var(--space-4); }
.relationship-editor__grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.relationship-editor input, .relationship-editor textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.relationship-editor__feedback, .relationship-editor__error { margin: 0; padding: var(--space-3); border-radius: var(--radius-sm); }
.relationship-editor__feedback--warning { background: var(--color-warning-surface); color: var(--color-warning); }
.relationship-editor__feedback--error, .relationship-editor__error { background: var(--color-danger-surface); color: var(--color-danger); }
.relationship-editor__error p { margin-bottom: 0; }
.relationship-editor__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.relationship-editor__spacer { flex: 1; }
@media (max-width: 28rem) { .relationship-editor__grid { grid-template-columns: 1fr; } }
</style>
