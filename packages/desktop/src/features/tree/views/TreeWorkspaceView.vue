<script setup lang="ts">
import { ref } from 'vue'
import { useMediaQuery } from '../../../shared/composables/useMediaQuery'
import MobileFamilyExplorer from './MobileFamilyExplorer.vue'
import DesktopTreeView from './TreeView.vue'

const compactLayout = useMediaQuery('(max-width: 48rem)')
const activeView = ref<{
  fitCanvas?(): void
  addPerson?(): void
} | null>(null)

function fitCanvas() {
  activeView.value?.fitCanvas?.()
}

function addPerson() {
  activeView.value?.addPerson?.()
}

defineExpose({ fitCanvas, addPerson })
</script>

<template>
  <MobileFamilyExplorer v-if="compactLayout" ref="activeView" />
  <DesktopTreeView v-else ref="activeView" />
</template>
