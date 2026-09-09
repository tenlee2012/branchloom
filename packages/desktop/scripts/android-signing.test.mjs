import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveSigningConfig, runCommand, signAndroidApk } from './android-signing.mjs'

const fixtures = []

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'branchloom-signing-'))
  fixtures.push(directory)
  const keystore = path.join(directory, 'test.keystore')
  writeFileSync(keystore, 'test key placeholder')
  const sdk = path.join(directory, 'Library/Android/sdk')
  for (const version of ['9.0.0', '35.0.0', '36.0.0']) {
    const tools = path.join(sdk, 'build-tools', version)
    mkdirSync(path.join(tools, 'lib'), { recursive: true })
    writeFileSync(path.join(tools, 'zipalign'), '')
    writeFileSync(path.join(tools, 'lib/apksigner.jar'), '')
  }
  const options = {
    workspaceDirectory: directory,
    userHome: directory,
    platform: 'darwin',
    interactive: false,
    env: {
      ANDROID_KEYSTORE_PATH: keystore,
      ANDROID_KEY_ALIAS: 'test-alias',
      ANDROID_KEYSTORE_PASSWORD: 'test-store-password',
      ANDROID_KEY_PASSWORD: 'test-key-password',
    },
  }
  const unsigned = path.join(directory, 'unsigned.apk')
  const signed = path.join(directory, 'signed.apk')
  writeFileSync(unsigned, 'test unsigned APK')
  return { directory, sdk, options, unsigned, signed }
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Android release signing', () => {
  it('requires signing credentials before any build starts', () => {
    expect(() => resolveSigningConfig({ workspaceDirectory: '/unused', env: {} })).toThrow('缺少 Android 签名配置')
  })

  it('detects the latest installed stable build tools', () => {
    const { sdk, options } = fixture()
    const config = resolveSigningConfig(options)
    expect(config.zipalign).toBe(path.join(sdk, 'build-tools/36.0.0/zipalign'))
    expect(config.alias).toBe('test-alias')
  })

  it('honors SDK, build tools and Java overrides', () => {
    const { sdk, options } = fixture()
    options.env.ANDROID_SDK_ROOT = sdk
    options.env.ANDROID_BUILD_TOOLS_VERSION = '35.0.0'
    options.env.JAVA_HOME = '/test-java'
    const config = resolveSigningConfig(options)
    expect(config.zipalign).toBe(path.join(sdk, 'build-tools/35.0.0/zipalign'))
    expect(config.java).toBe('/test-java/bin/java')
  })

  it('allows terminal password prompts but rejects missing passwords in unattended builds', () => {
    const { options } = fixture()
    delete options.env.ANDROID_KEYSTORE_PASSWORD
    expect(() => resolveSigningConfig(options)).toThrow('非交互环境需要设置')
    expect(() => resolveSigningConfig({ ...options, interactive: true })).not.toThrow()
  })

  it('publishes only after signing, signature verification and alignment checks, keeping passwords off argv', () => {
    const { directory, options, unsigned, signed } = fixture()
    const config = resolveSigningConfig(options)
    const calls = []
    const run = (command, args) => {
      calls.push({ command, args })
      if (args[0] === '-f') copyFileSync(unsigned, args.at(-1))
      if (args.includes('--out')) writeFileSync(args[args.indexOf('--out') + 1], 'verified test APK')
      expect(existsSync(signed)).toBe(false)
    }
    signAndroidApk(config, unsigned, signed, run)

    expect(calls.map(({ args }) => args[0] === '-jar' ? args[2] : args[0])).toEqual(['-f', 'sign', 'verify', '-c'])
    expect(calls[1].args).toContain('env:ANDROID_KEYSTORE_PASSWORD')
    expect(calls[1].args).toContain('env:ANDROID_KEY_PASSWORD')
    expect(JSON.stringify(calls)).not.toContain('test-store-password')
    expect(JSON.stringify(calls)).not.toContain('test-key-password')
    expect(readFileSync(signed, 'utf8')).toBe('verified test APK')
    expect(readFileSync(unsigned, 'utf8')).toBe('test unsigned APK')
    expect(readdirSync(directory).some((name) => name.startsWith('.android-signing-'))).toBe(false)
  })

  it('preserves the previous APK and cleans up temporary files when verification fails', () => {
    const { directory, options, unsigned, signed } = fixture()
    writeFileSync(signed, 'previous verified APK')
    const run = (_command, args) => {
      if (args[0] === '-f') copyFileSync(unsigned, args.at(-1))
      if (args.includes('--out')) writeFileSync(args[args.indexOf('--out') + 1], 'invalid test APK')
      if (args.includes('verify')) throw new Error('signature rejected')
    }
    expect(() => signAndroidApk(resolveSigningConfig(options), unsigned, signed, run)).toThrow('signature rejected')
    expect(readFileSync(signed, 'utf8')).toBe('previous verified APK')
    expect(readdirSync(directory).some((name) => name.startsWith('.android-signing-'))).toBe(false)
  })

  it('propagates child process failures', () => {
    expect(() => runCommand(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'pipe' })).toThrow('执行失败（7）')
  })
})
