import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function syncAndroidProject(workspaceDirectory) {
  const tauriDirectory = path.join(workspaceDirectory, 'packages/desktop/src-tauri')
  const androidDirectory = path.join(tauriDirectory, 'gen/android')
  const activityPath = 'app/src/main/java/app/branchloom/mobile/MainActivity.kt'
  if (!existsSync(path.join(androidDirectory, 'app/src/main/AndroidManifest.xml'))
      || !existsSync(path.join(androidDirectory, activityPath))) {
    throw new Error('Android 项目尚未初始化或包名不匹配，请先运行 pnpm android:init。')
  }

  // Keep owned native sources outside gen so android:init can always restore them.
  const files = [
    ['MainActivity.kt', activityPath],
    ['themes.xml', 'app/src/main/res/values/themes.xml'],
    ['themes.xml', 'app/src/main/res/values-night/themes.xml'],
  ]
  for (const [source, relativeTarget] of files) {
    const contents = readFileSync(path.join(tauriDirectory, 'android', source), 'utf8')
    const target = path.join(androidDirectory, relativeTarget)
    if (!existsSync(target) || readFileSync(target, 'utf8') !== contents) {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, contents)
    }
  }
}

export async function runWithAndroidProject(args, workspaceDirectory, run) {
  const commandIndex = args.findIndex((arg) => !arg.startsWith('-'))
  const [platform, command] = args.slice(commandIndex)
  const help = args.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
  const android = platform === 'android' && !help
  if (android && ['build', 'dev', 'android-studio-script'].includes(command)) {
    syncAndroidProject(workspaceDirectory)
  }
  await run(args)
  if (android && command === 'init') syncAndroidProject(workspaceDirectory)
}
