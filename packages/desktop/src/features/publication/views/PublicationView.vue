<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router'
import { IconBook, IconPrinter, IconRefresh, IconX } from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import ProjectManagementTabs from '../../../app/components/ProjectManagementTabs.vue'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import { NATIVE_STATE_REFRESHED_EVENT } from '../../../shared/repository/TauriRepository'
import { chapterLabels, fieldLabels, newPublicationPlan, type PublicationPlan, type PublicationFormat, type PublicationChapter, type PublicationContext, type PublicationStatus, type PublicationReport } from '../../../shared/domain/publication'
import { useNotificationsStore } from '../../../app/stores/notifications'
import PersonPicker from '../components/PersonPicker.vue'
import PdfPreview from '../components/PdfPreview.vue'
import fontLicense from '../../../../../core/assets/fonts/OFL.txt?raw'

const route = useRoute()
const repository = useBranchloomRepository()
const notifications = useNotificationsStore()
const projectId = computed(() => String(route.params.projectId))
const context = shallowRef<PublicationContext>()
const plan = ref<PublicationPlan>()
const original = ref('')
const planRevision = ref(0)
const generated = ref('')
const loading = ref(false)
const saving = ref(false)
const starting = ref(false)
const cancelling = ref(false)
const jobId = ref('')
const status = ref<PublicationStatus>()
const report = shallowRef<PublicationReport>()
const failure = ref('')
const pane = ref<'settings' | 'preview'>('settings')
const imageId = ref('')
const appendixId = ref('')
const appendixBusy = ref(false)
const pdfCounts = ref<Record<string, number>>({})
const reportPage = ref(1)
const reportQuery = ref('')
const personNames = computed(() => new Map(context.value?.people.map((person) => [person.id, person.names.find((name) => name.primary)?.value ?? person.names[0]?.value ?? person.id]) ?? []))
const savedPlans = computed(() => context.value?.project.publicationPlans ?? [])
const dirty = computed(() => Boolean(plan.value && JSON.stringify(plan.value) !== original.value))
const running = computed(() => starting.value || status.value?.state === 'running')
const stale = computed(() => Boolean(jobId.value && (status.value?.stale || JSON.stringify(plan.value) !== generated.value)))
const ready = computed(() => status.value?.state === 'ready' && !stale.value)
const imageAttachments = computed(() => context.value?.attachments.filter((a) => a.mimeType.startsWith('image/')) ?? [])
const pdfAttachments = computed(() => context.value?.attachments.filter((a) => a.mimeType === 'application/pdf' || a.name.toLowerCase().endsWith('.pdf')) ?? [])
const chapters = computed(() => [...(plan.value?.chapters ?? []), ...(Object.keys(chapterLabels) as PublicationChapter[]).filter((key) => !plan.value?.chapters.includes(key))])
const matches = computed(() => report.value?.entries.filter((entry) => !reportQuery.value || entry.name.includes(reportQuery.value) || String(entry.number) === reportQuery.value) ?? [])
const visibleEntries = computed(() => matches.value.slice((reportPage.value - 1) * 25, reportPage.value * 25))
watch(reportQuery, () => { reportPage.value = 1 })
let loadVersion = 0
let disposed = false
let pollTimer: ReturnType<typeof setTimeout> | undefined
const confirmation = ref<{ title: string; description: string; danger: boolean }>()
let settleConfirmation: ((value: boolean) => void) | undefined
function ask(title: string, description: string, danger = false): Promise<boolean> {
  settleConfirmation?.(false)
  confirmation.value = { title, description, danger }
  return new Promise((resolve) => { settleConfirmation = resolve })
}
function settle(value: boolean) { confirmation.value = undefined; settleConfirmation?.(value); settleConfirmation = undefined }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
async function canLeave() { return !dirty.value || await ask('保留未保存的方案？', '当前方案有未保存的修改。选择“放弃修改”后离开；已保存的方案和族谱资料不受影响。') }
onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(async (to, from) => to.params.projectId === from.params.projectId || await canLeave())
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
window.addEventListener('beforeunload', beforeUnload)

