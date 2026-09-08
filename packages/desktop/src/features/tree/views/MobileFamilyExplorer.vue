<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  IconArrowLeft,
  IconChevronRight,
  IconGitBranch,
  IconPlus,
  IconUser,
} from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import EmptyState from '../../../design-system/EmptyState.vue'
import type { BoundedFamilySlice, Person, Project, Relationship } from '../../../shared/domain/types'
import { getPrimaryName } from '../../../shared/domain/personNames'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import QuickAddRelativeDialog from '../../relationships/components/QuickAddRelativeDialog.vue'
import {
  buildMobileFamilyBranches,
  type MobileFamilyBranchKey,
} from '../model/buildMobileFamilyBranches'

const route = useRoute()
const router = useRouter()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const requestedCenterId = computed(() => typeof route.query.personId === 'string'
  ? route.query.personId
  : '')
const project = ref<Project>()
const familySlice = shallowRef<BoundedFamilySlice>()
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const trail = ref<Person[]>([])
const changingCenterId = ref('')
const quickAddOpen = ref(false)
const quickAddPreset = ref<'parent' | 'partner' | 'child' | 'custom'>('custom')
let latestRequest = 0

const centerPerson = computed(() => familySlice.value?.people
  .find(({ id }) => id === familySlice.value?.centerPersonId))
const centerName = computed(() => centerPerson.value ? getPrimaryName(centerPerson.value) : '未选择中心人物')
const branches = computed(() => familySlice.value
  ? buildMobileFamilyBranches(familySlice.value, familySlice.value.centerPersonId)
  : [])

watch(
  [projectId, requestedCenterId],
  ([nextProjectId], [previousProjectId]) => {
    if (nextProjectId !== previousProjectId) trail.value = []
    quickAddOpen.value = false
    void load()
  },
  { immediate: true },
)

function lifeSummary(person: Person): string {
  if (!person.birth && !person.death) return person.status === 'living' ? '在世' : '生卒时间待考'
  return [person.birth?.display ?? '生年待考', person.death?.display ?? ''].filter(Boolean).join(' — ')
}

function branchAddPreset(key: MobileFamilyBranchKey) {
  if (key === 'parents') return 'parent' as const
  if (key === 'partners') return 'partner' as const
  if (key === 'children') return 'child' as const
  return undefined
}

async function load() {
  const request = ++latestRequest
  const scopedProjectId = projectId.value
  const routeCenterId = requestedCenterId.value
  loadState.value = 'loading'
  loadError.value = ''
  changingCenterId.value = routeCenterId
  try {
    const loadedProject = project.value?.id === scopedProjectId
      ? project.value
      : await repository.getProject(scopedProjectId)
    let centerId = routeCenterId || loadedProject.defaultPersonId || ''
    if (!centerId) {
      const page = await repository.listPeople(scopedProjectId, {
        page: 1,
        pageSize: 1,
        sort: 'updatedAt',
      })
      centerId = page.items[0]?.id ?? ''
    }
    const slice = centerId
      ? await repository.getTreeFamilySlice(scopedProjectId, centerId, {
          generationsUp: 1,
          generationsDown: 1,
        })
      : undefined
    if (request !== latestRequest || scopedProjectId !== projectId.value) return
    project.value = loadedProject
    familySlice.value = slice
    loadState.value = 'ready'
    changingCenterId.value = ''
    if (centerId && !routeCenterId) {
      await router.replace({ query: { ...route.query, personId: centerId } })
    }
  } catch (error) {
    if (request !== latestRequest) return
    loadError.value = error instanceof Error ? error.message : '家谱关系暂时无法读取'
    loadState.value = 'error'
    changingCenterId.value = ''
  }
}

async function changeCenter(person: Person) {
  if (!centerPerson.value || person.id === centerPerson.value.id) return
  trail.value.push(centerPerson.value)
  changingCenterId.value = person.id
  await router.replace({ query: { ...route.query, personId: person.id } })
}

async function returnToPreviousCenter() {
  const previous = trail.value.pop()
  if (!previous) return
  changingCenterId.value = previous.id
  await router.replace({ query: { ...route.query, personId: previous.id } })
}

function openQuickAdd(preset: 'parent' | 'partner' | 'child' | 'custom') {
  quickAddPreset.value = preset
  quickAddOpen.value = true
}

