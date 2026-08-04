<script setup lang="ts">
import {
  IconBook2,
  IconEdit,
  IconEye,
  IconFocusCentered,
  IconUserPlus,
} from '@tabler/icons-vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDrawer from '../../../design-system/BaseDrawer.vue'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { Person, Relationship } from '../../../shared/domain/types'
import { relationshipDisplayLabel } from '../../relationships/composables/useRelationshipEditor'
import personPlaceholder from '../../../assets/person-placeholder.png'

const props = defineProps<{
  open: boolean
  person: Person | undefined
  relationships: Relationship[]
  people: Person[]
  collapsed: boolean
  isCenter: boolean
  inline?: boolean
}>()
const route = useRoute()
const router = useRouter()
const emit = defineEmits<{
  close: []
  center: [personId: string]
  toggleBranch: [personId: string]
  quickAdd: []
}>()

function primaryName(person: Person) {
  return getPrimaryName(person)
}

function relativePerson(relationship: Relationship): Person | undefined {
  if (!props.person) return undefined
  const id = relationship.fromPersonId === props.person.id ? relationship.toPersonId : relationship.fromPersonId
  return props.people.find((candidate) => candidate.id === id)
}

function relativeName(relationship: Relationship) {
  const person = relativePerson(relationship)
  return person ? primaryName(person) : '未知人物'
}

function treeReturnPath(person: Person): string {
  return router.resolve({
    name: 'project-tree',
    params: { projectId: person.projectId },
    query: { ...route.query, previewPersonId: person.id },
  }).fullPath
}
</script>

<template>
  <BaseDrawer
    :open="open && Boolean(person)"
    :inline="inline"
    :title="person ? `研究视图：${primaryName(person)}的家庭关系` : '人物研究视图'"
    close-label="关闭人物预览"
    @close="emit('close')"
  >
    <article v-if="person" class="person-preview">
      <span class="visually-hidden">{{ primaryName(person) }}的人物预览 · 添加人物</span>
      <header>
        <img class="person-preview__avatar" :src="person.avatarUrl || personPlaceholder" :alt="`${primaryName(person)}的头像`" />
        <div class="person-preview__identity"><p>{{ person.status === 'living' ? '在世' : person.status === 'deceased' ? '已故' : '状态未知' }}</p><h3>{{ primaryName(person) }}</h3></div>
        <div class="person-preview__header-actions">
          <RouterLink
            class="person-preview__header-action person-preview__header-detail"
            :to="{ name: 'person-detail', params: { projectId: person.projectId, personId: person.id } }"
            :aria-label="`查看人物详情：${primaryName(person)}`"
            :title="`查看人物详情：${primaryName(person)}`"
          >
            <IconEye :size="20" :stroke-width="1.8" aria-hidden="true" />
          </RouterLink>
          <RouterLink
            class="person-preview__header-action person-preview__header-edit"
            :to="{
              name: 'person-edit',
              params: { projectId: person.projectId, personId: person.id },
              query: { returnTo: treeReturnPath(person) },
            }"
            :aria-label="`编辑人物：${primaryName(person)}`"
            :title="`编辑人物：${primaryName(person)}`"
          >
            <IconEdit :size="20" :stroke-width="1.8" aria-hidden="true" />
          </RouterLink>
        </div>
      </header>
      <dl>
        <div><dt>出生</dt><dd>{{ person.birth?.display ?? '未记录' }}</dd></div>
        <div><dt>死亡</dt><dd>{{ person.death?.display ?? '未记录' }}</dd></div>
      </dl>
      <p class="person-preview__bio">{{ person.biography || '还没有生平摘要。' }}</p>
      <section aria-labelledby="preview-relationships">
        <h4 id="preview-relationships">直接关系</h4>
        <ul v-if="relationships.length">
          <li v-for="relationship in relationships" :key="relationship.id">
            <strong>{{ relationshipDisplayLabel(relationship, person.id, relativePerson(relationship)) }}</strong>
            <span>{{ relativeName(relationship) }}</span>
          </li>
        </ul>
        <p v-else>还没有记录关系。</p>
      </section>
      <section class="person-preview__sources" aria-labelledby="preview-sources">
        <div class="person-preview__section-title">
          <h4 id="preview-sources">关键来源（{{ person.sourceIds?.length ?? 0 }}）</h4>
          <span>查看全部来源</span>
        </div>
        <article v-if="person.sourceIds?.length">
          <span class="person-preview__source-number">1</span>
          <div>
            <strong>家庭档案与人物记录</strong>
            <p>已关联 {{ person.sourceIds?.length ?? 0 }} 项原始资料，可在资料来源中查看引用位置与摘录。</p>
          </div>
        </article>
        <p v-else>还没有关联资料来源。</p>
      </section>
      <footer>
        <BaseButton name="添加人物" variant="secondary" @click="emit('quickAdd')"><IconUserPlus :size="18" aria-hidden="true" />添加人物</BaseButton>
        <BaseButton v-if="!isCenter" name="设为中心人物" variant="secondary" @click="emit('center', person.id)"><IconFocusCentered :size="18" aria-hidden="true" />设为中心</BaseButton>
        <BaseButton :name="collapsed ? `展开${primaryName(person)}分支` : `收起${primaryName(person)}分支`" variant="secondary" @click="emit('toggleBranch', person.id)">
          {{ collapsed ? '展开分支' : '收起分支' }}
        </BaseButton>
        <RouterLink class="person-preview__view-sources" :to="{ name: 'project-sources', params: { projectId: person.projectId } }"><IconBook2 :size="18" aria-hidden="true" />查看来源</RouterLink>
      </footer>
    </article>
  </BaseDrawer>
