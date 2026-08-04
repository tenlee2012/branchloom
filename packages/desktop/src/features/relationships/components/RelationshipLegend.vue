<script setup lang="ts">
import {
  parentRelationshipOptions,
  partnerRelationshipOptions,
} from '../composables/useRelationshipEditor'
</script>

<template>
  <aside class="relationship-legend" aria-labelledby="relationship-legend-title">
    <h3 id="relationship-legend-title">关系类型说明</h3>
    <div>
      <p><strong>亲子与照护</strong></p>
      <ul>
        <li v-for="option in parentRelationshipOptions" :key="option.value">
          <span class="relationship-legend__line" :data-type="option.value" aria-hidden="true" />
          {{ option.label }}
        </li>
      </ul>
    </div>
    <div>
      <p><strong>伴侣</strong></p>
      <ul>
        <li v-for="option in partnerRelationshipOptions" :key="option.value">
          <span class="relationship-legend__line relationship-legend__line--partner" aria-hidden="true" />
          {{ option.label }}
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.relationship-legend { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.relationship-legend h3, .relationship-legend p { margin: 0; }
.relationship-legend ul { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: var(--space-2) 0 0; padding: 0; list-style: none; }
.relationship-legend li { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--color-muted); font-size: .875rem; }
.relationship-legend__line { width: 1.75rem; border-top: 2px solid var(--color-primary); }
.relationship-legend__line[data-type="adoptive"], .relationship-legend__line[data-type="guardian"] { border-top-style: dashed; }
.relationship-legend__line[data-type="step"] { border-top-style: dotted; }
.relationship-legend__line--partner { border-top-color: var(--color-accent); }
</style>
