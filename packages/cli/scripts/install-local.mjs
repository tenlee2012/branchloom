import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(npmCommand, ['run', 'build:release'])
run(process.execPath, ['scripts/stage-native.mjs'])
const branchloomNpmCache = mkdtempSync(resolve(tmpdir(), 'branchloom-npm-cache-'))
try {
  run(npmCommand, ['install', '--global', '--cache', branchloomNpmCache, packageRoot])
} finally {
  rmSync(branchloomNpmCache, { recursive: true, force: true })
}
