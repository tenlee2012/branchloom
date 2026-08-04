<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import BaseButton from '../../../design-system/BaseButton.vue'
import EmptyState from '../../../design-system/EmptyState.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  CareerRecord,
  Citation,
  FamilyEvent,
  Organization,
  Person,
  Relationship,
  Source,
} from '../../../shared/domain/types'

const props = withDefaults(defineProps<{
  projectId: string
  sources: Source[]
  citations: Citation[]
  people: Person[]
  events: FamilyEvent[]
  relationships: Relationship[]
  careers?: CareerRecord[]
  organizations?: Organization[]
  highlightedSourceId?: string
}>(), { careers: () => [], organizations: () => [] })
const emit = defineEmits<{
  editSource: [source: Source]
  deleteSource: [source: Source]
  editCitation: [citation: Citation]
}>()

const personById = computed(() => new Map(props.people.map((person) => [person.id, person])))
const eventById = computed(() => new Map(props.events.map((event) => [event.id, event])))
const relationshipById = computed(() => new Map(props.relationships.map((relationship) => [relationship.id, relationship])))
const careerById = computed(() => new Map(props.careers.map((career) => [career.id, career])))
const organizationById = computed(() => new Map(props.organizations.map((organization) => [organization.id, organization])))

function personName(id: string) {
  const person = personById.value.get(id)
  return person ? getPrimaryName(person) : '未知人物'
}

function typeLabel(type: Source['type']) {
  return { book: '书籍', web: '网页', archive: '档案', interview: '访谈', other: '其他' }[type]
}

function sourceCitations(sourceId: string) {
  return props.citations.filter(({ sourceId: id }) => id === sourceId)
}

interface Backlink {
  key: string
  type: Citation['targetType']
  targetId: string
  label: string
  to: string | { path: string; query: Record<string, string> }
}

function backlinks(source: Source): Backlink[] {
  const result = new Map<string, Backlink>()
  const add = (backlink: Backlink) => result.set(backlink.key, backlink)
  for (const citation of sourceCitations(source.id)) {
    if (citation.targetType === 'person') {
      add({ key: `person:${citation.targetId}`, type: 'person', targetId: citation.targetId, label: personName(citation.targetId), to: `/project/${props.projectId}/people/${citation.targetId}` })
    } else if (citation.targetType === 'event') {
      add({ key: `event:${citation.targetId}`, type: 'event', targetId: citation.targetId, label: eventById.value.get(citation.targetId)?.title ?? '未知事件', to: { path: `/project/${props.projectId}/timeline`, query: { eventId: citation.targetId } } })
    } else if (citation.targetType === 'relationship') {
      const relationship = relationshipById.value.get(citation.targetId)
      add({ key: `relationship:${citation.targetId}`, type: 'relationship', targetId: citation.targetId, label: relationship ? `${personName(relationship.fromPersonId)}与${personName(relationship.toPersonId)}（${relationship.category === 'parent' ? '亲子' : '伴侣'}）` : '未知关系', to: { path: `/project/${props.projectId}/tree`, query: { relationshipId: citation.targetId } } })
    } else if (citation.targetType === 'career') {
      const career = careerById.value.get(citation.targetId)
      const organization = career ? organizationById.value.get(career.organizationId ?? '') : undefined
      add({
        key: `career:${citation.targetId}`,
        type: 'career',
        targetId: citation.targetId,
        label: career
          ? [personName(career.personId), organization?.name, career.positionTitle].filter(Boolean).join(' · ')
          : '未知履历',
        to: career ? `/project/${props.projectId}/people/${career.personId}` : `/project/${props.projectId}/people`,
      })
    }
  }
  for (const person of props.people.filter(({ sourceIds }) => (sourceIds ?? []).includes(source.id))) {
    add({ key: `person:${person.id}`, type: 'person', targetId: person.id, label: personName(person.id), to: `/project/${props.projectId}/people/${person.id}` })
  }
  for (const event of props.events.filter(({ sourceIds }) => sourceIds.includes(source.id))) {
    add({ key: `event:${event.id}`, type: 'event', targetId: event.id, label: event.title, to: { path: `/project/${props.projectId}/timeline`, query: { eventId: event.id } } })
  }
  for (const relationship of props.relationships.filter(({ sourceIds }) => sourceIds.includes(source.id))) {
    add({
      key: `relationship:${relationship.id}`,
      type: 'relationship',
      targetId: relationship.id,
      label: `${personName(relationship.fromPersonId)}与${personName(relationship.toPersonId)}（${relationship.category === 'parent' ? '亲子' : '伴侣'}）`,
      to: {
        path: `/project/${props.projectId}/tree`,
        query: { relationshipId: relationship.id },
      },
    })
  }
  for (const career of props.careers.filter(({ sourceIds }) => sourceIds.includes(source.id))) {
    const organization = organizationById.value.get(career.organizationId ?? '')
    add({
      key: `career:${career.id}`,
      type: 'career',
      targetId: career.id,
      label: [personName(career.personId), organization?.name, career.positionTitle].filter(Boolean).join(' · '),
      to: `/project/${props.projectId}/people/${career.personId}`,
    })
  }
  return [...result.values()]
}

