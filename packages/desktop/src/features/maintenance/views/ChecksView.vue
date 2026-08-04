<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ProjectManagementTabs from '../../../app/components/ProjectManagementTabs.vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import type {
  Attachment,
  AttachmentLink,
  Citation,
  CleanupResult,
  DataIssue,
  DuplicateCandidate,
  FamilyEvent,
  Person,
  Place,
  Relationship,
  Source,
  UUID,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import CleanupDialog from '../components/CleanupDialog.vue'
import DuplicateCandidates from '../components/DuplicateCandidates.vue'
import IssueList from '../components/IssueList.vue'
import MergeWizard from '../components/MergeWizard.vue'
import {
  advanceLongTask,
  cancelLongTask,
  completeLongTask,
  createLongTaskState,
  failLongTask,
  startLongTask,
} from '../model/longTasks'

const route = useRoute()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const issues = ref<DataIssue[]>([])
const task = ref(createLongTaskState())
const errorMessage = ref('')
const cleanupOpen = ref(false)
const lastCleanup = ref<CleanupResult>()
const people = ref<Person[]>([])
const duplicateCandidates = ref<DuplicateCandidate[]>([])
const relationships = ref<Relationship[]>([])
const events = ref<FamilyEvent[]>([])
const places = ref<Place[]>([])
const sources = ref<Source[]>([])
const citations = ref<Citation[]>([])
const attachments = ref<Attachment[]>([])
const attachmentLinks = ref<AttachmentLink[]>([])
const duplicateState = ref<'loading' | 'ready' | 'failed'>('loading')
const duplicateError = ref('')
const mergeTarget = ref<{ keepPersonId: UUID; removePersonId: UUID }>()
let requestId = 0
let duplicateRequestId = 0

async function loadDuplicateData(scopedProjectId = projectId.value) {
  const request = ++duplicateRequestId
  duplicateState.value = 'loading'
  duplicateError.value = ''
  duplicateCandidates.value = []
  try {
    const [nextCandidates, peoplePage, nextRelationships, nextEvents, nextPlaces, nextSources, nextCitations, nextAttachments, nextLinks] = await Promise.all([
      repository.listDuplicateCandidates(scopedProjectId),
      repository.listPeople(scopedProjectId, { page: 1, pageSize: 500, sort: 'name' }),
      repository.listRelationships(scopedProjectId),
      repository.listEvents(scopedProjectId),
      repository.listPlaces(scopedProjectId),
      repository.listSources(scopedProjectId),
      repository.listCitations(scopedProjectId),
      repository.listAttachments(scopedProjectId),
      repository.listAttachmentLinks(scopedProjectId),
    ])
    if (request !== duplicateRequestId || scopedProjectId !== projectId.value) return
    duplicateCandidates.value = nextCandidates
    people.value = peoplePage.items.filter(({ projectId: id, deletedAt }) => id === scopedProjectId && !deletedAt)
    relationships.value = nextRelationships.filter(({ projectId: id }) => id === scopedProjectId)
    events.value = nextEvents.filter(({ projectId: id }) => id === scopedProjectId)
    places.value = nextPlaces.filter(({ projectId: id }) => id === scopedProjectId)
    sources.value = nextSources.filter(({ projectId: id }) => id === scopedProjectId)
    citations.value = nextCitations.filter(({ projectId: id }) => id === scopedProjectId)
    attachments.value = nextAttachments.filter(({ projectId: id }) => id === scopedProjectId)
    attachmentLinks.value = nextLinks.filter(({ projectId: id }) => id === scopedProjectId)
    duplicateState.value = 'ready'
  } catch (error) {
    if (request !== duplicateRequestId || scopedProjectId !== projectId.value) return
    duplicateError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '重复人物候选暂时无法读取'
    duplicateState.value = 'failed'
  }
}

function openMerge(keepPersonId: UUID, removePersonId: UUID) {
  mergeTarget.value = { keepPersonId, removePersonId }
}

function closeMerge() {
  mergeTarget.value = undefined
  void loadDuplicateData()
}

function mergeCompleted() {
  void loadDuplicateData()
}

function startInspection() {
  issues.value = []
  task.value = startLongTask(createLongTaskState())
}

function cancelInspection() { task.value = cancelLongTask(task.value) }

async function continueInspection() {
  if (task.value.stage !== 'processing') return
  task.value = advanceLongTask(task.value)
  if (task.value.stage !== 'committing') return
  const request = ++requestId
  errorMessage.value = ''
  try {
    const next = await repository.inspectProject(projectId.value)
    if (request !== requestId) return
    issues.value = next
    task.value = completeLongTask(task.value, [`检查完成，共 ${next.length} 个检查项`])
  } catch (error) {
    if (request !== requestId) return
    errorMessage.value = error instanceof Error && error.message ? error.message : '项目检查失败'
    task.value = failLongTask(task.value, errorMessage.value)
  }
}

function retryInspection() { startInspection() }

function cleanupCompleted(result: CleanupResult) {
  lastCleanup.value = result
  issues.value = result.issues
  task.value = completeLongTask(task.value, [`清理后重新检查，共 ${result.issues.length} 个检查项`])
  cleanupOpen.value = false
}

