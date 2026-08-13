<script setup lang="ts">
import { IconBrandGithub, IconRobot } from '@tabler/icons-vue'
import { RouterLink, RouterView } from 'vue-router'
import DataRefreshButton from '../components/DataRefreshButton.vue'
import PageBackLink from '../components/PageBackLink.vue'
</script>

<template>
  <div class="home-layout">
    <header class="home-layout__header" data-tauri-drag-region>
      <RouterLink class="home-layout__brand" to="/" aria-label="Branchloom 首页">
        <span aria-hidden="true">B</span>
        <strong>Branchloom</strong>
      </RouterLink>
      <div class="home-layout__header-actions">
        <p>一座属于你们家的私人档案馆</p>
        <RouterLink
          class="home-layout__github-import"
          to="/github-import"
          aria-label="从 GitHub 导入项目"
        >
          <IconBrandGithub :size="17" aria-hidden="true" /><span>从 GitHub 导入</span>
        </RouterLink>
        <RouterLink class="home-layout__ai-tools" to="/ai-tools">
          <IconRobot :size="17" aria-hidden="true" />AI 工具
        </RouterLink>
        <DataRefreshButton />
      </div>
    </header>
    <main class="home-layout__main" data-tauri-drag-region>
      <PageBackLink />
      <RouterView />
    </main>
    <footer class="home-layout__footer">离线优先 · 本地保存 · 家族共同记忆</footer>
  </div>
</template>

<style scoped>
.home-layout {
  position: relative;
  display: grid;
  min-height: calc(100dvh - 2rem);
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
}

.home-layout::before,
.home-layout::after {
  position: absolute;
  z-index: -1;
  border: 1px solid rgb(80 107 87 / 14%);
  border-radius: 50%;
  content: '';
}

.home-layout::before {
  top: -15rem;
  right: -9rem;
  width: 34rem;
  height: 34rem;
}

.home-layout::after {
  bottom: -19rem;
  left: -12rem;
  width: 38rem;
  height: 38rem;
}

.home-layout__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-6) clamp(1.25rem, 6vw, 5rem);
}

.home-layout__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text);
  font-family: var(--font-heading);
  font-size: 1.25rem;
  text-decoration: none;
}

.home-layout__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.home-layout__ai-tools,
.home-layout__github-import {
  display: inline-flex;
  min-height: 2.25rem;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-primary);
  font-size: .82rem;
  font-weight: 700;
  text-decoration: none;
}

.home-layout__brand span {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border-radius: 50% 48% 45% 52%;
  background: var(--color-primary);
  color: var(--color-surface);
}

.home-layout__header p,
.home-layout__footer {
  color: var(--color-muted);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
}

.home-layout__main {
  display: grid;
  width: min(76rem, 100%);
  place-items: center;
  margin: 0 auto;
  padding: clamp(2rem, 8vw, 7rem) clamp(1.25rem, 6vw, 5rem);
}

.home-layout__footer {
  padding: var(--space-6);
  text-align: center;
}

@media (max-width: 52rem) {
  .home-layout__header p {
    display: none;
  }
}

@media (max-width: 40rem) {
  .home-layout__header {
    gap: var(--space-2);
    padding-right: var(--space-4);
    padding-left: var(--space-4);
  }

  .home-layout__header-actions {
    gap: var(--space-2);
  }

  .home-layout__brand strong {
    display: none;
  }

  .home-layout__github-import span {
    display: none;
  }
}
</style>
