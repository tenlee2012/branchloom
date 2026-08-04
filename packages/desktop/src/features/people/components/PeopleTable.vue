<script setup lang="ts">
import {
  IconEdit,
  IconFocusCentered,
  IconHierarchy,
  IconTrash,
} from '@tabler/icons-vue'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { Person } from '../../../shared/domain/types'

const props = defineProps<{
  people: Person[]
  projectId: string
  selectedIds: string[]
  centerPersonId?: string
  centerBusy?: boolean
}>()

const emit = defineEmits<{
  select: [personId: string, selected: boolean]
  'select-page': [personIds: string[], selected: boolean]
  delete: [person: Person]
  'set-center': [person: Person]
}>()

const allPageSelected = computed(() =>
  props.people.length > 0 && props.people.every(({ id }) => props.selectedIds.includes(id)),
)

const statusLabels: Record<Person['status'], string> = {
  living: '在世',
  deceased: '已故',
  unknown: '未知',
}
const sexLabels: Record<Person['sex'], string> = {
  female: '女性',
  male: '男性',
  nonbinary: '非二元',
  unknown: '未知',
}

function primaryName(person: Person): string {
  return getPrimaryName(person)
}

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date)
}

function centerActionLabel(person: Person): string {
  return person.id === props.centerPersonId
    ? `取消中心人物：${primaryName(person)}`
    : `设为中心人物：${primaryName(person)}`
}

</script>

<template>
  <div class="people-table__viewport">
    <table class="people-table" aria-label="人物列表">
      <thead>
        <tr>
          <th class="people-table__select" scope="col">
            <span class="visually-hidden">选择</span>
            <input
              type="checkbox"
              :checked="allPageSelected"
              aria-label="选择本页全部人物"
              @change="emit('select-page', people.map(({ id }) => id), checked($event))"
            />
          </th>
          <th scope="col">人物</th>
          <th scope="col">状态</th>
          <th scope="col">性别</th>
          <th scope="col">出生</th>
          <th scope="col">死亡</th>
          <th scope="col">最近整理</th>
          <th scope="col"><span class="visually-hidden">操作</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="person in people"
          :key="person.id"
          :data-person-id="person.id"
          :data-center-person="person.id === centerPersonId || undefined"
        >
          <td class="people-table__select" data-label="选择">
            <input
              type="checkbox"
              :checked="selectedIds.includes(person.id)"
              :aria-label="`选择${primaryName(person)}`"
              @change="emit('select', person.id, checked($event))"
            />
          </td>
          <th data-label="人物" scope="row">
            <RouterLink
              class="people-table__name"
              data-person-name
              :to="{ name: 'person-detail', params: { projectId, personId: person.id } }"
              :aria-label="`打开人物详情：${primaryName(person)}`"
            >
              {{ primaryName(person) }}
            </RouterLink>
          </th>
          <td :data-person-status="person.status" data-label="状态">
            <span :class="['people-table__status', `people-table__status--${person.status}`]">
              {{ statusLabels[person.status] }}
            </span>
          </td>
          <td data-label="性别">{{ sexLabels[person.sex] }}</td>
          <td data-label="出生">{{ person.birth?.display ?? '—' }}</td>
          <td data-label="死亡">{{ person.death?.display ?? '—' }}</td>
          <td data-label="最近整理">{{ formatUpdatedAt(person.updatedAt) }}</td>
          <td class="people-table__actions" data-label="操作">
            <div class="people-table__action-list">
              <RouterLink
                class="people-table__icon-action"
                :to="{ name: 'person-edit', params: { projectId, personId: person.id } }"
                :aria-label="`编辑人物：${primaryName(person)}`"
                :title="`编辑人物：${primaryName(person)}`"
                :data-tooltip="`编辑人物：${primaryName(person)}`"
              >
                <IconEdit :size="18" :stroke-width="1.8" aria-hidden="true" />
              </RouterLink>
              <button
                class="people-table__icon-action people-table__icon-action--danger"
                type="button"
                :aria-label="`删除人物：${primaryName(person)}`"
                :title="`删除人物：${primaryName(person)}`"
                :data-tooltip="`删除人物：${primaryName(person)}`"
                @click="emit('delete', person)"
              >
                <IconTrash :size="18" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <RouterLink
                class="people-table__icon-action"
                :to="{ name: 'project-tree', params: { projectId }, query: { personId: person.id } }"
                :aria-label="`在家谱树中定位：${primaryName(person)}`"
                :title="`在家谱树中定位：${primaryName(person)}`"
                :data-tooltip="`在家谱树中定位：${primaryName(person)}`"
              >
                <IconHierarchy :size="18" :stroke-width="1.8" aria-hidden="true" />
              </RouterLink>
              <button
                class="people-table__icon-action"
                :class="{ 'people-table__icon-action--center': person.id === centerPersonId }"
                type="button"
                :aria-label="centerActionLabel(person)"
                :aria-pressed="person.id === centerPersonId"
                :aria-busy="centerBusy || undefined"
                :title="centerActionLabel(person)"
                :data-tooltip="centerActionLabel(person)"
                :disabled="centerBusy"
                @click="emit('set-center', person)"
              >
                <IconFocusCentered :size="18" :stroke-width="1.8" aria-hidden="true" />
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.people-table__viewport {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.people-table {
  width: 100%;
  min-width: 52rem;
  border-collapse: collapse;
}

.people-table th,
.people-table td {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: middle;
}

.people-table thead th {
  background: var(--color-muted-surface);
  color: var(--color-muted);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
}

.people-table tbody tr:last-child > * {
  border-bottom: 0;
}

.people-table tbody tr:hover {
  background: rgb(80 107 87 / 4%);
}

.people-table tbody th {
  min-width: 9rem;
  font-weight: 600;
}

.people-table__select {
  width: 3rem;
  text-align: center !important;
}

.people-table__select input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--color-primary);
}

