<script setup lang="ts">
import {
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { Person } from '../../../shared/domain/types'
import type { GraphDensity } from './FamilyGraph.vue'
import type { TreeMode } from '../model/buildVisibleGraph'

defineProps<{
  mode: TreeMode
  generationsUp: number
  generationsDown: number
  density: GraphDensity
  people: Person[]
  centerPersonId: string
  personSearch: string
  collapsedCount: number
  zoomLevel: number
}>()

const emit = defineEmits<{
  updateMode: [value: TreeMode]
  updateGenerationsUp: [value: number]
  updateGenerationsDown: [value: number]
  updateDensity: [value: GraphDensity]
  updatePersonSearch: [value: string]
  jump: [personId: string]
  relayout: []
  clearCollapsed: []
  zoomIn: []
  zoomOut: []
  zoomTo: [zoomLevel: number]
}>()

function primaryName(person: Person) {
  return getPrimaryName(person)
}

function numberValue(event: Event, fallback: number) {
  const value = Number((event.target as HTMLInputElement).value)
  return Number.isFinite(value) ? Math.min(8, Math.max(0, Math.floor(value))) : fallback
}

function zoomPercent(value: number) {
  return Math.round((Number.isFinite(value) ? value : 1) * 100)
}

function commitZoom(event: Event, fallbackLevel: number) {
  const input = event.target as HTMLInputElement
  const requested = Number(input.value)
  if (!Number.isFinite(requested)) {
    input.value = String(zoomPercent(fallbackLevel))
    return
  }
  const percent = Math.min(250, Math.max(20, Math.round(requested)))
  input.value = String(percent)
  emit('zoomTo', percent / 100)
}

</script>

<template>
  <aside class="tree-toolbar" aria-label="家谱树工具栏">
    <div class="tree-toolbar__mode" aria-label="家谱范围">
      <button type="button" :class="{ active: mode === 'combined' }" @click="emit('updateMode', 'combined')">综合</button>
      <button type="button" :class="{ active: mode === 'ancestors' }" @click="emit('updateMode', 'ancestors')">祖先</button>
      <button type="button" :class="{ active: mode === 'descendants' }" @click="emit('updateMode', 'descendants')">后代</button>
      <label class="visually-hidden" for="tree-mode">查看</label>
      <select id="tree-mode" class="visually-hidden" name="treeMode" :value="mode" @change="emit('updateMode', ($event.target as HTMLSelectElement).value as TreeMode)">
        <option value="combined">综合家庭</option>
        <option value="ancestors">祖先</option>
        <option value="descendants">后代</option>
      </select>
    </div>

    <div class="tree-toolbar__generation" aria-label="显示代数">
      <button type="button" :disabled="mode === 'descendants'" @click="emit('updateGenerationsUp', generationsUp === 8 ? 1 : generationsUp + 1)">上 {{ generationsUp }} 代</button>
      <button type="button" :disabled="mode === 'ancestors'" @click="emit('updateGenerationsDown', generationsDown === 8 ? 1 : generationsDown + 1)">下 {{ generationsDown }} 代</button>
      <label class="visually-hidden">向上
        <input name="generationsUp" type="number" min="0" max="8" :value="generationsUp" :disabled="mode === 'descendants'" @input="emit('updateGenerationsUp', numberValue($event, generationsUp))" />
      </label>
      <label class="visually-hidden">向下
        <input name="generationsDown" type="number" min="0" max="8" :value="generationsDown" :disabled="mode === 'ancestors'" @input="emit('updateGenerationsDown', numberValue($event, generationsDown))" />
      </label>
    </div>

    <div class="tree-toolbar__jump">
      <IconSearch :size="18" :stroke-width="1.7" aria-hidden="true" />
      <input
        type="search"
        aria-label="搜索跳转人物"
        placeholder="搜索人物（姓名/字号）"
        :value="personSearch"
        @input="emit('updatePersonSearch', ($event.target as HTMLInputElement).value)"
      />
      <label class="visually-hidden" for="tree-person-jump">跳转人物</label>
      <select id="tree-person-jump" class="visually-hidden" name="personJump" :value="centerPersonId" @change="emit('jump', ($event.target as HTMLSelectElement).value)">
        <option value="" disabled>选择人物</option>
        <option v-for="person in people" :key="person.id" :value="person.id">{{ primaryName(person) }}</option>
      </select>
    </div>

    <div class="tree-toolbar__zoom" aria-label="缩放">
      <button type="button" aria-label="缩小" @click="emit('zoomOut')"><IconMinus :size="18" aria-hidden="true" /></button>
      <label class="tree-toolbar__zoom-value">
        <input
          name="zoomPercent"
          type="number"
          min="20"
          max="250"
          step="1"
          inputmode="numeric"
          aria-label="缩放百分比"
          :value="zoomPercent(zoomLevel)"
          @change="commitZoom($event, zoomLevel)"
          @keydown.enter.prevent="commitZoom($event, zoomLevel)"
        />
        <span aria-hidden="true">%</span>
      </label>
      <button type="button" aria-label="放大" @click="emit('zoomIn')"><IconPlus :size="18" aria-hidden="true" /></button>
    </div>

    <details class="tree-toolbar__density">
      <summary>显示</summary>
      <div class="tree-toolbar__density-menu">
        <label><input name="showAvatars" type="checkbox" :checked="density.avatars" @change="emit('updateDensity', { ...density, avatars: ($event.target as HTMLInputElement).checked })" />头像</label>
        <label><input name="showDates" type="checkbox" :checked="density.dates" @change="emit('updateDensity', { ...density, dates: ($event.target as HTMLInputElement).checked })" />生卒日期</label>
        <label><input name="showPlaces" type="checkbox" :checked="density.places" @change="emit('updateDensity', { ...density, places: ($event.target as HTMLInputElement).checked })" />地点</label>
        <label><input name="showRelationships" type="checkbox" :checked="density.relationships" @change="emit('updateDensity', { ...density, relationships: ($event.target as HTMLInputElement).checked })" />关系说明</label>
        <label><input name="showNames" type="checkbox" :checked="density.names" @change="emit('updateDensity', { ...density, names: ($event.target as HTMLInputElement).checked })" />字、号等姓名</label>
      </div>
    </details>

    <div class="tree-toolbar__actions">
      <BaseButton class="tree-toolbar__relayout" name="重新布局" size="sm" variant="secondary" @click="emit('relayout')"><IconRefresh :size="17" aria-hidden="true" />重新布局</BaseButton>
    </div>
    <button v-if="collapsedCount" class="tree-toolbar__collapsed" type="button" @click="emit('clearCollapsed')">
      已收起 {{ collapsedCount }} 个分支 · 全部展开
    </button>
  </aside>
</template>

<style scoped>
.tree-toolbar { display: flex; min-height: 4.65rem; flex-wrap: nowrap; align-items: center; gap: .55rem; padding: .8rem 1.1rem; border-bottom: 1px solid var(--color-border); background: var(--color-card); }
.tree-toolbar button { font: inherit; }
.tree-toolbar__mode, .tree-toolbar__generation, .tree-toolbar__zoom, .tree-toolbar__actions { display: flex; flex: 0 0 auto; align-items: center; }
.tree-toolbar__mode, .tree-toolbar__generation, .tree-toolbar__zoom { overflow: hidden; border: 1px solid var(--color-border); border-radius: .35rem; }
.tree-toolbar__mode button, .tree-toolbar__generation button, .tree-toolbar__zoom button { min-height: 2.35rem; padding: 0 1rem; border: 0; border-right: 1px solid var(--color-border); background: var(--color-card); color: var(--color-text); cursor: pointer; white-space: nowrap; }
.tree-toolbar__mode button:last-of-type, .tree-toolbar__generation button:last-of-type, .tree-toolbar__zoom button:last-child { border-right: 0; }
.tree-toolbar__mode button.active { background: var(--color-primary-strong); color: white; }
.tree-toolbar__generation button:disabled { color: var(--color-muted); cursor: default; opacity: .6; }
.tree-toolbar__jump { display: flex; min-width: 10rem; max-width: 20rem; flex: 1; align-items: center; gap: .45rem; padding: 0 .65rem; border: 1px solid var(--color-border); border-radius: .35rem; background: var(--color-surface); }
.tree-toolbar__jump input { min-width: 5rem; min-height: 2.35rem; flex: 1; border: 0; outline: 0; background: transparent; font-size: .78rem; }
.tree-toolbar__zoom button { display: inline-flex; min-width: 3.2rem; align-items: center; justify-content: center; padding: 0; line-height: 1; }
.tree-toolbar__zoom button:last-child { border-left: 1px solid var(--color-border); }
.tree-toolbar__zoom-value { display: inline-flex; min-width: 3.2rem; min-height: 2.35rem; align-items: center; justify-content: center; box-sizing: border-box; line-height: 1; }
.tree-toolbar__zoom-value input { width: 2rem; padding: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font: inherit; font-size: .78rem; text-align: right; appearance: textfield; }
.tree-toolbar__zoom-value input::-webkit-inner-spin-button, .tree-toolbar__zoom-value input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.tree-toolbar__zoom-value span { font-size: .78rem; line-height: 1; }
.tree-toolbar__density { position: relative; display: block; height: calc(2.35rem + 2px); flex: 0 0 auto; }
.tree-toolbar__density summary { box-sizing: border-box; height: calc(2.35rem + 2px); min-height: calc(2.35rem + 2px); padding: 0 .7rem; border: 1px solid var(--color-border); border-radius: .35rem; cursor: pointer; font-size: .78rem; line-height: 2.35rem; }
.tree-toolbar__density[open] { z-index: 4; }
.tree-toolbar__density-menu { position: absolute; top: calc(100% + .35rem); right: 0; z-index: 1; display: grid; min-width: 9rem; gap: var(--space-2); padding: var(--space-2); background: var(--color-surface); box-shadow: var(--shadow-md); }
.tree-toolbar__density label { display: flex; align-items: center; gap: var(--space-2); font-size: .8rem; line-height: 1.35; }
.tree-toolbar__actions { flex: 0 0 auto; gap: .45rem; margin-left: auto; }
.tree-toolbar__actions :deep(.base-button) { gap: .42rem; white-space: nowrap; }
.tree-toolbar__collapsed { border: 0; background: transparent; color: var(--color-accent); cursor: pointer; font-size: .75rem; text-decoration: underline; }
@media (max-width: 82rem) { .tree-toolbar__actions { display: none; } }
@media (max-width: 76rem) { .tree-toolbar { flex-wrap: wrap; } .tree-toolbar__jump { order: 4; flex-basis: 100%; max-width: none; } .tree-toolbar__actions { margin-left: auto; } }
</style>
