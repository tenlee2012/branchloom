<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useBranchloomRepository } from '../../../shared/repository/injection'
import BaseButton from '../../../design-system/BaseButton.vue'
import BaseSelectControl from '../../../design-system/BaseSelectControl.vue'
import PdfPage from './PdfPage.vue'
const props = defineProps<{ projectId: string; jobId: string; bytes: number }>()
const repository = useBranchloomRepository()
const document = shallowRef<PDFDocumentProxy>()
const page = ref(1)
const scale = ref(1)
const thumbs = ref(false)
const error = ref('')
let task: PDFDocumentLoadingTask | undefined
let request = 0
const nearby = computed(() => Array.from({ length: Math.min(7, document.value?.numPages ?? 0) }, (_, index) => Math.max(1, Math.min(page.value - 3, (document.value?.numPages ?? 1) - 6)) + index))
function go(next: number) { page.value = Math.max(1, Math.min(Number.isFinite(next) ? Math.floor(next) : 1, document.value?.numPages ?? 1)) }
watch(() => [props.projectId, props.jobId], async () => {
  const current = ++request
  await task?.destroy()
  document.value = undefined
  error.value = ''
  page.value = 1
  const projectId = props.projectId
  const jobId = props.jobId
  try {
    // Tauri's system WebView can lack newer APIs such as URL.parse.
    // Use the compatibility build in both contexts, including the worker.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (current !== request) return
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    class Range extends pdfjs.PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number) {
        void (async () => {
          for (let offset = begin; offset < end && current === request; offset += 1_048_576) {
            const { data } = await repository.publication<{ data: string }>({ operation: 'read', projectId, jobId, offset, length: Math.min(1_048_576, end - offset) })
            if (current === request) this.onDataRange(offset, Uint8Array.from(atob(data), (char) => char.charCodeAt(0)))
          }
        })().catch((reason: unknown) => {
          if (current === request) { error.value = reason instanceof Error ? reason.message : String(reason); void task?.destroy() }
        })
      }
    }
    task = pdfjs.getDocument({ range: new Range(props.bytes, new Uint8Array(), false), rangeChunkSize: 65_536,
      disableAutoFetch: true, disableStream: true, isEvalSupported: false, useSystemFonts: false,
      cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/' })
    const loaded = await task.promise
    if (current === request) document.value = loaded
  } catch (reason) { if (current === request && !error.value) error.value = reason instanceof Error ? reason.message : String(reason) }
}, { immediate: true })
onBeforeUnmount(() => { request++; void task?.destroy() })
</script>
<template>
  <section class="pdf-preview" aria-label="成品 PDF 预览">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!document" role="status">正在读取成品 PDF…</p>
    <template v-else>
      <div class="pdf-preview__toolbar">
        <BaseButton variant="ghost" size="sm" :disabled="page <= 1" @click="go(page - 1)">上一页</BaseButton>
        <label>页码 <input :value="page" type="number" :min="1" :max="document.numPages" @change="go(Number(($event.target as HTMLInputElement).value))" /> / {{ document.numPages }}</label>
        <BaseButton variant="ghost" size="sm" :disabled="page >= document.numPages" @click="go(page + 1)">下一页</BaseButton>
        <label>缩放 <BaseSelectControl><select v-model.number="scale"><option :value="0.5">50%</option><option :value="0.75">75%</option><option :value="1">100%</option><option :value="1.5">150%</option><option :value="2">200%</option></select></BaseSelectControl></label>
        <BaseButton variant="ghost" size="sm" :aria-pressed="thumbs" @click="thumbs = !thumbs">缩略图</BaseButton>
      </div>
      <div v-if="thumbs" class="pdf-preview__thumbnails" aria-label="附近页面">
        <button v-for="index in nearby" :key="index" type="button" :aria-label="`查看第 ${index} 页`" :aria-current="index === page ? 'page' : undefined" @click="go(index)">
          <PdfPage :document="document" :page="index" thumbnail @error="error = $event" /><span>{{ index }}</span>
        </button>
      </div>
      <div class="pdf-preview__paper" tabindex="0" aria-label="PDF 纸面，可横向滚动" @keydown.left.prevent="go(page - 1)" @keydown.right.prevent="go(page + 1)">
        <PdfPage :key="page" :document="document" :page="page" :scale="scale" @navigate="go" @error="error = $event" />
      </div>
    </template>
  </section>
</template>
<style scoped>
.pdf-preview { min-width: 0; display: flex; flex-direction: column; min-height: 32rem; }
.pdf-preview__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .65rem; background: var(--color-surface); border-bottom: 1px solid var(--color-border); font-size: .8rem; }
.pdf-preview__toolbar label { display: flex; align-items: center; gap: .3rem; white-space: nowrap; flex-shrink: 0; }
.pdf-preview__toolbar input { width: 4.5rem; padding: .3rem; }
.pdf-preview__toolbar select { padding: .3rem; }
.pdf-preview__paper { overflow: auto; padding: 1.5rem; flex: 1; display: grid; align-items: start; justify-items: center; background: #dce0d9; max-height: 80vh; }
.pdf-preview__thumbnails { display: flex; gap: .75rem; overflow: auto; padding: .75rem; background: var(--color-background); }
.pdf-preview__thumbnails button { background: transparent; border: 2px solid transparent; padding: .3rem; font-size: .75rem; }
.pdf-preview__thumbnails button[aria-current] { border-color: var(--color-primary); }
.pdf-preview > p { padding: 1rem; }
@media (max-width: 760px) { .pdf-preview__paper { padding: .75rem; justify-items: start; } }
</style>
