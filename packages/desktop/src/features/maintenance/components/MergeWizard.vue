<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  AttachmentLink,
  Attachment,
  Citation,
  FamilyEvent,
  Person,
  PersonMergeChoices,
  PersonMergeResult,
  Place,
  Relationship,
  RelationshipConflictChoice,
  RelationshipMergeField,
  Source,
  UUID,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import {
  collectRelationshipMergeConflicts,
  createPersonMergePreview,
  derivePersonMergeDependencyConstraints,
  type RelationshipMergeConflict,
} from '../model/mergePeople'

const props = defineProps<{
  open: boolean
  keepPersonId: UUID
  removePersonId: UUID
  people: Person[]
  relationships: Relationship[]
  events: FamilyEvent[]
  citations: Citation[]
  attachmentLinks: AttachmentLink[]
  attachments: Attachment[]
  places: Place[]
  sources: Source[]
}>()
const emit = defineEmits<{ cancel: []; merged: [result: PersonMergeResult] }>()
const repository = useBranchloomRepository()
const session = useSessionStore()

type ChoiceKey = 'sex' | 'status' | 'avatarUrl' | 'birth' | 'death' | 'birthPlaceId' | 'deathPlaceId' | 'biography' | 'notes'
const choiceKeys: ChoiceKey[] = [
  'sex', 'status', 'avatarUrl', 'birth', 'death', 'birthPlaceId', 'deathPlaceId', 'biography', 'notes',
]
const choiceLabels: Record<ChoiceKey, string> = {
  sex: '性别',
  status: '生存状态',
  avatarUrl: '头像',
  birth: '出生日期',
  death: '死亡日期',
  birthPlaceId: '出生地点',
  deathPlaceId: '死亡地点',
  biography: '人物简介',
  notes: '备注',
}
const choices = reactive<Record<ChoiceKey, 'auto' | 'keep' | 'remove'>>({
  sex: 'auto', status: 'auto', avatarUrl: 'auto', birth: 'auto', death: 'auto',
  birthPlaceId: 'auto', deathPlaceId: 'auto', biography: 'auto', notes: 'auto',
})
const retainedNameIds = ref<UUID[]>([])
const retainedSourceIds = ref<UUID[]>([])
const retainedRelationshipIds = ref<UUID[]>([])
const retainedEventIds = ref<UUID[]>([])
const retainedCitationIds = ref<UUID[]>([])
const retainedAttachmentLinkIds = ref<UUID[]>([])
const relationshipFieldSelections = ref<Record<string, Partial<Record<RelationshipMergeField, UUID>>>>({})
const saving = ref(false)
const errorMessage = ref('')
const result = ref<PersonMergeResult>()

const personById = computed(() => new Map(props.people.map((person) => [person.id, person])))
const keep = computed(() => personById.value.get(props.keepPersonId))
const remove = computed(() => personById.value.get(props.removePersonId))
const placeById = computed(() => new Map(props.places.map((place) => [place.id, place.name])))
const sourceById = computed(() => new Map(props.sources.map((source) => [source.id, source.title])))

function reset() {
  for (const key of choiceKeys) choices[key] = 'auto'
  retainedNameIds.value = [...new Set([...(keep.value?.names ?? []), ...(remove.value?.names ?? [])].map(({ value }) => value))]
  retainedSourceIds.value = [...new Set([...(keep.value?.sourceIds ?? []), ...(remove.value?.sourceIds ?? [])])]
  retainedRelationshipIds.value = relatedRelationships.value.map(({ id }) => id)
  retainedEventIds.value = relatedEvents.value.map(({ id }) => id)
  retainedCitationIds.value = relatedCitations.value.map(({ id }) => id)
  retainedAttachmentLinkIds.value = relatedAttachmentLinks.value.map(({ id }) => id)
  relationshipFieldSelections.value = {}
  saving.value = false
  errorMessage.value = ''
  result.value = undefined
}

function personName(person: Person | undefined): string {
  return person ? getPrimaryName(person) : '未知人物'
}

function dateText(date: Person['birth']): string {
  if (!date) return '未填写'
  return date.display || [date.start, date.end].filter(Boolean).join(' — ') || '未知'
}

function sexText(person: Person | undefined): string {
  return ({ female: '女性', male: '男性', nonbinary: '非二元', unknown: '未知' } as const)[person?.sex ?? 'unknown']
}

