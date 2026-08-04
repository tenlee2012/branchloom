#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executableName = process.platform === 'win32' ? 'branchloom.exe' : 'branchloom'
const platformBinary = join(
  packageRoot,
  'bin',
  'native',
  `branchloom-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
)
const repositoryDebugBinary = resolve(packageRoot, '..', '..', 'target', 'debug', executableName)
const repositoryReleaseBinary = resolve(packageRoot, '..', '..', 'target', 'release', executableName)
const candidates = [
  process.env.BRANCHLOOM_NATIVE_BIN,
  repositoryReleaseBinary,
  repositoryDebugBinary,
  platformBinary,
].filter(Boolean)
const executable = candidates.find((candidate) => existsSync(candidate))

if (!executable) {
  process.stderr.write(
    `Branchloom native binary is unavailable for ${process.platform}-${process.arch}. `
    + 'Install a matching release or set BRANCHLOOM_NATIVE_BIN.\n',
  )
  process.exit(1)
}

const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit' })
if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