async function release() {
  if (pollTimer) clearTimeout(pollTimer)
  const old = jobId.value
  const scope = statusScope
  jobId.value = ''
  status.value = undefined
  report.value = undefined
  if (old) await repository.publication({ operation: 'release', projectId: scope, jobId: old }).catch(() => {})
}
let statusScope = projectId.value
async function load(reset = false) {
  const version = ++loadVersion
  const scope = projectId.value
  if (reset) { loading.value = true; failure.value = ''; await release(); plan.value = undefined; context.value = undefined }
  try {
    const result = await repository.publication<PublicationContext>({ operation: 'context', projectId: scope })
    if (disposed || version !== loadVersion) return
    context.value = result
    if (reset || !plan.value) {
      plan.value = structuredClone(result.project.publicationPlans?.[0] ?? newPublicationPlan(result.project.name))
      original.value = JSON.stringify(plan.value)
      planRevision.value = result.revision
    } else if (!dirty.value && !saving.value) {
      const current = result.project.publicationPlans?.find((item) => item.id === plan.value?.id)
      if (current) {
        plan.value = structuredClone(current)
        original.value = JSON.stringify(current)
        planRevision.value = result.revision
      }
    }
    if (status.value && status.value.revision !== result.revision) status.value = { ...status.value, stale: true }
  } catch (error) { if (version === loadVersion && !disposed) failure.value = errorText(error) }
  finally { if (version === loadVersion) loading.value = false }
}
watch(projectId, () => { void load(true) }, { immediate: true })
function refreshed() { void load() }
window.addEventListener(NATIVE_STATE_REFRESHED_EVENT, refreshed)
onBeforeUnmount(() => { disposed = true; loadVersion++; settle(false); void release(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener(NATIVE_STATE_REFRESHED_EVENT, refreshed) })

async function choosePlan(id: string) {
  if (dirty.value && !await ask('切换编印方案？', '当前修改尚未保存。选择“放弃修改”后切换方案。')) return
  const chosen = savedPlans.value.find((item) => item.id === id)
  if (!chosen) return
  await release()
  plan.value = structuredClone(chosen)
  original.value = JSON.stringify(plan.value)
  planRevision.value = context.value?.revision ?? 0
}
async function createPlan(copy = false) {
  if (!copy && dirty.value && !await ask('新建编印方案？', '当前修改尚未保存。选择“放弃修改”后新建方案。')) return
  const next = copy && plan.value ? { ...structuredClone(JSON.parse(JSON.stringify(plan.value)) as PublicationPlan), id: crypto.randomUUID(), name: `${plan.value.name}（副本）` } : newPublicationPlan(context.value?.project.name ?? '族谱')
  await release()
  plan.value = next
  original.value = ''
  planRevision.value = context.value?.revision ?? 0
}
async function savePlan() {
  if (!plan.value || !context.value || saving.value) return
  saving.value = true; failure.value = ''
  const snapshot = JSON.parse(JSON.stringify(plan.value)) as PublicationPlan
  const scope = projectId.value
  try {
    const result = await repository.publication<{ revision: number; plans: PublicationPlan[] }>({ operation: 'savePlan', projectId: scope, expectedRevision: planRevision.value, plan: snapshot })
    if (disposed || scope !== projectId.value) return
    context.value = { ...context.value, revision: result.revision, project: { ...context.value.project, publicationPlans: result.plans } }
    original.value = JSON.stringify(snapshot)
    planRevision.value = result.revision
    if (status.value) status.value = { ...status.value, stale: true }
    notifications.push('编印方案已保存', 'success')
  } catch (error) { failure.value = errorText(error) }
  finally { saving.value = false }
}
async function deletePlan() {
  if (!plan.value || !context.value || !await ask('删除这套编印方案？', `仅删除“${plan.value.name}”的设置；人物、附件和已经导出的 PDF 均保留。此操作无法撤销。`, true)) return
  saving.value = true; failure.value = ''
  try {
    await repository.publication({ operation: 'deletePlan', projectId: projectId.value, planId: plan.value.id, expectedRevision: planRevision.value })
    await load(true)
    notifications.push('编印方案已删除', 'success')
  } catch (error) { failure.value = errorText(error) }
  finally { saving.value = false }
}
function changeFormat(format: PublicationFormat) {
  if (!plan.value) return
  plan.value.format = format
  plan.value.paper.fontSize = format === 'traditional' ? 14 : 12
}
function toggleChapter(chapter: PublicationChapter, enabled: boolean) {
  if (!plan.value) return
  plan.value.chapters = enabled ? [...plan.value.chapters, chapter] : plan.value.chapters.filter((key) => key !== chapter)
}
function moveChapter(chapter: PublicationChapter, direction: number) {
  if (!plan.value) return
  const index = plan.value.chapters.indexOf(chapter)
  const target = index + direction
  if (index < 0 || target < 0 || target >= plan.value.chapters.length) return
  plan.value.chapters.splice(index, 1)
  plan.value.chapters.splice(target, 0, chapter)
}
function paperPreset(value: string) {
  if (!plan.value) return
  const sizes: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], B5: [176, 250] }
  const size = sizes[value]
  if (size) [plan.value.paper.widthMm, plan.value.paper.heightMm] = size
}
function addImage() {
  if (!plan.value || !imageId.value) return
  plan.value.images.push({ attachmentId: imageId.value, personId: null, caption: context.value?.attachments.find((item) => item.id === imageId.value)?.name ?? '' })
  imageId.value = ''
}
async function addAppendix() {
  if (!plan.value || !appendixId.value || appendixBusy.value) return
  appendixBusy.value = true; failure.value = ''
  const id = appendixId.value
  const scope = projectId.value
  const selectedPlan = plan.value.id
  try {
    const result = await repository.publication<{ pages: number }>({ operation: 'pdfInfo', projectId: scope, attachmentId: id })
    if (disposed || scope !== projectId.value || selectedPlan !== plan.value?.id) return
    pdfCounts.value[id] = result.pages
    plan.value.appendices.push({ attachmentId: id, pages: result.pages === 1 ? '1' : `1-${result.pages}` })
    appendixId.value = ''
  } catch (error) { failure.value = errorText(error) }
  finally { appendixBusy.value = false }
}
async function poll() {
  const id = jobId.value
  const scope = statusScope
  if (!id || disposed) return
  try {
    const next = await repository.publication<PublicationStatus>({ operation: 'status', projectId: scope, jobId: id })
    if (id !== jobId.value || disposed) return
    status.value = next
    if (next.state === 'ready' && !next.stale && !report.value) {
      const nextReport = await repository.publication<PublicationReport>({ operation: 'report', projectId: scope, jobId: id })
      if (id !== jobId.value || disposed) return
      report.value = nextReport
    }
    if (next.state === 'failed') failure.value = next.error ?? '生成失败，请调整方案后重试'
    if (next.state === 'running') pollTimer = setTimeout(() => { void poll() }, 700)
    else cancelling.value = false
  } catch (error) {
    if (id === jobId.value && !disposed) {
      failure.value = errorText(error); starting.value = false; cancelling.value = false
      // A transient status/read failure must not strand the UI in a running state.
      await release()
    }
  }
}
async function generate() {
  if (!plan.value || !context.value || running.value) return
  starting.value = true; failure.value = ''; cancelling.value = false
  const scope = projectId.value
  try {
    await release()
    const snapshot = JSON.parse(JSON.stringify(plan.value)) as PublicationPlan
    const result = await repository.publication<{ jobId: string; revision: number }>({ operation: 'start', projectId: scope, plan: snapshot, expectedRevision: context.value.revision })
    if (disposed || scope !== projectId.value) { await repository.publication({ operation: 'release', projectId: scope, jobId: result.jobId }); return }
    statusScope = scope
    jobId.value = result.jobId
    generated.value = JSON.stringify(snapshot)
    pane.value = 'preview'
    await poll()
  } catch (error) { failure.value = errorText(error) }
  finally { starting.value = false }
}
async function cancel() {
  cancelling.value = true
  try { await repository.publication({ operation: 'cancel', projectId: statusScope, jobId: jobId.value }); await poll() }
  catch (error) { failure.value = errorText(error); cancelling.value = false }
}
async function savePdf() {
  if (!ready.value || !plan.value || saving.value) return
  saving.value = true; failure.value = ''
  try { if (await repository.savePublicationPdf(projectId.value, jobId.value, plan.value.title)) notifications.push('族谱 PDF 已导出', 'success') }
  catch (error) { failure.value = errorText(error) }
  finally { saving.value = false }
}
function attachmentName(id: string) { return context.value?.attachments.find((a) => a.id === id)?.name ?? '附件已不存在' }
</script>

