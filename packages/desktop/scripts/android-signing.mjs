import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} 执行失败（${result.signal ?? result.status}）。`)
  }
}

export function resolveSigningConfig({ workspaceDirectory, env = process.env, platform = process.platform, userHome = homedir(), interactive = Boolean(process.stdin.isTTY) }) {
  if (!env.ANDROID_KEYSTORE_PATH || !env.ANDROID_KEY_ALIAS) {
    throw new Error('缺少 Android 签名配置。请复制 .env.android.example 为 .env.android.local，填写 ANDROID_KEYSTORE_PATH 和 ANDROID_KEY_ALIAS，再运行 pnpm build:android:release。已有 APK 可运行 pnpm android:sign 单独签名。')
  }
  const keystore = path.resolve(workspaceDirectory, env.ANDROID_KEYSTORE_PATH)
  accessSync(keystore, constants.R_OK)
  if (!interactive && !env.ANDROID_KEYSTORE_PASSWORD) {
    throw new Error('非交互环境需要设置 ANDROID_KEYSTORE_PASSWORD；也可以在本机终端运行命令并按提示输入密码。')
  }

  const defaultSdk = platform === 'darwin'
    ? path.join(userHome, 'Library/Android/sdk')
    : platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(userHome, 'AppData/Local'), 'Android/Sdk')
      : path.join(userHome, 'Android/Sdk')
  const sdk = env.ANDROID_SDK_ROOT || env.ANDROID_HOME || defaultSdk
  const toolsDirectory = path.join(sdk, 'build-tools')
  if (!existsSync(toolsDirectory)) {
    throw new Error('未找到 Android SDK Build Tools，请设置 ANDROID_SDK_ROOT。')
  }
  const versions = env.ANDROID_BUILD_TOOLS_VERSION
    ? [env.ANDROID_BUILD_TOOLS_VERSION]
    : readdirSync(toolsDirectory).filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
  const executableSuffix = platform === 'win32' ? '.exe' : ''
  const tools = versions.map((version) => path.join(toolsDirectory, version)).find((directory) => (
    existsSync(path.join(directory, `zipalign${executableSuffix}`))
    && existsSync(path.join(directory, 'lib/apksigner.jar'))
  ))
  if (!tools) throw new Error('未找到 zipalign 和 apksigner，请安装 Android SDK Build Tools。')

  return {
    keystore,
    alias: env.ANDROID_KEY_ALIAS,
    zipalign: path.join(tools, `zipalign${executableSuffix}`),
    apksigner: path.join(tools, 'lib/apksigner.jar'),
    java: env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', `java${executableSuffix}`) : 'java',
    env,
  }
}

export function signAndroidApk(config, unsignedApk, signedApk, run = runCommand) {
  accessSync(unsignedApk, constants.R_OK)
  const temporaryDirectory = mkdtempSync(path.join(path.dirname(signedApk), '.android-signing-'))
  const aligned = path.join(temporaryDirectory, 'aligned.apk')
  const signed = path.join(temporaryDirectory, 'signed.apk')
  const options = { env: config.env }
  const signer = (args) => run(config.java, ['-jar', config.apksigner, ...args], options)
  try {
    run(config.zipalign, ['-f', '-P', '16', '4', unsignedApk, aligned], options)
    const args = ['sign', '--ks', config.keystore, '--ks-key-alias', config.alias]
    if (config.env.ANDROID_KEYSTORE_PASSWORD) args.push('--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD')
    if (config.env.ANDROID_KEY_PASSWORD) args.push('--key-pass', 'env:ANDROID_KEY_PASSWORD')
    signer([...args, '--out', signed, aligned])
    signer(['verify', '--verbose', signed])
    run(config.zipalign, ['-c', '-P', '16', '4', signed], options)
    // Expose the installable APK only after both checks have passed.
    renameSync(signed, signedApk)
    return signedApk
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
