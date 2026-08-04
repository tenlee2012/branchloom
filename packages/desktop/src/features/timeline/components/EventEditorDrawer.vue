<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseDrawer from '../../../design-system/BaseDrawer.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { normalizeIsoDate } from '../../../shared/domain/date'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  FamilyEvent,
  GenealogyDate,
  Person,
  Place,
  Source,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  builtInEventTypes,
  expandIsoBoundary,
  findLifespanWarnings,
  formatEventDate,
} from '../model/groupEvents'

const CUSTOM_TYPE = '__custom__'

const props = withDefaults(defineProps<{
  open: boolean
  projectId: string
  event?: FamilyEvent | undefined
  people: Person[]
  places?: Place[]
  sources?: Source[]
  defaultParticipantIds?: string[]
}>(), {
  places: () => [],
  sources: () => [],
  defaultParticipantIds: () => [],
})

const emit = defineEmits<{ close: []; saved: [event: FamilyEvent]; deleted: [eventId: string] }>()
const repository = useBranchloomRepository()
const session = useSessionStore()

interface EventDraft {
  id: string
  typeChoice: string
  customType: string
  title: string
  precision: GenealogyDate['precision']
  dateDisplay: string
  dateStart: string
  dateEnd: string
  placeId: string
  participantIds: string[]
  participantRoles: Record<string, string>
  notes: string
  sourceIds: string[]
}

let fallbackId = 0

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `event-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `event-${Date.now()}-${fallbackId}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isBuiltInType(type: string): boolean {
  return builtInEventTypes.some(({ value }) => value === type)
}

function draftFromEvent(source: FamilyEvent | undefined): EventDraft {
  const type = source?.type ?? 'birth'
  return {
    id: source?.id ?? createId(),
    typeChoice: isBuiltInType(type) ? type : CUSTOM_TYPE,
    customType: isBuiltInType(type) ? '' : type,
    title: source?.title ?? '',
    precision: source?.date.precision ?? 'exact',
    dateDisplay: source?.date.display ?? '',
    dateStart: source?.date.start ?? '',
    dateEnd: source?.date.end ?? '',
    placeId: source?.placeId ?? '',
    participantIds: clone(source?.participantIds ?? props.defaultParticipantIds),
    participantRoles: clone(source?.participantRoles ?? {}),
    notes: source?.notes ?? '',
    sourceIds: clone(source?.sourceIds ?? []),
  }
}

const draft = reactive<EventDraft>(draftFromEvent(props.event))
const baseline = ref('')
const saving = ref(false)
const confirmDelete = ref(false)
const validationError = ref('')
const saveFailure = ref('')
const confirmClose = ref(false)
const confirmWarning = ref(false)

const dirty = computed(() => JSON.stringify(draft) !== baseline.value)
const title = computed(() => props.event ? '编辑事件' : '新建事件')

function replaceDraft(next: EventDraft) {
  Object.assign(draft, next)
  baseline.value = JSON.stringify(draft)
  validationError.value = ''
  saveFailure.value = ''
  confirmClose.value = false
  confirmWarning.value = false
}

function reset() {
  replaceDraft(draftFromEvent(props.event))
}

watch(
  () => [props.open, props.event?.id, props.projectId] as const,
  ([open]) => {
    if (open) reset()
    else {
      confirmClose.value = false
      confirmWarning.value = false
    }
  },
  { immediate: true },
)

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed || undefined
}

function buildDate(): GenealogyDate {
  if (draft.precision === 'unknown') {
    const date: GenealogyDate = { display: draft.dateDisplay, precision: 'unknown' }
    return { ...date, display: formatEventDate(date) }
  }
  const start = optionalTrimmed(draft.dateStart)
  const end = optionalTrimmed(draft.dateEnd)
  const date: GenealogyDate = {
    display: draft.dateDisplay,
    ...(draft.precision !== 'before' && start ? { start } : {}),
    ...(draft.precision !== 'after' && end ? { end } : {}),
    precision: draft.precision,
  }
  return { ...date, display: formatEventDate(date) }
}