<template>
  <main class="publication">
    <ProjectManagementTabs />
    <header class="publication__heading">
      <div><p class="publication__eyebrow">从家族资料到纸上族谱</p><h1>编印族谱</h1><p>保存编印方案，校对成品，再将 PDF 交付打印。</p></div>
      <div class="publication__actions">
        <BaseButton variant="secondary" :disabled="!plan || running || !context?.people.length" :loading="starting" @click="generate"><IconRefresh :size="17" aria-hidden="true" />{{ jobId ? '重新生成' : '生成 PDF' }}</BaseButton>
        <BaseButton :disabled="!ready" :loading="saving" @click="savePdf"><IconPrinter :size="17" aria-hidden="true" />保存 PDF</BaseButton>
      </div>
    </header>
    <p v-if="failure" class="publication__error" role="alert">{{ failure }} <BaseButton v-if="!context" variant="ghost" size="sm" @click="load(true)">重新加载</BaseButton></p>
    <p v-if="loading" role="status">正在读取项目与编印方案…</p>
    <p v-else-if="context && !context.people.length" class="publication__notice">项目中还没有人物。添加人物后即可编印族谱。</p>
    <template v-if="plan && context">
      <div class="publication__planbar">
        <label>编印方案<BaseSelectControl><select :disabled="running || saving" :value="savedPlans.some((p) => p.id === plan!.id) ? plan.id : ''" aria-label="切换编印方案" @change="choosePlan(($event.target as HTMLSelectElement).value)"><option value="" disabled>未保存的新方案</option><option v-for="item in savedPlans" :key="item.id" :value="item.id">{{ item.name }}</option></select></BaseSelectControl></label>
        <BaseButton variant="ghost" size="sm" :disabled="running || saving" @click="createPlan()">新建</BaseButton><BaseButton variant="ghost" size="sm" :disabled="running || saving" @click="createPlan(true)">复制</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="saving" @click="savePlan">保存方案{{ dirty ? ' · 未保存' : '' }}</BaseButton>
        <BaseButton variant="ghost" size="sm" :disabled="saving || !savedPlans.some((p) => p.id === plan!.id)" @click="deletePlan">删除方案</BaseButton>
        <BaseButton v-if="planRevision !== context.revision && dirty" variant="ghost" size="sm" @click="choosePlan(plan.id)">重新载入已保存方案</BaseButton>
      </div>
      <div class="publication__switch" aria-label="编印工作区"><button type="button" :aria-pressed="pane === 'settings'" @click="pane = 'settings'">编印设置</button><button type="button" :aria-pressed="pane === 'preview'" @click="pane = 'preview'">校对与预览</button></div>
      <div class="publication__workspace" :data-pane="pane">
        <aside class="publication__settings" aria-label="编印设置">
          <fieldset class="publication__formats"><legend>成品样式</legend><label v-for="(label, value) in { modern: '现代横排谱册', traditional: '传统中文谱册', chart: '世系挂图' }" :key="value" :class="{ selected: plan.format === value }"><input :checked="plan.format === value" type="radio" name="publication-format" :value="value" @change="changeFormat(value as PublicationFormat)" /><span>{{ label }}</span></label></fieldset>
          <p class="publication__hint">{{ plan.format === 'traditional' ? '宋体竖排，右侧装订；世系图与人物传记分节互查。' : plan.format === 'chart' ? '大幅单页或普通纸张分幅，保留可读字号与拼接位置。' : '现代横排、左侧装订，适合日常打印和装订。' }}</p>
          <label class="publication__field">方案名称<input v-model="plan.name" maxlength="128" /></label>
          <details open><summary>封面与谱序</summary><div class="publication__section">
            <label class="publication__field">族谱标题<input v-model="plan.title" /></label>
            <label class="publication__field">副标题<input v-model="plan.subtitle" /></label>
            <div class="publication__pair"><label>编修者<input v-model="plan.editor" /></label><label>版次<input v-model="plan.edition" /></label></div>
            <label class="publication__field">编修日期<input v-model="plan.date" placeholder="例如：2026 年秋" /></label>
            <label v-if="plan.format !== 'chart'" class="publication__field">封面图片<BaseSelectControl><select v-model="plan.coverAttachmentId"><option :value="null">不使用图片</option><option v-for="a in imageAttachments" :key="a.id" :value="a.id">{{ a.name }}{{ a.missing ? '（缺失）' : '' }}</option></select></BaseSelectControl></label>
            <label v-if="plan.format !== 'chart'" class="publication__field">谱序<textarea v-model="plan.preface" rows="5" placeholder="填写本次编修说明、家族序言等已有文字" /></label>
          </div></details>
          <details open><summary>收录范围 <span>{{ context.people.length }} 人可选</span></summary><div class="publication__section">
            <label class="publication__field">范围<BaseSelectControl><select v-model="plan.scope.mode"><option value="all">整个项目</option><option value="branch">指定分支</option><option value="descendants">起始人物及后代</option><option value="ancestors">起始人物及祖先</option></select></BaseSelectControl></label>
            <PersonPicker v-if="plan.scope.mode !== 'all'" v-model="plan.scope.roots" :people="context.people" label="起始人物（可多选）" />
            <div class="publication__pair"><label>代数（空为不限）<input :value="plan.scope.generations ?? ''" type="number" min="1" :disabled="plan.scope.mode === 'all'" @input="plan.scope.generations = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)" /></label><label>起始世数<input v-model.number="plan.scope.startGeneration" type="number" /></label></div>
            <label class="publication__check"><input v-model="plan.scope.partners" type="checkbox" :disabled="plan.scope.mode === 'all'" />包含直接伴侣</label>
            <fieldset class="publication__checks"><legend>亲子关系</legend><label v-for="(label, key) in { biological: '生育', adoptive: '收养', step: '继亲', guardian: '监护' }" :key="key"><input v-model="plan.scope.parentTypes" type="checkbox" :value="key" />{{ label }}</label></fieldset>
            <PersonPicker v-model="plan.scope.exclude" :people="context.people" label="明确排除的人物" />
          </div></details>
          <details v-if="plan.format !== 'chart'" open><summary>章节与人物内容</summary><div class="publication__section">
            <ol class="publication__chapters"><li v-for="chapter in chapters" :key="chapter"><label><input type="checkbox" :checked="plan.chapters.includes(chapter)" @change="toggleChapter(chapter, ($event.target as HTMLInputElement).checked)" />{{ chapterLabels[chapter] }}</label><span><button type="button" :aria-label="`上移${chapterLabels[chapter]}`" :disabled="plan.chapters.indexOf(chapter) <= 0" @click="moveChapter(chapter, -1)">↑</button><button type="button" :aria-label="`下移${chapterLabels[chapter]}`" :disabled="!plan.chapters.includes(chapter) || plan.chapters.indexOf(chapter) === plan.chapters.length - 1" @click="moveChapter(chapter, 1)">↓</button></span></li></ol>
            <fieldset class="publication__checks"><legend>人物传记收录字段</legend><label v-for="(label, key) in fieldLabels" :key="key"><input v-model="plan.fields" type="checkbox" :value="key" />{{ label }}</label></fieldset>
          </div></details>
          <details open><summary>纸张与装订</summary><div class="publication__section">
            <label class="publication__field">常用纸张<BaseSelectControl><select aria-label="常用纸张" @change="paperPreset(($event.target as HTMLSelectElement).value)"><option value="">选择规格或自定义尺寸</option><option value="A4">A4 · 210 × 297 mm</option><option value="A3">A3 · 297 × 420 mm</option><option value="B5">ISO B5 · 176 × 250 mm</option></select></BaseSelectControl></label>
            <div class="publication__pair"><label>宽度 mm<input v-model.number="plan.paper.widthMm" type="number" min="100" max="1200" /></label><label>高度 mm<input v-model.number="plan.paper.heightMm" type="number" min="100" max="1200" /></label></div>
            <BaseButton variant="ghost" size="sm" @click="[plan.paper.widthMm, plan.paper.heightMm] = [plan.paper.heightMm, plan.paper.widthMm]">切换横向／纵向</BaseButton>
            <div class="publication__pair"><label>页边距 mm<input v-model.number="plan.paper.marginMm" type="number" min="8" /></label><label>装订加宽 mm<input v-model.number="plan.paper.gutterMm" type="number" min="0" max="50" /></label></div>
            <div class="publication__pair"><label>正文字号 pt<input v-model.number="plan.paper.fontSize" type="number" min="8" max="40" /></label><label>图中文字 pt<input v-model.number="plan.chart.fontSize" type="number" min="10" max="40" /></label></div>
            <label class="publication__check"><input v-model="plan.paper.duplex" type="checkbox" />双面打印，镜像装订边距</label>
            <template v-if="plan.format === 'chart'"><label class="publication__check"><input v-model="plan.chart.tiled" type="checkbox" />按当前纸张分幅拼接</label><label class="publication__field">拼接重叠 mm<input v-model.number="plan.chart.overlapMm" type="number" min="0" max="20" /></label></template>
            <p class="publication__hint">使用内置中文字体。PDF 按阅读顺序排列，打印时使用实际尺寸；折手拼版交由印刷厂处理。</p>
            <details class="publication__license"><summary>内置字体许可</summary><pre>{{ fontLicense }}</pre></details>
          </div></details>
          <details v-if="plan.format !== 'chart'"><summary>照片与 PDF 史料 <span>{{ plan.images.length + plan.appendices.length }} 项</span></summary><div class="publication__section">
            <p class="publication__hint">只选择项目中已有的附件。人物照片可随传记排入，其余图片和 PDF 收入“史料附录”章节。</p>
            <label class="publication__field">增加图片<BaseSelectControl><select v-model="imageId"><option value="">选择项目图片</option><option v-for="a in imageAttachments" :key="a.id" :value="a.id">{{ a.name }}</option></select></BaseSelectControl></label><BaseButton variant="secondary" size="sm" :disabled="!imageId" @click="addImage">加入图片</BaseButton>
            <article v-for="(image, index) in plan.images" :key="index" class="publication__attachment"><div><strong>{{ attachmentName(image.attachmentId) }}</strong><button type="button" aria-label="从方案移除图片" @click="plan.images.splice(index, 1)"><IconX :size="16" /></button></div><label class="publication__field">图片说明<input v-model="image.caption" /></label><PersonPicker :model-value="image.personId ? [image.personId] : []" :people="context.people" label="随人物传记收录（空为史料插页）" single @update:model-value="image.personId = $event[0] ?? null" /></article>
            <label class="publication__field">增加 PDF 史料<BaseSelectControl><select v-model="appendixId"><option value="">选择项目 PDF</option><option v-for="a in pdfAttachments" :key="a.id" :value="a.id">{{ a.name }}</option></select></BaseSelectControl></label><BaseButton variant="secondary" size="sm" :disabled="!appendixId" :loading="appendixBusy" @click="addAppendix">读取页数并加入</BaseButton>
            <article v-for="(appendix, index) in plan.appendices" :key="index" class="publication__attachment"><div><strong>{{ attachmentName(appendix.attachmentId) }}</strong><button type="button" aria-label="从方案移除 PDF" @click="plan.appendices.splice(index, 1)"><IconX :size="16" /></button></div><label class="publication__field">选取原页码{{ pdfCounts[appendix.attachmentId] ? `（共 ${pdfCounts[appendix.attachmentId]} 页）` : '' }}<input v-model="appendix.pages" placeholder="例如：1-3,5" /></label><small>按填写顺序收入附录，每个原页单独一页。</small></article>
          </div></details>
        </aside>
        <section class="publication__proof" aria-label="校对与预览">
          <div v-if="running" class="publication__progress" role="status"><div><strong>{{ cancelling ? '正在取消…' : status?.stage ?? '正在启动编印…' }}</strong><span v-if="status?.total">{{ status.completed }} / {{ status.total }}</span></div><progress :value="status?.total ? status.completed : undefined" :max="status?.total || 1" /><BaseButton variant="ghost" size="sm" :disabled="starting || cancelling" @click="cancel">取消生成</BaseButton></div>
          <p v-if="stale" class="publication__notice" role="status">方案或资料已变化，请重新生成后再校对和保存。</p>
          <div v-if="report" class="publication__report">
            <dl><div><dt>收录人物</dt><dd>{{ report.people }}</dd></div><div><dt>分支</dt><dd>{{ report.branches }}</dd></div><div><dt>关系</dt><dd>{{ report.relationships }}</dd></div><div><dt>成品页数</dt><dd>{{ report.pages }}</dd></div></dl>
            <details><summary>校对报告 · {{ report.issues.length }} 条提示 · 排除 {{ report.excluded.length }} 人</summary><p v-for="(issue, index) in report.issues" :key="index" class="publication__notice">{{ issue.message }}</p><label class="publication__field">查找收录人物<input v-model="reportQuery" type="search" placeholder="姓名或本册编号" /></label><table><thead><tr><th>本册编号</th><th>姓名</th><th>世代</th><th>页码</th></tr></thead><tbody><tr v-for="entry in visibleEntries" :key="entry.id"><td>{{ entry.number }}</td><td>{{ entry.name }}</td><td>{{ entry.generation ?? '未定' }}</td><td>{{ entry.page ?? '未入传' }}</td></tr></tbody></table><div class="publication__actions"><BaseButton variant="ghost" size="sm" :disabled="reportPage <= 1" @click="reportPage--">上一组</BaseButton><span>{{ reportPage }} / {{ Math.max(1, Math.ceil(matches.length / 25)) }}</span><BaseButton variant="ghost" size="sm" :disabled="reportPage * 25 >= matches.length" @click="reportPage++">下一组</BaseButton></div><details v-if="report.excluded.length"><summary>排除名单与原因</summary><ul class="publication__excluded"><li v-for="entry in report.excluded" :key="entry.id">{{ personNames.get(entry.id) ?? entry.id }}：{{ entry.reason }}</li></ul></details><small>生成耗时 {{ (report.elapsedMs / 1000).toFixed(1) }} 秒 · {{ (report.bytes / 1024 / 1024).toFixed(2) }} MiB</small></details>
          </div>
          <PdfPreview v-if="ready && status" :key="jobId" :project-id="projectId" :job-id="jobId" :bytes="status.bytes" />
          <div v-else-if="!running" class="publication__empty"><IconBook :size="48" :stroke-width="1" aria-hidden="true" /><h2>{{ status?.state === 'cancelled' ? '生成已取消' : status?.state === 'failed' ? '请调整后重新生成' : stale ? '等待重新生成' : '纸上族谱，从这里开始' }}</h2><p>左侧设置收录范围和版式，生成后在此校对真实 PDF。</p><p class="publication__hint">预览与导出使用同一份文件。</p></div>
        </section>
      </div>
    </template>
    <BaseDialog :open="Boolean(confirmation)" :title="confirmation?.title ?? ''" :description="confirmation?.description" @close="settle(false)"><div class="publication__actions"><BaseButton variant="secondary" @click="settle(false)">返回继续编辑</BaseButton><BaseButton :variant="confirmation?.danger ? 'danger' : 'primary'" @click="settle(true)">{{ confirmation?.danger ? '删除方案' : '放弃修改' }}</BaseButton></div></BaseDialog>
  </main>
