<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  IconArrowRight,
  IconClock,
  IconFileImport,
  IconHistory,
  IconNetwork,
  IconPlus,
  IconSettings,
  IconShieldCheck,
} from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import type { Project, ProjectSummary } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import ProjectStats from '../components/ProjectStats.vue'

const route = useRoute()
const repository = useBranchloomRepository()
const projectId = computed(() => String(route.params.projectId ?? ''))
const project = ref<Project>()
const summary = ref<ProjectSummary>()
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
let loadRequest = 0

const managementLinks = computed(() => [
  {
    label: '导入与导出',
    ariaLabel: '打开导入与导出',
    description: '交换 GEDCOM、备份包与打印资料',
    icon: IconFileImport,
    to: `/project/${projectId.value}/manage/exchange`,
  },
  {
    label: '项目设置',
    ariaLabel: '打开项目设置',
    description: '编辑档案信息与备份策略',
    icon: IconSettings,
    to: `/project/${projectId.value}/manage/settings`,
  },
  {
    label: '备份与历史',
    ariaLabel: '打开备份与历史',
    description: '创建快照并查看修改记录',
    icon: IconHistory,
    to: `/project/${projectId.value}/manage/history`,
  },
  {
    label: '检查与维护',
    ariaLabel: '打开检查与维护',
    description: '发现重复、缺失和结构问题',
    icon: IconShieldCheck,
    to: `/project/${projectId.value}/manage/checks`,
  },
])

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '时间记录无效'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

async function loadOverview() {
  const request = ++loadRequest
  const scopedProjectId = projectId.value
  loadState.value = 'loading'
  loadError.value = ''
  try {
    const [nextProject, nextSummary] = await Promise.all([
      repository.getProject(scopedProjectId),
      repository.getProjectSummary(scopedProjectId),
    ])
    if (request !== loadRequest) return
    project.value = nextProject
    summary.value = nextSummary
    loadState.value = 'ready'
  } catch (error) {
    if (request !== loadRequest) return
    loadError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '项目概览暂时无法读取'
    loadState.value = 'error'
  }
}

watch(projectId, () => { void loadOverview() }, { immediate: true })
</script>

<template>
  <section class="project-overview" aria-labelledby="project-overview-title">
    <header class="project-overview__heading">
      <div>
        <p>项目管理</p>
        <h1 id="project-overview-title">项目概览</h1>
        <span>查看当前档案状态，并集中处理项目级操作。</span>
      </div>
      <RouterLink
        class="project-overview__create"
        :to="{ name: 'project-new', params: { projectId } }"
        aria-label="新建项目"
      >
        <IconPlus :size="19" aria-hidden="true" />
        新建项目
      </RouterLink>
    </header>
    <div v-if="loadState === 'loading'" class="project-overview__state" role="status">正在汇总项目资料…</div>
    <div v-else-if="loadState === 'error'" class="project-overview__state project-overview__state--error" role="alert">
      <strong>项目概览暂时无法读取</strong><span>{{ loadError }}</span>
      <BaseButton size="sm" variant="secondary" @click="loadOverview">重新读取</BaseButton>
    </div>
    <template v-else-if="project && summary">
      <section class="project-overview__intro">
        <div>
          <span>当前档案</span>
          <h2>{{ project.name }}</h2>
          <p>{{ project.description || '尚未填写项目简介。' }}</p>
        </div>
        <RouterLink :to="`/project/${projectId}/tree`">
          <IconNetwork :size="20" aria-hidden="true" />
          打开家谱树
        </RouterLink>
      </section>

      <section class="project-overview__section" aria-labelledby="project-stats-title">
        <div class="project-overview__section-heading">
          <div>
            <p>档案规模</p>
            <h2 id="project-stats-title">项目数据</h2>
          </div>
          <span>本地保存 · 自动汇总</span>
        </div>
        <ProjectStats :summary="summary" />
      </section>

      <section class="project-overview__section" aria-labelledby="project-tools-title">
        <div class="project-overview__section-heading">
          <div>
            <p>快捷操作</p>
            <h2 id="project-tools-title">管理工具</h2>
          </div>
        </div>
        <nav class="project-overview__tools" aria-label="项目管理导航">
          <RouterLink
            v-for="item in managementLinks"
            :key="item.label"
            :to="item.to"
            :aria-label="item.ariaLabel"
          >
            <component :is="item.icon" :size="21" :stroke-width="1.7" aria-hidden="true" />
            <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
            <IconArrowRight :size="18" aria-hidden="true" />
          </RouterLink>
        </nav>
      </section>

      <section class="project-overview__section" aria-labelledby="project-activity-title">
        <div class="project-overview__section-heading">
          <div>
            <p>时间记录</p>
            <h2 id="project-activity-title">最近活动</h2>
          </div>
        </div>
        <dl class="project-overview__timestamps">
          <div>
            <dt><IconClock :size="20" aria-hidden="true" />最近修改</dt>
            <dd><time data-field="updatedAt" :datetime="summary.updatedAt">{{ formatDate(summary.updatedAt) }}</time></dd>
          </div>
          <div>
            <dt><IconHistory :size="20" aria-hidden="true" />最近备份</dt>
            <dd><time v-if="summary.lastBackupAt" data-field="lastBackupAt" :datetime="summary.lastBackupAt">{{ formatDate(summary.lastBackupAt) }}</time><span v-else>尚无备份记录</span></dd>
          </div>
        </dl>
      </section>
    </template>
  </section>
