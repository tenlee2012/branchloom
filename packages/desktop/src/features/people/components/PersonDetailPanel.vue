<script setup lang="ts">
import {
  IconCalendarEvent,
  IconPhoto,
  IconPencil,
  IconTimeline,
  IconTrash,
  IconUserCircle,
} from '@tabler/icons-vue'
import { computed, ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import {
  getPrimaryName,
  isPrimaryName,
  personNameTypeLabels,
} from '../../../shared/domain/personNames'
import type {
  Attachment,
  AttachmentLink,
  CareerRecord,
  Citation,
  FamilyEvent,
  Organization,
  Person,
  Place,
  Relationship,
  Source,
} from '../../../shared/domain/types'
import { relationshipDisplayLabel } from '../../relationships/composables/useRelationshipEditor'
import PersonEventsModule from './PersonEventsModule.vue'

const props = withDefaults(defineProps<{
  person: Person
  relationships?: Relationship[]
  projectRelationships?: Relationship[]
  people?: Person[]
  careers?: CareerRecord[]
  organizations?: Organization[]
  places?: Place[]
  events?: FamilyEvent[]
  sources?: Source[]
  citations?: Citation[]
  attachments?: Attachment[]
  attachmentLinks?: AttachmentLink[]
}>(), {
  relationships: () => [],
  projectRelationships: () => [],
  people: () => [],
  careers: () => [],
  organizations: () => [],
  places: () => [],
  events: () => [],
  sources: () => [],
  citations: () => [],
  attachments: () => [],
  attachmentLinks: () => [],
})
const emit = defineEmits<{
  edit: []
  delete: []
  addRelationship: []
  quickAddRelative: []
  editRelationship: [relationship: Relationship]
  addCareer: []
  editCareer: [career: CareerRecord]
  addEvent: []
  editEvent: [event: FamilyEvent]
}>()

const statusLabels: Record<Person['status'], string> = {
  living: '在世',
  deceased: '已故',
  unknown: '状态未知',
}

const sexLabels: Record<Person['sex'], string> = {
  female: '女性',
  male: '男性',
  nonbinary: '非二元',
  unknown: '未知',
}

function primaryName(person: Person) {
  return getPrimaryName(person)
}

function avatarFallback(person: Person) {
  return Array.from(primaryName(person).trim())[0] ?? '人'
}

function otherPerson(relationship: Relationship) {
  const otherId = relationship.fromPersonId === props.person.id
    ? relationship.toPersonId
    : relationship.fromPersonId
  return props.people.find(({ id }) => id === otherId)
}

const sortedCareers = computed(() => [...props.careers].sort((left, right) => {
  if (left.status === 'current' && right.status !== 'current') return -1
  if (right.status === 'current' && left.status !== 'current') return 1
  return (right.start?.start ?? right.start?.end ?? '').localeCompare(
    left.start?.start ?? left.start?.end ?? '',
  ) || left.id.localeCompare(right.id)
}))
const sourceCount = computed(() => new Set([
  ...(props.person.sourceIds ?? []),
  ...props.careers.flatMap(({ sourceIds }) => sourceIds),
  ...props.events.flatMap(({ sourceIds }) => sourceIds),
  ...props.relationships.flatMap(({ sourceIds }) => sourceIds),
  ...props.citations.map(({ sourceId }) => sourceId),
]).size)
const sourceById = computed(() => new Map(props.sources.map((source) => [source.id, source])))
const attachmentById = computed(() =>
  new Map(props.attachments.map((attachment) => [attachment.id, attachment])))
const linkedAttachments = computed(() => [...new Map(props.attachmentLinks
  .map(({ attachmentId }) => [attachmentId, attachmentById.value.get(attachmentId)])
  .filter((entry): entry is [string, Attachment] => Boolean(entry[1]))).values()])
const albumAttachments = computed(() => props.attachmentLinks
  .filter(({ targetType, targetId, role }) =>
    targetType === 'person' && targetId === props.person.id && role === 'media')
  .map(({ attachmentId }) => attachmentById.value.get(attachmentId))
  .filter((attachment): attachment is Attachment =>
    Boolean(attachment?.mimeType.startsWith('image/'))))
const previewAttachment = ref<Attachment>()
const activeDetailModule = ref<'overview' | 'life' | 'events' | 'materials'>('overview')
const personById = computed(() => new Map(props.people.map((person) => [person.id, person])))
watch(() => props.person.id, () => { activeDetailModule.value = 'overview' })
const derivedRelationshipGroups = computed(() => {
  const lineage = props.projectRelationships.filter((relationship) =>
    relationship.category === 'parent'
    && (relationship.type === 'biological' || relationship.type === 'adoptive'))
  const parentIds = new Set(lineage
    .filter(({ toPersonId }) => toPersonId === props.person.id)
    .map(({ fromPersonId }) => fromPersonId))
  const childIds = new Set(lineage
    .filter(({ fromPersonId }) => fromPersonId === props.person.id)
    .map(({ toPersonId }) => toPersonId))
  const siblingIds = new Set(lineage
    .filter(({ fromPersonId, toPersonId }) =>
      parentIds.has(fromPersonId) && toPersonId !== props.person.id)
    .map(({ toPersonId }) => toPersonId))
  const grandparentIds = new Set(lineage
    .filter(({ toPersonId }) => parentIds.has(toPersonId))
    .map(({ fromPersonId }) => fromPersonId))
  const grandchildIds = new Set(lineage
    .filter(({ fromPersonId }) => childIds.has(fromPersonId))
    .map(({ toPersonId }) => toPersonId))
  const group = (label: string, ids: Set<string>) => ({
    label,
    people: [...ids].map((id) => personById.value.get(id)).filter(Boolean) as Person[],
  })
  return [
    group('兄弟姐妹', siblingIds),
    group('祖父母', grandparentIds),
    group('孙辈', grandchildIds),
  ].filter(({ people }) => people.length)
})

const careerCategoryLabels: Record<CareerRecord['category'], string> = {
  employment: '企业任职',
  civil_office: '文官',
  military_office: '武职',
  academic: '学术／教育',
  religious_office: '宗教职务',
  self_employed: '自由职业',
  other: '其他',
}

function organizationName(career: CareerRecord) {
  return props.organizations.find(({ id }) => id === career.organizationId)?.name
}

function placeName(career: CareerRecord) {
  return props.places.find(({ id }) => id === career.jurisdictionPlaceId)?.name
}

function personPlaceName(placeId: string | undefined) {
  return props.places.find(({ id }) => id === placeId)?.name ?? '未记录'
}

function careerPeriod(career: CareerRecord) {
  const start = career.start?.display
  const end = career.status === 'current' ? '至今' : career.end?.display
  return [start, end].filter(Boolean).join(' — ') || '时间未详'
}

function eventPlace(event: FamilyEvent) {
  return props.places.find(({ id }) => id === event.placeId)?.name
}

function citationSource(citation: Citation) {
  return sourceById.value.get(citation.sourceId)?.title ?? '未知来源'
}
</script>

<template>
  <article class="person-detail-panel">
    <header class="person-detail-panel__header">
      <div class="person-detail-panel__identity">
        <img
          v-if="person.avatarUrl"
          class="person-detail-panel__avatar"
          :src="person.avatarUrl"
          :alt="`${primaryName(person)}的头像`"
        />
        <div
          v-else
          class="person-detail-panel__avatar person-detail-panel__avatar--fallback"
          role="img"
          :aria-label="`${primaryName(person)}暂无头像`"
        >
          {{ avatarFallback(person) }}
        </div>
        <div>
          <p>人物档案</p>
          <h1>{{ primaryName(person) }}</h1>
          <div class="person-detail-panel__names">
            <span
              v-for="name in person.names.filter((name) => !isPrimaryName(person, name))"
              :key="`${name.value}-${name.type}`"
            >
              <b>{{ name.type === 'custom' ? name.customTypeLabel || '自定义' : personNameTypeLabels[name.type] }}</b>
              {{ name.value }}
            </span>
          </div>
        </div>
      </div>
      <div class="person-detail-panel__header-actions">
        <StatusBadge :tone="person.status === 'living' ? 'success' : 'neutral'">
          {{ statusLabels[person.status] }}
        </StatusBadge>
        <div class="person-detail-panel__commands" aria-label="人物操作">
          <button
            class="person-detail-panel__action person-detail-panel__action--edit"
            type="button"
            name="编辑人物"
            aria-label="编辑人物"
            @click="emit('edit')"
          >
            <IconPencil :size="18" :stroke-width="1.8" aria-hidden="true" />
            <span>编辑</span>
          </button>
          <span class="person-detail-panel__action-divider" aria-hidden="true" />
          <button
            class="person-detail-panel__action person-detail-panel__action--delete"
            type="button"
            name="删除人物"
            aria-label="删除人物"
            @click="emit('delete')"
          >
            <IconTrash :size="18" :stroke-width="1.8" aria-hidden="true" />
            <span>删除</span>
          </button>
        </div>
      </div>
    </header>

    <nav class="person-detail-panel__module-nav" aria-label="人物档案模块" role="tablist">
      <button
        id="person-detail-tab-overview"
        :class="['person-detail-panel__module-link', { 'person-detail-panel__module-link--active': activeDetailModule === 'overview' }]"
        type="button"
        role="tab"
        :aria-selected="activeDetailModule === 'overview'"
        :tabindex="activeDetailModule === 'overview' ? 0 : -1"
        aria-controls="person-overview"
        @click="activeDetailModule = 'overview'"
      >
        <IconUserCircle :size="18" aria-hidden="true" />人物概览
      </button>
      <button
        id="person-detail-tab-life"
        :class="['person-detail-panel__module-link', { 'person-detail-panel__module-link--active': activeDetailModule === 'life' }]"
        type="button"
        role="tab"
        :aria-selected="activeDetailModule === 'life'"
        :tabindex="activeDetailModule === 'life' ? 0 : -1"
        aria-controls="person-life-track"
        @click="activeDetailModule = 'life'"
      >
        <IconTimeline :size="18" aria-hidden="true" />生平轨迹
      </button>
      <button
        id="person-detail-tab-materials"
        :class="['person-detail-panel__module-link', { 'person-detail-panel__module-link--active': activeDetailModule === 'materials' }]"
        type="button"
        role="tab"
        :aria-selected="activeDetailModule === 'materials'"
        :tabindex="activeDetailModule === 'materials' ? 0 : -1"
        aria-controls="person-materials"
        @click="activeDetailModule = 'materials'"
      >
        <IconPhoto :size="18" aria-hidden="true" />资料与相册
      </button>
      <button
        id="person-detail-tab-events"
        :class="['person-detail-panel__module-link', { 'person-detail-panel__module-link--active': activeDetailModule === 'events' }]"
        type="button"
        role="tab"
        :aria-selected="activeDetailModule === 'events'"
        :tabindex="activeDetailModule === 'events' ? 0 : -1"
        aria-controls="person-events"
        @click="activeDetailModule = 'events'"
      >
        <IconCalendarEvent :size="18" aria-hidden="true" />事件
      </button>
    </nav>

    <div class="person-detail-panel__workspace">
      <section
        id="person-overview"
        v-show="activeDetailModule === 'overview'"
        class="person-detail-panel__module person-detail-panel__facts-module"
        aria-labelledby="person-detail-tab-overview"
        role="tabpanel"
      >
        <div class="person-detail-panel__module-heading">
          <h2 id="person-facts-heading">基本资料</h2>
        </div>
        <dl class="person-detail-panel__facts">
          <div><dt>生存状态</dt><dd>{{ statusLabels[person.status] }}</dd></div>
          <div data-person-sex><dt>性别</dt><dd>{{ sexLabels[person.sex] }}</dd></div>
          <div><dt>出生</dt><dd>{{ person.birth?.display ?? '未记录' }}</dd></div>
          <div><dt>出生地</dt><dd>{{ personPlaceName(person.birthPlaceId) }}</dd></div>
          <div><dt>死亡</dt><dd>{{ person.death?.display ?? '未记录' }}</dd></div>
          <div><dt>死亡地</dt><dd>{{ personPlaceName(person.deathPlaceId) }}</dd></div>
          <div><dt>来源</dt><dd>{{ sourceCount }} 项</dd></div>
        </dl>
      </section>

      <main class="person-detail-panel__primary">

    <section
      id="person-life-track"
      v-show="activeDetailModule === 'life'"
      class="person-detail-panel__module person-detail-panel__biography"
      aria-labelledby="person-detail-tab-life"
      role="tabpanel"
    >
      <div class="person-detail-panel__module-heading">
        <h2 id="person-biography-heading">生平与地点</h2>
      </div>
      <p>{{ person.biography || '还没有生平摘要。' }}</p>
      <dl class="person-detail-panel__place-summary">
        <div><dt>出生地</dt><dd>{{ personPlaceName(person.birthPlaceId) }}</dd></div>
        <div><dt>死亡地</dt><dd>{{ personPlaceName(person.deathPlaceId) }}</dd></div>
        <div><dt>主要活动</dt><dd>{{ events.map(eventPlace).filter(Boolean).slice(0, 2).join('、') || '未记录' }}</dd></div>
      </dl>
    </section>

    <PersonEventsModule
      id="person-events"
      v-show="activeDetailModule === 'events'"
      class="person-detail-panel__module"
      :person-id="person.id"
      :project-id="person.projectId"
      :events="events"
      :places="places"
      aria-labelledby="person-detail-tab-events"
      role="tabpanel"
      @create="emit('addEvent')"
      @edit="emit('editEvent', $event)"
    />

    <section v-show="activeDetailModule === 'life'" class="person-detail-panel__module person-detail-panel__careers" data-person-careers aria-labelledby="person-careers-heading">
      <div class="person-detail-panel__section-heading">
        <div>
          <h2 id="person-careers-heading">人物履历</h2>
          <p>公司职位与古代官职按时间统一整理。</p>
        </div>
        <BaseButton name="添加履历" variant="secondary" @click="emit('addCareer')">添加履历</BaseButton>
      </div>
      <ol v-if="sortedCareers.length">
        <li v-for="career in sortedCareers" :key="career.id" :data-career-id="career.id">
          <div class="person-detail-panel__career-mark" aria-hidden="true" />
          <div class="person-detail-panel__career-content">
            <div class="person-detail-panel__career-title">
              <div>
                <span>{{ careerCategoryLabels[career.category] }}</span>
                <h3>{{ career.positionTitle }}</h3>
              </div>
              <StatusBadge v-if="career.status === 'current'" tone="success">当前</StatusBadge>
            </div>
            <p class="person-detail-panel__career-org">
              {{ organizationName(career) || career.department || '机构未记录' }}
              <small v-if="organizationName(career) && career.department">· {{ career.department }}</small>
            </p>
            <p class="person-detail-panel__career-period">{{ careerPeriod(career) }}</p>
            <p v-if="career.regime || career.rankOrGrade || career.appointmentType || placeName(career)" class="person-detail-panel__career-meta">
              {{ [career.regime, career.rankOrGrade, career.appointmentType, placeName(career)].filter(Boolean).join(' · ') }}
            </p>
            <p v-if="career.description">{{ career.description }}</p>
            <small>{{ career.sourceIds.length ? `${career.sourceIds.length} 项来源` : '尚无来源' }}</small>
          </div>
          <BaseButton
            variant="ghost"
            size="sm"
            :aria-label="`编辑履历：${career.positionTitle}`"
            @click="emit('editCareer', career)"
          >编辑</BaseButton>
        </li>
      </ol>
      <p v-else class="person-detail-panel__empty">还没有记录人物履历。</p>
    </section>

    <section
      id="person-materials"
      v-show="activeDetailModule === 'materials'"
      class="person-detail-panel__module person-detail-panel__album"
      aria-labelledby="person-detail-tab-materials"
      role="tabpanel"
    >
      <div class="person-detail-panel__section-heading">
        <div>
          <h2 id="person-album-heading">人物相册</h2>
          <p>{{ albumAttachments.length }} 张照片</p>
        </div>
        <button class="person-detail-panel__text-action" type="button" @click="emit('edit')">管理相册</button>
      </div>
      <div v-if="albumAttachments.length" class="person-detail-panel__album-grid">
        <figure v-for="attachment in albumAttachments" :key="attachment.id">
          <button
            type="button"
            :disabled="!attachment.previewUrl"
            :aria-label="attachment.previewUrl ? `预览照片：${attachment.name}` : `${attachment.name}暂无预览`"
            @click="previewAttachment = attachment"
          >
            <img v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" />
            <span v-else><IconPhoto :size="26" aria-hidden="true" /></span>
          </button>
          <figcaption>{{ attachment.name }}</figcaption>
        </figure>
      </div>
      <div v-else class="person-detail-panel__album-empty">
        <IconPhoto :size="28" aria-hidden="true" />
        <span>还没有人物照片</span>
      </div>
    </section>
      </main>

      <aside class="person-detail-panel__secondary" aria-label="人物结构化资料">
    <section v-show="activeDetailModule === 'overview'" class="person-detail-panel__module person-detail-panel__name-module" aria-labelledby="person-name-module-heading">
      <div class="person-detail-panel__module-heading">
        <h2 id="person-name-module-heading">姓名与称谓</h2>
        <button class="person-detail-panel__text-action" type="button" @click="emit('edit')">编辑</button>
      </div>
      <dl>
        <div v-for="name in person.names" :key="`${name.value}-${name.type}`">
          <dt>{{ name.type === 'custom' ? name.customTypeLabel || '自定义' : personNameTypeLabels[name.type] }}</dt>
          <dd>{{ name.value }}</dd>
        </div>
      </dl>
    </section>

    <section v-show="activeDetailModule === 'overview'" class="person-detail-panel__module person-detail-panel__relationships" data-person-relationships aria-labelledby="person-relationships-heading">
      <div class="person-detail-panel__section-heading">
        <div>
          <h2 id="person-relationships-heading">家庭关系</h2>
          <p>兄弟姐妹与祖孙关系会从这些直接关系推导。</p>
        </div>
        <div class="person-detail-panel__relationship-actions">
          <BaseButton name="添加已有关系" variant="secondary" @click="emit('addRelationship')">
            添加已有关系
          </BaseButton>
          <BaseButton name="添加人物" @click="emit('quickAddRelative')">
            添加人物
          </BaseButton>
        </div>
      </div>
      <ul v-if="relationships.length">
        <li v-for="relationship in relationships" :key="relationship.id" :data-relationship-id="relationship.id">
          <div>
            <strong>{{ relationshipDisplayLabel(relationship, person.id, otherPerson(relationship)) }}</strong>
            <span>{{ otherPerson(relationship) ? primaryName(otherPerson(relationship)!) : '人物资料待读取' }}</span>
            <small>{{ relationship.type }}</small>
          </div>
          <BaseButton
            variant="ghost"
            size="sm"
            :aria-label="`编辑关系：${relationshipDisplayLabel(relationship, person.id, otherPerson(relationship))} ${otherPerson(relationship) ? primaryName(otherPerson(relationship)!) : '未知人物'}`"
            @click="emit('editRelationship', relationship)"
          >
            编辑
          </BaseButton>
        </li>
      </ul>
      <p v-else class="person-detail-panel__empty">还没有记录家庭关系。</p>
      <div
        v-if="derivedRelationshipGroups.length"
        class="person-detail-panel__derived"
        aria-label="推导关系摘要"
      >
        <div v-for="group in derivedRelationshipGroups" :key="group.label">
          <strong>{{ group.label }}</strong>
          <span>
            <a
              v-for="relative in group.people"
              :key="relative.id"
              :href="`/project/${person.projectId}/people/${relative.id}`"
            >{{ primaryName(relative) }}</a>
          </span>
        </div>
        <small>以上关系由已记录的亲生或收养亲子关系即时推导，不另存为关系记录。</small>
      </div>
    </section>

    <section v-show="activeDetailModule === 'materials'" class="person-detail-panel__module person-detail-panel__evidence" data-person-evidence aria-labelledby="person-evidence-heading">
      <div class="person-detail-panel__section-heading">
        <div>
          <h2 id="person-evidence-heading">来源与附件</h2>
          <p>{{ sources.length }} 项来源、{{ citations.length }} 条引用、{{ linkedAttachments.length }} 个附件。</p>
        </div>
        <a
          :href="`/project/${person.projectId}/sources`"
          aria-label="管理人物证据"
        >管理资料来源</a>
      </div>
      <ul v-if="citations.length" class="person-detail-panel__citations">
        <li v-for="citation in citations" :key="citation.id">
          <strong>{{ citationSource(citation) }}</strong>
          <span>{{ citation.locator || citation.excerpt || '已关联到人物资料' }}</span>
        </li>
      </ul>
      <ul v-if="linkedAttachments.length" class="person-detail-panel__attachments">
        <li v-for="attachment in linkedAttachments" :key="attachment.id">
          <span>{{ attachment.name }}</span>
          <StatusBadge :tone="attachment.missing ? 'warning' : 'success'">
            {{ attachment.missing ? '文件缺失' : '文件可用' }}
          </StatusBadge>
        </li>
      </ul>
      <p v-if="citations.length === 0 && linkedAttachments.length === 0" class="person-detail-panel__empty">
        还没有与此人物关联的引用或附件。
      </p>
    </section>

    <section v-show="activeDetailModule === 'life'" class="person-detail-panel__module person-detail-panel__notes" data-person-notes aria-labelledby="person-notes-heading">
      <div class="person-detail-panel__module-heading">
        <h2 id="person-notes-heading">整理笔记</h2>
      </div>
      <p>{{ person.notes || '还没有整理备注。' }}</p>
    </section>
      </aside>
    </div>

  </article>
  <BaseDialog
    :open="Boolean(previewAttachment?.previewUrl)"
    :title="previewAttachment?.name ?? '照片预览'"
    close-label="关闭照片预览"
    @close="previewAttachment = undefined"
  >
    <img
      v-if="previewAttachment?.previewUrl"
      class="person-detail-panel__photo-preview"
      :src="previewAttachment.previewUrl"
      :alt="previewAttachment.name"
    />
  </BaseDialog>
</template>

<style scoped>
.person-detail-panel { display: grid; gap: var(--space-6); padding: clamp(1.5rem, 4vw, 3rem); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.person-detail-panel__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.person-detail-panel__header-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-4); }
.person-detail-panel__commands { display: inline-flex; align-items: center; gap: var(--space-1); white-space: nowrap; }
.person-detail-panel__action { display: inline-flex; min-height: 2.5rem; align-items: center; gap: var(--space-1); padding: var(--space-2); border: 0; border-radius: var(--radius-sm); background: transparent; font: inherit; font-size: .9375rem; font-weight: 700; line-height: 1; cursor: pointer; transition: background-color 160ms ease, color 160ms ease; }
.person-detail-panel__action--edit { color: var(--color-primary); }
.person-detail-panel__action--delete { color: var(--color-danger); }
.person-detail-panel__action:hover { background: var(--color-muted-surface); }
.person-detail-panel__action--delete:hover { background: var(--color-danger-surface); }
.person-detail-panel__action-divider { width: 1px; height: 1.25rem; margin-inline: var(--space-1); background: var(--color-border); }
.person-detail-panel__identity { display: flex; min-width: 0; align-items: flex-start; gap: var(--space-4); }
.person-detail-panel__avatar { width: 5rem; height: 5rem; flex: 0 0 auto; border: 1px solid var(--color-border); border-radius: 50%; object-fit: cover; }
.person-detail-panel__avatar--fallback { display: grid; place-items: center; background: var(--color-muted-surface); color: var(--color-primary); font-family: var(--font-heading); font-size: 2rem; font-weight: 650; }
.person-detail-panel__header p { margin: 0; color: var(--color-accent); font-size: .75rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.person-detail-panel h1 { margin: var(--space-1) 0; font-family: var(--font-heading); font-size: clamp(2.25rem, 6vw, 4.5rem); font-weight: 560; }
.person-detail-panel h1 small { color: var(--color-muted); font-family: var(--font-body); font-size: .875rem; font-weight: 500; white-space: nowrap; }
.person-detail-panel__names { display: flex; flex-wrap: wrap; gap: var(--space-2); color: var(--color-muted); }
.person-detail-panel__facts { display: grid; grid-template-columns: repeat(4, 1fr); margin: 0; border-block: 1px solid var(--color-border); }
.person-detail-panel__facts div { padding: var(--space-4); }
.person-detail-panel__facts dt { color: var(--color-muted); font-size: .75rem; }
.person-detail-panel__facts dd { margin: var(--space-1) 0 0; font-weight: 700; }
.person-detail-panel section h2 { font-family: var(--font-heading); }
.person-detail-panel__notes { padding: var(--space-4); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.person-detail-panel__notes h2 { margin-top: 0; }
.person-detail-panel__notes p { margin-bottom: 0; }
.person-detail-panel__relationships { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.person-detail-panel__events,
.person-detail-panel__evidence { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.person-detail-panel__events ol,
.person-detail-panel__citations,
.person-detail-panel__attachments { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.person-detail-panel__events li a { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); color: inherit; text-decoration: none; }
.person-detail-panel__events li span,
.person-detail-panel__events li small { color: var(--color-muted); }
.person-detail-panel__citations li,
.person-detail-panel__attachments li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); }
.person-detail-panel__citations li span { color: var(--color-muted); text-align: right; }
.person-detail-panel__careers { display: grid; gap: var(--space-4); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.person-detail-panel__careers ol { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.person-detail-panel__careers li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--color-border); }
.person-detail-panel__careers li:last-child { border-bottom: 0; }
.person-detail-panel__career-mark { width: .65rem; height: .65rem; margin-top: .5rem; border: 2px solid var(--color-primary); border-radius: 50%; background: var(--color-surface); }
.person-detail-panel__career-content { display: grid; gap: var(--space-1); }
.person-detail-panel__career-title { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
.person-detail-panel__career-title span { color: var(--color-accent); font-size: .75rem; font-weight: 750; }
.person-detail-panel__career-title h3, .person-detail-panel__career-content p { margin: 0; }
.person-detail-panel__career-org { color: var(--color-text); font-weight: 700; }
.person-detail-panel__career-period, .person-detail-panel__career-meta, .person-detail-panel__career-content small { color: var(--color-muted); }
.person-detail-panel__section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
.person-detail-panel__section-heading h2, .person-detail-panel__section-heading p { margin: 0; }
.person-detail-panel__section-heading p, .person-detail-panel__empty { color: var(--color-muted); }
.person-detail-panel__relationship-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.person-detail-panel__relationships ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.person-detail-panel__relationships li { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); }
.person-detail-panel__relationships li > div { display: grid; gap: var(--space-1); }
.person-detail-panel__relationships li span, .person-detail-panel__relationships li small { color: var(--color-muted); }
.person-detail-panel__derived { display: grid; gap: var(--space-2); padding: var(--space-3); border-top: 1px solid var(--color-border); }
.person-detail-panel__derived > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: var(--space-3); }
.person-detail-panel__derived span { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.person-detail-panel__derived a { color: var(--color-primary); font-weight: 700; }
.person-detail-panel__derived small { color: var(--color-muted); }
.person-detail-panel__module-nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--color-border); }
.person-detail-panel__module-link { position: relative; display: inline-flex; min-height: 3.25rem; align-items: center; justify-content: center; gap: var(--space-2); padding: 0 var(--space-3); border: 0; background: transparent; color: var(--color-muted); font: inherit; font-size: .875rem; font-weight: 700; text-decoration: none; cursor: pointer; }
.person-detail-panel__module-link::after { position: absolute; right: 28%; bottom: -1px; left: 28%; height: 2px; background: transparent; content: ''; }
.person-detail-panel__module-link:hover { color: var(--color-primary); }
.person-detail-panel__module-link--active { color: var(--color-primary); }
.person-detail-panel__module-link--active::after { background: var(--color-primary); }
.person-detail-panel__workspace { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: var(--space-4); }
.person-detail-panel__primary,
.person-detail-panel__secondary { display: contents; }
.person-detail-panel__module { scroll-margin-top: var(--space-8); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.person-detail-panel__module-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.person-detail-panel__module-heading h2 { margin: 0; font-size: 1.125rem; }
.person-detail-panel__facts-module { grid-row: auto; grid-column: auto; }
.person-detail-panel__facts { grid-template-columns: repeat(2, minmax(0, 1fr)); border: 0; }
.person-detail-panel__facts div { padding: var(--space-2) 0; border-bottom: 1px solid color-mix(in srgb, var(--color-border) 65%, transparent); }
.person-detail-panel__facts div:nth-last-child(-n + 2) { border-bottom: 0; }
.person-detail-panel__facts dd { overflow-wrap: anywhere; }
.person-detail-panel__biography > p { max-width: 65ch; margin: 0; line-height: 1.85; }
.person-detail-panel__place-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-4) 0 0; padding-top: var(--space-4); border-top: 1px solid var(--color-border); }
.person-detail-panel__place-summary div { min-width: 0; }
.person-detail-panel__place-summary dt { color: var(--color-muted); font-size: .75rem; }
.person-detail-panel__place-summary dd { margin: var(--space-1) 0 0; font-weight: 700; overflow-wrap: anywhere; }
.person-detail-panel__events,
.person-detail-panel__evidence,
.person-detail-panel__careers,
.person-detail-panel__relationships { padding: var(--space-4); }
.person-detail-panel__events li a { grid-template-columns: minmax(7rem, .75fr) minmax(0, 1fr); border-radius: 0; background: transparent; border-bottom: 1px solid var(--color-border); }
.person-detail-panel__events li:last-child a { border-bottom: 0; }
.person-detail-panel__events li small { grid-column: 2; }
.person-detail-panel__album { display: grid; gap: var(--space-3); }
.person-detail-panel__album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr)); gap: var(--space-3); }
.person-detail-panel__album figure { min-width: 0; margin: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-background); }
.person-detail-panel__album figure > button { display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.person-detail-panel__album figure > button:disabled { cursor: default; }
.person-detail-panel__album figure img,
.person-detail-panel__album figure button > span { display: grid; width: 100%; aspect-ratio: 4 / 3; place-items: center; object-fit: cover; color: var(--color-muted); }
.person-detail-panel__album figcaption { padding: var(--space-2); overflow: hidden; color: var(--color-muted); font-size: .75rem; text-overflow: ellipsis; white-space: nowrap; }
.person-detail-panel__photo-preview { display: block; width: 100%; max-height: min(70vh, 46rem); object-fit: contain; border-radius: var(--radius-sm); background: var(--color-background); }
.person-detail-panel__album-empty { display: flex; min-height: 8rem; align-items: center; justify-content: center; gap: var(--space-2); border: 1px dashed var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted); }
.person-detail-panel__text-action { padding: var(--space-1) var(--space-2); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-primary); font: inherit; font-size: .8125rem; font-weight: 700; cursor: pointer; }
.person-detail-panel__text-action:hover { background: var(--color-muted-surface); }
.person-detail-panel__name-module dl { display: grid; gap: 0; margin: 0; }
.person-detail-panel__name-module dl div { display: grid; grid-template-columns: minmax(5.5rem, .8fr) minmax(0, 1fr); gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border); }
.person-detail-panel__name-module dl div:last-child { border-bottom: 0; }
.person-detail-panel__name-module dt { color: var(--color-muted); font-size: .8125rem; }
.person-detail-panel__name-module dd { margin: 0; font-weight: 650; overflow-wrap: anywhere; }
.person-detail-panel__relationships .person-detail-panel__section-heading { display: grid; }
.person-detail-panel__relationship-actions { justify-content: flex-start; }
.person-detail-panel__relationships ul { grid-template-columns: 1fr; }
.person-detail-panel__notes { background: var(--color-paper-tint); }
.person-detail-panel__notes p { margin: 0; line-height: 1.7; }
@media (max-width: 64rem) {
  .person-detail-panel__workspace { grid-template-columns: 1fr; }
  .person-detail-panel__facts-module,
  .person-detail-panel__primary,
  .person-detail-panel__secondary { grid-row: auto; grid-column: 1; }
  .person-detail-panel__facts-module { order: -1; }
}
@media (max-width: 36rem) {
  .person-detail-panel { padding: var(--space-4); }
  .person-detail-panel__header { flex-direction: column; }
  .person-detail-panel__header-actions { justify-content: flex-start; }
  .person-detail-panel__module-nav { grid-template-columns: 1fr; }
  .person-detail-panel__module-link { justify-content: flex-start; padding-inline: var(--space-3); }
  .person-detail-panel__module-link::after { right: auto; left: 0; width: 2px; height: 55%; bottom: 22%; }
  .person-detail-panel__facts,
  .person-detail-panel__place-summary { grid-template-columns: 1fr; }
  .person-detail-panel__section-heading { flex-direction: column; }
}
</style>
