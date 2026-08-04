<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import type { Place } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'

const props = defineProps<{
  open: boolean
  projectId: string
  places: Place[]
}>()
const emit = defineEmits<{ close: []; changed: [] }>()
const repository = useBranchloomRepository()
const session = useSessionStore()
const selectedId = ref('')
const saving = ref(false)
const failure = ref('')
const confirmDelete = ref(false)
const draft = reactive({
  name: '',
  aliases: '',
  parentId: '',
  notes: '',
})

const selected = computed(() => props.places.find(({ id }) => id === selectedId.value))

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `place-${crypto.randomUUID()}`
  }
  return `place-${Date.now()}`
}

function resetDraft(place?: Place) {
  selectedId.value = place?.id ?? ''
  draft.name = place?.name ?? ''
  draft.aliases = place?.aliases.join('；') ?? ''
  draft.parentId = place?.parentId ?? ''
  draft.notes = place?.notes ?? ''
  failure.value = ''
  confirmDelete.value = false
}

watch(() => props.open, (open) => {
  if (open) resetDraft(props.places[0])
}, { immediate: true })

watch(selectedId, (id) => {
  const place = props.places.find((item) => item.id === id)
  if (place) resetDraft(place)
})

async function save() {
  if (saving.value || !draft.name.trim()) return
  saving.value = true
  failure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    await repository.savePlace({
      id: selected.value?.id ?? createId(),
      projectId: props.projectId,
      name: draft.name.trim(),
      aliases: draft.aliases.split(/[；;\n]/).map((value) => value.trim()).filter(Boolean),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      notes: draft.notes.trim(),
    })
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    emit('changed')
  } catch (error) {
    const details = error instanceof Error ? error.message : '地点无法保存'
    failure.value = details
    session.saveStatus = 'failed'
    session.saveError = details
  } finally {
    saving.value = false
  }
}

async function remove() {
  const place = selected.value
  if (!place || saving.value) return
  saving.value = true
  failure.value = ''
  session.saveStatus = 'saving'
  try {
    await repository.deletePlace(place.id)
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    confirmDelete.value = false
    resetDraft()
    emit('changed')
  } catch (error) {
    const details = error instanceof Error ? error.message : '地点无法删除'
    failure.value = details.includes('still referenced')
      ? '该地点仍被人物、关系、事件或下级地点使用，请先移除关联。'
      : details
    session.saveStatus = 'failed'
    session.saveError = failure.value
    confirmDelete.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BaseDialog
    :open="open"
    title="管理地点"
    description="维护事件、人物和关系共用的地点资料。"
    close-label="关闭地点管理"
    @close="emit('close')"
  >
    <form class="place-manager" novalidate @submit.prevent="save">
      <label class="place-manager__select">
        <span>已有地点</span>
        <BaseSelectControl>
          <select v-model="selectedId" name="placeRecord">
            <option value="">新建地点</option>
            <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
          </select>
        </BaseSelectControl>
      </label>
      <BaseField id="place-name" label="地点名称" required>
        <input id="place-name" v-model="draft.name" name="placeName" />
      </BaseField>
      <BaseField id="place-aliases" label="别名" hint="多个别名使用分号分隔">
        <input id="place-aliases" v-model="draft.aliases" name="placeAliases" />
      </BaseField>
      <BaseField id="place-parent" label="上级地点">
        <BaseSelectControl>
          <select id="place-parent" v-model="draft.parentId" name="placeParent">
            <option value="">无上级地点</option>
            <option v-for="place in places.filter(({ id }) => id !== selectedId)" :key="place.id" :value="place.id">
              {{ place.name }}
            </option>
          </select>
        </BaseSelectControl>
      </BaseField>
      <BaseField id="place-notes" label="备注">
        <textarea id="place-notes" v-model="draft.notes" name="placeNotes" rows="3" />
      </BaseField>
      <p v-if="failure" class="place-manager__error" role="alert">{{ failure }}</p>
      <footer class="place-manager__actions">
        <BaseButton
          v-if="selected"
          name="删除地点"
          variant="danger"
          :disabled="saving"
          @click="confirmDelete = true"
        >删除地点</BaseButton>
        <span />
        <BaseButton variant="secondary" @click="resetDraft()">新建地点</BaseButton>
        <BaseButton name="保存地点" type="submit" :loading="saving" :disabled="!draft.name.trim()">保存地点</BaseButton>
      </footer>
    </form>
  </BaseDialog>
  <BaseDialog
    :open="confirmDelete"
    title="删除地点？"
    :description="selected ? `将删除“${selected.name}”。仍被资料引用的地点不会被删除。` : ''"
    close-label="保留地点"
    @close="confirmDelete = false"
  >
    <div class="place-manager__actions">
      <span />
      <BaseButton variant="secondary" @click="confirmDelete = false">保留地点</BaseButton>
      <BaseButton name="确认删除地点" variant="danger" :loading="saving" @click="remove">确认删除</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.place-manager { display: grid; gap: var(--space-4); }
.place-manager__select { display: grid; gap: var(--space-2); color: var(--color-muted); font-size: .8125rem; font-weight: 700; }
.place-manager input, .place-manager textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.place-manager__actions { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: var(--space-2); }
.place-manager__error { margin: 0; padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
</style>
