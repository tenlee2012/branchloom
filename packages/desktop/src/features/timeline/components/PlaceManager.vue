<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useSessionStore } from '../../../app/stores/session'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import BaseField from '../../../design-system/BaseField.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import type { Place } from '../../../shared/domain/types'
import { parsePlaceCoordinates } from '../../../shared/domain/placeCoordinates'
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
  latitude: '',
  longitude: '',
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
  draft.latitude = place?.coordinates ? String(place.coordinates.latitude) : ''
  draft.longitude = place?.coordinates ? String(place.coordinates.longitude) : ''
  failure.value = ''
  confirmDelete.value = false
}

watch(() => props.open, (open) => {
  if (open) resetDraft()
}, { immediate: true })

watch(selectedId, (id) => {
  resetDraft(props.places.find((item) => item.id === id))
}, { flush: 'sync' })

function requestClose() {
  if (!saving.value) emit('close')
}

async function save() {
  if (!props.open || saving.value || !draft.name.trim()) return
  saving.value = true
  failure.value = ''
  session.saveStatus = 'saving'
  session.saveError = undefined
  try {
    const coordinates = parsePlaceCoordinates(draft.latitude, draft.longitude)
    await repository.savePlace({
      id: selectedId.value || createId(),
      projectId: props.projectId,
      name: draft.name.trim(),
      aliases: draft.aliases.split(/[；;\n]/).map((value) => value.trim()).filter(Boolean),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      notes: draft.notes.trim(),
      ...(coordinates ? { coordinates } : {}),
    })
    await session.refreshHistory(repository)
    session.saveStatus = 'saved'
    resetDraft()
    emit('changed')
    emit('close')
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
    @close="requestClose"
  >
    <form class="place-manager" novalidate @submit.prevent="save">
      <label class="place-manager__select">
        <span>已有地点</span>
        <BaseSelectControl>
          <select v-model="selectedId" name="placeRecord" :disabled="saving">
            <option value="">新建地点</option>
            <option v-for="place in places" :key="place.id" :value="place.id">{{ place.name }}</option>
          </select>
        </BaseSelectControl>
      </label>
      <BaseField id="place-name" label="地点名称" required>
        <input id="place-name" v-model="draft.name" name="placeName" :disabled="saving" />
      </BaseField>
      <BaseField id="place-aliases" label="别名" hint="多个别名使用分号分隔">
        <input id="place-aliases" v-model="draft.aliases" name="placeAliases" :disabled="saving" />
      </BaseField>
      <BaseField id="place-parent" label="上级地点">
        <BaseSelectControl>
          <select id="place-parent" v-model="draft.parentId" name="placeParent" :disabled="saving">
            <option value="">无上级地点</option>
            <option v-for="place in places.filter(({ id }) => id !== selectedId)" :key="place.id" :value="place.id">
              {{ place.name }}
            </option>
          </select>
        </BaseSelectControl>
      </BaseField>
      <fieldset class="place-manager__coordinates">
        <legend>GPS 坐标（可选）</legend>
        <p id="place-coordinates-hint" class="place-manager__hint">使用 WGS84 十进制度；经纬度需一起填写，或一起留空。东经、北纬为正，西经、南纬为负。</p>
        <div class="place-manager__coordinate-fields">
          <BaseField id="place-longitude" label="经度" hint="-180 到 180">
            <template #default="field">
              <input id="place-longitude" v-model="draft.longitude" name="placeLongitude" inputmode="decimal" placeholder="例如 119.2965" :aria-describedby="`${field.describedBy} place-coordinates-hint`" :disabled="saving" />
            </template>
          </BaseField>
          <BaseField id="place-latitude" label="纬度" hint="-90 到 90">
            <template #default="field">
              <input id="place-latitude" v-model="draft.latitude" name="placeLatitude" inputmode="decimal" placeholder="例如 26.0745" :aria-describedby="`${field.describedBy} place-coordinates-hint`" :disabled="saving" />
            </template>
          </BaseField>
        </div>
      </fieldset>
      <BaseField id="place-notes" label="备注">
        <textarea id="place-notes" v-model="draft.notes" name="placeNotes" rows="3" :disabled="saving" />
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
        <BaseButton v-if="selectedId" variant="secondary" :disabled="saving" @click="resetDraft()">新建地点</BaseButton>
        <BaseButton
          :name="selectedId ? '保存地点' : '新建地点'"
          type="submit"
          :loading="saving"
          :disabled="!draft.name.trim()"
        >{{ selectedId ? '保存地点' : '新建地点' }}</BaseButton>
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
      <BaseButton variant="secondary" @click="confirmDelete = false">保留地点</BaseButton>
      <BaseButton name="确认删除地点" variant="danger" :loading="saving" @click="remove">确认删除</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.place-manager { display: grid; gap: var(--space-4); }
.place-manager__select { display: grid; gap: var(--space-2); color: var(--color-muted); font-size: .8125rem; font-weight: 700; }
.place-manager input, .place-manager textarea { box-sizing: border-box; width: 100%; min-height: 2.5rem; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); }
.place-manager__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: var(--space-2); }
.place-manager__error { margin: 0; padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
.place-manager__coordinates { min-width: 0; margin: 0; padding: 0; border: 0; }
.place-manager__coordinates legend { padding: 0; color: var(--color-text); font-weight: 650; }
.place-manager__hint { margin: var(--space-2) 0 var(--space-3); color: var(--color-muted); font-size: .8125rem; }
.place-manager__coordinate-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
@media (max-width: 480px) { .place-manager__coordinate-fields { grid-template-columns: 1fr; } }
</style>
