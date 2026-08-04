<script setup lang="ts">
import { computed } from 'vue'
import { IconFilterX, IconSearch } from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import FilterSelectControl from '../../../design-system/FilterSelectControl.vue'

const props = defineProps<{
  search: string
  status: string
  sex: string
  sourceFilter: string
  avatarFilter: string
  birthFilter: string
  deathFilter: string
  issueFilter: string
  sort: string
}>()

const emit = defineEmits<{
  'update:search': [value: string]
  'update:status': [value: string]
  'update:sex': [value: string]
  'update:source-filter': [value: string]
  'update:avatar-filter': [value: string]
  'update:birth-filter': [value: string]
  'update:death-filter': [value: string]
  'update:issue-filter': [value: string]
  'update:sort': [value: string]
  clear: []
}>()

const activeFilters = computed(() => {
  const result: Array<{ key: string; label: string; clear: () => void }> = []
  if (props.search) {
    result.push({
      key: 'search',
      label: `关键词：${props.search}`,
      clear: () => emit('update:search', ''),
    })
  }
  if (props.status) {
    const label = { living: '在世', deceased: '已故', unknown: '未知' }[props.status] ?? props.status
    result.push({ key: 'status', label: `状态：${label}`, clear: () => emit('update:status', '') })
  }
  if (props.sex) {
    const label = {
      female: '女性',
      male: '男性',
      nonbinary: '非二元',
      unknown: '未知',
    }[props.sex] ?? props.sex
    result.push({ key: 'sex', label: `性别：${label}`, clear: () => emit('update:sex', '') })
  }
  const booleanFilters = [
    ['sources', props.sourceFilter, '来源', '有来源', '无来源', () => emit('update:source-filter', '')],
    ['avatar', props.avatarFilter, '头像', '有头像', '无头像', () => emit('update:avatar-filter', '')],
    ['birth', props.birthFilter, '出生', '已记录', '未记录', () => emit('update:birth-filter', '')],
    ['death', props.deathFilter, '死亡', '已记录', '未记录', () => emit('update:death-filter', '')],
    ['issues', props.issueFilter, '问题', '有问题', '无问题', () => emit('update:issue-filter', '')],
  ] as const
  for (const [key, value, prefix, withLabel, withoutLabel, clear] of booleanFilters) {
    if (!value) continue
    result.push({
      key,
      label: `${prefix}：${value === 'with' ? withLabel : withoutLabel}`,
      clear,
    })
  }
  if (props.sort !== 'name') {
    result.push({
      key: 'sort',
      label: `排序：${props.sort === 'updatedAt' ? '最近更新' : '出生时间'}`,
      clear: () => emit('update:sort', 'name'),
    })
  }
  return result
})

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value
}
</script>

<template>
  <form class="people-filters" aria-label="人物搜索与筛选" @submit.prevent>
    <label class="people-filters__search">
      <span>搜索人物</span>
      <span class="people-filters__search-control">
        <IconSearch :size="18" :stroke-width="1.8" aria-hidden="true" />
        <input
          type="search"
          :value="search"
          aria-label="搜索人物"
          autocomplete="off"
          placeholder="姓名、别名、生平、地点或事件"
          @input="emit('update:search', inputValue($event))"
        />
      </span>
    </label>

    <label>
      <span>生存状态</span>
      <FilterSelectControl>
        <select
          :value="status"
          aria-label="生存状态"
          @change="emit('update:status', inputValue($event))"
        >
          <option value="">全部状态</option>
          <option value="living">在世</option>
          <option value="deceased">已故</option>
          <option value="unknown">未知</option>
        </select>
      </FilterSelectControl>
    </label>

    <label>
      <span>资料来源</span>
      <FilterSelectControl>
        <select
          :value="sourceFilter"
          aria-label="来源状态"
          @change="emit('update:source-filter', inputValue($event))"
        >
          <option value="">全部人物</option>
          <option value="with">有来源</option>
          <option value="without">无来源</option>
        </select>
      </FilterSelectControl>
    </label>

    <details class="people-filters__advanced">
      <summary>更多筛选</summary>
      <div class="people-filters__advanced-grid">
        <label>
          <span>性别</span>
          <FilterSelectControl>
            <select
              :value="sex"
              aria-label="性别筛选"
              @change="emit('update:sex', inputValue($event))"
            >
              <option value="">全部性别</option>
              <option value="female">女性</option>
              <option value="male">男性</option>
              <option value="nonbinary">非二元</option>
              <option value="unknown">未知</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>头像</span>
          <FilterSelectControl>
            <select
              :value="avatarFilter"
              aria-label="头像状态"
              @change="emit('update:avatar-filter', inputValue($event))"
            >
              <option value="">不限</option>
              <option value="with">有头像</option>
              <option value="without">无头像</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>出生资料</span>
          <FilterSelectControl>
            <select
              :value="birthFilter"
              aria-label="出生资料状态"
              @change="emit('update:birth-filter', inputValue($event))"
            >
              <option value="">不限</option>
              <option value="with">已记录</option>
              <option value="without">未记录</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>死亡资料</span>
          <FilterSelectControl>
            <select
              :value="deathFilter"
              aria-label="死亡资料状态"
              @change="emit('update:death-filter', inputValue($event))"
            >
              <option value="">不限</option>
              <option value="with">已记录</option>
              <option value="without">未记录</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>资料问题</span>
          <FilterSelectControl>
            <select
              :value="issueFilter"
              aria-label="资料问题状态"
              @change="emit('update:issue-filter', inputValue($event))"
            >
              <option value="">不限</option>
              <option value="with">有待核对问题</option>
              <option value="without">无已知问题</option>
            </select>
          </FilterSelectControl>
        </label>
      </div>
    </details>

    <label>
      <span>排序</span>
      <FilterSelectControl>
        <select
          :value="sort"
          aria-label="排序方式"
          @change="emit('update:sort', inputValue($event))"
        >
          <option value="name">按姓名</option>
          <option value="updatedAt">最近更新</option>
          <option value="birth">按出生时间</option>
        </select>
      </FilterSelectControl>
    </label>

    <BaseButton
      class="people-filters__clear"
      variant="secondary"
      aria-label="清除全部筛选条件"
      title="清除条件"
      @click="emit('clear')"
    >
      <IconFilterX :size="18" :stroke-width="1.8" aria-hidden="true" />
      <span class="people-filters__clear-label">清除条件</span>
    </BaseButton>

    <div v-if="activeFilters.length" class="people-filters__active" aria-label="当前筛选条件">
      <span>当前条件</span>
      <button
        v-for="filter in activeFilters"
        :key="filter.key"
        type="button"
        :aria-label="`清除${filter.label}`"
        @click="filter.clear"
      >
        {{ filter.label }} <span aria-hidden="true">×</span>
      </button>
    </div>
  </form>
