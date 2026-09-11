<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { IconArrowsExchange, IconRoute, IconUsersGroup } from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import { buildKinshipDescriptions } from '../../../shared/domain/kinship'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import KinshipPersonPicker from '../components/KinshipPersonPicker.vue'
import { useKinshipFamily } from '../composables/useKinshipFamily'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => String(route.params.projectId ?? ''))
const { people, relationships, state, error, loadedCount, incomplete, reload } = useKinshipFamily(useBranchloomRepository(), projectId)
const fromId = computed(() => typeof route.query.from === 'string' ? route.query.from : '')
const toId = computed(() => typeof route.query.to === 'string' ? route.query.to : '')
const from = computed(() => people.value.find(({ id }) => id === fromId.value))
const to = computed(() => people.value.find(({ id }) => id === toId.value))
const fromName = computed(() => from.value ? getPrimaryName(from.value) : '')
const toName = computed(() => to.value ? getPrimaryName(to.value) : '')
const invalidSelection = computed(() => state.value === 'ready' && ((fromId.value && !from.value) || (toId.value && !to.value)))
const canDescribe = computed(() => state.value === 'ready' && !incomplete.value && from.value && to.value)
const forward = computed(() => canDescribe.value ? buildKinshipDescriptions(people.value, relationships.value, fromId.value).get(toId.value) : undefined)
const reverse = computed(() => canDescribe.value ? buildKinshipDescriptions(people.value, relationships.value, toId.value).get(fromId.value) : undefined)
const navigationError = ref('')
let navigationQueue = Promise.resolve()

function updateSelection(patch: { from?: string; to?: string } | 'swap') {
  const scope = projectId.value
  navigationQueue = navigationQueue.catch(() => undefined).then(async () => {
    if (route.name !== 'project-kinship' || projectId.value !== scope) return
    const changes = patch === 'swap' ? { from: toId.value, to: fromId.value } : patch
    const query = { ...route.query }
    for (const [key, value] of Object.entries(changes)) {
      if (value) query[key] = value
      else delete query[key]
    }
    navigationError.value = ''
    await router.replace({ name: 'project-kinship', params: { projectId: scope }, query })
  }).catch(() => { navigationError.value = '选择未能更新，请重试。' })
}
</script>

