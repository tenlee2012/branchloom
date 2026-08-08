<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseDialog from '../../../design-system/BaseDialog.vue'
import StatusBadge from '../../../design-system/StatusBadge.vue'
import type { Attachment, AttachmentLink } from '../../../shared/domain/types'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import { importLocalAttachment, localAttachmentExists } from '../../../shared/repository/TauriRepository'

const props = defineProps<{
  projectId: string
  attachments: Attachment[]
  attachmentLinks: AttachmentLink[]
  highlightedAttachmentId?: string
}>()
const emit = defineEmits<{ changed: [attachment?: Attachment] }>()
const repository = useBranchloomRepository()
const busyId = ref('')
const failure = ref('')
const removing = ref<Attachment>()
const fileInput = ref<HTMLInputElement>()
const importMessage = ref('')
const repairing = ref<Attachment>()
const verifying = ref(false)

let fallbackId = 0
function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `attachment-${crypto.randomUUID()}`
  }
  fallbackId += 1
  return `attachment-${Date.now()}-${fallbackId}`
}

function linkCount(attachmentId: string) {
  return props.attachmentLinks.filter(({ attachmentId: id }) => id === attachmentId).length
}

const removalDescription = computed(() => removing.value
  ? `将移除“${removing.value.name}”的附件记录和 ${linkCount(removing.value.id)} 处关联。`
  : '')

