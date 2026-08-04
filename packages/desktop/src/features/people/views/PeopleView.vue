<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import EmptyState from '../../../design-system/EmptyState.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { Person, Project } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import PeopleFilters from '../components/PeopleFilters.vue'
import PeopleTable from '../components/PeopleTable.vue'
import DeletePersonDialog from '../components/DeletePersonDialog.vue'
import { usePeopleQuery } from '../composables/usePeopleQuery'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const session = useSessionStore()
const projectId = computed(() => String(route.params.projectId ?? ''))
const selectedIds = ref<string[]>([])
const project = ref<Project>()
const centerBusy = ref(false)
const centerError = ref('')
const deletingPerson = ref<Person>()
const deleteImpact = ref<{ relationships: number; events: number; citations: number } | null>(null)
const deleteLoading = ref(false)
const deleting = ref(false)
const deleteError = ref('')
let deleteRequest = 0
let projectRequest = 0

const peopleQuery = usePeopleQuery(repository, projectId)

watch(projectId, () => {
  projectRequest += 1
  deleteRequest += 1
  project.value = undefined
  centerBusy.value = false
  centerError.value = ''
  deletingPerson.value = undefined
  deleteImpact.value = null
  deleteLoading.value = false
  deleting.value = false
  deleteError.value = ''
  selectedIds.value = []
  void loadProject()
}, { immediate: true })

async function loadProject() {
  const request = ++projectRequest
  const scopedProjectId = projectId.value
  try {
    const loadedProject = await repository.getProject(scopedProjectId)
    if (request !== projectRequest || scopedProjectId !== projectId.value) return
    project.value = loadedProject
  } catch (error) {
    if (request !== projectRequest) return
    centerError.value = error instanceof Error ? error.message : '中心人物状态暂时无法读取'
  }
}

function selectPerson(personId: string, selected: boolean) {
  const next = new Set(selectedIds.value)
  if (selected) next.add(personId)
  else next.delete(personId)
  selectedIds.value = [...next]
}

function selectPage(personIds: string[], selected: boolean) {
  const next = new Set(selectedIds.value)
  for (const personId of personIds) {
    if (selected) next.add(personId)
    else next.delete(personId)
  }
  selectedIds.value = [...next]
}

function createPerson() {
  void router.push({ name: 'person-new', params: { projectId: projectId.value } })
}

async function toggleCenter(person: Person) {
  if (!project.value || centerBusy.value) return
  const scopedProjectId = projectId.value
  const nextDefaultPersonId = project.value.defaultPersonId === person.id ? undefined : person.id
  centerBusy.value = true
  centerError.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const saved = await repository.updateProject(scopedProjectId, {
      defaultPersonId: nextDefaultPersonId,
    })
    if (scopedProjectId !== projectId.value) return
    project.value = saved
    session.openProject(saved, repository.getHistoryState())
  } catch (error) {
    if (scopedProjectId !== projectId.value) return
    const details = error instanceof Error ? error.message : '中心人物暂时无法更新'
    centerError.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    if (scopedProjectId === projectId.value) centerBusy.value = false
  }
}

async function openDelete(person: Person) {
  const request = ++deleteRequest
  deletingPerson.value = person
  deleteImpact.value = null
  deleteLoading.value = true
  deleteError.value = ''
  try {
    const [relationships, events, citationItems] = await Promise.all([
      repository.listRelationships(person.projectId),
      repository.listEvents(person.projectId),
      repository.listCitations(person.projectId),
    ])
    if (request !== deleteRequest || deletingPerson.value?.id !== person.id) return
    deleteImpact.value = {
      relationships: relationships.filter(({ fromPersonId, toPersonId }) => fromPersonId === person.id || toPersonId === person.id).length,
      events: events.filter(({ participantIds }) => participantIds.includes(person.id)).length,
      citations: citationItems.filter(({ targetType, targetId }) => targetType === 'person' && targetId === person.id).length,
    }
  } catch (error) {
    if (request !== deleteRequest) return
    deleteError.value = error instanceof Error ? error.message : '关联资料无法读取'
  } finally {
    if (request === deleteRequest) deleteLoading.value = false
  }
}

function closeDelete() {
  if (deleting.value) return
  deleteRequest += 1
  deletingPerson.value = undefined
}

async function confirmDelete() {
  const target = deletingPerson.value
  if (!target || !deleteImpact.value || deleting.value) return
  const request = ++deleteRequest
  deleting.value = true
  deleteError.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.softDeletePerson(target.id)
    if (request !== deleteRequest || target.projectId !== projectId.value) return
    const refreshedProject = await repository.getProject(target.projectId)
    if (request !== deleteRequest) return
    project.value = refreshedProject
    session.openProject(refreshedProject, repository.getHistoryState())
    selectedIds.value = selectedIds.value.filter((id) => id !== target.id)
    deletingPerson.value = undefined
    await peopleQuery.retry()
  } catch (error) {
    if (request !== deleteRequest) return
    const details = error instanceof Error ? error.message : '本地资料暂时无法写入'
    deleteError.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    if (request === deleteRequest) deleting.value = false
  }
}
</script>

