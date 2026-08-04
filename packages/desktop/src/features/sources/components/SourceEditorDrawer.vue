<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseDrawer from '../../../design-system/BaseDrawer.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { isDefinitelyReversedDateRange, normalizeIsoDate } from '../../../shared/domain/date'
import type { GenealogyDate, Source } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'

const props = defineProps<{ open: boolean; projectId: string; source?: Source | undefined }>()
const emit = defineEmits<{ close: []; saved: [source: Source] }>()
const repository = useBranchloomRepository()
const session = useSessionStore()

interface SourceDraft {
  id: string
  title: string
  type: Source['type']
  author: string
  repository: string
  url: string
  datePrecision: GenealogyDate['precision']
  dateDisplay: string
  dateStart: string
  dateEnd: string
  referenceCode: string
  notes: string
}

let fallbackId = 0
function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `source-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `source-${Date.now()}-${fallbackId}`
}

function sourceDraft(source?: Source): SourceDraft {
  return {
    id: source?.id ?? createId(),
    title: source?.title ?? '',
    type: source?.type ?? 'book',
    author: source?.author ?? '',
    repository: source?.repository ?? '',
    url: source?.url ?? '',
    datePrecision: source?.date?.precision ?? 'exact',
    dateDisplay: source?.date?.display ?? '',
    dateStart: source?.date?.start ?? '',
    dateEnd: source?.date?.end ?? '',
    referenceCode: source?.referenceCode ?? '',
    notes: source?.notes ?? '',
  }
}

const draft = reactive<SourceDraft>(sourceDraft(props.source))
const baseline = ref('')
const saving = ref(false)
const validationError = ref('')
const saveFailure = ref('')
const confirmClose = ref(false)
const dirty = computed(() => JSON.stringify(draft) !== baseline.value)

function reset() {
  Object.assign(draft, sourceDraft(props.source))
  baseline.value = JSON.stringify(draft)
  validationError.value = ''
  saveFailure.value = ''
  confirmClose.value = false
}

watch(
  () => [props.open, props.projectId, props.source?.id] as const,
  ([open]) => { if (open) reset() },
  { immediate: true },
)

function optional(value: string) {
  const trimmed = value.trim()
  return trimmed || undefined
}

function buildDate(): GenealogyDate | undefined {
  const display = draft.dateDisplay.trim()
  const start = optional(draft.dateStart)
  const end = optional(draft.dateEnd)
  if (!display && !start && !end && draft.datePrecision === 'exact') return undefined
  return {
    display,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    precision: draft.datePrecision,
  }
}

function candidate(): Source {
  const author = optional(draft.author)
  const sourceRepository = optional(draft.repository)
  const url = optional(draft.url)
  const date = buildDate()
  const referenceCode = optional(draft.referenceCode)
  return {
    id: draft.id,
    projectId: props.projectId,
    title: draft.title.trim(),
    type: draft.type,
    ...(author ? { author } : {}),
    ...(sourceRepository ? { repository: sourceRepository } : {}),
    ...(url ? { url } : {}),
    ...(date ? { date } : {}),
    ...(referenceCode ? { referenceCode } : {}),
    notes: draft.notes.trim(),
  }
}

function validate(source: Source): string | undefined {
  if (!source.title) return '请填写来源标题。'
  if (source.url) {
    try {
      const url = new URL(source.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    } catch {
      return '网址必须是有效的 http:// 或 https:// 地址。'
    }
  }
  for (const boundary of [source.date?.start, source.date?.end]) {
    if (boundary && !normalizeIsoDate(boundary)) {
      return '日期边界必须是有效的 ISO 日期，例如 YYYY、YYYY-MM 或 YYYY-MM-DD。'
    }
  }
  if (source.date?.precision === 'before' && !source.date.end) return '早于日期需要填写结束边界。'
  if (source.date?.precision === 'after' && !source.date.start) return '晚于日期需要填写开始边界。'
  if (source.date?.precision === 'range' && (!source.date.start || !source.date.end)) {
    return '日期范围需要填写开始和结束边界。'
  }
  if (source.date?.precision === 'range'
    && source.date.start
    && source.date.end
    && isDefinitelyReversedDateRange(source.date.start, source.date.end)) {
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
    const saved = await repository.saveSource(value)
    Object.assign(draft, sourceDraft(saved))
    baseline.value = JSON.stringify(draft)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('saved', saved)
    emit('close')
  } catch (error) {
    const details = error instanceof Error && error.message.trim()
      ? error.message
      : '本地来源暂时无法写入'
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
</script>

<template>
  <BaseDrawer
    :open="open"
    :title="source ? '编辑资料来源' : '新建资料来源'"
    description="记录来源本身；定位信息和原文摘录在引用中填写。"
    close-label="关闭来源编辑器"
    @close="requestClose"
  >
    <form class="source-editor" novalidate @submit.prevent="submit">
      <BaseField id="source-title" label="标题" required>
        <input id="source-title" v-model="draft.title" name="sourceTitle" autocomplete="off" />
      </BaseField>
      <div class="source-editor__grid">
        <BaseField id="source-type" label="类型">
          <BaseSelectControl>
            <select id="source-type" v-model="draft.type" name="sourceType">
              <option value="book">书籍</option>
              <option value="web">网页</option>
              <option value="archive">档案</option>
              <option value="interview">访谈</option>
              <option value="other">其他</option>
            </select>
          </BaseSelectControl>
        </BaseField>
        <BaseField id="source-author" label="作者或责任者">
          <input id="source-author" v-model="draft.author" name="sourceAuthor" />
        </BaseField>
        <BaseField id="source-repository" label="出版或保存机构">
          <input id="source-repository" v-model="draft.repository" name="sourceRepository" />
        </BaseField>
        <BaseField id="source-reference" label="档案编号">
          <input id="source-reference" v-model="draft.referenceCode" name="sourceReferenceCode" />
        </BaseField>
      </div>
      <BaseField id="source-url" label="网址" hint="仅支持 http:// 或 https:// 地址。">
        <input id="source-url" v-model="draft.url" name="sourceUrl" inputmode="url" />
      </BaseField>
      <fieldset class="source-editor__date">
        <legend>来源时间</legend>
        <label><span>日期语义</span><BaseSelectControl><select v-model="draft.datePrecision" name="datePrecision">
            <option value="exact">精确</option><option value="about">约</option>
            <option value="before">早于</option><option value="after">晚于</option>
            <option value="range">范围</option><option value="unknown">未知</option>
          </select></BaseSelectControl></label>
        <label><span>显示文字</span><input v-model="draft.dateDisplay" name="dateDisplay" /></label>
        <label><span>开始边界</span><input v-model="draft.dateStart" name="dateStart" placeholder="YYYY-MM-DD" /></label>
        <label><span>结束边界</span><input v-model="draft.dateEnd" name="dateEnd" placeholder="YYYY-MM-DD" /></label>
      </fieldset>
      <BaseField id="source-notes" label="备注">
        <textarea id="source-notes" v-model="draft.notes" name="sourceNotes" rows="4" />
      </BaseField>
      <p v-if="validationError" class="source-editor__error" role="alert">{{ validationError }}</p>
      <div v-if="saveFailure" class="source-editor__error" role="alert">
        <strong>保存失败，来源尚未写入。</strong>
        <details open><summary>错误详情</summary><p>{{ saveFailure }}</p></details>
      </div>
      <footer class="source-editor__actions">
        <BaseButton name="取消" variant="secondary" :disabled="saving" @click="requestClose">取消</BaseButton>
        <BaseButton name="保存来源" type="submit" :loading="saving">保存来源</BaseButton>
      </footer>
    </form>
  </BaseDrawer>
  <BaseDialog
    :open="confirmClose"
    title="放弃未保存的修改？"
    description="关闭后，这次填写的来源资料不会保留。"
    close-label="继续编辑"
    @close="confirmClose = false"
  >
    <div class="source-editor__actions">
      <BaseButton name="继续编辑" variant="secondary" @click="confirmClose = false">继续编辑</BaseButton>
      <BaseButton name="放弃修改" variant="danger" @click="discard">放弃修改</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.source-editor { display: grid; gap: var(--space-5); }
.source-editor__grid, .source-editor__date { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
.source-editor__date { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.source-editor__date legend { width: max-content; max-width: 100%; padding: 0 var(--space-2); font-weight: 700; white-space: nowrap; }
.source-editor__date label { display: grid; gap: var(--space-2); color: var(--color-muted); font-size: .8125rem; }
.source-editor input, .source-editor textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.source-editor__error { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.source-editor__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
@media (max-width: 30rem) { .source-editor__grid, .source-editor__date { grid-template-columns: 1fr; } }
</style>