function buildCandidate(): FamilyEvent {
  const placeId = optionalTrimmed(draft.placeId)
  const participantIds = [...new Set(draft.participantIds)]
  const participantRoles = Object.fromEntries(participantIds
    .map((personId) => [personId, draft.participantRoles[personId]?.trim()])
    .filter((entry): entry is [string, string] => Boolean(entry[1])))
  return {
    id: draft.id,
    projectId: props.projectId,
    type: (draft.typeChoice === CUSTOM_TYPE ? draft.customType : draft.typeChoice).trim(),
    title: draft.title.trim(),
    date: buildDate(),
    ...(placeId ? { placeId } : {}),
    participantIds,
    ...(Object.keys(participantRoles).length ? { participantRoles } : {}),
    sourceIds: clone(draft.sourceIds),
    notes: draft.notes.trim(),
  }
}

const previewCandidate = computed(buildCandidate)
const lifespanWarnings = computed(() => findLifespanWarnings(previewCandidate.value, props.people))

function validate(candidate: FamilyEvent): string | undefined {
  if (!candidate.type) return '请选择事件类型，或填写自定义事件类型。'
  if (!candidate.title) return '请填写事件标题或摘要。'
  for (const boundary of [candidate.date.start, candidate.date.end]) {
    if (boundary && !normalizeIsoDate(boundary)) {
      return '日期边界必须是有效的 ISO 日期，例如 YYYY、YYYY-MM 或 YYYY-MM-DD。'
    }
  }
  if (candidate.date.precision !== 'unknown' && !candidate.date.start && !candidate.date.end) {
    return '请填写事件日期边界，或将日期设为未知。'
  }
  if (candidate.date.precision === 'exact'
    && candidate.date.start
    && candidate.date.end
    && candidate.date.start !== candidate.date.end) {
    return '精确日期的开始和结束边界必须一致。'
  }
  if (candidate.date.precision === 'before' && !candidate.date.end) {
    return '早于某日需要填写结束边界。'
  }
  if (candidate.date.precision === 'after' && !candidate.date.start) {
    return '晚于某日需要填写开始边界。'
  }
  if (candidate.date.precision === 'range' && (!candidate.date.start || !candidate.date.end)) {
    return '日期范围需要开始和结束日期。'
  }
  if (candidate.date.precision === 'range' && candidate.date.start && candidate.date.end) {
    const start = expandIsoBoundary(candidate.date.start)
    const end = expandIsoBoundary(candidate.date.end)
    if (start && end && start.lower > end.upper) {
      return '日期范围的开始边界晚于结束边界，请核对。'
    }
  }
  return undefined
}

async function persist(candidate: FamilyEvent) {
  if (saving.value) return
  saving.value = true
  saveFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const saved = await repository.saveEvent(candidate)
    replaceDraft(draftFromEvent(saved))
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('saved', saved)
    emit('close')
  } catch (error) {
    const details = error instanceof Error ? error.message : '本地事件暂时无法写入'
    saveFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    saving.value = false
  }
}

async function submit(confirmed = false) {
  if (saving.value) return
  const candidate = buildCandidate()
  const error = validate(candidate)
  if (error) {
    validationError.value = error
    return
  }
  validationError.value = ''
  if (!confirmed && findLifespanWarnings(candidate, props.people).length) {
    confirmWarning.value = true
    return
  }
  confirmWarning.value = false
  await persist(candidate)
}

function requestClose() {
  if (saving.value) return
  if (dirty.value) confirmClose.value = true
  else emit('close')
}

function discardAndClose() {
  reset()
  emit('close')
}

async function removeEvent() {
  const event = props.event
  if (!event || saving.value) return
  saving.value = true
  saveFailure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.deleteEvent(event.id)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    confirmDelete.value = false
    emit('deleted', event.id)
    emit('close')
  } catch (error) {
    const details = error instanceof Error ? error.message : '本地事件暂时无法删除'
    saveFailure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
    confirmDelete.value = false
  } finally {
    saving.value = false
  }
}

