<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import {
  IconBook2,
  IconCalendarEvent,
  IconChevronRight,
  IconFileDescription,
  IconMapPin,
  IconNotes,
  IconPencil,
  IconX,
} from '@tabler/icons-vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  Citation,
  Person,
  Place,
  Relationship,
  Source,
} from '../../../shared/domain/types'
import personPlaceholder from '../../../assets/person-placeholder.png'

const props = defineProps<{
  projectId: string
  relationship: Relationship
  people: Person[]
  places: Place[]
  sources: Source[]
  citations: Citation[]
}>()

const emit = defineEmits<{
  close: []
  edit: []
}>()

const relationshipLabels: Record<Relationship['type'], string> = {
  biological: '亲生',
  adoptive: '收养',
  step: '继亲',
  guardian: '监护',
  engaged: '订婚',
  married: '婚姻',
  partner: '事实伴侣',
  separated: '分居',
  divorced: '离异',
}

function primaryName(person: Person | undefined) {
  return person ? getPrimaryName(person) : '未知人物'
}

function lifespan(person: Person | undefined) {
  if (!person) return '生卒未详'
  const birth = person.birth?.display ?? '?'
  const death = person.status === 'living' ? '' : person.death?.display ?? '?'
  return death ? `${birth}—${death}` : `${birth}—`
}

function placeName(person: Person | undefined) {
  const placeId = person?.birthPlaceId
  return placeId
    ? props.places.find(({ id }) => id === placeId)?.name ?? '地点未详'
    : '地点未详'
}

const fromPerson = computed(() =>
  props.people.find(({ id }) => id === props.relationship.fromPersonId))
const toPerson = computed(() =>
  props.people.find(({ id }) => id === props.relationship.toPersonId))
const relationshipLabel = computed(() => relationshipLabels[props.relationship.type])
const relationshipPlace = computed(() =>
  props.relationship.placeId
    ? props.places.find(({ id }) => id === props.relationship.placeId)?.name ?? '地点未详'
    : '未记录')

const relatedSourceIds = computed(() => {
  const ids = new Set(props.relationship.sourceIds)
  for (const id of fromPerson.value?.sourceIds ?? []) ids.add(id)
  for (const id of toPerson.value?.sourceIds ?? []) ids.add(id)
  return ids
})

const keySources = computed(() =>
  props.sources.filter(({ id }) => relatedSourceIds.value.has(id)).slice(0, 2))

function citationFor(sourceId: string) {
  const relatedPersonIds = new Set([
    props.relationship.fromPersonId,
    props.relationship.toPersonId,
  ])
  return props.citations.find((citation) =>
    citation.sourceId === sourceId
    && (
      (citation.targetType === 'relationship' && citation.targetId === props.relationship.id)
      || (citation.targetType === 'person' && relatedPersonIds.has(citation.targetId))
    ))
}
</script>

