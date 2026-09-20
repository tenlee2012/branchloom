import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import type { Plugin } from 'vite'

/** Bundle PDF.js's optional decoders and fonts for offline preview of imported source pages. */
export function pdfAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files = new Map<string, string>()
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const file of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (file.isFile()) files.set(`pdf-assets/${directory}/${file.name}`, join(root, directory, file.name))
    }
  }
  return {
    name: 'branchloom-offline-pdf-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]?.replace(/^\//, '') ?? ''
        const file = files.get(path)
        if (!file) return next()
        response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [fileName, path] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) })
    },
  }
}
