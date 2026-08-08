import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { compareUtf8, createFileHashManifest } from './ai-tools-manifest.mjs'

const desktopDirectory = fileURLToPath(new URL('..', import.meta.url))
const workspaceDirectory = path.resolve(desktopDirectory, '../..')
const resourceDirectory = path.join(desktopDirectory, 'src-tauri', 'resources', 'ai-tools')
const argumentsList = process.argv.slice(2)

function option(name) {
  const index = argumentsList.indexOf(name)
  return index >= 0 ? argumentsList[index + 1] : undefined
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`${command} exited with ${result.status ?? 'an unknown status'}`)
  }
  return result.stdout.trim()
}

function rustHostTriple() {
  const verbose = run('rustc', ['-vV'])
  const host = verbose.split('\n').find((line) => line.startsWith('host: '))?.slice(6).trim()
  if (!host) throw new Error('Unable to determine the Rust host target')
  return host
}

function platformId(targetTriple) {
  const platforms = new Map([
    ['aarch64-apple-darwin', 'darwin-arm64'],
    ['x86_64-apple-darwin', 'darwin-x64'],
    ['x86_64-pc-windows-msvc', 'windows-x64'],
    ['x86_64-unknown-linux-gnu', 'linux-x64'],
  ])
  const platform = platforms.get(targetTriple)
  if (!platform) throw new Error(`Unsupported Branchloom desktop target: ${targetTriple}`)
  return platform
}

function packageVersion(file) {
  const source = readFileSync(file, 'utf8')
  const packageSection = source.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1]
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!version) throw new Error(`Unable to read package version from ${file}`)
  return version
}

function contractVersion() {
  const source = readFileSync(path.join(workspaceDirectory, 'packages/core/src/contract.rs'), 'utf8')
  const version = source.match(/PUBLIC_CONTRACT_VERSION:\s*u64\s*=\s*(\d+)/)?.[1]
  if (!version) throw new Error('Unable to read the public CLI contract version')
  return Number(version)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function listFiles(directory, prefix = '') {
  const files = []
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill resources may not contain symbolic links: ${entry.name}`)
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolute, relative))
    else if (entry.isFile()) files.push({ path: relative, sha256: sha256(absolute) })
  }
  return files
}

if (process.env.BRANCHLOOM_AI_TOOLS_PREPARED === '1' && !option('--binary')) {
  const manifest = path.join(resourceDirectory, 'manifest.json')
  if (!existsSync(manifest)) {
    throw new Error('AI tools were marked prepared, but manifest.json is missing')
  }
  process.exit(0)
}

const targetTriple = option('--target')
  ?? process.env.BRANCHLOOM_TARGET_TRIPLE
  ?? process.env.TAURI_ENV_TARGET_TRIPLE
  ?? rustHostTriple()
const platform = platformId(targetTriple)
const release = argumentsList.includes('--release')
const profile = release ? 'release' : 'debug'
const extension = targetTriple.includes('windows') ? '.exe' : ''

if (argumentsList.includes('--build')) {
  const cargoArguments = ['build', '-p', 'branchloom-cli', '--target', targetTriple]
  if (release) cargoArguments.push('--release')
  run('cargo', cargoArguments)
}

const binary = path.resolve(
  workspaceDirectory,
  option('--binary') ?? path.join('target', targetTriple, profile, `branchloom-cli${extension}`),
)
if (!existsSync(binary) || !statSync(binary).isFile()) {
  throw new Error(`Branchloom CLI binary is missing: ${binary}`)
}

rmSync(resourceDirectory, { recursive: true, force: true })
mkdirSync(path.join(resourceDirectory, 'cli'), { recursive: true })
mkdirSync(path.join(resourceDirectory, 'skills'), { recursive: true })
writeFileSync(path.join(resourceDirectory, '.gitkeep'), '')

const stagedBinaryName = `branchloom-cli${extension}`
const stagedBinary = path.join(resourceDirectory, 'cli', stagedBinaryName)
copyFileSync(binary, stagedBinary)
if (!targetTriple.includes('windows')) chmodSync(stagedBinary, 0o755)

if (targetTriple.includes('apple-darwin') && process.platform === 'darwin') {
  run('codesign', ['--force', '--sign', '-', stagedBinary])
  run('codesign', ['--verify', '--verbose=2', stagedBinary])
}

const skillSource = path.join(workspaceDirectory, 'skills', 'branchloom')
const stagedSkill = path.join(resourceDirectory, 'skills', 'branchloom')
cpSync(skillSource, stagedSkill, { recursive: true, errorOnExist: true })
const skillManifest = createFileHashManifest(listFiles(stagedSkill))

const desktopVersion = JSON.parse(
  readFileSync(path.join(desktopDirectory, 'src-tauri', 'tauri.conf.json'), 'utf8'),
).version
const cliVersion = packageVersion(path.join(workspaceDirectory, 'packages/cli/native/Cargo.toml'))
if (desktopVersion !== cliVersion) {
  throw new Error(`Desktop version ${desktopVersion} does not match CLI version ${cliVersion}`)
}

const manifest = {
  schemaVersion: 1,
  managedBy: 'app.branchloom.desktop',
  desktopVersion,
  cliVersion,
  contractVersion: contractVersion(),
  targetTriple,
  platform,
  cli: {
    file: `cli/${stagedBinaryName}`,
    sha256: sha256(stagedBinary),
  },
  skill: {
    directory: 'skills/branchloom',
    ...skillManifest,
  },
}
writeFileSync(path.join(resourceDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

if (argumentsList.includes('--verify')) {
  const version = JSON.parse(run(stagedBinary, ['version', '--output', 'json']))
  if (version.ok !== true
      || version.data?.cliVersion !== cliVersion
      || version.contractVersion !== manifest.contractVersion) {
    throw new Error('Staged CLI version output does not match manifest.json')
  }
  const diagnosticRoot = mkdtempSync(path.join(tmpdir(), 'branchloom-ai-tools-'))
  try {
    const diagnosticData = path.join(diagnosticRoot, 'data')
    const doctor = JSON.parse(run(stagedBinary, [
      'doctor',
      '--data-dir', diagnosticData,
      '--output', 'json',
    ]))
    if (doctor.ok !== true
        || doctor.contractVersion !== manifest.contractVersion
        || doctor.data?.compatible !== true) {
      throw new Error('Staged CLI doctor output is incompatible with manifest.json')
    }
  } finally {
    rmSync(diagnosticRoot, { recursive: true, force: true })
  }
}
process.stdout.write(`Prepared Branchloom AI tools for ${targetTriple}\n`)