function openBranchQuickAdd(key: MobileFamilyBranchKey) {
  const preset = branchAddPreset(key)
  if (preset) openQuickAdd(preset)
}

async function handleRelativeSaved(_person: Person, _relationship: Relationship) {
  quickAddOpen.value = false
  await load()
}

function fitCanvas() {
  document.querySelector('.mobile-family-explorer__center')?.scrollIntoView({ block: 'start' })
}

function addPerson() {
  void router.push({ name: 'person-new', params: { projectId: projectId.value } })
}

defineExpose({ fitCanvas, addPerson })
</script>

<template>
  <section class="mobile-family-explorer" aria-labelledby="mobile-family-title">
    <header class="mobile-family-explorer__intro">
      <div>
        <p>以人物为中心</p>
        <h1 id="mobile-family-title">逐层读家谱</h1>
      </div>
      <RouterLink
        :to="{ name: 'project-people', params: { projectId } }"
        aria-label="搜索并选择中心人物"
      >
        <IconUser :size="19" aria-hidden="true" />选择人物
      </RouterLink>
    </header>

    <div v-if="trail.length" class="mobile-family-explorer__trail" aria-label="探索路径">
      <button type="button" @click="returnToPreviousCenter">
        <IconArrowLeft :size="18" aria-hidden="true" />
        返回 {{ getPrimaryName(trail[trail.length - 1]!) }}
      </button>
      <span>{{ trail.length }} 步探索</span>
    </div>

    <div v-if="loadState === 'loading'" class="mobile-family-explorer__state" role="status">
      <span aria-hidden="true" />
      正在展开 {{ changingCenterId ? '这一支' : '家谱' }}…
    </div>

    <div v-else-if="loadState === 'error'" class="mobile-family-explorer__state mobile-family-explorer__state--error" role="alert">
      <strong>这一支家谱未能展开</strong>
      <p>{{ loadError }}</p>
      <BaseButton size="sm" variant="secondary" @click="load">重新读取</BaseButton>
    </div>

    <EmptyState
      v-else-if="!centerPerson"
      title="还没有中心人物"
      description="先建立一位人物，再从他或她出发记录家族关系。"
    >
      <span class="mobile-family-explorer__empty-mark">谱</span>
      <template #actions>
        <RouterLink :to="{ name: 'person-new', params: { projectId } }">建立第一个人物</RouterLink>
      </template>
    </EmptyState>

    <template v-else>
      <article class="mobile-family-explorer__center" aria-live="polite">
        <div class="mobile-family-explorer__portrait" aria-hidden="true">
          <img v-if="centerPerson.avatarUrl" :src="centerPerson.avatarUrl" alt="" />
          <span v-else>{{ centerName.slice(0, 1) }}</span>
        </div>
        <div class="mobile-family-explorer__identity">
          <p>当前中心人物</p>
          <h2>{{ centerName }}</h2>
          <span>{{ lifeSummary(centerPerson) }}</span>
        </div>
        <RouterLink
          class="mobile-family-explorer__profile"
          :to="{
            name: 'person-detail',
            params: { projectId, personId: centerPerson.id },
            query: { returnTo: route.fullPath },
          }"
        >查看档案</RouterLink>
        <button
          type="button"
          class="mobile-family-explorer__add-relative"
          :aria-label="`为${centerName}添加亲属`"
          @click="openQuickAdd('custom')"
        >
          <IconPlus :size="18" aria-hidden="true" />添加亲属
        </button>
      </article>

      <div class="mobile-family-explorer__branches">
        <section
          v-for="branch in branches"
          :key="branch.key"
          class="mobile-family-explorer__branch"
          :data-branch="branch.key"
          :aria-labelledby="`mobile-family-${branch.key}`"
        >
          <header>
            <span class="mobile-family-explorer__branch-mark" aria-hidden="true">
              <IconGitBranch :size="17" />
            </span>
            <div>
              <p>{{ branch.hint }}</p>
              <h3 :id="`mobile-family-${branch.key}`">{{ branch.label }}</h3>
            </div>
            <span class="mobile-family-explorer__count">{{ branch.items.length }}</span>
            <button
              v-if="branchAddPreset(branch.key)"
              type="button"
              :aria-label="`为${centerName}添加${branch.label}`"
              @click="openBranchQuickAdd(branch.key)"
            >
              <IconPlus :size="18" aria-hidden="true" />
            </button>
          </header>

          <div v-if="branch.items.length" class="mobile-family-explorer__people">
            <button
              v-for="item in branch.items"
              :key="`${branch.key}-${item.relationship.id}-${item.person.id}`"
              type="button"
              :aria-label="`以${getPrimaryName(item.person)}为中心继续探索`"
              @click="changeCenter(item.person)"
            >
              <span class="mobile-family-explorer__mini-portrait" aria-hidden="true">
                <img v-if="item.person.avatarUrl" :src="item.person.avatarUrl" alt="" />
                <span v-else>{{ getPrimaryName(item.person).slice(0, 1) }}</span>
              </span>
              <span class="mobile-family-explorer__person-copy">
                <small>{{ item.relationLabel }}</small>
                <strong>{{ getPrimaryName(item.person) }}</strong>
                <span>{{ lifeSummary(item.person) }}</span>
              </span>
              <IconChevronRight :size="20" aria-hidden="true" />
            </button>
          </div>
          <p v-else class="mobile-family-explorer__empty-branch">这一支还没有记录</p>
        </section>
      </div>
    </template>

    <QuickAddRelativeDialog
      v-if="centerPerson"
      :open="quickAddOpen"
      :project-id="projectId"
      :person="centerPerson"
      :preset="quickAddPreset"
      @close="quickAddOpen = false"
      @saved="handleRelativeSaved"
    />
  </section>