</template>

<style scoped>
.people-filters {
  --people-filter-control-height: 2.75rem;

  display: grid;
  grid-template-columns: minmax(14rem, 1.8fr) repeat(4, minmax(6.75rem, 1fr)) auto;
  align-items: end;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgb(255 252 246 / 88%);
  box-shadow: var(--shadow-sm);
}

.people-filters label {
  display: grid;
  min-width: 0;
  gap: var(--space-1);
  color: var(--color-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.people-filters input {
  width: 100%;
  height: var(--people-filter-control-height);
  min-height: var(--people-filter-control-height);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  padding: 0 var(--space-3) 0 2.5rem;
}

.people-filters :deep(.base-select-control select) {
  height: var(--people-filter-control-height);
  min-height: var(--people-filter-control-height);
  padding-top: 0;
  padding-bottom: 0;
}

.people-filters__search-control {
  position: relative;
  display: block;
}

.people-filters__search-control > svg {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: var(--space-3);
  color: var(--color-primary);
  pointer-events: none;
  transform: translateY(-50%);
}

.people-filters__clear {
  width: auto;
  min-width: var(--people-filter-control-height);
  height: var(--people-filter-control-height);
  padding: 0 var(--space-3);
  white-space: nowrap;
}

.people-filters__active {
  display: flex;
  grid-column: 1 / -1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-muted);
  font-size: .75rem;
}

.people-filters__active button {
  min-height: auto;
  padding: .35rem .65rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-muted-surface);
  color: var(--color-primary);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.people-filters__advanced {
  position: relative;
  align-self: end;
}

.people-filters__advanced > summary {
  display: flex;
  height: var(--people-filter-control-height);
  min-height: var(--people-filter-control-height);
  align-items: center;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-primary);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 700;
  white-space: nowrap;
}

.people-filters__advanced-grid {
  position: absolute;
  z-index: 5;
  top: calc(100% + var(--space-2));
  right: 0;
  display: grid;
  width: min(42rem, calc(100vw - 4rem));
  grid-template-columns: repeat(3, minmax(9rem, 1fr));
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}

@media (max-width: 80rem) {
  .people-filters__clear {
    width: var(--people-filter-control-height);
    padding: 0;
  }

  .people-filters__clear-label {
    display: none;
  }
}

@media (max-width: 64rem) {
  .people-filters {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .people-filters__search {
    grid-column: span 2;
  }
}

@media (max-width: 48rem) {
  .people-filters {
    grid-template-columns: 1fr 1fr;
  }

  .people-filters__search {
    grid-column: 1 / -1;
  }

  .people-filters__advanced-grid {
    position: static;
    width: auto;
    grid-template-columns: 1fr 1fr;
    margin-top: var(--space-2);
  }
}

@media (max-width: 32rem) {
  .people-filters {
    grid-template-columns: 1fr;
  }

  .people-filters__search {
    grid-column: auto;
  }

  .people-filters__advanced-grid {
    grid-template-columns: 1fr;
  }
}
</style>
