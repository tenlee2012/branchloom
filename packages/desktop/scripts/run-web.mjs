import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import path from 'node:path'

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'preview') {
  console.error('Usage: node scripts/run-web.mjs <dev|preview> [vite options]')
  process.exit(2)
}

const desktopDirectory = fileURLToPath(new URL('..', import.meta.url))
const workspaceDirectory = path.resolve(desktopDirectory, '../..')
const binaryName = process.platform === 'win32' ? 'branchloom-cli.exe' : 'branchloom-cli'
const bridgeBinary = path.join(workspaceDirectory, 'target', 'debug', binaryName)
const token = randomBytes(32).toString('hex')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${signal ?? code}`))
    })
  })
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForBridge(port, child) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Branchloom Web data bridge stopped during startup')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { 'X-Branchloom-Token': token },
      })
      if (response.ok) return
    } catch {
      // The native process may still be opening SQLite.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out while starting the Branchloom Web data bridge')
}

let bridge
let vite

function stop(signal = 'SIGTERM') {
  if (vite && vite.exitCode === null) vite.kill(signal)
  if (bridge && bridge.exitCode === null) bridge.kill(signal)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(signal)
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

try {
  await run('cargo', ['build', '-p', 'branchloom-cli'], { cwd: workspaceDirectory })
  await run(process.execPath, [
    path.join(desktopDirectory, 'scripts', 'prepare-ai-tools.mjs'),
    '--binary',
    bridgeBinary,
  ], { cwd: workspaceDirectory })
  const port = await reservePort()
  const runtimeEnvironment = {
    ...process.env,
    BRANCHLOOM_WEB_BRIDGE_PORT: String(port),
    BRANCHLOOM_WEB_BRIDGE_TOKEN: token,
  }
  bridge = spawn(bridgeBinary, ['web-bridge', '--port', String(port)], {
    cwd: workspaceDirectory,
    env: runtimeEnvironment,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await waitForBridge(port, bridge)

  const viteArguments = ['exec', 'vite']
  if (mode === 'preview') viteArguments.push('preview')
  viteArguments.push(...process.argv.slice(3))
  vite = spawn('pnpm', viteArguments, {
    cwd: desktopDirectory,
    env: runtimeEnvironment,
    stdio: 'inherit',
  })
  const exitCode = await new Promise((resolve, reject) => {
    vite.once('error', reject)
    vite.once('exit', (code) => resolve(code ?? 1))
    bridge.once('exit', (code) => {
      if (vite.exitCode === null) reject(new Error(`Branchloom Web data bridge stopped (${code ?? 1})`))
    })
  })
  stop()
  process.exitCode = exitCode
} catch (error) {
  stop()
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