function statusText(person: Person | undefined): string {
  return ({ living: '在世', deceased: '已故', unknown: '未知' } as const)[person?.status ?? 'unknown']
}

function fieldValue(person: Person, key: ChoiceKey): unknown {
  const value = person[key]
  if ((key === 'sex' || key === 'status') && value === 'unknown') return undefined
  if ((key === 'birth' || key === 'death')
    && (value as Person['birth'])?.precision === 'unknown') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  return value
}

function isConflict(key: ChoiceKey): boolean {
  if (!keep.value || !remove.value) return false
  const left = fieldValue(keep.value, key)
  const right = fieldValue(remove.value, key)
  return left !== undefined && right !== undefined && JSON.stringify(left) !== JSON.stringify(right)
}

function familyIds(personId: UUID, kind: 'parents' | 'partners' | 'children'): UUID[] {
  const ids = new Set<UUID>()
  for (const relationship of props.relationships) {
    if (kind === 'parents' && relationship.category === 'parent' && relationship.toPersonId === personId) ids.add(relationship.fromPersonId)
    if (kind === 'children' && relationship.category === 'parent' && relationship.fromPersonId === personId) ids.add(relationship.toPersonId)
    if (kind === 'partners' && relationship.category === 'partner') {
      if (relationship.fromPersonId === personId) ids.add(relationship.toPersonId)
      if (relationship.toPersonId === personId) ids.add(relationship.fromPersonId)
    }
  }
  return [...ids]
}

function peopleText(ids: UUID[]): string {
  return ids.map((id) => personName(personById.value.get(id))).join('、') || '无'
}

function eventText(personId: UUID): string {
  return props.events.filter(({ participantIds }) => participantIds.includes(personId)).map(({ title }) => title).join('、') || '无'
}

function sourceText(person: Person | undefined): string {
  if (!person) return '无'
  return (person.sourceIds ?? []).map((id) => sourceById.value.get(id) ?? id).join('、') || '无'
}

const relatedRelationships = computed(() => props.relationships.filter(({ fromPersonId, toPersonId }) =>
  [fromPersonId, toPersonId].includes(props.keepPersonId) || [fromPersonId, toPersonId].includes(props.removePersonId)))
const relatedEvents = computed(() => props.events.filter(({ participantIds }) =>
  participantIds.includes(props.keepPersonId) || participantIds.includes(props.removePersonId)))
const relatedCitations = computed(() => {
  const relationshipIds = new Set(relatedRelationships.value.map(({ id }) => id))
  return props.citations.filter((citation) =>
    (citation.targetType === 'person' && [props.keepPersonId, props.removePersonId].includes(citation.targetId))
    || (citation.targetType === 'relationship' && relationshipIds.has(citation.targetId)))
})
const relatedAttachmentLinks = computed(() => {
  const relationshipIds = new Set(relatedRelationships.value.map(({ id }) => id))
  const citationIds = new Set(relatedCitations.value.map(({ id }) => id))
  return props.attachmentLinks.filter((link) =>
    (link.targetType === 'person' && [props.keepPersonId, props.removePersonId].includes(link.targetId))
    || (link.targetType === 'relationship' && relationshipIds.has(link.targetId))
    || (link.targetType === 'citation' && citationIds.has(link.targetId)))
})
const dependencyConstraints = computed(() => derivePersonMergeDependencyConstraints({
  relationships: props.relationships,
  citations: props.citations,
  attachmentLinks: props.attachmentLinks,
}, {
  keepPersonId: props.keepPersonId,
  removePersonId: props.removePersonId,
  choices: {
    retainedRelationshipIds: [...retainedRelationshipIds.value],
    retainedCitationIds: [...retainedCitationIds.value],
    retainedAttachmentLinkIds: [...retainedAttachmentLinkIds.value],
  },
}))
const forcedCitationIds = computed(() => new Set(dependencyConstraints.value.forcedCitationIds))
const forcedAttachmentLinkIds = computed(() => new Set(dependencyConstraints.value.forcedAttachmentLinkIds))
const attachmentById = computed(() => new Map(props.attachments.map((attachment) => [attachment.id, attachment])))

function storedRelationshipChoices(): RelationshipConflictChoice[] {
  return Object.entries(relationshipFieldSelections.value).map(([key, fields]) => {
    const [leftId, rightId] = key.split('\0') as [UUID, UUID]
    return { relationshipIds: [leftId, rightId], fields: { ...fields } }
  })
}

