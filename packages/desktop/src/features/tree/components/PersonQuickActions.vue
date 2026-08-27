<script setup lang="ts">
import { computed } from 'vue'
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconDots,
  IconHeart,
  IconX,
} from '@tabler/icons-vue'
import type { GraphNodeAnchor } from './FamilyGraph.vue'

type RelativeQuickAction = 'parent' | 'partner' | 'child' | 'custom'

const props = defineProps<{
  personName: string
  anchor: GraphNodeAnchor
}>()
const emit = defineEmits<{
  action: [action: RelativeQuickAction]
  close: []
}>()

const PANEL_WIDTH = 272
const PANEL_HEIGHT = 164
const PANEL_GAP = 16
const CANVAS_EDGE = 14

const placement = computed(() => {
  const { x1, x2, y1, y2, canvasWidth, canvasHeight } = props.anchor
  if (canvasWidth < 620) return 'dock'
  if (x2 + PANEL_GAP + PANEL_WIDTH <= canvasWidth - CANVAS_EDGE) return 'right'
  if (x1 - PANEL_GAP - PANEL_WIDTH >= CANVAS_EDGE) return 'left'
  if (y2 + PANEL_GAP + PANEL_HEIGHT <= canvasHeight - CANVAS_EDGE) return 'bottom'
  if (y1 - PANEL_GAP - PANEL_HEIGHT >= CANVAS_EDGE) return 'top'
  return 'dock'
})

const positionStyle = computed(() => {
  const { x1, x2, y1, y2 } = props.anchor
  if (placement.value === 'right') return { left: `${x2 + PANEL_GAP}px`, top: `${(y1 + y2) / 2}px` }
  if (placement.value === 'left') return { left: `${x1 - PANEL_GAP}px`, top: `${(y1 + y2) / 2}px` }
  if (placement.value === 'bottom') return { left: `${(x1 + x2) / 2}px`, top: `${y2 + PANEL_GAP}px` }
  if (placement.value === 'top') return { left: `${(x1 + x2) / 2}px`, top: `${y1 - PANEL_GAP}px` }
  return undefined
})
</script>

<template>
  <aside
    class="person-quick-actions"
    :class="`person-quick-actions--${placement}`"
    :style="positionStyle"
    :data-placement="placement"
    :aria-label="`为${personName}添加关系`"
    @keydown.esc.stop="emit('close')"
  >
    <header class="person-quick-actions__header">
      <div>
        <span>关系快捷</span>
        <strong>为 {{ personName }} 添加</strong>
      </div>
      <button type="button" :aria-label="`关闭${personName}的关系快捷项`" @click="emit('close')">
        <IconX :size="16" aria-hidden="true" />
      </button>
    </header>

    <div class="person-quick-actions__grid" role="toolbar" :aria-label="`${personName}的关系快捷项`">
      <button type="button" :aria-label="`为${personName}添加父母`" @click="emit('action', 'parent')">
        <IconArrowUpRight :size="19" aria-hidden="true" />
        <span>添加父母</span>
      </button>
      <button class="person-quick-actions__partner" type="button" :aria-label="`为${personName}添加伴侣`" @click="emit('action', 'partner')">
        <IconHeart :size="19" aria-hidden="true" />
        <span>添加伴侣</span>
      </button>
      <button type="button" :aria-label="`为${personName}添加子女`" @click="emit('action', 'child')">
        <IconArrowDownRight :size="19" aria-hidden="true" />
        <span>添加子女</span>
      </button>
      <button class="person-quick-actions__more" type="button" :aria-label="`为${personName}选择更多关系`" @click="emit('action', 'custom')">
        <IconDots :size="20" aria-hidden="true" />
        <span>更多关系</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.person-quick-actions {
  position: absolute;
  z-index: 5;
  box-sizing: border-box;
  width: 17rem;
  padding: .7rem;
  border: 1px solid color-mix(in srgb, var(--color-primary) 38%, var(--color-border));
  border-radius: var(--radius-md);
  background: rgb(255 253 248 / 97%);
  box-shadow: var(--shadow-md);
  color: var(--color-text);
}

.person-quick-actions::before {
  position: absolute;
  content: '';
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-border));
}

.person-quick-actions--right { transform: translateY(-50%); }
.person-quick-actions--right::before { top: 50%; right: 100%; width: 1rem; border-top: 1px solid; }
.person-quick-actions--left { transform: translate(-100%, -50%); }
.person-quick-actions--left::before { top: 50%; left: 100%; width: 1rem; border-top: 1px solid; }
.person-quick-actions--bottom { transform: translateX(-50%); }
.person-quick-actions--bottom::before { bottom: 100%; left: 50%; height: 1rem; border-left: 1px solid; }
.person-quick-actions--top { transform: translate(-50%, -100%); }
.person-quick-actions--top::before { top: 100%; left: 50%; height: 1rem; border-left: 1px solid; }
.person-quick-actions--dock { right: .85rem; bottom: .85rem; left: auto !important; top: auto !important; }
.person-quick-actions--dock::before { display: none; }

.person-quick-actions__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: .15rem .2rem .65rem .3rem;
}

.person-quick-actions__header div { display: grid; gap: .1rem; min-width: 0; }
.person-quick-actions__header span { color: var(--color-muted); font-size: .66rem; letter-spacing: .14em; }
.person-quick-actions__header strong { overflow: hidden; font-family: var(--font-heading); font-size: .95rem; text-overflow: ellipsis; white-space: nowrap; }
.person-quick-actions__header button { display: grid; width: 1.8rem; height: 1.8rem; flex: 0 0 auto; place-items: center; border: 0; border-radius: 50%; background: transparent; color: var(--color-muted); cursor: pointer; }
.person-quick-actions__header button:hover { background: var(--color-muted-surface); color: var(--color-text); }

.person-quick-actions__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; }
.person-quick-actions__grid button { display: flex; min-width: 0; min-height: 2.85rem; align-items: center; gap: .45rem; padding: .55rem .65rem; border: 1px dashed color-mix(in srgb, var(--color-primary) 52%, var(--color-border)); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-primary) 5%, var(--color-surface)); color: var(--color-primary-strong); cursor: pointer; font: inherit; font-size: .78rem; font-weight: 700; text-align: left; transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease; }
.person-quick-actions__grid button:hover { border-style: solid; border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 11%, var(--color-surface)); transform: translateY(-1px); }
.person-quick-actions__grid button:focus-visible, .person-quick-actions__header button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.person-quick-actions__grid button svg { flex: 0 0 auto; }
.person-quick-actions__partner { border-color: color-mix(in srgb, var(--color-accent) 58%, var(--color-border)) !important; background: color-mix(in srgb, var(--color-accent) 6%, var(--color-surface)) !important; color: color-mix(in srgb, var(--color-accent) 82%, var(--color-text)) !important; }
.person-quick-actions__partner:hover { border-color: var(--color-accent) !important; background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface)) !important; }
.person-quick-actions__more { border-style: solid !important; border-color: var(--color-border) !important; background: var(--color-surface) !important; color: var(--color-muted) !important; }

@media (prefers-reduced-motion: reduce) {
  .person-quick-actions__grid button { transition: none; }
}

@media (max-width: 72rem) {
  .person-quick-actions {
    right: .85rem;
    bottom: .85rem;
    left: .85rem !important;
    top: auto !important;
    width: auto;
    transform: none;
  }

  .person-quick-actions::before { display: none; }
  .person-quick-actions__grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}

@media (max-width: 40rem) {
  .person-quick-actions { right: .65rem; bottom: .65rem; left: .65rem !important; width: auto; }
  .person-quick-actions__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
