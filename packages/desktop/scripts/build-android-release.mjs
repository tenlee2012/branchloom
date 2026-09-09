import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

import { resolveSigningConfig, runCommand, signAndroidApk } from './android-signing.mjs'

const workspaceDirectory = fileURLToPath(new URL('../../../', import.meta.url))

try {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--sign-only')) throw new Error('仅支持 --sign-only 参数。')
  const environmentFile = path.join(workspaceDirectory, '.env.android.local')
  if (existsSync(environmentFile)) loadEnvFile(environmentFile)
  // Check signing prerequisites before starting an expensive release build.
  const config = resolveSigningConfig({ workspaceDirectory })
  if (!args.includes('--sign-only')) {
    if (!process.env.npm_execpath) throw new Error('请通过 pnpm build:android:release 运行。')
    runCommand(process.execPath, [process.env.npm_execpath, 'run', 'build:android:release:unsigned'], { cwd: workspaceDirectory })
  }
  const outputDirectory = path.join(workspaceDirectory, 'packages/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release')
  const signedApk = signAndroidApk(
    config,
    path.join(outputDirectory, 'app-universal-release-unsigned.apk'),
    path.join(outputDirectory, 'app-universal-release.apk'),
  )
  process.stdout.write(`\n签名和校验通过，可安装 APK：\n${signedApk}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