function personName(person: Person): string {
  return getPrimaryName(person)
}
</script>

<template>
  <BaseDrawer
    :open="open"
    :title="title"
    description="事件日期保留精确、不确定、范围与未知等原始语义。"
    close-label="关闭事件编辑器"
    @close="requestClose"
  >
    <form class="event-editor" novalidate @submit.prevent="submit(false)">
      <BaseField id="event-type" label="事件类型">
        <BaseSelectControl><select id="event-type" v-model="draft.typeChoice" name="eventType">
            <option v-for="option in builtInEventTypes" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
            <option :value="CUSTOM_TYPE">自定义事件类型</option>
          </select></BaseSelectControl>
      </BaseField>

      <BaseField v-if="draft.typeChoice === CUSTOM_TYPE" id="event-custom-type" label="自定义事件类型">
        <input id="event-custom-type" v-model="draft.customType" name="customEventType" />
      </BaseField>

      <BaseField id="event-title" label="标题或摘要">
        <input id="event-title" v-model="draft.title" name="eventTitle" />
      </BaseField>

      <div class="event-editor__date-grid">
        <BaseField id="event-date-precision" label="日期表达">
          <BaseSelectControl><select id="event-date-precision" v-model="draft.precision" name="datePrecision">
              <option value="exact">精确日期</option>
              <option value="about">大约</option>
              <option value="before">早于</option>
              <option value="after">晚于</option>
              <option value="range">日期范围</option>
              <option value="unknown">未知日期</option>
            </select></BaseSelectControl>
        </BaseField>
        <BaseField id="event-date-display" label="显示文字" hint="例如：约 1995 年">
          <input id="event-date-display" v-model="draft.dateDisplay" name="dateDisplay" />
        </BaseField>
        <BaseField v-if="draft.precision !== 'unknown' && draft.precision !== 'before'" id="event-date-start" label="开始边界">
          <input id="event-date-start" v-model="draft.dateStart" name="dateStart" placeholder="YYYY-MM-DD" />
        </BaseField>
        <BaseField v-if="draft.precision !== 'unknown' && draft.precision !== 'after'" id="event-date-end" label="结束边界">
          <input id="event-date-end" v-model="draft.dateEnd" name="dateEnd" placeholder="YYYY-MM-DD" />
        </BaseField>
      </div>

      <BaseField v-if="places.length" id="event-place" label="地点">
        <BaseSelectControl><select id="event-place" v-model="draft.placeId" name="placeId">
            <option value="">未关联地点</option>
            <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
          </select></BaseSelectControl>
      </BaseField>

      <fieldset class="event-editor__participants">
        <legend>参与人物</legend>
        <label v-for="person in people" :key="person.id">
          <input v-model="draft.participantIds" type="checkbox" :value="person.id" />
          <span>{{ personName(person) }}</span>
          <input
            v-if="draft.participantIds.includes(person.id)"
            v-model="draft.participantRoles[person.id]"
            class="event-editor__participant-role"
            type="text"
            :aria-label="`${personName(person)}的事件角色`"
            placeholder="角色（可选）"
          />
        </label>
      </fieldset>

      <fieldset class="event-editor__sources">
        <legend>资料来源</legend>
        <label v-for="source in sources" :key="source.id">
          <input v-model="draft.sourceIds" type="checkbox" :value="source.id" />
          <span>{{ source.title }}</span>
        </label>
        <p v-if="sources.length === 0">当前项目还没有可选的资料来源。</p>
      </fieldset>

      <BaseField id="event-notes" label="备注">
        <textarea id="event-notes" v-model="draft.notes" name="eventNotes" rows="4" />
      </BaseField>

      <div v-if="lifespanWarnings.length" class="event-editor__warning" role="status" data-lifespan-warning>
        <strong>时间可能需要核对</strong>
        <ul>
          <li v-for="warning in lifespanWarnings" :key="warning">{{ warning }}</li>
        </ul>
      </div>
      <p v-if="validationError" class="event-editor__error" role="alert">{{ validationError }}</p>
      <div v-if="saveFailure" class="event-editor__error" role="alert">
        <strong>保存失败，事件尚未写入。</strong>
        <details open>
          <summary>错误详情</summary>
          <p>{{ saveFailure }}</p>
        </details>
      </div>

      <footer class="event-editor__actions">
        <BaseButton v-if="event" name="删除事件" variant="danger" :disabled="saving" @click="confirmDelete = true">删除事件</BaseButton>
        <span class="event-editor__spacer" />
        <BaseButton name="取消" variant="secondary" :disabled="saving" @click="requestClose">取消</BaseButton>
        <BaseButton name="保存事件" type="submit" :loading="saving">保存事件</BaseButton>
      </footer>
    </form>
  </BaseDrawer>

  <BaseDialog
    :open="confirmDelete"
    title="删除事件？"
    :description="event ? `将删除“${event.title}”以及只属于该事件的引用关联。` : ''"
    close-label="保留事件"
    @close="confirmDelete = false"
  >
    <div class="event-editor__actions">
      <BaseButton variant="secondary" @click="confirmDelete = false">保留事件</BaseButton>
      <BaseButton name="确认删除事件" variant="danger" :loading="saving" @click="removeEvent">确认删除</BaseButton>
    </div>
  </BaseDialog>

  <BaseDialog
    :open="confirmWarning"
    title="确认保留可疑时间？"
    description="时间或史料方面的疑点不会阻止保存，但需要你明确确认。"
    close-label="返回核对事件"
    @close="confirmWarning = false"
  >
    <ul class="event-editor__confirm-list">
      <li v-for="warning in lifespanWarnings" :key="warning">{{ warning }}</li>
    </ul>
    <div class="event-editor__actions">
      <BaseButton variant="secondary" name="返回核对" @click="confirmWarning = false">返回核对</BaseButton>
      <BaseButton name="确认并保存事件" @click="submit(true)">确认并保存</BaseButton>
    </div>
  </BaseDialog>

  <BaseDialog
    :open="confirmClose"
    title="放弃未保存的事件修改？"
    description="关闭后，这次填写的事件资料不会保留。"
    close-label="继续编辑事件"
    @close="confirmClose = false"
  >
    <div class="event-editor__actions">
      <BaseButton variant="secondary" name="继续编辑事件" @click="confirmClose = false">继续编辑</BaseButton>
      <BaseButton variant="danger" name="放弃事件修改" @click="discardAndClose">放弃修改</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.event-editor { display: grid; gap: var(--space-5); }