<template>
  <section class="people-view" aria-labelledby="people-view-title">
    <header class="people-view__heading">
      <div>
        <p>人物档案与检索</p>
        <h1 id="people-view-title">人物档案</h1>
      </div>
      <div class="people-view__heading-actions">
        <div class="people-view__count" aria-live="polite">
          <strong>{{ peopleQuery.result.value.total }}</strong>
          <span>位人物</span>
        </div>
        <BaseButton name="新建人物" @click="createPerson">新建人物</BaseButton>
      </div>
    </header>

    <PeopleFilters
      :search="peopleQuery.searchInput.value"
      :status="peopleQuery.status.value"
      :sex="peopleQuery.sex.value"
      :source-filter="peopleQuery.sourceFilter.value"
      :avatar-filter="peopleQuery.avatarFilter.value"
      :birth-filter="peopleQuery.birthFilter.value"
      :death-filter="peopleQuery.deathFilter.value"
      :issue-filter="peopleQuery.issueFilter.value"
      :sort="peopleQuery.sort.value"
      @update:search="peopleQuery.updateSearch"
      @update:status="peopleQuery.updateStatus"
      @update:sex="peopleQuery.updateSex"
      @update:source-filter="peopleQuery.updateSourceFilter"
      @update:avatar-filter="peopleQuery.updateAvatarFilter"
      @update:birth-filter="peopleQuery.updateBirthFilter"
      @update:death-filter="peopleQuery.updateDeathFilter"
      @update:issue-filter="peopleQuery.updateIssueFilter"
      @update:sort="peopleQuery.updateSort"
      @clear="peopleQuery.clearFilters"
    />

    <div class="people-view__summary">
      <p aria-live="polite">
        {{ selectedIds.length > 0 ? `已选择 ${selectedIds.length} 人` : '可选择人物查看或导出资料' }}
      </p>
      <span v-if="peopleQuery.loadState.value === 'ready'">
        共 {{ peopleQuery.result.value.total }} 条结果
      </span>
    </div>

    <p v-if="centerError" class="people-view__center-error" role="alert">{{ centerError }}</p>

    <div v-if="peopleQuery.loadState.value === 'loading'" class="people-view__state" role="status">
      正在查找人物档案…
    </div>

    <div
      v-else-if="peopleQuery.loadState.value === 'error'"
      class="people-view__state people-view__state--error"
      role="alert"
    >
      <strong>人物资料未能读取</strong>
      <span>{{ peopleQuery.loadError.value }}</span>
      <BaseButton
        variant="secondary"
        size="sm"
        aria-label="重试载入人物"
        @click="peopleQuery.retry"
      >
        重新读取
      </BaseButton>
    </div>

    <div
      v-else-if="peopleQuery.result.value.items.length === 0"
      class="people-view__state people-view__state--empty"
      role="status"
    >
      <EmptyState
        title="没有找到符合条件的人物"
        description="试试修改关键词或清除筛选条件。"
      >
        <span class="people-view__empty-mark">人</span>
        <template #actions>
          <BaseButton variant="secondary" size="sm" @click="peopleQuery.clearFilters">
            清除条件
          </BaseButton>
        </template>
      </EmptyState>
    </div>

    <template v-else>
      <PeopleTable
        :people="peopleQuery.result.value.items"
        :project-id="projectId"
        :selected-ids="selectedIds"
        :center-person-id="project?.defaultPersonId"
        :center-busy="centerBusy || !project"
        @select="selectPerson"
        @select-page="selectPage"
        @delete="openDelete"
        @set-center="toggleCenter"
      />

      <nav class="people-view__pagination" aria-label="人物分页">
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="peopleQuery.page.value <= 1"
          aria-label="上一页"
          @click="peopleQuery.goToPage(peopleQuery.page.value - 1)"
        >
          ← 上一页
        </BaseButton>
        <span aria-label="分页信息">
          第 {{ peopleQuery.page.value }} / {{ peopleQuery.totalPages.value }} 页
        </span>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="peopleQuery.page.value >= peopleQuery.totalPages.value"
          aria-label="下一页"
          @click="peopleQuery.goToPage(peopleQuery.page.value + 1)"
        >
          下一页 →
        </BaseButton>
      </nav>
    </template>

    <DeletePersonDialog
      :open="Boolean(deletingPerson)"
      :person-name="deletingPerson ? getPrimaryName(deletingPerson) : '这位人物'"
      :impact="deleteImpact"
      :loading="deleteLoading"
      :deleting="deleting"
      v-bind="deleteError ? { error: deleteError } : {}"
      @close="closeDelete"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.people-view {
  display: grid;
  width: min(76rem, 100%);
  gap: var(--space-4);
  margin: 0 auto;
}

.people-view__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: var(--space-6);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.people-view__heading p {
  margin: 0;
  color: var(--color-accent);
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.people-view h1 {
  margin: var(--space-1) 0 0;
  font-family: var(--font-heading);
  font-size: clamp(2.25rem, 5vw, 4.25rem);
  font-weight: 560;
  letter-spacing: -0.035em;
  line-height: 1.05;
}

.people-view__count {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  white-space: nowrap;
  color: var(--color-muted);
}

.people-view__heading-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.people-view__count strong {
  color: var(--color-primary);
  font-family: var(--font-heading);
  font-size: 2rem;
  line-height: 1;
}

.people-view__summary {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  color: var(--color-muted);
  font-size: 0.8125rem;
}

.people-view__summary p {
  margin: 0;
}

.people-view__center-error {
  margin: 0;
  color: var(--color-danger);
  font-size: .8125rem;
}

.people-view__state {
  display: grid;
  min-height: 17rem;
  place-content: center;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-8);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-muted);
  text-align: center;
}

.people-view__state--error {
  border-color: var(--color-danger);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.people-view__state--error button {
  margin-top: var(--space-3);
}

.people-view__empty-mark {
  display: grid;
  width: 3.5rem;
  height: 3.5rem;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-family: var(--font-heading);
  font-size: 1.5rem;
}

.people-view__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}

.people-view__pagination span {
  min-width: 6.5rem;
  color: var(--color-muted);
  text-align: center;
}

@media (max-width: 40rem) {
  .people-view__heading {
    align-items: start;
  }

  .people-view__summary {
    display: grid;
  }

  .people-view__pagination {
    justify-content: space-between;
  }
}
</style>
