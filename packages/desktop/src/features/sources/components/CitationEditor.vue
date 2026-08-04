<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseDrawer from '../../../design-system/BaseDrawer.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { isDefinitelyReversedDateRange, normalizeIsoDate } from '../../../shared/domain/date'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  Attachment,
  AttachmentLink,
  CareerRecord,
  Citation,
  FamilyEvent,
  GenealogyDate,
  Person,
  Organization,
  Relationship,
  Source,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'

const props = withDefaults(defineProps<{
  open: boolean
  projectId: string
  citation?: Citation | undefined
  sources: Source[]
  people: Person[]
  events: FamilyEvent[]
  relationships: Relationship[]
  careers?: CareerRecord[]
  organizations?: Organization[]
  attachments: Attachment[]
  attachmentLinks: AttachmentLink[]
}>(), { careers: () => [], organizations: () => [] })
const emit = defineEmits<{
  close: []
  saved: [citation: Citation]
  deleted: [citationId: string]
}>()
const repository = useBranchloomRepository()
const session = useSessionStore()

interface CitationDraft {
  id: string
  sourceId: string
  targetType: Citation['targetType']
  targetId: string
  locator: string
  excerpt: string
  accessedPrecision: GenealogyDate['precision']
  accessedDisplay: string
  accessedStart: string
  accessedEnd: string
  notes: string
  attachmentIds: string[]
}

