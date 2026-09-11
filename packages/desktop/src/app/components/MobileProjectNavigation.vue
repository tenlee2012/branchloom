<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IconX } from '@tabler/icons-vue'
import AppSidebar from './AppSidebar.vue'
import { useNavigationDrawer } from './useNavigationDrawer'
import { useModalOverlay } from '../../design-system/useModalOverlay'

defineProps<{ projectId: string; projectName: string }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const route = useRoute()
const router = useRouter()
const { open, show, close } = useNavigationDrawer()
const surface = ref<HTMLElement | null>(null)
const backdrop = ref<HTMLElement | null>(null)
let disposed = false
let suppressClick = false
let gesture: { id: number; x: number; y: number; opening: boolean } | undefined

useModalOverlay({ open, surface, backdrop, onClose: () => { void close() } })
watch(open, (value) => emit('update:open', value))
watch(() => route.fullPath, () => { void close() })
onBeforeUnmount(() => { disposed = true })

function startSwipe(event: PointerEvent, opening: boolean) {
  suppressClick = false
  if (!event.isPrimary || !['touch', 'pen'].includes(event.pointerType)) return
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, opening }
}

function moveSwipe(event: PointerEvent) {
  if (!gesture || gesture.id !== event.pointerId) return
  const dx = event.clientX - gesture.x
  const dy = event.clientY - gesture.y
  if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
    gesture = undefined
    return
  }
  if (Math.abs(dx) > 12) {
    suppressClick = true
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
  }
}

function endSwipe(event: PointerEvent) {
  const active = gesture
  gesture = undefined
  if (!active || active.id !== event.pointerId) return
  const dx = event.clientX - active.x
  const dy = event.clientY - active.y
  if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return
  if (active.opening && dx > 0) void show()
  else if (!active.opening && dx < 0) void close()
}

async function handleClick(event: MouseEvent) {
  if (suppressClick && event.detail > 0) {
    suppressClick = false
    event.preventDefault()
    event.stopPropagation()
    return
  }
  suppressClick = false
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!link || link.target === '_blank' || link.hasAttribute('download') || link.origin !== window.location.origin) return
  event.preventDefault()
  // Remove the menu's history entry before starting a page navigation.
  const target = link.pathname + link.search + link.hash
  await close()
  if (!disposed) await router.push(target)
}

defineExpose({ show })
</script>

<template>
  <div
    v-if="!open"
    class="mobile-navigation__edge"
    aria-hidden="true"
    @pointerdown="startSwipe($event, true)"
    @pointermove="moveSwipe"
    @pointerup="endSwipe"
    @pointercancel="gesture = undefined"
  />
  <Teleport to="body">
    <Transition name="mobile-navigation">
      <div v-if="open" ref="backdrop" class="mobile-navigation__backdrop" @click.self="close">
        <section
          id="mobile-project-menu"
          ref="surface"
          class="mobile-navigation__panel"
          role="dialog"
          aria-modal="true"
          aria-label="项目菜单"
          tabindex="-1"
          @click.capture="handleClick"
          @pointerdown="startSwipe($event, false)"
          @pointermove="moveSwipe"
          @pointerup="endSwipe"
          @pointercancel="gesture = undefined"
        >
          <button class="mobile-navigation__close" type="button" aria-label="关闭菜单" @click="close">
            <IconX :size="22" aria-hidden="true" />
          </button>
          <AppSidebar mobile :project-id="projectId" :project-name="projectName" />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mobile-navigation__edge { position: fixed; z-index: 30; top: calc(3.75rem + env(safe-area-inset-top)); bottom: env(safe-area-inset-bottom); left: 0; width: 1rem; touch-action: pan-y; }
.mobile-navigation__backdrop { position: fixed; z-index: 1000; inset: 0; background: var(--color-overlay); }
.mobile-navigation__panel { position: relative; display: flex; width: min(20rem, calc(100vw - 3.5rem)); height: 100%; overflow: auto; overscroll-behavior: contain; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom) env(safe-area-inset-left); background: var(--color-primary-strong); box-shadow: var(--shadow-lg); touch-action: pan-y; }
.mobile-navigation__close { position: absolute; z-index: 1; top: calc(.5rem + env(safe-area-inset-top)); right: .5rem; display: grid; width: 2.75rem; height: 2.75rem; place-items: center; border: 0; border-radius: var(--radius-sm); background: transparent; color: #fffdf6; cursor: pointer; }
.mobile-navigation__close:hover { background: rgb(255 253 246 / 10%); }
.mobile-navigation__panel :deep(.app-sidebar) { width: 100%; flex: 0 0 auto; border: 0; }
.mobile-navigation__panel :deep(:focus-visible) { outline-color: #fffdf6; }
.mobile-navigation-enter-active, .mobile-navigation-leave-active { transition: opacity 220ms ease; }
.mobile-navigation-enter-active .mobile-navigation__panel, .mobile-navigation-leave-active .mobile-navigation__panel { transition: transform 220ms cubic-bezier(.2, .8, .2, 1); }
.mobile-navigation-enter-from, .mobile-navigation-leave-to { opacity: 0; }
.mobile-navigation-enter-from .mobile-navigation__panel, .mobile-navigation-leave-to .mobile-navigation__panel { transform: translateX(-100%); }
</style>
