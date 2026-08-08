import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface AppNotification {
  id: number
  tone: 'info' | 'success' | 'warning' | 'danger'
  message: string
}

const MAX_VISIBLE_NOTIFICATIONS = 3

export const useNotificationsStore = defineStore('notifications', () => {
  const notifications = ref<AppNotification[]>([])
  let nextId = 1

  function push(message: string, tone: AppNotification['tone'] = 'info') {
    const notification: AppNotification = { id: nextId++, message, tone }
    notifications.value.push(notification)
    if (notifications.value.length > MAX_VISIBLE_NOTIFICATIONS) {
      notifications.value.splice(0, notifications.value.length - MAX_VISIBLE_NOTIFICATIONS)
    }
    return notification.id
  }

  function dismiss(id: number) {
    notifications.value = notifications.value.filter((notification) => notification.id !== id)
  }

  return { notifications, push, dismiss }
})