<template>
  <aside class="relationship-research" aria-labelledby="relationship-research-title">
    <header class="relationship-research__header">
      <h2 id="relationship-research-title">
        研究视图：{{ primaryName(fromPerson) }} 与 {{ primaryName(toPerson) }} 的 {{ relationshipLabel }}关系
      </h2>
      <button type="button" aria-label="关闭关系研究视图" @click="emit('close')">
        <IconX :size="20" :stroke-width="1.6" aria-hidden="true" />
      </button>
    </header>

    <div class="relationship-research__scroll">
      <section class="relationship-research__couple" aria-label="关系双方">
        <article>
          <img :src="fromPerson?.avatarUrl || personPlaceholder" :alt="`${primaryName(fromPerson)}的头像`" />
          <div>
            <h3>{{ primaryName(fromPerson) }}</h3>
            <p>{{ lifespan(fromPerson) }}</p>
            <span>{{ placeName(fromPerson) }}</span>
          </div>
        </article>
        <div class="relationship-research__bond">
          <strong>{{ relationshipLabel }}</strong>
          <span>{{ relationship.start?.display ?? '日期未详' }}</span>
        </div>
        <article>
          <img :src="toPerson?.avatarUrl || personPlaceholder" :alt="`${primaryName(toPerson)}的头像`" />
          <div>
            <h3>{{ primaryName(toPerson) }}</h3>
            <p>{{ lifespan(toPerson) }}</p>
            <span>{{ placeName(toPerson) }}</span>
          </div>
        </article>
      </section>

      <dl class="relationship-research__facts">
        <div>
          <dt><IconCalendarEvent :size="18" aria-hidden="true" />{{ relationshipLabel }}日期</dt>
          <dd>{{ relationship.start?.display ?? '未记录' }}</dd>
        </div>
        <div>
          <dt><IconMapPin :size="18" aria-hidden="true" />登记地点</dt>
          <dd>{{ relationshipPlace }}</dd>
        </div>
        <div>
          <dt><IconNotes :size="18" aria-hidden="true" />备注</dt>
          <dd>{{ relationship.notes || '暂无补充备注' }}</dd>
        </div>
      </dl>

      <section class="relationship-research__sources" aria-labelledby="relationship-sources-title">
        <div class="relationship-research__section-title">
          <h3 id="relationship-sources-title">关键来源（{{ keySources.length }}）</h3>
          <RouterLink
            :to="{ name: 'project-sources', params: { projectId } }"
          >
            查看全部来源 <IconChevronRight :size="15" aria-hidden="true" />
          </RouterLink>
        </div>

        <ol v-if="keySources.length">
          <li v-for="(source, index) in keySources" :key="source.id">
            <span class="relationship-research__source-number">{{ index + 1 }}</span>
            <div>
              <RouterLink
                class="relationship-research__source-name"
                :to="{ name: 'project-sources', params: { projectId }, query: { source: source.id } }"
              >
                <strong>{{ source.title }}</strong>
                <IconChevronRight :size="17" aria-hidden="true" />
              </RouterLink>
              <dl>
                <div><dt>档案号：</dt><dd>{{ source.referenceCode || '未记录' }}</dd></div>
                <div><dt>页码/位置：</dt><dd>{{ citationFor(source.id)?.locator || '未记录' }}</dd></div>
                <div><dt>记录日期：</dt><dd>{{ citationFor(source.id)?.accessedAt?.display || source.date?.display || '未记录' }}</dd></div>
              </dl>
              <p>
                <IconFileDescription :size="16" aria-hidden="true" />
                摘录：{{ citationFor(source.id)?.excerpt || source.notes || '暂无摘录。' }}
              </p>
            </div>
          </li>
        </ol>
        <p v-else class="relationship-research__empty">这段关系还没有关联资料来源。</p>
      </section>
    </div>

    <footer>
      <BaseButton name="编辑关系" variant="secondary" @click="emit('edit')">
        <IconPencil :size="18" aria-hidden="true" />编辑关系
      </BaseButton>
      <RouterLink
        class="relationship-research__view-sources"
        :to="{ name: 'project-sources', params: { projectId } }"
      >
        <IconBook2 :size="20" aria-hidden="true" />查看来源
      </RouterLink>
    </footer>
  </aside>
</template>

<style scoped>
.relationship-research {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-left: 1px solid var(--color-border);
  background: var(--color-surface);
}

.relationship-research__header {
  display: flex;
  min-height: 3.7rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: .8rem 1rem;
  border-bottom: 1px solid var(--color-border);
}

.relationship-research__header h2 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.relationship-research__header button {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}

.relationship-research__header button:hover {
  background: var(--color-muted-surface);
  color: var(--color-text);
}

.relationship-research__scroll {
  min-height: 0;
  overflow: auto;
}

.relationship-research__couple {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: .45rem;
  padding: 1.15rem 1.05rem;
  border-bottom: 1px solid var(--color-border);
}

.relationship-research__couple article {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .55rem;
}

.relationship-research__couple img {
  width: 3.25rem;
  height: 3.25rem;
  flex: 0 0 auto;
  border-radius: 50%;
  object-fit: cover;
}

