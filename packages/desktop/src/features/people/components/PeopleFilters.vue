<script setup lang="ts">
import { t } from '../../../shared/i18n'
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
      label: t('关键词：{0}', [props.search]),
      clear: () => emit('update:search', ''),
    })
  }
  if (props.status) {
    const label = { living: t('在世'), deceased: t('已故'), unknown: t('未知') }[props.status] ?? props.status
    result.push({ key: 'status', label: t('状态：{0}', [label]), clear: () => emit('update:status', '') })
  }
  if (props.sex) {
    const label = {
      female: t('女性'),
      male: t('男性'),
      nonbinary: t('非二元'),
      unknown: t('未知'),
    }[props.sex] ?? props.sex
    result.push({ key: 'sex', label: t('性别：{0}', [label]), clear: () => emit('update:sex', '') })
  }
  const booleanFilters = [
    ['sources', props.sourceFilter, t('来源'), t('有来源'), t('无来源'), () => emit('update:source-filter', '')],
    ['avatar', props.avatarFilter, t('头像'), t('有头像'), t('无头像'), () => emit('update:avatar-filter', '')],
    ['birth', props.birthFilter, t('出生'), t('已记录'), t('未记录'), () => emit('update:birth-filter', '')],
    ['death', props.deathFilter, t('死亡'), t('已记录'), t('未记录'), () => emit('update:death-filter', '')],
    ['issues', props.issueFilter, t('问题'), t('有问题'), t('无问题'), () => emit('update:issue-filter', '')],
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
      label: t('排序：{0}', [props.sort === 'updatedAt' ? t('最近更新') : t('出生时间')]),
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
  <form class="people-filters" :aria-label="t('人物搜索与筛选')" @submit.prevent>
    <label class="people-filters__search">
      <span>{{ t('搜索人物') }}</span>
      <span class="people-filters__search-control">
        <IconSearch :size="18" :stroke-width="1.8" aria-hidden="true" />
        <input
          type="search"
          :value="search"
          :aria-label="t('搜索人物')"
          autocomplete="off"
          :placeholder="t('姓名、别名、生平、地点或事件')"
          @input="emit('update:search', inputValue($event))"
        />
      </span>
    </label>

    <label>
      <span>{{ t('生存状态') }}</span>
      <FilterSelectControl>
        <select
          :value="status"
          :aria-label="t('生存状态')"
          @change="emit('update:status', inputValue($event))"
        >
          <option value="">{{ t('全部状态') }}</option>
          <option value="living">{{ t('在世') }}</option>
          <option value="deceased">{{ t('已故') }}</option>
          <option value="unknown">{{ t('未知') }}</option>
        </select>
      </FilterSelectControl>
    </label>

    <label>
      <span>{{ t('资料来源') }}</span>
      <FilterSelectControl>
        <select
          :value="sourceFilter"
          :aria-label="t('来源状态')"
          @change="emit('update:source-filter', inputValue($event))"
        >
          <option value="">{{ t('全部人物') }}</option>
          <option value="with">{{ t('有来源') }}</option>
          <option value="without">{{ t('无来源') }}</option>
        </select>
      </FilterSelectControl>
    </label>

    <details class="people-filters__advanced">
      <summary>{{ t('更多筛选') }}</summary>
      <div class="people-filters__advanced-grid">
        <label>
          <span>{{ t('性别') }}</span>
          <FilterSelectControl>
            <select
              :value="sex"
              :aria-label="t('性别筛选')"
              @change="emit('update:sex', inputValue($event))"
            >
              <option value="">{{ t('全部性别') }}</option>
              <option value="female">{{ t('女性') }}</option>
              <option value="male">{{ t('男性') }}</option>
              <option value="nonbinary">{{ t('非二元') }}</option>
              <option value="unknown">{{ t('未知') }}</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>{{ t('头像') }}</span>
          <FilterSelectControl>
            <select
              :value="avatarFilter"
              :aria-label="t('头像状态')"
              @change="emit('update:avatar-filter', inputValue($event))"
            >
              <option value="">{{ t('不限') }}</option>
              <option value="with">{{ t('有头像') }}</option>
              <option value="without">{{ t('无头像') }}</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>{{ t('出生资料') }}</span>
          <FilterSelectControl>
            <select
              :value="birthFilter"
              :aria-label="t('出生资料状态')"
              @change="emit('update:birth-filter', inputValue($event))"
            >
              <option value="">{{ t('不限') }}</option>
              <option value="with">{{ t('已记录') }}</option>
              <option value="without">{{ t('未记录') }}</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>{{ t('死亡资料') }}</span>
          <FilterSelectControl>
            <select
              :value="deathFilter"
              :aria-label="t('死亡资料状态')"
              @change="emit('update:death-filter', inputValue($event))"
            >
              <option value="">{{ t('不限') }}</option>
              <option value="with">{{ t('已记录') }}</option>
              <option value="without">{{ t('未记录') }}</option>
            </select>
          </FilterSelectControl>
        </label>
        <label>
          <span>{{ t('资料问题') }}</span>
          <FilterSelectControl>
            <select
              :value="issueFilter"
              :aria-label="t('资料问题状态')"
              @change="emit('update:issue-filter', inputValue($event))"
            >
              <option value="">{{ t('不限') }}</option>
              <option value="with">{{ t('有待核对问题') }}</option>
              <option value="without">{{ t('无已知问题') }}</option>
            </select>
          </FilterSelectControl>
        </label>
      </div>
    </details>

    <label>
      <span>{{ t('排序') }}</span>
      <FilterSelectControl>
        <select
          :value="sort"
          :aria-label="t('排序方式')"
          @change="emit('update:sort', inputValue($event))"
        >
          <option value="name">{{ search.trim() ? t('按匹配程度') : t('按姓名') }}</option>
          <option value="updatedAt">{{ t('最近更新') }}</option>
          <option value="birth">{{ t('按出生时间') }}</option>
        </select>
      </FilterSelectControl>
    </label>

    <BaseButton
      class="people-filters__clear"
      variant="secondary"
      :aria-label="t('清除全部筛选条件')"
      :title="t('清除条件')"
      @click="emit('clear')"
    >
      <IconFilterX :size="18" :stroke-width="1.8" aria-hidden="true" />
      <span class="people-filters__clear-label">{{ t('清除条件') }}</span>
    </BaseButton>

    <div v-if="activeFilters.length" class="people-filters__active" :aria-label="t('当前筛选条件')">
      <span>{{ t('当前条件') }}</span>
      <button
        v-for="filter in activeFilters"
        :key="filter.key"
        type="button"
        :aria-label="t('清除{0}', [filter.label])"
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