let fallbackId = 0
function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `citation-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `citation-${Date.now()}-${fallbackId}`
}

function draftFromCitation(citation?: Citation): CitationDraft {
  const id = citation?.id ?? createId()
  return {
    id,
    sourceId: citation?.sourceId ?? props.sources[0]?.id ?? '',
    targetType: citation?.targetType ?? 'person',
    targetId: citation?.targetId ?? '',
    locator: citation?.locator ?? '',
    excerpt: citation?.excerpt ?? '',
    accessedPrecision: citation?.accessedAt?.precision ?? 'exact',
    accessedDisplay: citation?.accessedAt?.display ?? '',
    accessedStart: citation?.accessedAt?.start ?? '',
    accessedEnd: citation?.accessedAt?.end ?? '',
    notes: citation?.notes ?? '',
    attachmentIds: props.attachmentLinks
      .filter(({ targetType, targetId }) => targetType === 'citation' && targetId === id)
      .map(({ attachmentId }) => attachmentId),
  }
}

const draft = reactive<CitationDraft>(draftFromCitation(props.citation))
const baseline = ref('')
const saving = ref(false)
const validationError = ref('')
const saveFailure = ref('')
const confirmClose = ref(false)
const confirmDelete = ref(false)
const dirty = computed(() => JSON.stringify(draft) !== baseline.value)

function personName(person: Person) {
  return getPrimaryName(person)
}

function relationshipName(relationship: Relationship) {
  const from = props.people.find(({ id }) => id === relationship.fromPersonId)
  const to = props.people.find(({ id }) => id === relationship.toPersonId)
  return `${from ? personName(from) : '未知人物'} — ${to ? personName(to) : '未知人物'}（${relationship.category === 'parent' ? '亲子' : '伴侣'}）`
}

const targets = computed(() => {
  if (draft.targetType === 'person') return props.people.map((person) => ({ id: person.id, label: personName(person) }))
  if (draft.targetType === 'event') return props.events.map((event) => ({ id: event.id, label: event.title }))
  if (draft.targetType === 'career') {
    return props.careers.map((career) => {
      const person = props.people.find(({ id }) => id === career.personId)
      const organization = props.organizations.find(({ id }) => id === career.organizationId)
      return {
        id: career.id,
        label: [person ? personName(person) : '未知人物', organization?.name, career.positionTitle]
          .filter(Boolean)
          .join(' · '),
      }
    })
  }
  return props.relationships.map((relationship) => ({ id: relationship.id, label: relationshipName(relationship) }))
})

function reset() {
  Object.assign(draft, draftFromCitation(props.citation))
  baseline.value = JSON.stringify(draft)
  validationError.value = ''
  saveFailure.value = ''
  confirmClose.value = false
}

watch(
  () => [props.open, props.projectId, props.citation?.id] as const,
  ([open]) => { if (open) reset() },
  { immediate: true },
)

watch(() => draft.targetType, () => {
  if (!targets.value.some(({ id }) => id === draft.targetId)) draft.targetId = targets.value[0]?.id ?? ''
})

function optional(value: string) {
  const trimmed = value.trim()
  return trimmed || undefined
}

function accessedDate(): GenealogyDate | undefined {
  const display = draft.accessedDisplay.trim()
  const start = optional(draft.accessedStart)
  const end = optional(draft.accessedEnd)
  if (!display && !start && !end && draft.accessedPrecision === 'exact') return undefined
  return {
    display,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    precision: draft.accessedPrecision,
  }
}

function candidate(): Citation {
  const locator = optional(draft.locator)
  const excerpt = optional(draft.excerpt)
  const accessedAt = accessedDate()
  return {
    id: draft.id,
    projectId: props.projectId,
    sourceId: draft.sourceId,
    targetType: draft.targetType,
    targetId: draft.targetId,
    ...(locator ? { locator } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(accessedAt ? { accessedAt } : {}),
    notes: draft.notes.trim(),
  }
}

function validate(citation: Citation): string | undefined {
  if (!citation.sourceId) return '请选择引用来源。'
  if (!citation.targetId) return '请选择引用所支持的人物、关系或事件。'
  for (const boundary of [citation.accessedAt?.start, citation.accessedAt?.end]) {
    if (boundary && !normalizeIsoDate(boundary)) return '访问或记录日期边界必须是有效的 ISO 日期。'
  }
  if (citation.accessedAt?.precision === 'before' && !citation.accessedAt.end) return '早于日期需要填写结束边界。'
  if (citation.accessedAt?.precision === 'after' && !citation.accessedAt.start) return '晚于日期需要填写开始边界。'
  if (citation.accessedAt?.precision === 'range' && (!citation.accessedAt.start || !citation.accessedAt.end)) {
    return '日期范围需要填写开始和结束边界。'
  }
  if (citation.accessedAt?.precision === 'range'
    && citation.accessedAt.start
    && citation.accessedAt.end
    && isDefinitelyReversedDateRange(citation.accessedAt.start, citation.accessedAt.end)) {
    return '日期范围的开始边界晚于结束边界，请核对。'
  }
  return undefined
}

async function submit() {
  if (saving.value) return
  const value = candidate()
  const error = validate(value)
  if (error) {
    validationError.value = error
    return
  }
  saving.value = true
  validationError.value = ''
  saveFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const saved = await repository.saveCitationWithAttachmentLinks(value, [...draft.attachmentIds])
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('saved', saved)
    emit('close')
  } catch (error) {
    const details = error instanceof Error && error.message.trim()
      ? error.message
      : '本地引用暂时无法写入'
    saveFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    saving.value = false
  }
}

function requestClose() {
  if (saving.value) return
  if (dirty.value) confirmClose.value = true
  else emit('close')
}

function discard() {
  reset()
  emit('close')
}

async function removeCitation() {
  const citation = props.citation
  if (!citation || saving.value) return
  saving.value = true
  saveFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.deleteCitation(citation.id)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    confirmDelete.value = false
    emit('deleted', citation.id)
    emit('close')
  } catch (error) {
    const details = error instanceof Error ? error.message : '本地引用暂时无法删除'
    saveFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
    confirmDelete.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BaseDrawer
    :open="open"
    :title="citation ? '编辑引用' : '新建引用'"
    description="引用把具体资料位置连接到人物、关系或事件。"
    close-label="关闭引用编辑器"
    @close="requestClose"
  >
    <form class="citation-editor" novalidate @submit.prevent="submit">
      <BaseField id="citation-source" label="来源" required>
        <BaseSelectControl><select id="citation-source" v-model="draft.sourceId" name="citationSource">
            <option value="">请选择来源</option>
            <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.title }}</option>
          </select></BaseSelectControl>
      </BaseField>
      <div class="citation-editor__grid">
        <BaseField id="citation-target-type" label="资料类型">
          <BaseSelectControl><select id="citation-target-type" v-model="draft.targetType" name="citationTargetType">
              <option value="person">人物</option>
              <option value="relationship">关系</option>
              <option value="event">事件</option>
              <option value="career">人物履历</option>
            </select></BaseSelectControl>
        </BaseField>
        <BaseField id="citation-target" label="支持的资料" required>
          <BaseSelectControl><select id="citation-target" v-model="draft.targetId" name="citationTargetId">
              <option value="">请选择资料</option>
              <option v-for="target in targets" :key="target.id" :value="target.id">{{ target.label }}</option>
            </select></BaseSelectControl>
        </BaseField>
      </div>
      <BaseField id="citation-locator" label="页码、章节或定位信息">
        <input id="citation-locator" v-model="draft.locator" name="citationLocator" />
      </BaseField>
      <BaseField id="citation-excerpt" label="原文摘录">
        <textarea id="citation-excerpt" v-model="draft.excerpt" name="citationExcerpt" rows="4" />
      </BaseField>
      <fieldset class="citation-editor__date">
        <legend>访问或记录日期</legend>
        <label><span>日期语义</span><BaseSelectControl><select v-model="draft.accessedPrecision" name="accessedPrecision">
            <option value="exact">精确</option><option value="about">约</option><option value="before">早于</option>
            <option value="after">晚于</option><option value="range">范围</option><option value="unknown">未知</option>
          </select></BaseSelectControl></label>
        <label><span>显示文字</span><input v-model="draft.accessedDisplay" name="accessedDisplay" /></label>
        <label><span>开始边界</span><input v-model="draft.accessedStart" name="accessedStart" /></label>
        <label><span>结束边界</span><input v-model="draft.accessedEnd" name="accessedEnd" /></label>
      </fieldset>
      <fieldset class="citation-editor__attachments">
        <legend>相关附件</legend>
        <p v-if="attachments.length === 0">暂无可关联附件。</p>
        <label v-for="attachment in attachments" :key="attachment.id">
          <input v-model="draft.attachmentIds" type="checkbox" :value="attachment.id" />
          <span>{{ attachment.name }}<small v-if="attachment.missing">（缺失）</small></span>
        </label>
      </fieldset>
      <BaseField id="citation-notes" label="备注">
        <textarea id="citation-notes" v-model="draft.notes" name="citationNotes" rows="4" />
      </BaseField>
      <p v-if="validationError" class="citation-editor__error" role="alert">{{ validationError }}</p>
      <div v-if="saveFailure" class="citation-editor__error" role="alert">
        <strong>保存失败，引用尚未写入。</strong>
        <details open><summary>错误详情</summary><p>{{ saveFailure }}</p></details>
      </div>
      <footer class="citation-editor__actions">
        <BaseButton v-if="citation" name="删除引用" variant="danger" :disabled="saving" @click="confirmDelete = true">删除引用</BaseButton>
        <span class="citation-editor__spacer" />
        <BaseButton name="取消引用编辑" variant="secondary" :disabled="saving" @click="requestClose">取消</BaseButton>
        <BaseButton name="保存引用" type="submit" :loading="saving">保存引用</BaseButton>
      </footer>
    </form>
  </BaseDrawer>
  <BaseDialog
    :open="confirmDelete"
    title="删除引用？"
    description="引用记录及其附件关联将被删除，来源和附件本身会保留。"
    close-label="保留引用"
    @close="confirmDelete = false"
  >
    <div class="citation-editor__actions">
      <BaseButton variant="secondary" @click="confirmDelete = false">保留引用</BaseButton>
      <BaseButton name="确认删除引用" variant="danger" :loading="saving" @click="removeCitation">确认删除</BaseButton>
    </div>
  </BaseDialog>
  <BaseDialog :open="confirmClose" title="放弃未保存的引用？" close-label="继续编辑" @close="confirmClose = false">
    <div class="citation-editor__actions">
      <BaseButton name="继续编辑引用" variant="secondary" @click="confirmClose = false">继续编辑</BaseButton>
      <BaseButton name="放弃引用修改" variant="danger" @click="discard">放弃修改</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.citation-editor { display: grid; gap: var(--space-5); }
.citation-editor__grid, .citation-editor__date { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.citation-editor__date, .citation-editor__attachments { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.citation-editor fieldset legend { padding: 0 var(--space-2); font-weight: 700; }
.citation-editor__date label, .citation-editor__attachments label { display: grid; gap: var(--space-2); color: var(--color-muted); font-size: .8125rem; }
.citation-editor__attachments { display: grid; gap: var(--space-2); }
.citation-editor__attachments label { grid-template-columns: auto 1fr; align-items: center; color: var(--color-text); }
.citation-editor input:not([type="checkbox"]), .citation-editor textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.citation-editor__error { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.citation-editor__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.citation-editor__spacer { flex: 1; }
@media (max-width: 30rem) { .citation-editor__grid, .citation-editor__date { grid-template-columns: 1fr; } }
</style>
