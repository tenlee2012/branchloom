<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cytoscapeGraphAdapter, type GraphCreateOptions } from '../composables/useFamilyGraph'
import type { VisibleGraph } from '../model/buildVisibleGraph'
import type { KinshipDescription } from '../../../shared/domain/kinship'

export interface GraphAnnotations {
  searchPersonIds: ReadonlySet<string>
  kinships: ReadonlyMap<string, KinshipDescription>
}

export interface GraphDensity {
  avatars: boolean
  dates: boolean
  places: boolean
  relationships: boolean
  names?: boolean
}

export interface GraphNodeAnchor {
  personId: string
  x1: number
  x2: number
  y1: number
  y2: number
  canvasWidth: number
  canvasHeight: number
}

export interface GraphRuntime {
  update(graph: VisibleGraph, density: GraphDensity): void
  focus?(personId: string): void
  annotate?(annotations: GraphAnnotations): void
  locate?(personId: string): void
  fit(): void
  relayout(): void
  zoomIn?(): void
  zoomOut?(): void
  zoomTo?(zoomLevel: number): void
  destroy(): void
}

export interface GraphAdapter {
  create(options: GraphCreateOptions): Promise<GraphRuntime>
}

const props = withDefaults(defineProps<{
  graph: VisibleGraph
  density: GraphDensity
  selectedPersonId?: string
  annotations?: GraphAnnotations
  adapter?: GraphAdapter
}>(), {
  selectedPersonId: '',
  annotations: () => ({ searchPersonIds: new Set(), kinships: new Map() }),
})
const emit = defineEmits<{
  nodeClick: [personId: string, showQuickActions?: boolean]
  nodeDoubleClick: [personId: string]
  canvasClick: []
  selectedNodeAnchorChange: [anchor: GraphNodeAnchor | undefined]
  zoomChange: [zoomLevel: number]
}>()
const container = ref<HTMLElement | null>(null)
const loadError = ref('')
const selectedName = computed(() => props.graph.nodes.find(({ id }) => id === props.selectedPersonId)?.primaryName)
let runtime: GraphRuntime | undefined
let disposed = false
let pendingLocation = ''

function message(error: unknown) {
  return error instanceof Error ? error.message : '图形引擎无法更新'
}

function updateRuntime(graph: VisibleGraph, density: GraphDensity) {
  const active = runtime
  if (!active) return
  try {
    active.update(graph, density)
  } catch (error) {
    runtime = undefined
    active.destroy()
    loadError.value = message(error)
  }
}

onMounted(async () => {
  if (!container.value) return
  try {
    const created = await (props.adapter ?? cytoscapeGraphAdapter).create({
      container: container.value,
      graph: props.graph,
      density: props.density,
      selectedPersonId: props.selectedPersonId,
      onNodeClick: (personId) => emit('nodeClick', personId),
      onNodeDoubleClick: (personId) => emit('nodeDoubleClick', personId),
      onCanvasClick: () => emit('canvasClick'),
      onSelectedNodeAnchorChange: (anchor) => emit('selectedNodeAnchorChange', anchor),
      onZoomChange: (zoomLevel) => emit('zoomChange', zoomLevel),
    })
    if (disposed) {
      created.destroy()
      return
    }
    try {
      created.update(props.graph, props.density)
      created.focus?.(props.selectedPersonId)
      created.annotate?.(props.annotations)
      if (pendingLocation) created.locate?.(pendingLocation)
    } catch (error) {
      created.destroy()
      throw error
    }
    runtime = created
  } catch (error) {
    if (!disposed) loadError.value = message(error)
  }
})

watch(
  () => [props.graph, props.density] as const,
  ([graph, density]) => updateRuntime(graph, density),
  { deep: true },
)

watch(() => props.selectedPersonId, (personId) => runtime?.focus?.(personId))
watch(() => props.annotations, (annotations) => runtime?.annotate?.(annotations))

onBeforeUnmount(() => {
  disposed = true
  runtime?.destroy()
  runtime = undefined
})

defineExpose({
  locate(personId: string) {
    pendingLocation = personId
    runtime?.locate?.(personId)
  },
  fit() { runtime?.fit() },
  relayout() { runtime?.relayout() },
  zoomIn() { runtime?.zoomIn?.() },
  zoomOut() { runtime?.zoomOut?.() },
  zoomTo(zoomLevel: number) { runtime?.zoomTo?.(zoomLevel) },
})
</script>

<template>
  <div class="family-graph">
    <div v-if="loadError" class="family-graph__error" role="alert">
      <strong>家谱图形未能载入</strong>
      <span>{{ loadError }}</span>
    </div>
    <div
      ref="container"
      class="family-graph__canvas"
      data-testid="family-graph"
      role="application"
      aria-label="可缩放和平移的家谱图"
    />
    <p v-if="selectedName" class="visually-hidden" role="status">{{ selectedName }}对其他人物的称呼</p>
  </div>
</template>

<style scoped>
.family-graph, .family-graph__canvas { width: 100%; height: 100%; min-height: 32rem; }
.family-graph { position: relative; overflow: hidden; background: #fffdf9; }
.family-graph__error { position: absolute; z-index: 3; top: var(--space-4); left: 50%; display: grid; max-width: 28rem; transform: translateX(-50%); gap: var(--space-1); padding: var(--space-3) var(--space-4); border: 1px solid var(--color-danger); border-radius: var(--radius-sm); background: var(--color-danger-surface); color: var(--color-danger); }
</style>
