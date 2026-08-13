<script setup lang="ts">
import { IconBrandGithub } from '@tabler/icons-vue'
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import NewProjectForm from '../components/NewProjectForm.vue'
import { BrowserRecentProjectLocations } from '../model/recentProjectLocations'
import appIcon from '../../../../src-tauri/icons/icon.png'

const repository = useBranchloomRepository()
const route = useRoute()
const router = useRouter()
const recentLocations = new BrowserRecentProjectLocations()
const saving = ref(false)
const submitError = ref('')
const currentProjectId = computed(() => String(route.params.projectId ?? ''))
const isProjectTask = computed(() => Boolean(currentProjectId.value))

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message.trim() || fallback
}

async function createProject(input: { name: string; description: string }) {
  if (saving.value) return
  saving.value = true
  submitError.value = ''
  try {
    const project = await repository.createProject(input)
    try {
      recentLocations.record(project)
    } catch {
      // The project is safely stored even if the optional recent shortcut cannot be updated.
    }
    await router.push({ name: 'project-tree', params: { projectId: project.id } })
  } catch (error) {
    submitError.value = errorMessage(error, '项目未能建立，请重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    :class="['new-project-view', { 'new-project-view--task': isProjectTask }]"
    aria-labelledby="new-project-title"
  >
    <div class="new-project-view__intro">
      <p class="new-project-view__eyebrow">建立一份新的家族档案</p>
      <h1 id="new-project-title">从一个名字开始</h1>
      <p>
        不需要一次准备齐全。项目建立后，你可以从家谱树添加第一位家人，再慢慢补充关系、日期和资料来源。
      </p>
      <ul aria-label="新项目说明">
        <li><span aria-hidden="true">01</span> 项目资料保存在本机</li>
        <li><span aria-hidden="true">02</span> 项目名称和简介之后都可以修改</li>
        <li><span aria-hidden="true">03</span> 初建时可以暂不设置中心人物与封面</li>
      </ul>
    </div>
    <div class="new-project-view__panel">
      <div class="new-project-view__panel-heading">
        <img :src="appIcon" alt="" aria-hidden="true" />
        <div>
          <p>新项目</p>
          <h2>家族档案信息</h2>
        </div>
      </div>
      <NewProjectForm :saving="saving" :submit-error="submitError" @submit="createProject" />
      <RouterLink
        v-if="!isProjectTask"
        class="new-project-view__github-import"
        :to="{ name: 'github-import' }"
      >
        <IconBrandGithub :size="18" aria-hidden="true" />
        已有 GitHub 项目？直接导入
      </RouterLink>
      <RouterLink v-if="!isProjectTask" class="new-project-view__cancel" :to="{ name: 'home' }">
        返回最近项目
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.new-project-view {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 0.9fr) minmax(24rem, 1.1fr);
  align-items: center;
  gap: clamp(2.5rem, 8vw, 7rem);
}

.new-project-view__eyebrow,
.new-project-view__panel-heading p {
  margin: 0;
  color: var(--color-accent);
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.new-project-view__intro h1 {
  margin: var(--space-3) 0 0;
  font-family: var(--font-heading);
  font-size: clamp(2.5rem, 6vw, 4.75rem);
  font-weight: 550;
  letter-spacing: -0.04em;
  line-height: 1.05;
}

.new-project-view__intro > p:not(.new-project-view__eyebrow) {
  max-width: 35rem;
  margin: var(--space-6) 0 0;
  color: var(--color-muted);
}

.new-project-view__intro ul {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-6) 0 0;
  margin: var(--space-6) 0 0;
  border-top: 1px solid var(--color-border);
  list-style: none;
  color: var(--color-muted);
  font-size: 0.875rem;
}

.new-project-view__intro li {
  display: grid;
  grid-template-columns: 2rem 1fr;
  gap: var(--space-3);
}

.new-project-view__intro li span {
  color: var(--color-accent);
  font-weight: 750;
}

.new-project-view__panel {
  display: grid;
  gap: var(--space-6);
  padding: clamp(1.5rem, 5vw, 3.5rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: rgb(255 252 246 / 92%);
  box-shadow: var(--shadow-lg);
}

.new-project-view__panel-heading {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--color-border);
}

.new-project-view__panel-heading > img {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  object-fit: cover;
}

.new-project-view__panel-heading h2 {
  margin: var(--space-1) 0 0;
  font-family: var(--font-heading);
  font-size: 1.5rem;
}

.new-project-view__cancel {
  justify-self: start;
  color: var(--color-muted);
  font-size: 0.875rem;
}

.new-project-view__github-import {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-muted-surface);
  color: var(--color-primary);
  font-weight: 700;
  text-decoration: none;
}

.new-project-view--task {
  width: min(68rem, 100%);
  grid-template-columns: minmax(0, .8fr) minmax(23rem, 1.2fr);
  gap: clamp(2rem, 5vw, 4.5rem);
  margin: 0 auto;
}

.new-project-view--task .new-project-view__intro h1 {
  font-size: clamp(2.75rem, 5vw, 4rem);
}

.new-project-view--task .new-project-view__panel {
  padding: clamp(1.5rem, 3vw, 2.5rem);
}

@media (max-width: 52rem) {
  .new-project-view {
    grid-template-columns: 1fr;
  }
}
</style>