.people-table__name {
  color: var(--color-primary);
  font-weight: 700;
}

.people-table__status {
  display: inline-flex;
  padding: 0.18rem var(--space-2);
  border-radius: 999px;
  background: var(--color-muted-surface);
  color: var(--color-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.people-table__status--living {
  background: var(--color-success-surface);
  color: var(--color-success);
}

.people-table__status--deceased {
  background: var(--color-info-surface);
  color: var(--color-info);
}

.people-table__actions {
  white-space: nowrap;
}

.people-table__action-list {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.people-table__icon-action {
  position: relative;
  display: inline-grid;
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.people-table__icon-action:hover,
.people-table__icon-action:focus-visible {
  border-color: var(--color-border);
  background: var(--color-muted-surface);
  color: var(--color-primary);
  outline: none;
}

.people-table__icon-action--danger:hover,
.people-table__icon-action--danger:focus-visible {
  color: var(--color-danger);
}

.people-table__icon-action--center {
  border-color: color-mix(in srgb, var(--color-primary) 36%, var(--color-border));
  background: color-mix(in srgb, var(--color-primary) 9%, var(--color-surface));
  color: var(--color-primary);
}

.people-table__icon-action:disabled {
  cursor: wait;
  opacity: .55;
}

.people-table__icon-action::after {
  position: absolute;
  z-index: 5;
  bottom: calc(100% + .4rem);
  left: 50%;
  width: max-content;
  max-width: 14rem;
  padding: .35rem .55rem;
  border-radius: .3rem;
  background: var(--color-text);
  color: var(--color-surface);
  content: attr(data-tooltip);
  font-size: .72rem;
  font-weight: 600;
  line-height: 1.25;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, .2rem);
  transition: opacity 120ms ease, transform 120ms ease;
  white-space: nowrap;
}

.people-table__icon-action:hover::after,
.people-table__icon-action:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

@media (max-width: 60rem) {
  .people-table {
    min-width: 0;
  }

  .people-table th,
  .people-table td {
    padding-inline: var(--space-2);
  }

  .people-table tbody th {
    min-width: 6rem;
  }

  .people-table__actions {
    white-space: normal;
  }

  .people-table__action-list {
    flex-wrap: wrap;
    row-gap: var(--space-1);
  }
}

@media (max-width: 40rem) {
  .people-table__viewport {
    overflow: visible;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .people-table,
  .people-table tbody,
  .people-table tr {
    display: block;
    min-width: 0;
  }

  .people-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .people-table tbody {
    display: grid;
    gap: var(--space-3);
  }

  .people-table tbody tr {
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .people-table tbody th,
  .people-table tbody td {
    display: grid;
    grid-template-columns: 6rem minmax(0, 1fr);
    gap: var(--space-3);
    padding: var(--space-2);
    border: 0;
  }

  .people-table tbody th::before,
  .people-table tbody td::before {
    color: var(--color-muted);
    content: attr(data-label);
    font-size: 0.75rem;
    font-weight: 700;
  }

  .people-table__select {
    width: auto;
    text-align: left !important;
  }

  .people-table__action-list {
    flex-wrap: wrap;
  }
}
</style>
