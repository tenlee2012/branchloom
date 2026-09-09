import { fileURLToPath } from 'node:url'
import { run } from '@tauri-apps/cli'

import { withWorkspaceVersion } from './tauri-version.mjs'
import { runWithAndroidProject } from './android-project.mjs'

const workspaceDirectory = fileURLToPath(new URL('../../../', import.meta.url))

try {
  const args = withWorkspaceVersion(process.argv.slice(2), workspaceDirectory)
  await runWithAndroidProject(args, workspaceDirectory, (cliArgs) => run(cliArgs, 'pnpm run tauri'))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