</template>

<style scoped>
.person-preview { display: grid; gap: 1.15rem; }
.person-preview header { display: flex; align-items: center; gap: var(--space-3); }
.person-preview__avatar { width: 4.25rem; height: 4.25rem; border-radius: 50%; object-fit: cover; }
.person-preview__identity { min-width: 0; flex: 1; }
.person-preview__header-actions { display: flex; flex: 0 0 auto; gap: var(--space-2); }
.person-preview__header-action { display: inline-grid; width: 2.5rem; height: 2.5rem; place-items: center; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-primary); text-decoration: none; transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease; }
.person-preview__header-action:hover, .person-preview__header-action:focus-visible { border-color: var(--color-primary); outline: none; background: var(--color-muted-surface); transform: translateY(-1px); }
.person-preview h3, .person-preview header p { margin: 0; }
.person-preview h3 { font-family: var(--font-heading); font-size: 2rem; }
.person-preview header p { color: var(--color-accent); font-size: .75rem; font-weight: 700; }
.person-preview dl { display: grid; grid-template-columns: repeat(2, 1fr); margin: 0; border-block: 1px solid var(--color-border); }
.person-preview dl div { padding: var(--space-3); }
.person-preview dt { color: var(--color-muted); font-size: .7rem; }
.person-preview dd { margin: var(--space-1) 0 0; font-weight: 700; }
.person-preview__bio { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-muted-surface); }
.person-preview ul { display: grid; gap: var(--space-2); padding: 0; list-style: none; }
.person-preview li { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2); border-bottom: 1px solid var(--color-border); }
.person-preview footer { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.person-preview__section-title { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.person-preview__section-title h4 { margin: 0; font-family: var(--font-heading); font-size: 1.05rem; }
.person-preview__section-title span { color: var(--color-primary); font-size: .72rem; }
.person-preview__sources article { display: flex; gap: .7rem; margin-top: .7rem; padding: .8rem; border: 1px solid #dfd2bd; border-radius: .35rem; background: #fcf8ef; }
.person-preview__sources article p { margin: .3rem 0 0; color: var(--color-muted); font-size: .72rem; line-height: 1.6; }
.person-preview__source-number { display: grid; width: 1.35rem; height: 1.35rem; flex: 0 0 auto; place-items: center; border-radius: 50%; background: #315d45; color: white; font-size: .7rem; }
.person-preview__view-sources { display: inline-flex; min-height: 2.5rem; flex: 1; align-items: center; justify-content: center; gap: .45rem; border: 1px solid #315d45; border-radius: .35rem; background: #315d45; color: white; font-size: .82rem; font-weight: 650; text-decoration: none; }

:deep(.base-drawer__surface--inline .base-drawer__header) { padding: 1rem 1.15rem; }
:deep(.base-drawer__surface--inline .base-drawer__title) { font-size: 1rem; }
:deep(.base-drawer__surface--inline .base-drawer__body) { padding: 1.15rem; }
</style>