const relationshipConflicts = computed<RelationshipMergeConflict[]>(() => {
  const retained = new Set(retainedRelationshipIds.value)
  return collectRelationshipMergeConflicts(
    relatedRelationships.value.filter(({ id }) => retained.has(id)),
    props.keepPersonId,
    props.removePersonId,
    storedRelationshipChoices(),
  )
})

function setRelationshipField(conflict: RelationshipMergeConflict, field: RelationshipMergeField, value: UUID) {
  relationshipFieldSelections.value = {
    ...relationshipFieldSelections.value,
    [conflict.key]: { ...relationshipFieldSelections.value[conflict.key], [field]: value },
  }
}

function relationshipFieldText(relationship: Relationship, field: RelationshipMergeField): string {
  const value = relationship[field]
  if (field === 'start' || field === 'end') {
    const date = value as Relationship['start']
    return date?.display || JSON.stringify(date)
  }
  if (field === 'placeId') return placeById.value.get(value as UUID) ?? String(value)
  return String(value)
}

function relationshipChoices(): RelationshipConflictChoice[] {
  return storedRelationshipChoices()
}

watch(
  () => [props.open, props.keepPersonId, props.removePersonId] as const,
  ([open]) => { if (open) reset() },
  { immediate: true },
)

function citationsText(personId: UUID): string {
  return props.citations.filter(({ targetType, targetId }) => targetType === 'person' && targetId === personId)
    .map((citation) => `${sourceById.value.get(citation.sourceId) ?? citation.sourceId}${citation.locator ? `（${citation.locator}）` : ''}`)
    .join('、') || '无'
}

function attachmentsText(personId: UUID): string {
  const citationIds = new Set(props.citations
    .filter(({ targetType, targetId }) => targetType === 'person' && targetId === personId)
    .map(({ id }) => id))
  return props.attachmentLinks.filter((link) =>
    (link.targetType === 'person' && link.targetId === personId)
    || (link.targetType === 'citation' && citationIds.has(link.targetId)))
    .map(({ attachmentId }) => attachmentById.value.get(attachmentId)?.name ?? attachmentId)
    .join('、') || '无'
}

function toggle(values: UUID[], id: UUID, checked: boolean): UUID[] {
  return checked ? [...new Set([...values, id])] : values.filter((value) => value !== id)
}

function currentChoices(): PersonMergeChoices {
  return {
    ...Object.fromEntries(choiceKeys.map((key) => [key, choices[key]])),
    retainedNameValues: [...retainedNameIds.value],
    retainedSourceIds: [...retainedSourceIds.value],
    retainedRelationshipIds: [...retainedRelationshipIds.value],
    retainedEventIds: [...retainedEventIds.value],
    retainedCitationIds: retainedCitationIds.value.filter((id) => !forcedCitationIds.value.has(id)),
    retainedAttachmentLinkIds: retainedAttachmentLinkIds.value.filter((id) => !forcedAttachmentLinkIds.value.has(id)),
    relationshipConflictChoices: relationshipChoices(),
  }
}

const unresolvedConflicts = computed(() => choiceKeys.filter((key) =>
  isConflict(key) && choices[key] === 'auto'))
const unresolvedRelationshipConflicts = computed(() => relationshipConflicts.value.flatMap((conflict) =>
  conflict.fields.filter((field) => !relationshipFieldSelections.value[conflict.key]?.[field])))

const preview = computed(() => {
  if (!keep.value || !remove.value || retainedNameIds.value.length === 0
    || unresolvedConflicts.value.length > 0 || unresolvedRelationshipConflicts.value.length > 0) return undefined
  return createPersonMergePreview({
    people: props.people,
    relationships: props.relationships,
    events: props.events,
    citations: props.citations,
    attachmentLinks: props.attachmentLinks,
  }, {
    keepPersonId: props.keepPersonId,
    removePersonId: props.removePersonId,
    choices: currentChoices(),
  })
})