function unused(source: Source) {
  return sourceCitations(source.id).length === 0 && backlinks(source).length === 0
}
</script>

<template>
  <EmptyState
    v-if="sources.length === 0"
    title="没有符合条件的资料来源"
    description="可以调整搜索或筛选条件，也可以新建来源。"
  ><span aria-hidden="true">据</span></EmptyState>
  <div v-else class="source-list">
    <article
      v-for="source in sources"
      :key="source.id"
      class="source-list__card"
      data-source-row
      :data-source-id="source.id"
      :aria-current="source.id === highlightedSourceId ? 'true' : undefined"
      :class="{ 'source-list__card--highlighted': source.id === highlightedSourceId }"
    >
      <header>
        <div>
          <div class="source-list__badges">
            <StatusBadge tone="info">{{ typeLabel(source.type) }}</StatusBadge>
            <StatusBadge v-if="unused(source)" tone="warning">未使用</StatusBadge>
          </div>
          <h2>{{ source.title }}</h2>
          <p>{{ [source.author, source.repository, source.referenceCode].filter(Boolean).join(' · ') || '尚未补充责任者或保存机构' }}</p>
        </div>
        <div class="source-list__actions">
          <BaseButton :name="`编辑来源：${source.title}`" size="sm" variant="secondary" @click="emit('editSource', source)">编辑</BaseButton>
          <BaseButton :name="`删除来源：${source.title}`" size="sm" variant="ghost" @click="emit('deleteSource', source)">删除</BaseButton>
        </div>
      </header>
      <div class="source-list__citation-heading">
        <strong>{{ sourceCitations(source.id).length }} 条引用</strong>
        <span>{{ backlinks(source).length }} 处关联资料</span>
      </div>
      <ul v-if="backlinks(source).length" class="source-list__backlinks" :aria-label="`${source.title} 的关联资料`">
        <li v-for="backlink in backlinks(source)" :key="backlink.key">
          <RouterLink :to="backlink.to">{{ backlink.label }}</RouterLink>
          <span>{{ backlink.type === 'person' ? '人物' : backlink.type === 'event' ? '事件' : '关系' }}</span>
        </li>
      </ul>
      <p v-else class="source-list__unused">该来源尚未被人物、关系或事件使用。</p>
      <div v-if="sourceCitations(source.id).length" class="source-list__citations">
        <button
          v-for="citation in sourceCitations(source.id)"
          :key="citation.id"
          type="button"
          :name="`编辑引用：${citation.id}`"
          @click="emit('editCitation', citation)"
        >
          <span>{{ citation.locator || '未填写定位信息' }}</span>
          <small>{{ citation.excerpt || '打开编辑引用详情' }}</small>
        </button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.source-list { display: grid; gap: var(--space-4); }
.source-list__card { display: grid; gap: var(--space-4); padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.source-list__card--highlighted { border-color: var(--color-info); box-shadow: var(--focus-ring); }
.source-list__card > header { display: flex; align-items: start; justify-content: space-between; gap: var(--space-4); }
.source-list__card h2 { margin: var(--space-2) 0 0; font-family: var(--font-heading); font-size: 1.2rem; }
.source-list__card header p { margin: var(--space-1) 0 0; color: var(--color-muted); }
.source-list__badges, .source-list__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.source-list__citation-heading { display: flex; justify-content: space-between; gap: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-border); }
.source-list__citation-heading span, .source-list__unused { color: var(--color-muted); font-size: .875rem; }
.source-list__backlinks { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.source-list__backlinks li { display: flex; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: 999px; background: var(--color-muted-surface); font-size: .8125rem; }
.source-list__backlinks a { color: var(--color-primary); font-weight: 650; }
.source-list__backlinks span { color: var(--color-muted); }
.source-list__citations { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--space-2); }
.source-list__citations button { display: grid; gap: var(--space-1); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); text-align: left; cursor: pointer; }
.source-list__citations small { overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 38rem) { .source-list__card > header { flex-direction: column; } }
</style>
