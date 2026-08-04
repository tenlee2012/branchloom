<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import { NATIVE_STATE_REFRESHED_EVENT } from './shared/repository/TauriRepository'

const nativeStateRevision = ref(0)

function refreshRouteState() {
  nativeStateRevision.value += 1
}

onMounted(() => window.addEventListener(NATIVE_STATE_REFRESHED_EVENT, refreshRouteState))
onBeforeUnmount(() => window.removeEventListener(NATIVE_STATE_REFRESHED_EVENT, refreshRouteState))
</script>

<template>
  <div class="app-root">
    <RouterView :key="nativeStateRevision" />
  </div>
</template>

<style scoped>
.app-root {
  min-height: 100%;
}
</style>