async function confirmMerge() {
  if (saving.value) return
  if (!preview.value) {
    errorMessage.value = '至少需要保留一个姓名。'
    return
  }
  saving.value = true
  errorMessage.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    result.value = await repository.mergePeople({
      keepPersonId: props.keepPersonId,
      removePersonId: props.removePersonId,
      choices: currentChoices(),
    })
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('merged', result.value)
  } catch (error) {
    const details = error instanceof Error && error.message.trim()
      ? error.message
      : '人物合并事务失败，原数据已保留。'
    errorMessage.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="open" class="backdrop">
    <section role="dialog" aria-modal="true" aria-labelledby="merge-title" class="wizard">
      <template v-if="result">
        <h2 id="merge-title">合并完成</h2>
        <p>已创建合并前快照“{{ result.snapshot.note }}”，可从备份与快照恢复。</p>
        <dl class="summary">
          <div><dt>关系重连</dt><dd>{{ result.summary.rewiredRelationships }}</dd></div>
          <div><dt>事件重连</dt><dd>{{ result.summary.rewiredEvents }}</dd></div>
          <div><dt>引用重连</dt><dd>{{ result.summary.rewiredCitations }}</dd></div>
          <div><dt>检查结果</dt><dd>{{ result.issues.length }}</dd></div>
        </dl>
        <button type="button" name="关闭合并结果" @click="emit('cancel')">完成</button>
      </template>

      <template v-else>
        <header>
          <div>
            <h2 id="merge-title">合并人物</h2>
            <p>逐项核对，只有确认后才会创建快照并写入。</p>
          </div>
          <button type="button" name="取消合并" :disabled="saving" @click="emit('cancel')">取消</button>
        </header>

        <div v-if="keep && remove" class="comparison">
          <div class="row heading"><strong>字段</strong><strong>保留记录：{{ personName(keep) }}</strong><strong>合并记录：{{ personName(remove) }}</strong><strong>采用</strong></div>
          <div class="row"><b>姓名</b><span>{{ keep.names.map(({ value }) => value).join('、') }}</span><span>{{ remove.names.map(({ value }) => value).join('、') }}</span><span>默认全部保留</span></div>
          <div v-for="name in [...keep.names, ...remove.names]" :key="`${name.value}-${name.type}`" class="preserve-option">
            <label><input type="checkbox" :checked="retainedNameIds.includes(name.value)" @change="retainedNameIds = toggle(retainedNameIds, name.value, ($event.target as HTMLInputElement).checked)">保留姓名“{{ name.value }}”</label>
          </div>
          <div class="row"><b>性别</b><span>{{ sexText(keep) }}</span><span>{{ sexText(remove) }}</span><BaseSelectControl v-if="isConflict('sex')"><select name="choice-sex" :aria-label="`保留字段：${choiceLabels.sex}`" v-model="choices.sex"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
          <div class="row"><b>生存状态</b><span>{{ statusText(keep) }}</span><span>{{ statusText(remove) }}</span><BaseSelectControl v-if="isConflict('status')"><select name="choice-status" :aria-label="`保留字段：${choiceLabels.status}`" v-model="choices.status"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
          <div class="row"><b>头像</b><span>{{ keep.avatarUrl ? '已设置本地头像' : '无' }}</span><span>{{ remove.avatarUrl ? '已设置本地头像' : '无' }}</span><BaseSelectControl v-if="isConflict('avatarUrl')"><select name="choice-avatarUrl" :aria-label="`保留字段：${choiceLabels.avatarUrl}`" v-model="choices.avatarUrl"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
          <div class="row"><b>出生</b><span>{{ dateText(keep.birth) }}</span><span>{{ dateText(remove.birth) }}</span><BaseSelectControl v-if="isConflict('birth')"><select name="choice-birth" :aria-label="`保留字段：${choiceLabels.birth}`" v-model="choices.birth"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
          <div class="row"><b>死亡</b><span>{{ dateText(keep.death) }}</span><span>{{ dateText(remove.death) }}</span><BaseSelectControl v-if="isConflict('death')"><select name="choice-death" :aria-label="`保留字段：${choiceLabels.death}`" v-model="choices.death"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
          <div class="row"><b>父母</b><span>{{ peopleText(familyIds(keep.id, 'parents')) }}</span><span>{{ peopleText(familyIds(remove.id, 'parents')) }}</span><span>安全重连</span></div>
          <div class="row"><b>伴侣</b><span>{{ peopleText(familyIds(keep.id, 'partners')) }}</span><span>{{ peopleText(familyIds(remove.id, 'partners')) }}</span><span>安全重连</span></div>
          <div class="row"><b>子女</b><span>{{ peopleText(familyIds(keep.id, 'children')) }}</span><span>{{ peopleText(familyIds(remove.id, 'children')) }}</span><span>安全重连</span></div>
          <div v-for="relationship in relatedRelationships" :key="relationship.id" class="preserve-option"><label><input :name="`retain-relationship-${relationship.id}`" type="checkbox" :checked="retainedRelationshipIds.includes(relationship.id)" @change="retainedRelationshipIds = toggle(retainedRelationshipIds, relationship.id, ($event.target as HTMLInputElement).checked)">保留关系 {{ relationship.id }}</label></div>
          <div v-for="conflict in relationshipConflicts" :key="conflict.key" class="relationship-conflict">
            <strong>关系字段冲突：{{ conflict.left.id }} / {{ conflict.right.id }}</strong>
            <label v-for="field in conflict.fields" :key="field">
              {{ field }}
              <BaseSelectControl>
                <select
                  :name="`relationship-choice-${field}-${[conflict.left.id, conflict.right.id].sort().join('-')}`"
                  :aria-label="`关系冲突：${field}（${conflict.left.id} / ${conflict.right.id}）`"
                  :value="relationshipFieldSelections[conflict.key]?.[field] ?? ''"
                  @change="setRelationshipField(conflict, field, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>请选择保留值</option>
                  <option :value="conflict.left.id">{{ conflict.left.id }}：{{ relationshipFieldText(conflict.left, field) }}</option>
                  <option :value="conflict.right.id">{{ conflict.right.id }}：{{ relationshipFieldText(conflict.right, field) }}</option>
                </select>
              </BaseSelectControl>
            </label>
          </div>
          <div class="row"><b>事件</b><span>{{ eventText(keep.id) }}</span><span>{{ eventText(remove.id) }}</span><span>参与者去重</span></div>
          <div v-for="event in relatedEvents" :key="event.id" class="preserve-option"><label><input :name="`retain-event-${event.id}`" type="checkbox" :checked="retainedEventIds.includes(event.id)" @change="retainedEventIds = toggle(retainedEventIds, event.id, ($event.target as HTMLInputElement).checked)">保留事件关联“{{ event.title }}”</label></div>
          <div class="row"><b>地点</b><span>出生：{{ placeById.get(keep.birthPlaceId ?? '') ?? '无' }}；死亡：{{ placeById.get(keep.deathPlaceId ?? '') ?? '无' }}</span><span>出生：{{ placeById.get(remove.birthPlaceId ?? '') ?? '无' }}；死亡：{{ placeById.get(remove.deathPlaceId ?? '') ?? '无' }}</span><span class="stacked"><BaseSelectControl v-if="isConflict('birthPlaceId')"><select name="choice-birthPlaceId" :aria-label="`保留字段：${choiceLabels.birthPlaceId}`" v-model="choices.birthPlaceId"><option value="auto">自动采用保留记录</option><option value="keep">出生地取保留记录</option><option value="remove">出生地取合并记录</option></select></BaseSelectControl><span v-else>出生地自动保留非空值</span><BaseSelectControl v-if="isConflict('deathPlaceId')"><select name="choice-deathPlaceId" :aria-label="`保留字段：${choiceLabels.deathPlaceId}`" v-model="choices.deathPlaceId"><option value="auto">自动采用保留记录</option><option value="keep">死亡地取保留记录</option><option value="remove">死亡地取合并记录</option></select></BaseSelectControl><span v-else>死亡地自动保留非空值</span></span></div>
          <div class="row"><b>来源</b><span>{{ sourceText(keep) }}</span><span>{{ sourceText(remove) }}</span><span>默认全部保留</span></div>
          <div v-for="sourceId in [...new Set([...(keep.sourceIds ?? []), ...(remove.sourceIds ?? [])])]" :key="sourceId" class="preserve-option">
            <label><input type="checkbox" :checked="retainedSourceIds.includes(sourceId)" @change="retainedSourceIds = toggle(retainedSourceIds, sourceId, ($event.target as HTMLInputElement).checked)">保留来源“{{ sourceById.get(sourceId) ?? sourceId }}”</label>
          </div>
          <div class="row"><b>引用</b><span>{{ citationsText(keep.id) }}</span><span>{{ citationsText(remove.id) }}</span><span>默认全部保留</span></div>
          <div v-for="citation in relatedCitations" :key="citation.id" class="preserve-option"><label><input :name="`retain-citation-${citation.id}`" type="checkbox" :checked="retainedCitationIds.includes(citation.id) && !forcedCitationIds.has(citation.id)" :disabled="forcedCitationIds.has(citation.id)" @change="retainedCitationIds = toggle(retainedCitationIds, citation.id, ($event.target as HTMLInputElement).checked)">保留引用 {{ citation.locator || citation.id }}</label></div>
          <div class="row"><b>附件</b><span>{{ attachmentsText(keep.id) }}</span><span>{{ attachmentsText(remove.id) }}</span><span>默认全部保留</span></div>
          <div v-for="link in relatedAttachmentLinks" :key="link.id" class="preserve-option"><label><input :name="`retain-attachment-${link.id}`" type="checkbox" :checked="retainedAttachmentLinkIds.includes(link.id) && !forcedAttachmentLinkIds.has(link.id)" :disabled="forcedAttachmentLinkIds.has(link.id)" @change="retainedAttachmentLinkIds = toggle(retainedAttachmentLinkIds, link.id, ($event.target as HTMLInputElement).checked)">保留附件“{{ attachmentById.get(link.attachmentId)?.name ?? link.attachmentId }}”</label></div>
          <div v-if="forcedCitationIds.size || forcedAttachmentLinkIds.size" class="cascade-note">随已取消的关系或引用一并移除，避免产生悬空证据。</div>
          <div class="row"><b>备注</b><span>{{ keep.notes || '无' }}</span><span>{{ remove.notes || '无' }}</span><BaseSelectControl v-if="isConflict('notes')"><select name="choice-notes" :aria-label="`保留字段：${choiceLabels.notes}`" v-model="choices.notes"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
          <div class="row"><b>人物简介</b><span>{{ keep.biography || '无' }}</span><span>{{ remove.biography || '无' }}</span><BaseSelectControl v-if="isConflict('biography')"><select name="choice-biography" :aria-label="`保留字段：${choiceLabels.biography}`" v-model="choices.biography"><option value="auto">自动采用保留记录</option><option value="keep">保留记录</option><option value="remove">合并记录</option></select></BaseSelectControl><span v-else>自动保留非空值</span></div>
        </div>
        <p v-else role="alert">待合并人物不存在。</p>
        <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
        <footer>
          <span v-if="preview">预览：删除 {{ preview.summary.removedRelationships }} 条自环或重复关系，重连 {{ preview.summary.rewiredEvents + preview.summary.rewiredCitations + preview.summary.rewiredAttachmentLinks }} 个关联。</span>
          <span v-else-if="unresolvedConflicts.length">请先选择所有冲突字段的保留值。</span>
          <span v-else-if="unresolvedRelationshipConflicts.length">请先选择所有关系冲突字段的保留值。</span>
          <button type="button" name="确认合并" :disabled="saving || !preview" @click="confirmMerge">{{ saving ? '合并中…' : '确认合并' }}</button>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 60; background: rgb(15 23 42 / 48%); display: grid; place-items: center; padding: 24px; }
