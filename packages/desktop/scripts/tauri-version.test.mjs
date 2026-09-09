import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readWorkspaceVersion } from '../../../scripts/workspace-version.mjs'
import { withWorkspaceVersion } from './tauri-version.mjs'

const fixtures = []

function createWorkspace(version) {
  const directory = mkdtempSync(path.join(tmpdir(), 'branchloom-version-'))
  fixtures.push(directory)
  const packages = ['branchloom', 'branchloom-cli', 'branchloom-core']
  writeFileSync(path.join(directory, 'Cargo.toml'), `
[workspace]
members = ${JSON.stringify(packages)}
resolver = "2"

[workspace.package]
version = "${version}"
`)
  for (const name of packages) {
    const packageDirectory = path.join(directory, name)
    mkdirSync(path.join(packageDirectory, 'src'), { recursive: true })
    writeFileSync(path.join(packageDirectory, 'Cargo.toml'), `
[package]
name = "${name}"
version.workspace = true
edition = "2021"
`)
    writeFileSync(path.join(packageDirectory, 'src/lib.rs'), '')
  }
  readWorkspaceVersion(directory)
  return directory
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Tauri Android workspace version', () => {
  it.each(['init', 'dev', 'build'])('passes the inherited Cargo version to Android %s', (command) => {
    const directory = createWorkspace('2.3.4')
    const args = withWorkspaceVersion(['android', command], directory)

    expect(args.slice(0, 2)).toEqual(['android', command])
    expect(JSON.parse(args[args.indexOf('--config') + 1])).toEqual({ version: '2.3.4' })
  })

  it('reads a changed workspace version on the next build without writing project config', () => {
    const directory = createWorkspace('0.1.5')
    const manifestPath = path.join(directory, 'Cargo.toml')
    const source = readFileSync(manifestPath, 'utf8')
    withWorkspaceVersion(['android', 'build'], directory)
    expect(readFileSync(manifestPath, 'utf8')).toBe(source)

    writeFileSync(manifestPath, source.replace('0.1.5', '0.1.6'))
    readWorkspaceVersion(directory)
    const args = withWorkspaceVersion(['android', 'build'], directory)
    expect(JSON.parse(args[args.indexOf('--config') + 1]).version).toBe('0.1.6')
  })

  it('preserves debug, target, caller config and Cargo arguments', () => {
    const directory = createWorkspace('0.1.5')
    const options = ['--debug', '--apk', '--target', 'aarch64', '--config', '{"bundle":{"android":{"minSdkVersion":31}}}', '--', '--locked']
    const args = withWorkspaceVersion(['-v', 'android', 'build', ...options], directory)

    expect(args.slice(0, 3)).toEqual(['-v', 'android', 'build'])
    expect(JSON.parse(args[4])).toEqual({ version: '0.1.5' })
    expect(args.slice(5)).toEqual(options)
  })

  it('rejects inconsistent Rust package versions instead of using a default', () => {
    const directory = createWorkspace('0.1.5')
    const manifestPath = path.join(directory, 'branchloom-cli/Cargo.toml')
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('version.workspace = true', 'version = "0.1.4"'))
    expect(() => readWorkspaceVersion(directory)).toThrow('versions do not match')
    expect(() => withWorkspaceVersion(['android', 'build'], directory)).toThrow('versions do not match')
  })

  it.each([
    ['icon', 'src-tauri/app-icon-manifest.json'],
    ['build', '--bundles', 'dmg'],
    ['android', 'android-studio-script', '--target', 'aarch64'],
  ])('passes other commands through (%s)', (...args) => {
    expect(withWorkspaceVersion(args, '/unused-workspace')).toEqual(args)
  })
})
