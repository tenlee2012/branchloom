<script setup lang="ts">
import { t } from '../../../shared/i18n'
import { computed, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseDrawer from '../../../design-system/BaseDrawer.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import { parseGenealogyDate } from '../../../shared/domain/date'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type {
  AttachmentLink,
  CareerCategory,
  CareerRecord,
  Citation,
  Organization,
  OrganizationType,
  Person,
  Place,
  Source,
} from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'

const props = defineProps<{
  open: boolean
  projectId: string
  personId: string
  career?: CareerRecord
}>()
const emit = defineEmits<{ close: []; saved: [career: CareerRecord]; deleted: [careerId: string] }>()
const repository = useBranchloomRepository()
const session = useSessionStore()

const organizations = ref<Organization[]>([])
const places = ref<Place[]>([])
const sources = ref<Source[]>([])
const citations = ref<Citation[]>([])
const attachmentLinks = ref<AttachmentLink[]>([])
const people = ref<Person[]>([])
const loadingOptions = ref(false)
const evidenceReady = ref(false)
const saving = ref(false)
const deleting = ref(false)
const confirmClose = ref(false)
const confirmDelete = ref(false)
const error = ref('')
const newOrganizationName = ref('')
const newOrganizationType = ref<OrganizationType>('company')
const newOrganizationAliases = ref('')
const newOrganizationParentId = ref('')
const newOrganizationPlaceId = ref('')
const newOrganizationValidFrom = ref('')
const newOrganizationValidTo = ref('')
const newOrganizationNotes = ref('')
const newOrganizationSourceIds = ref<string[]>([])
let fallbackId = 0

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `${prefix}-${Date.now()}-${fallbackId}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createDraft(): CareerRecord {
  return {
    id: createId('career'),
    projectId: props.projectId,
    personId: props.personId,
    category: 'employment',
    positionTitle: '',
    status: 'unknown',
    description: '',
    notes: '',
    sourceIds: [],
  }
}

const draft = ref<CareerRecord>(createDraft())
const baseline = ref('')
const dirty = computed(() =>
  JSON.stringify(draft.value) !== baseline.value
  || newOrganizationName.value.trim().length > 0
  || newOrganizationAliases.value.trim().length > 0
  || newOrganizationParentId.value.length > 0
  || newOrganizationPlaceId.value.length > 0
  || newOrganizationValidFrom.value.trim().length > 0
  || newOrganizationValidTo.value.trim().length > 0
  || newOrganizationNotes.value.trim().length > 0
  || newOrganizationSourceIds.value.length > 0)
const isAncientOffice = computed(() =>
  draft.value.category === 'civil_office' || draft.value.category === 'military_office')
const deleteImpact = computed(() => {
  const careerId = props.career?.id
  if (!careerId) return { sources: 0, citations: 0, attachments: 0 }
  const relatedCitations = citations.value.filter(({ targetType, targetId }) =>
    targetType === 'career' && targetId === careerId)
  const citationIds = new Set(relatedCitations.map(({ id }) => id))
  const attachments = new Set(attachmentLinks.value
    .filter(({ targetType, targetId }) =>
      (targetType === 'career' && targetId === careerId)
      || (targetType === 'citation' && citationIds.has(targetId)))
    .map(({ attachmentId }) => attachmentId))
  return {
    sources: props.career?.sourceIds.length ?? 0,
    citations: relatedCitations.length,
    attachments: attachments.size,
  }
})

const categoryLabels: Record<CareerCategory, string> = {
  employment: t('企业任职'),
  civil_office: t('古代文官'),
  military_office: t('古代武职'),
  academic: t('学术／教育任职'),
  religious_office: t('宗教职务'),
  self_employed: t('自由职业／自营'),
  other: t('其他'),
}
const organizationTypeLabels: Record<OrganizationType, string> = {
  company: t('公司'),
  government: t('政府机构'),
  imperial_court: t('朝廷／政权'),
  military: t('军队'),
  education: t('教育机构'),
  religious: t('宗教机构'),
  clan: t('宗族组织'),
  other: t('其他'),
}

function reset() {
  draft.value = props.career
    ? clone(props.career)
    : createDraft()
  newOrganizationName.value = ''
  newOrganizationType.value = isAncientOffice.value ? 'government' : 'company'
  newOrganizationAliases.value = ''
  newOrganizationParentId.value = ''
  newOrganizationPlaceId.value = ''
  newOrganizationValidFrom.value = ''
  newOrganizationValidTo.value = ''
  newOrganizationNotes.value = ''
  newOrganizationSourceIds.value = []
  baseline.value = JSON.stringify(draft.value)
  error.value = ''
  confirmClose.value = false
  confirmDelete.value = false
}

async function loadOptions() {
  loadingOptions.value = true
  evidenceReady.value = false
  try {
    const [
      organizationResult,
      placeResult,
      sourceResult,
      peopleResult,
      citationResult,
      attachmentLinkResult,
    ] = await Promise.all([
      repository.listOrganizations(props.projectId),
      repository.listPlaces(props.projectId),
      repository.listSources(props.projectId),
      repository.listPeople(props.projectId, { page: 1, pageSize: 500, sort: 'name' }),
      repository.listCitations(props.projectId),
      repository.listAttachmentLinks(props.projectId),
    ])
    organizations.value = organizationResult
    places.value = placeResult
    sources.value = sourceResult
    people.value = peopleResult.items
    citations.value = citationResult
    attachmentLinks.value = attachmentLinkResult
    evidenceReady.value = true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('履历选项无法读取')
  } finally {
    loadingOptions.value = false
  }
}

watch(
  () => [props.open, props.career?.id, props.projectId, props.personId] as const,
  ([open]) => {
    if (!open) return
    reset()
    void loadOptions()
  },
  { immediate: true },
)

watch(isAncientOffice, (ancient) => {
  if (newOrganizationType.value === 'company' || newOrganizationType.value === 'government') {
    newOrganizationType.value = ancient ? 'government' : 'company'
  }
})

function setDate(field: 'start' | 'end', value: string) {
  const text = value.trim()
  if (text) draft.value[field] = parseGenealogyDate(text)
  else delete draft.value[field]
}

function setOptional(field: keyof CareerRecord, value: string) {
  const next = value.trim()
  if (next) Object.assign(draft.value, { [field]: next })
  else delete draft.value[field]
}

function toggleSource(sourceId: string, checked: boolean) {
  const next = new Set(draft.value.sourceIds)
  if (checked) next.add(sourceId)
  else next.delete(sourceId)
  draft.value.sourceIds = [...next]
}

function toggleOrganizationSource(sourceId: string, checked: boolean) {
  const next = new Set(newOrganizationSourceIds.value)
  if (checked) next.add(sourceId)
  else next.delete(sourceId)
  newOrganizationSourceIds.value = [...next]
}

function requestClose() {
  if (saving.value || deleting.value) return
  if (dirty.value) confirmClose.value = true
  else emit('close')
}

async function submit() {
  if (saving.value) return
  if (!draft.value.positionTitle.trim()) {
    error.value = t('请填写职位或官职。')
    return
  }
  if (draft.value.status === 'current') delete draft.value.end
  saving.value = true
  error.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    let saved: CareerRecord
    const organizationName = newOrganizationName.value.trim()
    if (organizationName) {
      const organization: Organization = {
        id: createId('organization'),
        projectId: props.projectId,
        name: organizationName,
        type: newOrganizationType.value,
        aliases: newOrganizationAliases.value.split(/[、,，]/)
          .map((alias) => alias.trim()).filter(Boolean),
        ...(newOrganizationParentId.value ? { parentId: newOrganizationParentId.value } : {}),
        ...(newOrganizationPlaceId.value ? { placeId: newOrganizationPlaceId.value } : {}),
        ...(newOrganizationValidFrom.value.trim()
          ? { validFrom: parseGenealogyDate(newOrganizationValidFrom.value.trim()) }
          : {}),
        ...(newOrganizationValidTo.value.trim()
          ? { validTo: parseGenealogyDate(newOrganizationValidTo.value.trim()) }
          : {}),
        notes: newOrganizationNotes.value.trim(),
        sourceIds: [...newOrganizationSourceIds.value],
      }
      const result = await repository.saveOrganizationWithCareer(organization, {
        ...clone(draft.value),
        organizationId: organization.id,
      })
      organizations.value = [...organizations.value, result.organization]
      saved = result.career
    } else {
      saved = await repository.saveCareer(clone(draft.value))
    }
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('saved', saved)
    emit('close')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('履历保存失败')
    session.saveStatus = 'failed'
    session.saveError = error.value
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!props.career || deleting.value) return
  deleting.value = true
  error.value = ''
  session.saveStatus = 'saving'
  try {
    await repository.deleteCareer(props.career.id)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('deleted', props.career.id)
    emit('close')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('履历删除失败')
    session.saveStatus = 'failed'
    session.saveError = error.value
  } finally {
    deleting.value = false
    confirmDelete.value = false
  }
}
</script>

<template>
  <BaseDrawer
    :open="open"
    :title="career ? t('编辑人物履历') : t('添加人物履历')"
    :description="t('现代公司职位和古代官职使用同一套履历资料。')"
    :close-label="t('关闭履历编辑器')"
    @close="requestClose"
  >
    <form class="career-editor" novalidate @submit.prevent="submit">
      <div class="career-editor__grid">
        <BaseField id="career-category" :label="t('履历类型')" required>
          <BaseSelectControl>
            <select id="career-category" v-model="draft.category" name="careerCategory">
              <option v-for="(label, value) in categoryLabels" :key="value" :value="value">{{ label }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
        <BaseField id="career-status" :label="t('任职状态')">
          <BaseSelectControl>
            <select id="career-status" v-model="draft.status" name="careerStatus">
              <option value="unknown">{{ t('未知') }}</option>
              <option value="current">{{ t('当前在任') }}</option>
              <option value="former">{{ t('已结束') }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>

      <section v-if="newOrganizationName.trim()" class="career-editor__new-organization" aria-labelledby="career-new-organization-heading">
        <div>
          <h3 id="career-new-organization-heading">{{ t('新机构资料') }}</h3>
          <p>{{ t('新机构会和履历作为同一个操作保存，失败时不会留下半成品。') }}</p>
        </div>
        <div class="career-editor__grid">
          <BaseField id="career-new-organization-type" :label="t('机构类型')">
            <BaseSelectControl>
              <select id="career-new-organization-type" v-model="newOrganizationType">
                <option v-for="(label, value) in organizationTypeLabels" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </BaseSelectControl>
          </BaseField>
          <BaseField id="career-new-organization-aliases" :label="t('别名／历史名称')" :hint="t('用逗号或顿号分隔')">
            <input id="career-new-organization-aliases" v-model="newOrganizationAliases" />
          </BaseField>
          <BaseField id="career-new-organization-parent" :label="t('上级机构')">
            <BaseSelectControl>
              <select id="career-new-organization-parent" v-model="newOrganizationParentId">
                <option value="">{{ t('无上级机构') }}</option>
                <option v-for="organization in organizations" :key="organization.id" :value="organization.id">
                  {{ organization.name }}
                </option>
              </select>
            </BaseSelectControl>
          </BaseField>
          <BaseField id="career-new-organization-place" :label="t('机构所在地')">
            <BaseSelectControl>
              <select id="career-new-organization-place" v-model="newOrganizationPlaceId">
                <option value="">{{ t('未记录') }}</option>
                <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
              </select>
            </BaseSelectControl>
          </BaseField>
          <BaseField id="career-new-organization-from" :label="t('有效开始时间')">
            <input id="career-new-organization-from" v-model="newOrganizationValidFrom" />
          </BaseField>
          <BaseField id="career-new-organization-to" :label="t('有效结束时间')">
            <input id="career-new-organization-to" v-model="newOrganizationValidTo" />
          </BaseField>
        </div>
        <BaseField id="career-new-organization-notes" :label="t('机构备注')">
          <textarea id="career-new-organization-notes" v-model="newOrganizationNotes" rows="2" />
        </BaseField>
        <fieldset v-if="sources.length" class="career-editor__sources">
          <legend>{{ t('机构来源') }}</legend>
          <label v-for="source in sources" :key="source.id">
            <input
              type="checkbox"
              :checked="newOrganizationSourceIds.includes(source.id)"
              @change="toggleOrganizationSource(source.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ source.title }}
          </label>
        </fieldset>
      </section>

      <div class="career-editor__organization">
        <BaseField id="career-organization" :label="isAncientOffice ? t('官署／机构') : t('公司／机构')">
          <BaseSelectControl>
            <select
              id="career-organization"
              v-model="draft.organizationId"
              name="careerOrganization"
              :disabled="Boolean(newOrganizationName)"
            >
              <option :value="undefined">{{ t('暂不关联机构') }}</option>
              <option v-for="organization in organizations" :key="organization.id" :value="organization.id">
                {{ organization.name }}
              </option>
            </select>
          </BaseSelectControl>
        </BaseField>
        <BaseField id="career-new-organization" :label="t('或新建机构')" :hint="t('保存履历时一并创建。')">
          <input
            id="career-new-organization"
            v-model="newOrganizationName"
            name="newOrganizationName"
            :placeholder="isAncientOffice ? t('例如：杭州州府') : t('例如：字节跳动')"
            :disabled="Boolean(draft.organizationId)"
          />
        </BaseField>
      </div>

      <div class="career-editor__grid">
        <BaseField id="career-position" :label="isAncientOffice ? t('官职原文') : t('职位')" required>
          <input id="career-position" v-model="draft.positionTitle" name="careerPosition" required />
        </BaseField>
        <BaseField id="career-department" :label="isAncientOffice ? t('下属机构') : t('部门')">
          <input
            id="career-department"
            :value="draft.department ?? ''"
            name="careerDepartment"
            @input="setOptional('department', ($event.target as HTMLInputElement).value)"
          />
        </BaseField>
        <BaseField id="career-start" :label="t('开始时间')" :hint="t('可保留原始纪年文字')">
          <input
            id="career-start"
            :value="draft.start?.display ?? ''"
            name="careerStart"
            :placeholder="t('例如：2020 或 熙宁四年')"
            @input="setDate('start', ($event.target as HTMLInputElement).value)"
          />
        </BaseField>
        <BaseField id="career-end" :label="t('结束时间')">
          <input
            id="career-end"
            :value="draft.end?.display ?? ''"
            name="careerEnd"
            :disabled="draft.status === 'current'"
            @input="setDate('end', ($event.target as HTMLInputElement).value)"
          />
        </BaseField>
        <BaseField id="career-place" :label="t('任职地点')">
          <BaseSelectControl>
            <select id="career-place" v-model="draft.jurisdictionPlaceId" name="careerPlace">
              <option :value="undefined">{{ t('未记录') }}</option>
              <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
            </select>
          </BaseSelectControl>
        </BaseField>
      </div>

      <section v-if="isAncientOffice" class="career-editor__advanced" aria-labelledby="career-ancient-heading">
        <div>
          <h3 id="career-ancient-heading">{{ t('古代官职资料') }}</h3>
          <p>{{ t('原始纪年会与可计算日期一起保留；无法换算时不会伪造公历日期。') }}</p>
        </div>
        <div class="career-editor__grid">
          <BaseField id="career-regime" :label="t('朝代／政权')">
            <input id="career-regime" :value="draft.regime ?? ''" name="careerRegime" @input="setOptional('regime', ($event.target as HTMLInputElement).value)" />
          </BaseField>
          <BaseField id="career-rank" :label="t('品秩／等级')">
            <input id="career-rank" :value="draft.rankOrGrade ?? ''" name="careerRank" @input="setOptional('rankOrGrade', ($event.target as HTMLInputElement).value)" />
          </BaseField>
          <BaseField id="career-appointment" :label="t('任命性质')">
            <input id="career-appointment" :value="draft.appointmentType ?? ''" name="careerAppointment" :placeholder="t('任职、兼任、署理、追赠…')" @input="setOptional('appointmentType', ($event.target as HTMLInputElement).value)" />
          </BaseField>
          <BaseField id="career-appointed-by" :label="t('授予者／任命者')">
            <BaseSelectControl>
              <select id="career-appointed-by" v-model="draft.appointedByPersonId" name="careerAppointedBy">
                <option :value="undefined">{{ t('未记录') }}</option>
                <option v-for="candidate in people" :key="candidate.id" :value="candidate.id">
                  {{ getPrimaryName(candidate) }}
                </option>
              </select>
            </BaseSelectControl>
          </BaseField>
        </div>
      </section>

      <BaseField id="career-description" :label="t('职责与经历')">
        <textarea id="career-description" v-model="draft.description" name="careerDescription" rows="3" />
      </BaseField>
      <BaseField id="career-notes" :label="t('整理笔记')">
        <textarea id="career-notes" v-model="draft.notes" name="careerNotes" rows="3" />
      </BaseField>

      <fieldset v-if="sources.length" class="career-editor__sources">
        <legend>{{ t('资料来源') }}</legend>
        <label v-for="source in sources" :key="source.id">
          <input
            type="checkbox"
            :checked="draft.sourceIds.includes(source.id)"
            @change="toggleSource(source.id, ($event.target as HTMLInputElement).checked)"
          />
          {{ source.title }}
        </label>
      </fieldset>

      <p v-if="loadingOptions" class="career-editor__hint" role="status">{{ t('正在读取机构与来源…') }}</p>
      <p v-if="error" class="career-editor__error" role="alert">{{ error }}</p>

      <footer class="career-editor__actions">
        <BaseButton v-if="career" :name="t('删除履历')" variant="danger" :disabled="saving" @click="confirmDelete = true"> {{ t('删除履历') }} </BaseButton>
        <span />
        <BaseButton :name="t('取消')" variant="secondary" :disabled="saving || deleting" @click="requestClose">{{ t('取消') }}</BaseButton>
        <BaseButton :name="t('保存履历')" type="submit" :loading="saving">{{ t('保存履历') }}</BaseButton>
      </footer>
    </form>
  </BaseDrawer>

  <BaseDialog
    :open="confirmClose"
    :title="t('放弃未保存的履历？')"
    :description="t('关闭后，这次填写的内容不会保留。')"
    @close="confirmClose = false"
  >
    <div class="career-editor__dialog-actions">
      <BaseButton variant="secondary" @click="confirmClose = false">{{ t('继续编辑') }}</BaseButton>
      <BaseButton variant="danger" @click="emit('close')">{{ t('放弃修改') }}</BaseButton>
    </div>
  </BaseDialog>

  <BaseDialog
    :open="confirmDelete"
    :title="t('删除这条履历？')"
    :description="t('相关引用和附件关联会一并清理，来源与附件文件仍会保留。')"
    @close="confirmDelete = false"
  >
    <div class="career-editor__delete-dialog">
      <p v-if="evidenceReady"> {{ t('这条履历关联了 {0} 项来源、{1} 条引用和 {2} 个附件。', [deleteImpact.sources, deleteImpact.citations, deleteImpact.attachments]) }} </p>
      <p v-else role="alert">{{ t('暂时无法读取履历的证据影响，当前不能安全删除。') }}</p>
      <div class="career-editor__dialog-actions">
        <BaseButton variant="secondary" @click="confirmDelete = false">{{ t('取消') }}</BaseButton>
        <BaseButton
          :name="t('确认删除履历')"
          variant="danger"
          :disabled="!evidenceReady"
          :loading="deleting"
          @click="remove"
        >{{ t('确认删除') }}</BaseButton>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.career-editor { display: grid; gap: var(--space-5); }
.career-editor__grid, .career-editor__organization { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.career-editor input, .career-editor textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.career-editor__advanced { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.career-editor__new-organization { display: grid; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-muted-surface); }
.career-editor__new-organization h3, .career-editor__new-organization p { margin: 0; }
.career-editor__new-organization p { color: var(--color-muted); font-size: .8125rem; }
.career-editor__advanced h3, .career-editor__advanced p { margin: 0; }
.career-editor__advanced p, .career-editor__hint { color: var(--color-muted); font-size: .8125rem; }
.career-editor__sources { display: grid; gap: var(--space-2); margin: 0; padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.career-editor__sources label { display: flex; align-items: center; gap: var(--space-2); }
.career-editor__sources input { width: 1rem; min-height: 1rem; }
.career-editor__error { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.career-editor__actions { display: grid; grid-template-columns: auto 1fr auto auto; gap: var(--space-3); }
.career-editor__dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
.career-editor__delete-dialog { display: grid; gap: var(--space-4); }
.career-editor__delete-dialog p { margin: 0; }
@media (max-width: 36rem) {
  .career-editor__grid, .career-editor__organization { grid-template-columns: 1fr; }
  .career-editor__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; }
}
</style>
