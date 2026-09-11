<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { IconChevronDown, IconSearch, IconX } from '@tabler/icons-vue'
import { getNameSearchRank, getPrimaryName } from '../../../shared/domain/personNames'
import type { Person } from '../../../shared/domain/types'
import personPlaceholder from '../../../assets/person-placeholder.png'

const props = defineProps<{ label: string; modelValue: string; people: readonly Person[] }>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const uid = useId()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const searchInput = ref<HTMLInputElement>()
const resultList = ref<HTMLElement>()
const open = ref(false)
const search = ref('')
const limit = ref(30)
const selected = computed(() => props.people.find(({ id }) => id === props.modelValue))
const matches = computed(() => props.people
  .map((person) => ({ person, rank: getNameSearchRank(person, search.value) }))
  .filter(({ rank }) => !search.value.trim() || rank < 6)
  .sort((a, b) => a.rank - b.rank || getPrimaryName(a.person).localeCompare(getPrimaryName(b.person), 'zh-CN') || a.person.id.localeCompare(b.person.id))
  .map(({ person }) => person))

watch(search, () => { limit.value = 30 })
watch(() => props.modelValue, () => { open.value = false })

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  search.value = ''
  limit.value = 30
  await nextTick()
  searchInput.value?.focus()
}

function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function choose(id: string) {
  emit('update:modelValue', id)
  close(true)
}

function focusResult(index = 0) {
  resultList.value?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
}

function moveResult(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(resultList.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
  buttons[target]?.focus()
}

function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}

function leave(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node)) close()
}

async function showMore() {
  const previousLimit = limit.value
  limit.value += 30
  await nextTick()
  focusResult(previousLimit)
}

onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div ref="root" class="kinship-picker" @focusout="leave" @keydown.esc.stop.prevent="close(true)">
    <span :id="`${uid}-label`" class="kinship-picker__label">{{ label }}</span>
    <button
      :id="`${uid}-trigger`" ref="trigger" class="kinship-picker__trigger" type="button"
      :aria-label="`${label}：${selected ? getPrimaryName(selected) : '选择人物'}`"
      :aria-expanded="open" :aria-controls="open ? `${uid}-popover` : undefined" @click="toggle"
    >
      <img :src="selected?.avatarUrl || personPlaceholder" alt="" />
      <span class="kinship-picker__identity">
        <strong>{{ selected ? getPrimaryName(selected) : '选择人物' }}</strong>
        <small>{{ selected ? selected.birth?.display || '出生日期未记录' : '搜索姓名、字号或别名' }}</small>
      </span>
      <IconChevronDown :size="20" aria-hidden="true" />
    </button>

    <div v-if="open" :id="`${uid}-popover`" class="kinship-picker__popover" role="region" :aria-labelledby="`${uid}-label`">
      <div class="kinship-picker__search">
        <IconSearch :size="18" aria-hidden="true" />
        <input ref="searchInput" v-model="search" type="search" :aria-label="`${label}：搜索人物`" placeholder="输入姓名、字号或别名"
          @keydown.down.prevent="focusResult()" @keydown.enter.prevent="matches[0] && choose(matches[0].id)" />
      </div>
      <p class="kinship-picker__count" role="status">{{ matches.length ? `找到 ${matches.length} 位人物` : '未找到匹配人物，试试其他姓名或别名。' }}</p>
      <ul ref="resultList" class="kinship-picker__results" @keydown="moveResult">
        <li v-for="person in matches.slice(0, limit)" :key="person.id">
          <button type="button" :aria-pressed="person.id === modelValue" @click="choose(person.id)">
            <img :src="person.avatarUrl || personPlaceholder" alt="" loading="lazy" />
            <span><strong>{{ getPrimaryName(person) }}</strong><small>{{ person.birth?.display || '出生日期未记录' }}<template v-if="person.names.length > 1"> · {{ person.names.filter((name) => name.value !== getPrimaryName(person)).map((name) => name.value).join('、') }}</template></small></span>
          </button>
        </li>
      </ul>
      <button v-if="matches.length > limit" class="kinship-picker__text-button" type="button" @click="showMore">显示更多人物（还有 {{ matches.length - limit }} 位）</button>
      <button v-if="modelValue" class="kinship-picker__text-button" type="button" @click="choose('')"><IconX :size="16" aria-hidden="true" />清除选择</button>
    </div>
  </div>
</template>

<style scoped>
.kinship-picker { position: relative; min-width: 0; }
.kinship-picker__label { display: block; margin-bottom: .75rem; font-size: .875rem; font-weight: 650; }
.kinship-picker__trigger { display: flex; width: 100%; min-height: 5.5rem; align-items: center; gap: 1rem; padding: 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font: inherit; text-align: left; cursor: pointer; }
.kinship-picker__trigger:hover, .kinship-picker__trigger[aria-expanded='true'] { border-color: var(--color-primary); background: var(--color-paper-tint); }
.kinship-picker__trigger img { width: 3rem; height: 3rem; flex: 0 0 auto; border-radius: 50%; object-fit: cover; }
.kinship-picker__trigger > svg { flex: 0 0 auto; color: var(--color-primary); }
.kinship-picker__identity { display: grid; min-width: 0; flex: 1; gap: .3rem; overflow-wrap: anywhere; }
.kinship-picker__identity strong { font-size: 1.125rem; font-weight: 650; }
.kinship-picker small { color: var(--color-muted); font-size: .8125rem; line-height: 1.5; }
.kinship-picker__popover { position: absolute; z-index: 30; top: calc(100% + .5rem); right: 0; left: 0; padding: .75rem; border-radius: var(--radius-sm); background: var(--color-surface); box-shadow: var(--shadow-lg); }
.kinship-picker__search { display: flex; align-items: center; gap: .5rem; padding: .3rem .5rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted); }
.kinship-picker__search input { min-width: 0; width: 100%; min-height: 2.5rem; border: 0; background: transparent; color: var(--color-text); font: inherit; }
.kinship-picker__count { margin: .75rem .25rem .5rem; color: var(--color-muted); font-size: .8125rem; line-height: 1.5; }
.kinship-picker__results { max-height: min(17rem, 36dvh); overflow: auto; margin: 0; padding: 0; list-style: none; }
.kinship-picker__results button { display: flex; width: 100%; align-items: center; gap: .65rem; padding: .65rem .5rem; border: 0; border-radius: .35rem; background: transparent; color: var(--color-text); font: inherit; text-align: left; cursor: pointer; }
.kinship-picker__results button:hover, .kinship-picker__results button[aria-pressed='true'] { background: var(--color-muted-surface); }
.kinship-picker__results img { width: 2.25rem; height: 2.25rem; flex: 0 0 auto; border-radius: 50%; object-fit: cover; }
.kinship-picker__results span { display: grid; min-width: 0; gap: .2rem; overflow-wrap: anywhere; }
.kinship-picker__text-button { display: flex; min-height: 2.75rem; align-items: center; gap: .4rem; padding: .4rem .5rem; border: 0; background: transparent; color: var(--color-primary); font: inherit; font-size: .8125rem; text-align: left; cursor: pointer; }
@media (max-width: 40rem) {
  .kinship-picker__trigger { min-height: 4.75rem; padding: .75rem; }
  .kinship-picker__popover { position: relative; top: auto; margin-top: .5rem; border: 1px solid var(--color-border); box-shadow: none; }
}
</style>
