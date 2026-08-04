import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extension = process.platform === 'win32' ? '.exe' : ''
const source = resolve(packageRoot, '..', '..', 'target', 'release', `branchloom${extension}`)
const destination = join(
  packageRoot,
  'bin',
  'native',
  `branchloom-${process.platform}-${process.arch}${extension}`,
)

mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
if (process.platform !== 'win32') chmodSync(destination, 0o755)
