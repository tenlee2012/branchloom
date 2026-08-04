<script setup lang="ts">
import { IconCalendarEvent, IconPencil, IconPlus } from '@tabler/icons-vue'
import { computed } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import type { FamilyEvent, Place } from '../../../shared/domain/types'
import { eventTypeLabel } from '../../timeline/model/groupEvents'

const props = withDefaults(defineProps<{
  personId: string
  projectId: string
  events?: FamilyEvent[]
  places?: Place[]
}>(), {
  events: () => [],
  places: () => [],
})

const emit = defineEmits<{
  create: []
  edit: [event: FamilyEvent]
}>()

const sortedEvents = computed(() => [...props.events].sort((left, right) =>
  (right.date.start ?? right.date.end ?? '').localeCompare(
    left.date.start ?? left.date.end ?? '',
  ) || left.id.localeCompare(right.id)))
const placeById = computed(() => new Map(props.places.map((place) => [place.id, place.name])))

function eventMeta(event: FamilyEvent) {
  return [
    eventTypeLabel(event.type),
    event.participantRoles?.[props.personId],
    event.placeId ? placeById.value.get(event.placeId) : undefined,
  ].filter(Boolean).join(' · ')
}
</script>

<template>
  <section class="person-events-module" data-person-events aria-labelledby="person-events-heading">
    <header class="person-events-module__heading">
      <div>
        <p class="person-events-module__eyebrow"><IconCalendarEvent :size="16" aria-hidden="true" />人物事件</p>
        <h2 id="person-events-heading">事件记录</h2>
        <p>展示这位人物参与的事件，可在此新建或修改。</p>
      </div>
      <div class="person-events-module__actions">
        <a :href="`/project/${projectId}/timeline`">完整时间线</a>
        <BaseButton name="新建人物事件" size="sm" variant="secondary" @click="emit('create')">
          <IconPlus :size="17" aria-hidden="true" />新建事件
        </BaseButton>
      </div>
    </header>

    <ol v-if="sortedEvents.length" class="person-events-module__list">
      <li v-for="event in sortedEvents" :key="event.id" :data-event-id="event.id">
        <time>{{ event.date.display || '时间未详' }}</time>
        <div>
          <a :href="`/project/${projectId}/timeline?eventId=${encodeURIComponent(event.id)}`">
            {{ event.title || eventTypeLabel(event.type) }}
          </a>
          <span>{{ eventMeta(event) }}</span>
          <p v-if="event.notes">{{ event.notes }}</p>
        </div>
        <BaseButton
          variant="ghost"
          size="sm"
          :aria-label="`编辑事件：${event.title || eventTypeLabel(event.type)}`"
          @click="emit('edit', event)"
        >
          <IconPencil :size="16" aria-hidden="true" />编辑
        </BaseButton>
      </li>
    </ol>

    <div v-else class="person-events-module__empty">
      <IconCalendarEvent :size="28" aria-hidden="true" />
      <div>
        <strong>还没有人物事件</strong>
        <span>可以记录出生、迁居、婚姻、任职等经历。</span>
      </div>
      <BaseButton name="记录第一件人物事件" size="sm" variant="secondary" @click="emit('create')">
        记录事件
      </BaseButton>
    </div>
  </section>
</template>

<style scoped>
.person-events-module { display: grid; gap: var(--space-4); }
.person-events-module__heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.person-events-module__heading h2,
.person-events-module__heading p { margin: 0; }
.person-events-module__heading h2 { margin-top: var(--space-1); font-family: var(--font-heading); font-size: 1.25rem; }
.person-events-module__heading > div > p:last-child { margin-top: var(--space-1); color: var(--color-muted); font-size: .8125rem; }
.person-events-module__eyebrow { display: flex; align-items: center; gap: var(--space-1); color: var(--color-accent); font-size: .75rem; font-weight: 750; }
.person-events-module__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); }
.person-events-module__actions > a { color: var(--color-primary); font-size: .8125rem; font-weight: 700; text-decoration: none; }
.person-events-module__actions > a:hover { text-decoration: underline; }
.person-events-module__list { display: grid; margin: 0; padding: 0; list-style: none; }
.person-events-module__list li { display: grid; grid-template-columns: minmax(7rem, .7fr) minmax(0, 2fr) auto; align-items: start; gap: var(--space-4); padding: var(--space-4) 0; border-top: 1px solid var(--color-border); }
.person-events-module__list time { color: var(--color-muted); font-variant-numeric: tabular-nums; }
.person-events-module__list li > div { display: grid; gap: var(--space-1); min-width: 0; }
.person-events-module__list li > div > a { color: var(--color-primary); font-weight: 750; text-decoration: none; overflow-wrap: anywhere; }
.person-events-module__list li > div > a:hover { text-decoration: underline; }
.person-events-module__list span { color: var(--color-muted); font-size: .8125rem; }
.person-events-module__list p { margin: var(--space-1) 0 0; line-height: 1.65; }
.person-events-module__empty { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 7rem; padding: var(--space-4); border: 1px dashed var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted); }
.person-events-module__empty > div { display: grid; gap: var(--space-1); }
.person-events-module__empty strong { color: var(--color-text); }
.person-events-module__empty span { font-size: .8125rem; }

@media (max-width: 42rem) {
  .person-events-module__heading { flex-direction: column; }
  .person-events-module__actions { justify-content: flex-start; }
  .person-events-module__list li { grid-template-columns: 1fr auto; gap: var(--space-2) var(--space-3); }
  .person-events-module__list time { grid-column: 1 / -1; }
  .person-events-module__empty { grid-template-columns: auto minmax(0, 1fr); }
  .person-events-module__empty :deep(.base-button) { grid-column: 1 / -1; justify-self: start; }
}
</style>
