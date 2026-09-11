/// <reference types="vite/client" />

declare module 'cytoscape-elk' {
  import type { Ext } from 'cytoscape'
  const register: Ext
  export default register
}

declare module 'relationship.js' {
  export default function relationship(options: {
    text: string
    sex: -1 | 0 | 1
    optimal: boolean
  }): string[]
}
