<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ProjectManagementTabs from '../../../app/components/ProjectManagementTabs.vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import type { RestoreResult, Snapshot } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import GithubSyncPanel from '../../projects/components/GithubSyncPanel.vue'
import RestoreDialog from '../components/RestoreDialog.vue'
import SnapshotDialog from '../components/SnapshotDialog.vue'

const route = useRoute()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const snapshots = ref<Snapshot[]>([])
const state = ref<'loading' | 'ready' | 'failed'>('loading')
const errorMessage = ref('')
const snapshotOpen = ref(false)
const restoreTarget = ref<Snapshot>()
const restoreResult = ref<RestoreResult>()
let loadRequest = 0

const orderedSnapshots = computed(() => [...snapshots.value].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)))
const reasonLabels: Record<Snapshot['reason'], string> = { manual: '手动快照', import: '导入前', merge: '合并前', cleanup: '清理前', restore: '恢复前' }

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间记录无效' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

async function load(scopedProjectId = projectId.value) {
  const request = ++loadRequest
  state.value = 'loading'; errorMessage.value = ''
  try {
    const next = await repository.listSnapshots(scopedProjectId)
    if (request !== loadRequest || scopedProjectId !== projectId.value) return
    snapshots.value = next; state.value = 'ready'
  } catch (error) {
    if (request !== loadRequest || scopedProjectId !== projectId.value) return
    errorMessage.value = error instanceof Error && error.message ? error.message : '历史版本读取失败'; state.value = 'failed'
  }
}

function snapshotCreated(snapshot: Snapshot) {
  if (snapshot.projectId !== projectId.value) return
  snapshots.value = [...snapshots.value, snapshot]
}
async function restored(result: RestoreResult) {
  if (result.safetySnapshot.projectId !== projectId.value) return
  restoreResult.value = result; restoreTarget.value = undefined; await load()
}

watch(projectId, (nextProjectId) => {
  loadRequest += 1
  snapshots.value = []
  state.value = 'loading'
  errorMessage.value = ''
  snapshotOpen.value = false
  restoreTarget.value = undefined
  restoreResult.value = undefined
  void load(nextProjectId)
}, { immediate: true })
</script>

<template>
  <section class="history-view" aria-label="备份与历史">
    <ProjectManagementTabs />
    <GithubSyncPanel :project-id="projectId" />
    <section class="history-view__actions"><div><strong>可恢复的研究节点</strong><span>每个版本展示原因、备注和数据规模；恢复前会自动保护当前状态。</span></div><BaseButton variant="secondary" @click="snapshotOpen = true">创建手动快照</BaseButton></section>
    <p v-if="restoreResult" class="history-view__result" role="status">恢复完成并重新检查；恢复前状态已保存为“{{ restoreResult.safetySnapshot.note }}”。</p>
    <p v-if="state === 'loading'" class="history-view__state" role="status">正在读取历史版本…</p>
    <div v-else-if="state === 'failed'" class="history-view__state history-view__state--error" role="alert"><strong>历史版本无法读取</strong><span>{{ errorMessage }}</span><BaseButton size="sm" variant="secondary" @click="load()">重试</BaseButton></div>
    <ol v-else class="history-view__list">
      <li v-for="snapshot in orderedSnapshots" :key="snapshot.id">
        <div class="history-view__timeline" aria-hidden="true" />
        <article><header><div><time :datetime="snapshot.createdAt">{{ formatDate(snapshot.createdAt) }}</time><h2>{{ snapshot.note || '无备注快照' }}</h2></div><StatusBadge tone="info">{{ reasonLabels[snapshot.reason] }}</StatusBadge></header><p>人物 {{ snapshot.summary.people }} · 关系 {{ snapshot.summary.relationships }} · 事件 {{ snapshot.summary.events }}</p><BaseButton size="sm" variant="secondary" :aria-label="`恢复版本：${snapshot.note || snapshot.createdAt}`" @click="restoreTarget = snapshot">预览并恢复</BaseButton></article>
      </li>
    </ol>
    <SnapshotDialog :open="snapshotOpen" :project-id="projectId" @close="snapshotOpen = false" @created="snapshotCreated" />
    <RestoreDialog v-if="restoreTarget" :open="true" :snapshot="restoreTarget" @close="restoreTarget = undefined" @restored="restored" />
  </section>
</template>

<style scoped>
.history-view { display: grid; width: min(72rem, 100%); gap: var(--space-5); margin: 0 auto; }
.history-view__actions { display: flex; align-items: center; justify-content: space-between; gap: var(--space-5); padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }.history-view__actions > div { display: grid; gap: .4rem; }.history-view__actions strong { font-family: var(--font-heading); font-size: 1.15rem; }.history-view__actions span { color: var(--color-muted); font-size: .875rem; line-height: 1.5; }
.history-view__result { padding: var(--space-3) var(--space-4); margin: 0; border-radius: var(--radius-sm); background: var(--color-success-surface); color: var(--color-success); }.history-view__state { display: grid; justify-items: start; gap: var(--space-3); padding: var(--space-8); border: 1px dashed var(--color-border); border-radius: var(--radius-lg); }.history-view__state--error { color: var(--color-danger); }
.history-view__list { display: grid; padding: 0; margin: 0; list-style: none; }.history-view__list li { display: grid; grid-template-columns: 1.25rem 1fr; gap: var(--space-3); }.history-view__timeline { position: relative; border-left: 2px solid var(--color-border); margin-left: .5rem; }.history-view__timeline::before { position: absolute; top: var(--space-6); left: -.45rem; width: .75rem; height: .75rem; border: 2px solid var(--color-surface); border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 0 1px var(--color-accent); content: ''; }
.history-view article { display: grid; justify-items: start; gap: var(--space-3); padding: var(--space-5); margin-bottom: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }.history-view article header { display: flex; width: 100%; align-items: start; justify-content: space-between; gap: var(--space-4); }.history-view time { color: var(--color-muted); font-size: .8125rem; }.history-view h2 { margin: var(--space-1) 0 0; font-family: var(--font-heading); font-size: 1.125rem; }.history-view article p { margin: 0; color: var(--color-muted); }
@media (max-width: 44rem) { .history-view__actions { align-items: stretch; flex-direction: column; } }
</style>