function formatSize(size: number) {
  if (size === 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

async function run(id: string, operation: () => Promise<Attachment | void>) {
  if (busyId.value) return
  busyId.value = id
  failure.value = ''
  try {
    const result = await operation()
    if (result) emit('changed', result)
    else emit('changed')
  } catch (error) {
    failure.value = error instanceof Error && error.message.trim()
      ? error.message
      : '附件元数据暂时无法更新'
  } finally {
    busyId.value = ''
  }
}

function selectAttachment() {
  fileInput.value?.click()
}

async function importSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const id = createId()
  const repairTarget = repairing.value
  repairing.value = undefined
  importMessage.value = ''
  await run(id, async () => {
    const imported = await importLocalAttachment(props.projectId, file, repairTarget?.contentHash)
    if (repairTarget) {
      const repaired = await repository.saveAttachment({
        ...repairTarget,
        name: imported.name,
        mimeType: imported.mimeType,
        size: imported.size,
        missing: false,
      })
      importMessage.value = `“${repairTarget.name}”已重新定位并通过内容校验。`
      return repaired
    }
    const existing = props.attachments.find(({ contentHash }) => contentHash === imported.contentHash)
    if (existing) {
      importMessage.value = `“${file.name}”与已有附件内容相同，未重复保存。`
      return existing
    }
    const attachment: Attachment = {
      id,
      projectId: props.projectId,
      name: imported.name,
      mimeType: imported.mimeType,
      size: imported.size,
      contentHash: imported.contentHash,
      missing: false,
    }
    importMessage.value = imported.alreadyStored
      ? `“${file.name}”已连接到项目中已有的文件内容。`
      : `“${file.name}”已复制到项目管理区域。`
    return repository.saveAttachment(attachment)
  })
}

async function locate(attachment: Attachment) {
  repairing.value = attachment
  fileInput.value?.click()
}

async function verifyNativeAttachments() {
  if (verifying.value) return
  verifying.value = true
  let changed = false
  try {
    for (const attachment of props.attachments) {
      if (!/^[a-f0-9]{64}$/i.test(attachment.contentHash)) continue
      const exists = await localAttachmentExists(props.projectId, attachment.contentHash)
      if (attachment.missing === !exists) continue
      await repository.saveAttachment({ ...attachment, missing: !exists })
      changed = true
    }
    if (changed) emit('changed')
  } catch (error) {
    if (!failure.value) {
      failure.value = error instanceof Error ? error.message : '附件完整性暂时无法检查'
    }
  } finally {
    verifying.value = false
  }
}

watch(
  () => props.attachments.map(({ id, contentHash, missing }) => `${id}:${contentHash}:${missing}`).join('|'),
  () => { void verifyNativeAttachments() },
  { immediate: true },
)

async function confirmRemove() {
  const attachment = removing.value
  if (!attachment) return
  await run(attachment.id, () => repository.deleteAttachment(attachment.id))
  if (!failure.value) removing.value = undefined
}
</script>

<template>
  <section class="attachment-panel" aria-labelledby="attachment-panel-title">
    <header class="attachment-panel__header">
      <div>
        <h2 id="attachment-panel-title">本地附件</h2>
        <p>从本机导入照片、扫描件与文档。</p>
      </div>
      <StatusBadge tone="success">本地文件</StatusBadge>
    </header>
    <div class="attachment-panel__notice attachment-panel__notice--native" role="note">
      选择的文件会复制进有谱的本地项目管理区域，并使用 SHA-256 内容哈希避免重复保存。
    </div>
    <input ref="fileInput" class="attachment-panel__file-input" type="file" @change="importSelected" />
    <BaseButton name="选择附件" variant="secondary" :loading="busyId.startsWith('attachment-')" @click="selectAttachment">
      选择附件
    </BaseButton>
    <p v-if="importMessage" class="attachment-panel__success" role="status">{{ importMessage }}</p>
    <ul class="attachment-panel__list">
      <li v-for="attachment in attachments" :key="attachment.id" :data-attachment-id="attachment.id" :aria-current="attachment.id === highlightedAttachmentId ? 'true' : undefined" :class="{ 'attachment-panel__item--highlighted': attachment.id === highlightedAttachmentId }">
        <div>
          <strong>{{ attachment.name }}</strong>
          <span>{{ attachment.mimeType }} · {{ formatSize(attachment.size) }} · {{ linkCount(attachment.id) }} 处关联</span>
          <span v-if="attachment.missing" class="attachment-panel__missing" role="status">附件缺失，元数据和关联已保留</span>
        </div>
        <div class="attachment-panel__actions">
          <BaseButton
            v-if="attachment.missing"
            :name="`重新选择附件：${attachment.name}`"
            size="sm"
            variant="secondary"
            :loading="busyId === attachment.id"
            @click="locate(attachment)"
          >重新选择</BaseButton>
          <BaseButton
            :name="`移除附件：${attachment.name}`"
            size="sm"
            variant="ghost"
            :disabled="Boolean(busyId)"
            @click="removing = attachment"
          >移除</BaseButton>
        </div>
      </li>
    </ul>
    <p v-if="failure" class="attachment-panel__error" role="alert">更新失败：{{ failure }}</p>
  </section>
  <BaseDialog
    :open="Boolean(removing)"
    title="移除附件记录？"
    :description="removalDescription"
    close-label="保留附件"
    @close="removing = undefined"
  >
    <div class="attachment-panel__dialog-actions">
      <BaseButton name="保留附件" variant="secondary" @click="removing = undefined">保留</BaseButton>
      <BaseButton name="确认移除附件" variant="danger" :loading="Boolean(busyId)" @click="confirmRemove">确认移除附件</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.attachment-panel { display: grid; gap: var(--space-4); padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.attachment-panel__header { display: flex; align-items: start; justify-content: space-between; gap: var(--space-3); }
.attachment-panel__header h2, .attachment-panel__header p { margin: 0; }
.attachment-panel__header p { margin-top: var(--space-1); color: var(--color-muted); }
.attachment-panel__notice { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-warning-surface); color: var(--color-warning); font-size: .875rem; }
.attachment-panel__notice--native { background: var(--color-success-surface); color: var(--color-success); }
.attachment-panel__file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.attachment-panel__success { margin: 0; color: var(--color-success); }
.attachment-panel__list { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.attachment-panel__list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.attachment-panel__list .attachment-panel__item--highlighted { border-color: var(--color-info); box-shadow: var(--focus-ring); }
.attachment-panel__list li > div:first-child { display: grid; gap: var(--space-1); }
.attachment-panel__list span { color: var(--color-muted); font-size: .8125rem; }
.attachment-panel__list .attachment-panel__missing { color: var(--color-danger); }
.attachment-panel__actions, .attachment-panel__dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.attachment-panel__error { padding: var(--space-3); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
@media (max-width: 38rem) { .attachment-panel__list li { align-items: stretch; flex-direction: column; } }
</style>