</template>

<style scoped>
.mobile-family-explorer {
  min-height: 100%;
  padding: 1rem 1rem calc(2rem + env(safe-area-inset-bottom));
  background:
    linear-gradient(90deg, transparent 1.4rem, rgb(63 109 84 / 11%) 1.4rem, rgb(63 109 84 / 11%) calc(1.4rem + 1px), transparent calc(1.4rem + 1px)),
    var(--color-background);
}

.mobile-family-explorer__intro {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  padding: .35rem .25rem 1rem;
}

.mobile-family-explorer__intro p,
.mobile-family-explorer__intro h1,
.mobile-family-explorer__identity p,
.mobile-family-explorer__identity h2,
.mobile-family-explorer__branch header p,
.mobile-family-explorer__branch header h3 {
  margin: 0;
}

.mobile-family-explorer__intro p,
.mobile-family-explorer__identity p,
.mobile-family-explorer__branch header p {
  color: var(--color-muted);
  font-size: .7rem;
  font-weight: 720;
  letter-spacing: .08em;
}

.mobile-family-explorer__intro h1 {
  margin-top: .1rem;
  font-family: var(--font-heading);
  font-size: clamp(1.55rem, 7vw, 2.1rem);
  font-weight: 580;
}

.mobile-family-explorer__intro > a,
.mobile-family-explorer__trail button {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  gap: .4rem;
  padding: 0 .8rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-primary-strong);
  font-size: .78rem;
  font-weight: 720;
  text-decoration: none;
}

.mobile-family-explorer__trail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: .85rem;
}

.mobile-family-explorer__trail button {
  border: 0;
  padding-left: .25rem;
  background: transparent;
}

.mobile-family-explorer__trail > span {
  color: var(--color-muted);
  font-size: .72rem;
}

.mobile-family-explorer__state {
  display: grid;
  min-height: 18rem;
  place-content: center;
  justify-items: center;
  gap: var(--space-3);
  color: var(--color-muted);
  text-align: center;
}

.mobile-family-explorer__state > span {
  width: 2rem;
  height: 2rem;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: mobile-family-spin .75s linear infinite;
}