</template>

<style scoped>
.publication { width: 100%; max-width: 1600px; margin: 0 auto; }
.publication > .project-management-tabs { margin-bottom: 1.5rem; }
.publication__heading { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
h1 { margin: .2rem 0 .6rem; font-family: var(--font-heading); font-size: 2rem; }
.publication__heading p { margin: 0; color: var(--color-muted); }
.publication__eyebrow { font-size: .75rem; letter-spacing: .12em; }
.publication__actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
.publication__planbar { display: flex; align-items: end; flex-wrap: wrap; gap: .65rem; padding: 1rem 0; border-top: 1px solid var(--color-border); }
.publication__planbar > label { min-width: 13rem; flex: 1; max-width: 24rem; font-size: .8rem; display: grid; gap: .35rem; }
.publication__workspace { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 1.25rem; align-items: start; }
.publication__settings { min-width: 0; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 1rem; }
.publication__formats { border: 0; padding: 0; margin: 0; min-width: 0; }
.publication__formats legend { width: 100%; margin-bottom: .65rem; font-weight: 650; }
.publication__formats label { display: flex; align-items: center; gap: .6rem; padding: .65rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; }
.publication__formats label + label { margin-top: .4rem; }
.publication__formats .selected { border-color: var(--color-primary); background: var(--color-success-surface); }
.publication__hint { color: var(--color-muted); font-size: .8rem; line-height: 1.6; }
.publication__license { font-size: .75rem; color: var(--color-muted); }
.publication__license pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow: auto; }
.publication__field, .publication__pair > label { display: grid; gap: .4rem; margin: .4rem 0; font-size: .85rem; }
.publication :deep(input:not([type="checkbox"]):not([type="radio"])), textarea { width: 100%; min-width: 0; padding: .55rem .65rem; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); border-radius: var(--radius-sm); }
textarea { resize: vertical; }
.publication__settings > details { margin-top: 1rem; border-top: 1px solid var(--color-border); }
summary { cursor: pointer; padding: .9rem 0; font-weight: 600; }
summary span { font-size: .75rem; font-weight: 400; color: var(--color-muted); }
.publication__section { display: grid; gap: .65rem; padding-bottom: .4rem; }
.publication__pair { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem; }
.publication__check { display: flex; gap: .5rem; align-items: center; font-size: .85rem; }
input[type="checkbox"], input[type="radio"] { accent-color: var(--color-primary); }
.publication__checks { display: flex; flex-wrap: wrap; gap: .6rem 1rem; padding: 0; border: 0; font-size: .85rem; }
.publication__checks legend { margin-bottom: .5rem; }
.publication__checks label { display: flex; gap: .35rem; align-items: center; }
.publication__chapters { padding: 0; margin: 0; list-style: none; }
.publication__chapters li { display: flex; align-items: center; justify-content: space-between; padding: .3rem 0; }
.publication__chapters label { display: flex; align-items: center; gap: .4rem; font-size: .85rem; }
.publication__chapters button, .publication__attachment button { padding: .35rem .55rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: transparent; }
.publication__chapters button:disabled { opacity: .25; }
.publication__attachment { padding: .7rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); display: grid; gap: .5rem; }
.publication__attachment > div:first-child { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-size: .8rem; }
.publication__attachment strong { overflow-wrap: anywhere; }
.publication__proof { border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; min-width: 0; background: var(--color-surface); position: sticky; top: 1rem; }
.publication__empty { min-height: 34rem; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; text-align: center; background: var(--color-muted-surface); }
.publication__empty svg { color: var(--color-primary); }
.publication__empty h2 { font: 1.5rem var(--font-heading); margin: 1rem 0 .25rem; }
.publication__empty p { max-width: 24rem; color: var(--color-muted); line-height: 1.7; }
.publication__notice { padding: .75rem 1rem; margin: 0; background: var(--color-warning-surface); color: var(--color-warning); font-size: .85rem; line-height: 1.6; }
.publication__error { color: var(--color-danger); background: var(--color-danger-surface); padding: .8rem 1rem; border-radius: var(--radius-sm); overflow-wrap: anywhere; }
.publication__progress { padding: 1rem; display: grid; gap: .65rem; }
.publication__progress > div { display: flex; justify-content: space-between; }
progress { width: 100%; accent-color: var(--color-primary); }
.publication__report { padding: .8rem 1rem; border-bottom: 1px solid var(--color-border); }
.publication__report dl { display: grid; grid-template-columns: repeat(4, 1fr); margin: 0; gap: .5rem; }
.publication__report dt { color: var(--color-muted); font-size: .7rem; }
.publication__report dd { margin: .2rem 0 0; font-variant-numeric: tabular-nums; font-size: 1.4rem; }
.publication__report > details { max-height: 28rem; overflow: auto; font-size: .8rem; }
.publication__report table { width: 100%; border-collapse: collapse; }
th, td { padding: .35rem; text-align: left; border-bottom: 1px solid var(--color-border); }
.publication__excluded { max-height: 10rem; overflow: auto; }
.publication__switch { display: none; }
@media (max-width: 1000px) { .publication__heading { align-items: start; flex-direction: column; } .publication__workspace { grid-template-columns: 300px minmax(0, 1fr); } }
@media (max-width: 760px) { .publication__workspace { display: block; } .publication__switch { display: flex; margin: .5rem 0 1rem; gap: .5rem; } .publication__switch button { flex: 1; border: 1px solid var(--color-border); padding: .7rem; border-radius: var(--radius-sm); background: var(--color-surface); } .publication__switch button[aria-pressed="true"] { color: var(--color-primary); border-color: var(--color-primary); background: var(--color-success-surface); } [data-pane="settings"] .publication__proof, [data-pane="preview"] .publication__settings { display: none; } .publication__proof { position: static; } .publication__empty { min-height: 24rem; } }
</style>