.wizard { background: white; border-radius: 16px; width: min(1080px, 96vw); max-height: 92vh; overflow: auto; padding: 22px; display: grid; gap: 16px; box-shadow: 0 20px 50px rgb(15 23 42 / 25%); }
header, footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h2, p { margin: 0; }
header p, footer span { color: #667085; font-size: 13px; }
.comparison { display: grid; gap: 1px; background: #d9dee8; border: 1px solid #d9dee8; border-radius: 10px; overflow: hidden; }
.row { display: grid; grid-template-columns: 120px 1fr 1fr 210px; gap: 12px; align-items: start; background: white; padding: 10px 12px; }
.heading { background: #f5f7fb; }
.preserve-option { background: #fafbfc; padding: 6px 12px 6px 132px; }
.relationship-conflict { background: #fff8eb; padding: 10px 12px 10px 132px; display: grid; gap: 8px; }
.cascade-note { background: #fff8eb; padding: 8px 12px 8px 132px; color: #92400e; }
.relationship-conflict label { display: flex; align-items: center; gap: 8px; }
.stacked { display: grid; gap: 6px; }
button { border: 1px solid #c9d1de; border-radius: 8px; background: white; padding: 7px 9px; }
button { cursor: pointer; }
button:disabled { cursor: wait; opacity: .6; }
[role="alert"] { color: #b42318; background: #fff1f0; border-radius: 8px; padding: 10px; }
.summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 0; }
.summary div { background: #f5f7fb; border-radius: 10px; padding: 12px; }
.summary dt { color: #667085; font-size: 13px; }.summary dd { margin: 4px 0 0; font-size: 22px; font-weight: 700; }
</style>
