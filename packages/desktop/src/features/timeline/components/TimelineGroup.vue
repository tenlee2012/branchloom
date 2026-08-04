<script setup lang="ts">
import { RouterLink } from 'vue-router'
import type { FamilyEvent } from '../../../shared/domain/types'
import { eventTypeLabel, formatEventDate, type TimelineGroup } from '../model/groupEvents'

defineProps<{
  group: TimelineGroup
  projectId: string
  personNames: Record<string, string>
  placeNames: Record<string, string>
}>()

const emit = defineEmits<{ edit: [event: FamilyEvent] }>()
</script>

<template>
  <section
    class="timeline-group"
    :class="{ 'timeline-group--unknown': group.unknown }"
    :aria-labelledby="`timeline-group-${group.key}`"
    :data-group-key="group.key"
  >
    <header class="timeline-group__header">
      <span class="timeline-group__marker" aria-hidden="true" />
      <h2 :id="`timeline-group-${group.key}`">{{ group.label }}</h2>
      <span>{{ group.events.length }} 件</span>
    </header>

    <ol class="timeline-group__events">
      <li v-for="event in group.events" :key="event.id" :data-event-id="event.id">
        <article class="timeline-event">
          <header>
            <span class="timeline-event__type">{{ eventTypeLabel(event.type) }}</span>
            <time>{{ formatEventDate(event.date) }}</time>
          </header>
          <button
            class="timeline-event__title"
            type="button"
            :aria-label="`编辑事件：${event.title || eventTypeLabel(event.type)}`"
            @click="emit('edit', event)"
          >
            {{ event.title || eventTypeLabel(event.type) }}
          </button>
          <p v-if="event.placeId && placeNames[event.placeId]" class="timeline-event__place">
            {{ placeNames[event.placeId] }}
          </p>
          <ul v-if="event.participantIds.length" class="timeline-event__participants" aria-label="参与人物">
            <li v-for="personId in event.participantIds" :key="personId">
              <RouterLink
                :to="{ name: 'person-detail', params: { projectId, personId } }"
                :aria-label="`打开人物详情：${personNames[personId] ?? '未命名人物'}`"
              >
                {{ personNames[personId] ?? '未命名人物' }}
              </RouterLink>
              <small v-if="event.participantRoles?.[personId]">
                {{ event.participantRoles[personId] }}
              </small>
            </li>
          </ul>
          <p v-if="event.notes" class="timeline-event__notes">{{ event.notes }}</p>
        </article>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.timeline-group {
  position: relative;
  display: grid;
  grid-template-columns: minmax(6rem, 9rem) minmax(0, 1fr);
  gap: var(--space-5);
}

.timeline-group::before {
  position: absolute;
  top: 1.1rem;
  bottom: calc(-1 * var(--space-5));
  left: calc(min(9rem, 25%) + var(--space-5) / 2);
  width: 1px;
  background: var(--color-border);
  content: '';
}

.timeline-group:last-child::before { bottom: 0; }

.timeline-group__header {
  position: relative;
  align-self: start;
  text-align: right;
}

.timeline-group__header h2 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1.35rem;
}

.timeline-group__header > span:last-child {
  color: var(--color-muted);
  font-size: 0.75rem;
}

.timeline-group__marker {
  position: absolute;
  top: 0.45rem;
  right: calc(-1 * var(--space-5) - 0.42rem);
  z-index: 1;
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid var(--color-surface);
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 0 1px var(--color-primary);
}

.timeline-group--unknown .timeline-group__marker { background: var(--color-accent); }

.timeline-group__events {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.timeline-event {
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.timeline-event > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  color: var(--color-muted);
  font-size: 0.75rem;
}

.timeline-event__type {
  padding: 0.15rem var(--space-2);
  border-radius: 999px;
  background: var(--color-muted-surface);
  color: var(--color-primary);
  font-weight: 750;
}

.timeline-event__title {
  margin-top: var(--space-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-heading);
  font-size: 1.2rem;
  font-weight: 650;
  text-align: left;
  cursor: pointer;
}

.timeline-event__title:hover { color: var(--color-primary); }
.timeline-event__title:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }

.timeline-event__place,
.timeline-event__notes { margin: var(--space-2) 0 0; color: var(--color-muted); }

.timeline-event__participants {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.timeline-event__participants li { display: inline-flex; align-items: center; gap: var(--space-1); }
.timeline-event__participants a { color: var(--color-primary); font-size: 0.8125rem; font-weight: 700; }
.timeline-event__participants small { color: var(--color-muted); }

@media (max-width: 40rem) {
  .timeline-group { grid-template-columns: 1fr; gap: var(--space-2); }
  .timeline-group::before,
  .timeline-group__marker { display: none; }
  .timeline-group__header { text-align: left; }
}
</style>