watch(projectId, () => {
  requestId += 1
  duplicateRequestId += 1
  issues.value = []
  errorMessage.value = ''
  task.value = createLongTaskState()
  mergeTarget.value = undefined
  void loadDuplicateData()
}, { immediate: true })
</script>

<template>
  <section class="checks-view" aria-label="数据检查与维护">
    <ProjectManagementTabs />
    <section class="checks-view__actions" aria-label="检查操作">
      <div><strong>完整性检查</strong><span>结构错误会阻止写入；日期、历史和附件疑点作为可跳转警告保留。</span></div>
      <div>
        <BaseButton v-if="task.stage === 'idle' || task.stage === 'cancelled'" name="开始项目检查" variant="secondary" @click="startInspection">开始检查</BaseButton>
        <BaseButton v-if="task.stage === 'processing'" name="继续项目检查" variant="secondary" @click="continueInspection">继续检查</BaseButton>
        <BaseButton v-if="task.stage === 'processing'" name="取消项目检查" variant="ghost" @click="cancelInspection">安全取消</BaseButton>
        <BaseButton v-if="task.stage === 'committing'" name="取消项目检查" variant="ghost" disabled>不可取消</BaseButton>
        <BaseButton v-if="task.stage === 'complete'" variant="secondary" @click="startInspection">重新检查</BaseButton>
        <BaseButton name="打开清理项目对话框" variant="danger" :disabled="task.stage === 'committing'" @click="cleanupOpen = true">清理项目</BaseButton>
      </div>
    </section>
    <p v-if="lastCleanup" class="checks-view__result" role="status">清理完成：移除附件 {{ lastCleanup.removedAttachments }} 个、来源 {{ lastCleanup.removedSources }} 个，并重新执行检查。</p>
    <div v-if="task.stage === 'idle'" class="checks-view__state" role="status">检查尚未开始。点击“开始检查”后可在安全阶段取消。</div>
    <div v-else-if="task.stage === 'processing' || task.stage === 'committing'" class="checks-view__state" role="status"><progress :value="task.progress" max="100" role="progressbar" :aria-valuenow="task.progress">{{ task.progress }}%</progress><strong>{{ task.phase }}</strong><span>{{ task.stage === 'committing' ? '正在汇总检查结果，当前阶段不可安全取消。' : '正在分析人物结构、日期、来源和附件；当前可安全取消。' }}</span></div>
    <div v-else-if="task.stage === 'cancelled'" class="checks-view__state" role="status">检查已安全取消，没有修改项目资料。</div>
    <div v-else-if="task.stage === 'failed'" class="checks-view__state checks-view__state--error" role="alert"><strong>检查未完成</strong><span>{{ errorMessage }}</span><BaseButton name="重试项目检查" size="sm" variant="secondary" @click="retryInspection">重试检查</BaseButton></div>
    <IssueList v-else-if="task.stage === 'complete'" :project-id="projectId" :issues="issues" />
    <section class="checks-view__duplicates" aria-label="重复人物维护">
      <p v-if="duplicateState === 'loading'" role="status">正在分析重复人物候选…</p>
      <div v-else-if="duplicateState === 'failed'" class="checks-view__state checks-view__state--error" role="alert">
        <strong>重复人物候选无法读取</strong><span>{{ duplicateError }}</span>
        <BaseButton size="sm" variant="secondary" @click="loadDuplicateData()">重试</BaseButton>
      </div>
      <DuplicateCandidates
        v-else
        :people="people"
        :candidates="duplicateCandidates"
        @merge="openMerge"
      />
    </section>
    <CleanupDialog :open="cleanupOpen" :project-id="projectId" @close="cleanupOpen = false" @completed="cleanupCompleted" />
    <MergeWizard
      v-if="mergeTarget"
      :open="true"
      :keep-person-id="mergeTarget.keepPersonId"
      :remove-person-id="mergeTarget.removePersonId"
      :people="people"
      :relationships="relationships"
      :events="events"
      :citations="citations"
      :attachment-links="attachmentLinks"
      :attachments="attachments"
      :places="places"
      :sources="sources"
      @cancel="closeMerge"
      @merged="mergeCompleted"
    />
  </section>
</template>

<style scoped>
.checks-view { display: grid; width: min(72rem, 100%); gap: var(--space-5); margin: 0 auto; }
.checks-view__actions > div:last-child { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.checks-view__actions { display: flex; align-items: center; justify-content: space-between; gap: var(--space-5); padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.checks-view__actions > div:first-child { display: grid; gap: var(--space-1); }.checks-view__actions span { color: var(--color-muted); }
.checks-view__result { padding: var(--space-3) var(--space-4); margin: 0; border-radius: var(--radius-sm); background: var(--color-success-surface); color: var(--color-success); }
.checks-view__state { display: grid; justify-items: start; gap: var(--space-3); padding: var(--space-8); border: 1px dashed var(--color-border); border-radius: var(--radius-lg); }.checks-view__state--error { color: var(--color-danger); }
.checks-view__duplicates { padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
@media (max-width: 44rem) { .checks-view__actions { align-items: stretch; flex-direction: column; } }
</style>
