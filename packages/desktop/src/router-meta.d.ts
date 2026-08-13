import 'vue-router'

export {}

declare module 'vue-router' {
  interface RouteMeta {
    workspaceMode?: 'standard' | 'management' | 'canvas'
  }
}
