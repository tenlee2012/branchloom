import 'vue-router'

export {}

declare module 'vue-router' {
  interface RouteMeta {
    /** The page handles data refresh without discarding its unsaved editor or running job. */
    refreshInPlace?: boolean
    workspaceMode?: 'standard' | 'management' | 'canvas'
  }
}