<template>
  <section class="kinship-view" aria-labelledby="kinship-title">
    <header class="kinship-view__heading">
      <h1 id="kinship-title">查称呼</h1>
      <p>选两个人，看看彼此怎么称呼。</p>
    </header>

    <div v-if="state === 'loading'" class="kinship-view__state" role="status" aria-busy="true">
      <IconUsersGroup :size="36" :stroke-width="1.4" aria-hidden="true" />
      <strong>正在读取人物与家庭关系…</strong>
      <span v-if="loadedCount">已读取 {{ loadedCount }} 位人物</span>
    </div>
    <div v-else-if="state === 'error'" class="kinship-view__state" role="alert">
      <strong>查询资料未能读取</strong><p>{{ error }}</p>
      <BaseButton variant="secondary" @click="reload">重新读取</BaseButton>
    </div>
    <div v-else-if="!people.length" class="kinship-view__state" role="status">
      <IconUsersGroup :size="36" :stroke-width="1.4" aria-hidden="true" />
      <strong>这个家谱还没有人物</strong><p>先建立人物档案、记录家庭关系，就能在这里查询称呼。</p>
      <RouterLink :to="{ name: 'project-people', params: { projectId } }">前往人物档案</RouterLink>
    </div>
    <template v-else>
      <div class="kinship-view__selection">
        <KinshipPersonPicker label="谁来称呼" :people="people" :model-value="fromId" @update:model-value="updateSelection({ from: $event })" />
        <BaseButton class="kinship-view__swap" variant="secondary" :disabled="!from || !to" aria-label="交换两个人物" @click="updateSelection('swap')">
          <IconArrowsExchange :size="22" aria-hidden="true" /><span>交换</span>
        </BaseButton>
        <KinshipPersonPicker label="称呼谁" :people="people" :model-value="toId" @update:model-value="updateSelection({ to: $event })" />
      </div>
      <p v-if="navigationError" class="kinship-view__notice" role="alert">{{ navigationError }}</p>
      <p v-if="invalidSelection" class="kinship-view__notice" role="alert">所选人物已被移除或不属于当前项目，请重新选择。</p>
      <div v-if="incomplete" class="kinship-view__state" role="alert">
        <strong>关系资料不完整，暂无法计算称呼</strong>
        <p>部分关系关联的人物资料缺失，请刷新资料或检查家庭关系后重试。</p>
        <BaseButton variant="secondary" @click="reload">重新读取</BaseButton>
      </div>
      <div v-else-if="!from || !to" class="kinship-view__state" role="status">
        <IconUsersGroup :size="36" :stroke-width="1.4" aria-hidden="true" />
        <strong>{{ from ? `选择另一位人物，看看${fromName}怎么称呼 TA` : '从两个人的名字开始' }}</strong>
        <p>支持搜索当前家谱中的姓名、字号和别名。</p>
      </div>
      <div v-else-if="!forward || !reverse" class="kinship-view__state" role="status">
        <IconRoute :size="36" :stroke-width="1.4" aria-hidden="true" />
        <strong>当前资料中未找到关系路径</strong>
        <p>可能尚未记录连接{{ fromName }}与{{ toName }}的家庭关系。</p>
      </div>
      <template v-else>
        <div class="kinship-view__answers" role="status" aria-label="双向称呼" aria-live="polite" aria-atomic="true">
          <div class="kinship-view__answer" data-kinship-direction="forward">
            <p>{{ fromName }}叫{{ toName }}</p>
            <strong :class="{ 'kinship-view__term--long': forward.label.length > 8 }">{{ forward.label }}</strong>
          </div>
          <div class="kinship-view__answer" data-kinship-direction="reverse">
            <p>{{ toName }}叫{{ fromName }}</p>
            <strong :class="{ 'kinship-view__term--long': reverse.label.length > 8 }">{{ reverse.label }}</strong>
          </div>
        </div>
        <section class="kinship-view__paths" aria-labelledby="kinship-path-title">
          <div class="kinship-view__path-heading"><h2 id="kinship-path-title">关系路径</h2><span>从{{ fromName }}出发</span></div>
          <p v-if="fromId === toId" class="kinship-view__path">选中的是同一位人物。</p>
          <p v-else class="kinship-view__path"><IconRoute :size="22" aria-hidden="true" /><span>{{ forward.paths[0] }}</span></p>
          <details v-if="forward.paths.length > 1">
            <summary>查看其他 {{ forward.paths.length - 1 }} 条最短关系路径</summary>
            <ul><li v-for="path in forward.paths.slice(1)" :key="path">{{ path }}</li></ul>
          </details>
        </section>
      </template>
      <footer class="kinship-view__footer">
        <p>根据已记录的最短关系路径推算；资料不全时，可能无法确定唯一称呼。</p>
        <RouterLink v-if="from" :to="{ name: 'project-tree', params: { projectId }, query: { personId: from.id, previewPersonId: from.id } }">在家谱中查看</RouterLink>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.kinship-view { width: min(62rem, 100%); margin: clamp(0rem, 2vw, 1.5rem) auto; padding: clamp(1.25rem, 4vw, 3rem); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.kinship-view a { color: var(--color-primary); font-weight: 650; text-underline-offset: .2em; }
.kinship-view__heading { margin-bottom: 2.5rem; }
.kinship-view__heading h1 { margin: 0; font-family: var(--font-heading); font-size: clamp(1.75rem, 3vw, 2.5rem); font-weight: 650; }
.kinship-view__heading p { margin: .65rem 0 0; color: var(--color-muted); line-height: 1.6; }
.kinship-view__selection { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: 1.25rem; padding-bottom: 2.5rem; }
.kinship-view__swap { min-width: 3.5rem; align-self: center; margin-top: 1.75rem; padding: .5rem; }
.kinship-view__swap :deep(.base-button__content) { flex-direction: column; gap: .25rem; font-size: .75rem; }
.kinship-view__answers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 2.5rem 0; border-block: 1px solid var(--color-border); }
.kinship-view__answer { display: flex; min-width: 0; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: .5rem 1.25rem; text-align: center; overflow-wrap: anywhere; }
.kinship-view__answer + .kinship-view__answer { border-left: 1px solid var(--color-border); }
.kinship-view__answer p { margin: 0; font-size: 1rem; line-height: 1.65; }
.kinship-view__answer strong { max-width: 100%; color: var(--color-primary-strong); font-family: var(--font-heading); font-size: clamp(2.5rem, 5.5vw, 4.5rem); font-weight: 650; line-height: 1.25; }
.kinship-view__answer .kinship-view__term--long { font-size: clamp(1.25rem, 2.6vw, 2rem); line-height: 1.6; }
.kinship-view__paths { padding: 1.75rem 0; }
.kinship-view__path-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: .75rem; }
.kinship-view__path-heading h2 { margin: 0; font-family: var(--font-heading); font-size: 1.125rem; }
.kinship-view__path-heading > span { color: var(--color-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.kinship-view__path { display: flex; align-items: flex-start; gap: .75rem; margin: 1.25rem 0 0; font-size: 1rem; line-height: 1.85; overflow-wrap: anywhere; }
.kinship-view__path > svg { flex: 0 0 auto; margin-top: .25rem; color: var(--color-primary); }
.kinship-view__paths details { margin-top: 1.25rem; font-size: .875rem; line-height: 1.8; }
.kinship-view__paths summary { padding: .35rem 0; color: var(--color-primary); cursor: pointer; }
.kinship-view__paths li { margin: .5rem 0; overflow-wrap: anywhere; }
.kinship-view__footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--color-border); }
.kinship-view__footer p { max-width: 36rem; margin: 0; color: var(--color-muted); font-size: .8125rem; line-height: 1.7; }
.kinship-view__footer a { flex: 0 0 auto; padding: .2rem 0; font-size: .875rem; }
.kinship-view__state { display: flex; min-height: 14rem; flex-direction: column; align-items: center; justify-content: center; gap: .75rem; padding: 1.5rem 0; border-top: 1px solid var(--color-border); text-align: center; overflow-wrap: anywhere; }
.kinship-view__state > svg { margin-bottom: .5rem; color: var(--color-primary); }
.kinship-view__state p, .kinship-view__state > span { max-width: 36rem; margin: 0; color: var(--color-muted); line-height: 1.7; }
.kinship-view__notice { margin: 0 0 1rem; color: var(--color-danger); font-size: .875rem; line-height: 1.7; }
@media (max-width: 40rem) {
  .kinship-view__heading { margin-bottom: 1.75rem; }
  .kinship-view__selection { grid-template-columns: minmax(0, 1fr); gap: .75rem; padding-bottom: 1.5rem; }
  .kinship-view__swap { justify-self: end; min-height: 2.75rem; margin: 0; padding: .5rem .75rem; }
  .kinship-view__swap :deep(.base-button__content) { flex-direction: row; }
  .kinship-view__answers { padding: 1.5rem 0; }
  .kinship-view__answer { gap: .75rem; padding: .25rem .6rem; }
  .kinship-view__answer p { font-size: .8125rem; }
  .kinship-view__footer { flex-direction: column; gap: .75rem; }
  .kinship-view__footer a { min-height: 2.75rem; display: inline-flex; align-items: center; }
}
</style>