.mobile-family-explorer__state--error {
  min-height: 12rem;
  padding: var(--space-6);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

.mobile-family-explorer__state--error p {
  margin: 0;
}

.mobile-family-explorer__center {
  position: relative;
  display: grid;
  min-height: 9.5rem;
  align-items: center;
  gap: .8rem 1rem;
  padding: 1.1rem;
  border: 1px solid rgb(36 74 61 / 32%);
  border-radius: 1.25rem;
  background: var(--color-primary-strong);
  box-shadow: 0 12px 28px rgb(36 74 61 / 18%);
  color: #fffdf8;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.mobile-family-explorer__portrait,
.mobile-family-explorer__mini-portrait {
  display: grid;
  overflow: hidden;
  place-items: center;
  border-radius: 50%;
  background: var(--color-muted-surface);
  color: var(--color-primary-strong);
  font-family: var(--font-heading);
}

.mobile-family-explorer__portrait {
  width: 4.2rem;
  height: 4.2rem;
  border: 2px solid rgb(255 253 248 / 75%);
  font-size: 1.55rem;
}

.mobile-family-explorer__portrait img,
.mobile-family-explorer__mini-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mobile-family-explorer__identity {
  min-width: 0;
}

.mobile-family-explorer__identity p {
  color: rgb(255 253 248 / 68%);
}

.mobile-family-explorer__identity h2 {
  overflow: hidden;
  margin-top: .15rem;
  font-family: var(--font-heading);
  font-size: 1.55rem;
  font-weight: 580;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-family-explorer__identity > span {
  display: block;
  margin-top: .2rem;
  color: rgb(255 253 248 / 72%);
  font-size: .76rem;
}

.mobile-family-explorer__profile {
  color: #fffdf8;
  font-size: .75rem;
  font-weight: 720;
  text-underline-offset: .2rem;
}

.mobile-family-explorer__add-relative {
  display: inline-flex;
  min-height: 2.65rem;
  align-items: center;
  justify-content: center;
  gap: .35rem;
  grid-column: 1 / -1;
  border: 1px solid rgb(255 253 248 / 28%);
  border-radius: .7rem;
  background: rgb(255 253 248 / 9%);
  color: #fffdf8;
  font-size: .8rem;
  font-weight: 720;
}

.mobile-family-explorer__branches {
  display: grid;
  gap: 1rem;
  margin-top: 1.15rem;
}

.mobile-family-explorer__branch {
  position: relative;
  margin-left: .4rem;
  padding: .85rem .8rem .85rem 1.1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  box-shadow: var(--shadow-sm);
}

.mobile-family-explorer__branch::before {
  position: absolute;
  top: 1.4rem;
  left: -.68rem;
  width: .9rem;
  border-top: 1px solid var(--color-primary);
  content: '';
}

.mobile-family-explorer__branch > header {
  display: grid;
  align-items: center;
  gap: .65rem;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
}

.mobile-family-explorer__branch-mark {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border-radius: .6rem;
  background: var(--color-muted-surface);
  color: var(--color-primary);
}

.mobile-family-explorer__branch header h3 {
  font-family: var(--font-heading);
  font-size: 1rem;
  font-weight: 620;
}

.mobile-family-explorer__count {
  display: grid;
  min-width: 1.55rem;
  height: 1.55rem;
  place-items: center;
  border-radius: 50%;
  background: var(--color-paper-tint);
  color: var(--color-muted);
  font-size: .7rem;
}

.mobile-family-explorer__branch > header > button {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-primary);
}

.mobile-family-explorer__people {
  display: grid;
  gap: .45rem;
  margin-top: .75rem;
}

.mobile-family-explorer__people > button {
  display: grid;
  width: 100%;
  min-height: 4.25rem;
  align-items: center;
  gap: .75rem;
  padding: .55rem .35rem .55rem .2rem;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
  background: transparent;
  color: var(--color-text);
  grid-template-columns: auto minmax(0, 1fr) auto;
  text-align: left;
}

.mobile-family-explorer__mini-portrait {
  width: 2.7rem;
  height: 2.7rem;
  font-size: 1rem;
}

.mobile-family-explorer__person-copy {
  display: grid;
  min-width: 0;
  gap: .05rem;
}

.mobile-family-explorer__person-copy small {
  color: var(--color-accent);
  font-size: .66rem;
  font-weight: 720;
}

.mobile-family-explorer__person-copy strong {
  overflow: hidden;
  font-family: var(--font-heading);
  font-size: 1rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-family-explorer__person-copy > span {
  color: var(--color-muted);
  font-size: .7rem;
}

.mobile-family-explorer__empty-branch {
  margin: .8rem 0 .1rem 2.65rem;
  color: var(--color-muted);
  font-size: .76rem;
}

.mobile-family-explorer__empty-mark {
  display: grid;
  width: 3.2rem;
  height: 3.2rem;
  place-items: center;
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--color-surface);
  font-family: var(--font-heading);
  font-size: 1.3rem;
}

@keyframes mobile-family-spin {
  to { transform: rotate(360deg); }
}

@media (min-width: 40rem) {
  .mobile-family-explorer {
    max-width: 48rem;
    padding-inline: 1.5rem;
    margin: 0 auto;
  }

  .mobile-family-explorer__branches {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
