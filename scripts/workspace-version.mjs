import { spawnSync } from 'node:child_process'

const packageNames = ['branchloom', 'branchloom-cli', 'branchloom-core']

function cargoMetadata(workspaceDirectory, { locked = false } = {}) {
  const args = ['metadata', '--no-deps', '--format-version', '1']
  if (locked) args.push('--locked')
  const result = spawnSync('cargo', args, {
    cwd: workspaceDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    throw new Error(`cargo metadata exited with ${result.status ?? 'an unknown status'}`)
  }
  return JSON.parse(result.stdout)
}

export function readWorkspaceVersion(workspaceDirectory, options) {
  const metadata = cargoMetadata(workspaceDirectory, options)
  const versions = new Map(
    metadata.packages
      .filter((pkg) => packageNames.includes(pkg.name))
      .map((pkg) => [pkg.name, pkg.version]),
  )
  const missing = packageNames.filter((name) => !versions.has(name))
  if (missing.length > 0) {
    throw new Error(`Cargo metadata is missing Branchloom packages: ${missing.join(', ')}`)
  }
  const uniqueVersions = new Set(versions.values())
  if (uniqueVersions.size !== 1) {
    const details = packageNames.map((name) => `${name}=${versions.get(name)}`).join(' ')
    throw new Error(`Branchloom workspace versions do not match: ${details}`)
  }
  return versions.get('branchloom')
}