</template>

<style scoped>
.project-overview {
  display: grid;
  width: min(72rem, 100%);
  gap: var(--space-4);
  margin: 0 auto;
}

.project-overview__heading,
.project-overview__intro,
.project-overview__section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
}

.project-overview__heading {
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.project-overview__heading p,
.project-overview__heading h1,
.project-overview__heading span,
.project-overview__intro h2,
.project-overview__intro p,
.project-overview__section-heading p,
.project-overview__section-heading h2 {
  margin: 0;
}

.project-overview__heading p,
.project-overview__section-heading p {
  color: var(--color-accent);
  font-size: .7rem;
  font-weight: 750;
  letter-spacing: .12em;
}

.project-overview__heading h1 {
  margin-top: var(--space-1);
  font-family: var(--font-heading);
  font-size: clamp(1.85rem, 3vw, 2.35rem);
  font-weight: 560;
}

.project-overview__heading div > span {
  display: block;
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: .8125rem;
}

.project-overview__create,
.project-overview__intro > a {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  border-radius: var(--radius-sm);
  font-size: .875rem;
  font-weight: 700;
  text-decoration: none;
}

.project-overview__create {
  background: var(--color-primary);
  color: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.project-overview__intro {
  min-height: 7rem;
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-lg);
  background: var(--color-primary);
  color: var(--color-surface);
  box-shadow: var(--shadow-md);
}

.project-overview__intro span {
  color: rgb(255 253 248 / 76%);
  font-size: .7rem;
  font-weight: 750;
  letter-spacing: .12em;
}

.project-overview__intro h2 {
  margin-top: var(--space-1);
  font-family: var(--font-heading);
  font-size: clamp(1.65rem, 3vw, 2.2rem);
  font-weight: 540;
}

.project-overview__intro p {
  max-width: 46rem;
  margin-top: var(--space-2);
  color: rgb(255 253 248 / 78%);
}

.project-overview__intro > a {
  flex: none;
  background: var(--color-surface);
  color: var(--color-primary);
}

.project-overview__section {
  display: grid;
  gap: var(--space-2);
}

.project-overview__section-heading h2 {
  margin-top: .15rem;
  font-family: var(--font-heading);
  font-size: 1.25rem;
  font-weight: 600;
}

.project-overview__section-heading > span {
  color: var(--color-muted);
  font-size: .75rem;
}

.project-overview__tools {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.project-overview__tools a {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-primary);
  text-decoration: none;
  box-shadow: var(--shadow-sm);
}

.project-overview__tools a:hover {
  border-color: var(--color-primary);
}

.project-overview__tools a span,
.project-overview__tools a strong,
.project-overview__tools a small {
  display: block;
  min-width: 0;
}

.project-overview__tools a strong {
  color: var(--color-text);
  font-size: .8125rem;
}

.project-overview__tools a small {
  margin-top: .15rem;
  overflow: hidden;
  color: var(--color-muted);
  font-size: .68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-overview__timestamps {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin: 0;
}

.project-overview__timestamps > div {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.project-overview__timestamps dt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-muted);
  font-size: .75rem;
}

.project-overview__timestamps dt svg {
  color: var(--color-primary);
}

.project-overview__timestamps dd {
  margin: .15rem 0 0;
  font-size: .875rem;
  font-weight: 650;
}

.project-overview__state {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  padding: var(--space-8);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
}

.project-overview__state--error {
  color: var(--color-danger);
}

@media (max-width: 70rem) {
  .project-overview__tools { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 44rem) {
  .project-overview__heading,
  .project-overview__intro {
    align-items: stretch;
    flex-direction: column;
  }

  .project-overview__create,
  .project-overview__intro > a {
    align-self: flex-start;
  }

  .project-overview__tools,
  .project-overview__timestamps {
    grid-template-columns: 1fr;
  }
}
</style>
