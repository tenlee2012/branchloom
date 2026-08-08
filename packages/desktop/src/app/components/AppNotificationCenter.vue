<script setup lang="ts">
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-vue'
import { storeToRefs } from 'pinia'
import { onBeforeUnmount, watch } from 'vue'
import {
  useNotificationsStore,
  type AppNotification,
} from '../stores/notifications'

const store = useNotificationsStore()
const { notifications } = storeToRefs(store)
const timers = new Map<number, number>()

function duration(tone: AppNotification['tone']): number {
  return tone === 'success' || tone === 'info' ? 5_000 : 8_000
}

function clearTimer(id: number) {
  const timer = timers.get(id)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(id)
}

function scheduleDismiss(notification: AppNotification) {
  clearTimer(notification.id)
  timers.set(notification.id, window.setTimeout(() => {
    timers.delete(notification.id)
    store.dismiss(notification.id)
  }, duration(notification.tone)))
}

function dismiss(id: number) {
  clearTimer(id)
  store.dismiss(id)
}

function toneLabel(tone: AppNotification['tone']): string {
  return {
    info: '提示',
    success: '成功',
    warning: '注意',
    danger: '错误',
  }[tone]
}

watch(
  () => notifications.value.map(({ id }) => id),
  () => {
    const visibleIds = new Set(notifications.value.map(({ id }) => id))
    for (const id of timers.keys()) {
      if (!visibleIds.has(id)) clearTimer(id)
    }
    for (const notification of notifications.value) {
      if (!timers.has(notification.id)) scheduleDismiss(notification)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  for (const id of timers.keys()) clearTimer(id)
})
</script>

<template>
  <aside
    class="notification-center"
    aria-label="应用通知"
  >
    <TransitionGroup name="notification-list" tag="ol">
      <li
        v-for="notification in notifications"
        :key="notification.id"
        :class="['notification', `notification--${notification.tone}`]"
        :role="notification.tone === 'danger' ? 'alert' : 'status'"
        :aria-live="notification.tone === 'danger' ? 'assertive' : 'polite'"
        aria-atomic="true"
        @mouseenter="clearTimer(notification.id)"
        @mouseleave="scheduleDismiss(notification)"
        @focusin="clearTimer(notification.id)"
        @focusout="scheduleDismiss(notification)"
      >
        <span class="notification__icon" aria-hidden="true">
          <IconCheck v-if="notification.tone === 'success'" :size="19" />
          <IconAlertTriangle v-else-if="notification.tone === 'warning'" :size="19" />
          <IconX v-else-if="notification.tone === 'danger'" :size="19" />
          <IconInfoCircle v-else :size="19" />
        </span>
        <span class="notification__copy">
          <strong>{{ toneLabel(notification.tone) }}</strong>
          <span>{{ notification.message }}</span>
        </span>
        <button
          type="button"
          class="notification__dismiss"
          :aria-label="`关闭通知：${notification.message}`"
          @click="dismiss(notification.id)"
        >
          <IconX :size="18" aria-hidden="true" />
        </button>
      </li>
    </TransitionGroup>
  </aside>
</template>

<style scoped>
.notification-center {
  position: fixed;
  z-index: 1200;
  top: var(--space-4);
  right: var(--space-4);
  width: min(24rem, calc(100vw - 2rem));
  pointer-events: none;
}

.notification-center ol {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.notification {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-left-width: 4px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
  color: var(--color-text);
  pointer-events: auto;
}

.notification--success { border-left-color: var(--color-success); }
.notification--warning { border-left-color: var(--color-warning); }
.notification--danger { border-left-color: var(--color-danger); }
.notification--info { border-left-color: var(--color-info); }

.notification__icon { display: grid; margin-top: 0.1rem; color: var(--color-info); }
.notification--success .notification__icon { color: var(--color-success); }
.notification--warning .notification__icon { color: var(--color-warning); }
.notification--danger .notification__icon { color: var(--color-danger); }

.notification__copy { display: grid; gap: var(--space-1); min-width: 0; line-height: 1.45; }
.notification__copy strong { font-size: 0.8rem; }
.notification__copy > span { overflow-wrap: anywhere; color: var(--color-muted); font-size: 0.9rem; }

.notification__dismiss {
  display: grid;
  width: 2rem;
  height: 2rem;
  margin: calc(var(--space-1) * -1);
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}

.notification__dismiss:hover { background: var(--color-muted-surface); color: var(--color-text); }
.notification__dismiss:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

.notification-list-enter-active,
.notification-list-leave-active { transition: opacity 180ms ease, transform 180ms ease; }
.notification-list-enter-from,
.notification-list-leave-to { opacity: 0; transform: translateY(-0.5rem); }

@media (max-width: 40rem) {
  .notification-center { top: var(--space-3); right: var(--space-3); width: calc(100vw - 1.5rem); }
}

@media (prefers-reduced-motion: reduce) {
  .notification-list-enter-active,
  .notification-list-leave-active { transition: none; }
}
</style>
