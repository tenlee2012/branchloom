import { describe, expect, it } from 'vitest'

import { createFileHashManifest } from './ai-tools-manifest.mjs'

describe('AI tools file manifest', () => {
  it('uses the same UTF-8 byte order as the Rust installer', () => {
    const manifest = createFileHashManifest([
      { path: 'evals/evals.json', sha256: 'b'.repeat(64) },
      { path: 'references/cli-reference.md', sha256: 'c'.repeat(64) },
      { path: 'SKILL.md', sha256: 'a'.repeat(64) },
    ])

    expect(manifest.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'evals/evals.json',
      'references/cli-reference.md',
    ])
    expect(manifest.sha256).toBe(
      '1e9ad09c8bac7ee522af4b9720d519355f256bed5e41758d30b6c13b67a6cdfd',
    )
  })
})
