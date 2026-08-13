<script setup lang="ts">
import { IconBrandGithub, IconLock } from '@tabler/icons-vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import type { GithubProjectImportResult } from '../../../shared/githubSync'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import { requestNativeRepositoryRefresh } from '../../../shared/repository/TauriRepository'
import { BrowserRecentProjectLocations } from '../../projects/model/recentProjectLocations'
import GithubProjectImportPanel from '../components/GithubProjectImportPanel.vue'

const repository = useBranchloomRepository()
const router = useRouter()
const recentLocations = new BrowserRecentProjectLocations()
const navigationError = ref('')

async function openProject(projectId: string) {
  navigationError.value = ''
  try {
    await requestNativeRepositoryRefresh(repository)
    const project = await repository.getProject(projectId)
    recentLocations.record(project)
    await router.replace({ name: 'project-tree', params: { projectId } })
  } catch (error) {
    navigationError.value = error instanceof Error && error.message.trim()
      ? error.message
      : '项目已经导入，但暂时无法打开。请返回首页后重试。'
  }
}

async function handleImported(result: GithubProjectImportResult) {
  await openProject(result.projectId)
}
</script>

<template>
  <section class="github-import-view" aria-labelledby="github-import-title">
    <div class="github-import-view__intro">
      <span class="github-import-view__icon" aria-hidden="true">
        <IconBrandGithub :size="30" />
      </span>
      <p class="github-import-view__eyebrow">加入已有家族档案</p>
      <h1 id="github-import-title">从 GitHub 导入</h1>
      <p>
        直接读取家人已经同步的 Branchloom 私有仓库，保留原有稳定项目身份，并在本机建立同步基线。
      </p>
      <div class="github-import-view__privacy">
        <IconLock :size="20" aria-hidden="true" />
        <span>导入预览不会修改 GitHub；Token 只保存在系统安全凭据中。</span>
      </div>
    </div>

    <div class="github-import-view__panel">
      <GithubProjectImportPanel @imported="handleImported" @existing="openProject" />
      <p v-if="navigationError" class="github-import-view__error" role="alert">
        {{ navigationError }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.github-import-view {
  display: grid;
  width: min(72rem, 100%);
  grid-template-columns: minmax(18rem, .8fr) minmax(30rem, 1.2fr);
  align-items: center;
  gap: clamp(2.5rem, 7vw, 6rem);
}

.github-import-view__intro {
  display: grid;
  justify-items: start;
}

.github-import-view__icon {
  display: grid;
  width: 4rem;
  height: 4rem;
  place-items: center;
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--color-surface);
}

.github-import-view__eyebrow {
  margin: var(--space-5) 0 0;
  color: var(--color-accent);
  font-size: .75rem;
  font-weight: 750;
  letter-spacing: .14em;
  text-transform: uppercase;
}

.github-import-view h1 {
  margin: var(--space-2) 0 0;
  font-family: var(--font-heading);
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  font-weight: 550;
  letter-spacing: -.04em;
  line-height: 1.05;
}

.github-import-view__intro > p:not(.github-import-view__eyebrow) {
  margin: var(--space-5) 0 0;
  color: var(--color-muted);
  line-height: 1.7;
}

.github-import-view__privacy {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2);
  padding-top: var(--space-5);
  margin-top: var(--space-5);
  border-top: 1px solid var(--color-border);
  color: var(--color-muted);
  font-size: .875rem;
}

.github-import-view__panel {
  display: grid;
  gap: var(--space-4);
  padding: clamp(1.5rem, 4vw, 3rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: rgb(255 252 246 / 94%);
  box-shadow: var(--shadow-lg);
}

.github-import-view__error {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger);
}

@media (max-width: 60rem) {
  .github-import-view {
    grid-template-columns: 1fr;
  }
}
</style>
