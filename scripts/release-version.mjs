import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { readWorkspaceVersion } from './workspace-version.mjs'

const workspaceDirectory = fileURLToPath(new URL('..', import.meta.url))
const workspaceManifest = path.join(workspaceDirectory, 'Cargo.toml')
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function setVersion(nextVersion) {
  if (!semverPattern.test(nextVersion)) {
    throw new Error(`Invalid semantic version: ${nextVersion}`)
  }
  const source = readFileSync(workspaceManifest, 'utf8')
  const versionPattern = /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m
  if (!versionPattern.test(source)) {
    throw new Error('Cargo.toml is missing [workspace.package] version')
  }
  const updated = source.replace(versionPattern, `$1${nextVersion}$2`)
  if (updated !== source) writeFileSync(workspaceManifest, updated)

  // Refresh Cargo.lock after changing the inherited workspace version.
  const resolvedVersion = readWorkspaceVersion(workspaceDirectory)
  if (resolvedVersion !== nextVersion) {
    throw new Error(`Cargo resolved ${resolvedVersion}, expected ${nextVersion}`)
  }
  process.stdout.write(`Updated Branchloom workspace version to ${nextVersion}\n`)
}

function checkTag(tag) {
  if (!tag) throw new Error('A release tag is required')
  const version = readWorkspaceVersion(workspaceDirectory, { locked: true })
  const expectedTag = `v${version}`
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag} does not match workspace version ${version}`)
  }
  process.stdout.write(`Release tag ${tag} matches workspace version ${version}\n`)
}

try {
  const [command, value] = process.argv.slice(2)
  if (!command || command === '--print') {
    process.stdout.write(`${readWorkspaceVersion(workspaceDirectory, { locked: true })}\n`)
  } else if (command === '--check-tag') {
    checkTag(value)
  } else {
    setVersion(command === '--set' ? value : command)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
