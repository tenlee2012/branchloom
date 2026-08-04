<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const title = computed(() => String(route.meta.title ?? 'Branchloom'))
const eyebrow = computed(() => String(route.meta.eyebrow ?? '家族档案'))
</script>

<template>
  <section class="route-placeholder" :aria-labelledby="`page-${String(route.name)}`">
    <p class="route-placeholder__eyebrow">{{ eyebrow }}</p>
    <h1 :id="`page-${String(route.name)}`">{{ title }}</h1>
    <p class="route-placeholder__copy">
      这一页的核心工作区将在后续功能步骤中展开，应用导航与本地保存已经就绪。
    </p>
    <div class="route-placeholder__rule" aria-hidden="true">
      <span />
      <i>✦</i>
      <span />
    </div>
  </section>
</template>

<style scoped>
.route-placeholder {
  width: min(48rem, 100%);
  padding: clamp(2rem, 6vw, 5rem);
  border: 1px solid rgb(216 208 194 / 86%);
  border-radius: var(--radius-lg);
  background: rgb(255 252 246 / 88%);
  box-shadow: var(--shadow-md);
}

.route-placeholder__eyebrow {
  margin: 0 0 var(--space-2);
  color: var(--color-accent);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: clamp(2rem, 6vw, 4.5rem);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.1;
}

.route-placeholder__copy {
  max-width: 34rem;
  margin: var(--space-6) 0 0;
  color: var(--color-muted);
}

.route-placeholder__rule {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-8);
  color: var(--color-primary);
}

.route-placeholder__rule span {
  height: 1px;
  background: var(--color-border);
}

.route-placeholder__rule i {
  font-style: normal;
}
</style>