.relationship-research__couple h3,
.relationship-research__couple p {
  margin: 0;
}

.relationship-research__couple h3 {
  overflow: hidden;
  font-family: var(--font-heading);
  font-size: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relationship-research__couple p,
.relationship-research__couple span {
  color: var(--color-muted);
  font-size: .74rem;
}

.relationship-research__bond {
  display: grid;
  justify-items: center;
  gap: .25rem;
  text-align: center;
}

.relationship-research__bond strong {
  padding: .2rem .5rem;
  border: 1px solid var(--color-primary);
  border-radius: .25rem;
  color: var(--color-primary);
  font-size: .76rem;
}

.relationship-research__bond span {
  color: var(--color-muted);
  font-size: .68rem;
}

.relationship-research__facts {
  display: grid;
  gap: .85rem;
  margin: 0;
  padding: 1rem;
  border-bottom: 1px solid var(--color-border);
}

.relationship-research__facts div {
  display: grid;
  grid-template-columns: 6.4rem minmax(0, 1fr);
  gap: .7rem;
  align-items: start;
}

.relationship-research__facts dt {
  display: flex;
  align-items: center;
  gap: .45rem;
  color: var(--color-muted);
  font-size: .78rem;
}

.relationship-research__facts dd {
  margin: 0;
  font-size: .84rem;
  line-height: 1.6;
}

.relationship-research__sources {
  padding: 1rem;
}

.relationship-research__section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  margin-bottom: .8rem;
}

.relationship-research__section-title h3 {
  margin: 0;
  font-family: var(--font-heading);
  font-size: 1rem;
}

.relationship-research__section-title a {
  display: inline-flex;
  align-items: center;
  color: var(--color-primary);
  font-size: .72rem;
  text-decoration: none;
}

.relationship-research__sources ol {
  display: grid;
  gap: .65rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.relationship-research__sources li {
  display: flex;
  gap: .6rem;
  padding: .82rem;
  border: 1px solid var(--color-border);
  border-radius: .35rem;
  background: var(--color-paper-tint);
}

.relationship-research__source-number {
  display: grid;
  width: 1.35rem;
  height: 1.35rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--color-surface);
  font-size: .68rem;
  font-weight: 700;
}

.relationship-research__source-name {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: .5rem;
  color: var(--color-text);
  font-size: .8rem;
  line-height: 1.45;
  text-decoration: none;
}

.relationship-research__sources li > div {
  min-width: 0;
  flex: 1;
}

.relationship-research__sources li dl {
  display: grid;
  gap: .22rem;
  margin: .55rem 0;
  color: var(--color-muted);
  font-size: .72rem;
}

.relationship-research__sources li dl div {
  display: flex;
}

.relationship-research__sources li dd {
  margin: 0;
}

.relationship-research__sources li p {
  display: flex;
  align-items: flex-start;
  gap: .35rem;
  margin: 0;
  padding: .62rem;
  border: 1px solid rgb(182 95 60 / 16%);
  border-radius: .25rem;
  background: rgb(255 253 248 / 72%);
  color: var(--color-muted);
  font-size: .72rem;
  line-height: 1.65;
}

.relationship-research__empty {
  color: var(--color-muted);
  font-size: .75rem;
}

.relationship-research footer {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: .65rem;
  padding: .85rem 1rem;
  border-top: 1px solid var(--color-border);
}

.relationship-research footer :deep(.base-button) {
  justify-content: center;
}

.relationship-research__view-sources {
  display: inline-flex;
  min-height: 2.65rem;
  align-items: center;
  justify-content: center;
  gap: .45rem;
  border-radius: .35rem;
  background: var(--color-primary);
  color: var(--color-surface);
  font-size: .78rem;
  font-weight: 700;
  text-decoration: none;
}

@media (max-width: 26rem) {
  .relationship-research__couple {
    grid-template-columns: 1fr;
  }

  .relationship-research__bond {
    justify-items: start;
  }
}
</style>