.event-editor__date-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }

.event-editor input,
.event-editor textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 2.5rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
}

.event-editor__participants,
.event-editor__sources {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.event-editor__participants legend,
.event-editor__sources legend {
  width: max-content;
  max-width: 100%;
  padding: 0 var(--space-2);
  font-weight: 700;
  white-space: nowrap;
}
.event-editor__participants label,
.event-editor__sources label { display: flex; align-items: center; gap: var(--space-2); }
.event-editor__participants input,
.event-editor__sources input { width: 1rem; min-height: 1rem; accent-color: var(--color-primary); }
.event-editor__participants .event-editor__participant-role { width: min(12rem, 100%); min-height: 2rem; margin-left: auto; }
.event-editor__sources p { grid-column: 1 / -1; margin: 0; color: var(--color-muted); }

.event-editor__warning,
.event-editor__error { padding: var(--space-3); border-radius: var(--radius-sm); }
.event-editor__warning { background: var(--color-warning-surface); color: var(--color-warning); }
.event-editor__error { background: var(--color-danger-surface); color: var(--color-danger); }
.event-editor__warning ul,
.event-editor__confirm-list { margin-bottom: 0; padding-left: var(--space-5); }
.event-editor__error p { margin-bottom: 0; }
.event-editor__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.event-editor__spacer { flex: 1; }

@media (max-width: 28rem) {
  .event-editor__date-grid,
  .event-editor__participants,
  .event-editor__sources { grid-template-columns: 1fr; }
}
</style>
