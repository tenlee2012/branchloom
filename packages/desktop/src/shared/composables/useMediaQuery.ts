import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export function useMediaQuery(query: string): Ref<boolean> {
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : undefined
  const matches = ref(media?.matches ?? false)

  const update = (event: MediaQueryListEvent | MediaQueryList) => {
    matches.value = event.matches
  }

  onMounted(() => {
    if (!media) return
    update(media)
    media.addEventListener('change', update)
  })

  onBeforeUnmount(() => media?.removeEventListener('change', update))

  return matches
}
