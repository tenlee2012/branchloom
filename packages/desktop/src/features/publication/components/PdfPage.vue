<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
const props = withDefaults(defineProps<{ document: PDFDocumentProxy; page: number; scale?: number; thumbnail?: boolean }>(), { scale: 1, thumbnail: false })
const emit = defineEmits<{ navigate: [page: number]; error: [message: string] }>()
const canvas = ref<HTMLCanvasElement>()
const busy = ref(true)
const dimensions = ref({ width: 0, height: 0 })
const links = ref<Array<{ left: number; top: number; width: number; height: number; page: number }>>([])
let task: RenderTask | undefined
let request = 0
watch(() => [props.document, props.page, props.scale, canvas.value], async () => {
  const current = ++request
  task?.cancel()
  if (!canvas.value) return
  busy.value = true
  links.value = []
  let loadedPage: PDFPageProxy | undefined
  try {
    const pdfPage = await props.document.getPage(props.page)
    loadedPage = pdfPage
    if (current !== request || !canvas.value) return
    const raw = pdfPage.getViewport({ scale: 1 })
    const scale = props.thumbnail ? 110 / raw.width : Math.min(props.scale, 1600 / raw.width, Math.sqrt(5_000_000 / (raw.width * raw.height)))
    const viewport = pdfPage.getViewport({ scale })
    const ratio = props.thumbnail ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    dimensions.value = { width: viewport.width, height: viewport.height }
    const target = canvas.value
    target.width = Math.ceil(viewport.width * ratio)
    target.height = Math.ceil(viewport.height * ratio)
    const context = target.getContext('2d')
    if (!context) throw new Error('当前设备无法显示 PDF 预览')
    task = pdfPage.render({ canvas: target, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
    await task.promise
    if (!props.thumbnail) {
      for (const annotation of await pdfPage.getAnnotations()) {
        if (!annotation.dest || !annotation.rect) continue
        const destination = typeof annotation.dest === 'string' ? await props.document.getDestination(annotation.dest) : annotation.dest
        if (!destination) continue
        const page = typeof destination[0] === 'number' ? destination[0] + 1 : (await props.document.getPageIndex(destination[0])) + 1
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect)
        if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) continue
        if (current === request) links.value.push({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), page })
      }
    }
  } catch (error) {
    if (current === request && !(error instanceof Error && error.name === 'RenderingCancelledException')) emit('error', error instanceof Error ? error.message : 'PDF 页面无法显示')
  } finally { loadedPage?.cleanup(); if (current === request) busy.value = false }
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => { request++; task?.cancel() })
</script>
<template>
  <div class="pdf-page" :aria-busy="busy" :style="{ width: `${dimensions.width}px`, height: `${dimensions.height}px` }">
    <canvas ref="canvas" :style="{ width: `${dimensions.width}px`, height: `${dimensions.height}px` }" role="img" :aria-label="`PDF 第 ${page} 页`" />
    <button v-for="(link, index) in links" :key="index" class="pdf-page__link" type="button" :aria-label="`跳转到第 ${link.page} 页`"
      :style="{ left: `${link.left}px`, top: `${link.top}px`, width: `${link.width}px`, height: `${link.height}px` }" @click="emit('navigate', link.page)" />
  </div>
</template>
<style scoped>
.pdf-page { position: relative; flex: 0 0 auto; background: white; box-shadow: 0 4px 18px #0002; }
canvas { display: block; }
.pdf-page__link { position: absolute; border: 0; padding: 0; background: transparent; cursor: pointer; }
.pdf-page__link:hover { background: #3f6d5420; }
.pdf-page__link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
