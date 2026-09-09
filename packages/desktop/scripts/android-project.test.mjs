import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runWithAndroidProject, syncAndroidProject } from './android-project.mjs'

const fixtures = []
const nativeSources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri/android')
const activityPath = 'app/src/main/java/app/branchloom/mobile/MainActivity.kt'

function fixture() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'branchloom-android-project-'))
  fixtures.push(workspace)
  const tauri = path.join(workspace, 'packages/desktop/src-tauri')
  cpSync(nativeSources, path.join(tauri, 'android'), { recursive: true })
  const generated = path.join(tauri, 'gen/android')
  const initialize = () => {
    mkdirSync(path.dirname(path.join(generated, activityPath)), { recursive: true })
    writeFileSync(path.join(generated, activityPath), 'generated default activity')
    writeFileSync(path.join(generated, 'app/src/main/AndroidManifest.xml'), '<manifest />')
  }
  const assertSources = () => {
    expect(readFileSync(path.join(generated, activityPath), 'utf8')).toBe(readFileSync(path.join(nativeSources, 'MainActivity.kt'), 'utf8'))
    for (const values of ['values', 'values-night']) {
      expect(readFileSync(path.join(generated, `app/src/main/res/${values}/themes.xml`), 'utf8')).toBe(readFileSync(path.join(nativeSources, 'themes.xml'), 'utf8'))
    }
  }
  return { workspace, generated, initialize, assertSources }
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Android native project preparation', () => {
  it.each(['build', 'dev', 'android-studio-script'])('applies global system-bar sources before %s runs', async (command) => {
    const { workspace, initialize, assertSources } = fixture()
    initialize()
    const runner = vi.fn(async () => assertSources())
    await runWithAndroidProject(['android', command], workspace, runner)
    expect(runner).toHaveBeenCalledOnce()
  })

  it('restores native styling after android:init regenerates a deleted project', async () => {
    const { workspace, generated, initialize, assertSources } = fixture()
    await runWithAndroidProject(['android', 'init'], workspace, initialize)
    assertSources()
    rmSync(generated, { recursive: true })
    await runWithAndroidProject(['android', 'init'], workspace, initialize)
    assertSources()
  })

  it('leaves unchanged native files and unrelated generated settings intact', () => {
    const { workspace, generated, initialize } = fixture()
    initialize()
    const activity = path.join(generated, activityPath)
    const manifest = path.join(generated, 'app/src/main/AndroidManifest.xml')
    syncAndroidProject(workspace)
    const modifiedAt = statSync(activity).mtimeMs
    syncAndroidProject(workspace)
    expect(statSync(activity).mtimeMs).toBe(modifiedAt)
    expect(readFileSync(manifest, 'utf8')).toBe('<manifest />')
  })

  it('fails before a build without creating a partial Android project', async () => {
    const { workspace, generated } = fixture()
    const runner = vi.fn()
    await expect(runWithAndroidProject(['android', 'build'], workspace, runner)).rejects.toThrow('pnpm android:init')
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(generated)).toBe(false)
  })

  it.each([
    ['icon', 'src-tauri/app-icon-manifest.json'],
    ['build', '--bundles', 'dmg'],
    ['android', 'build', '--help'],
    ['android', 'init', '-h'],
  ])('passes unrelated commands and help through (%s)', async (...args) => {
    const { workspace, generated } = fixture()
    const runner = vi.fn()
    await runWithAndroidProject(args, workspace, runner)
    expect(runner).toHaveBeenCalledWith(args)
    expect(existsSync(generated)).toBe(false)
  })
})
