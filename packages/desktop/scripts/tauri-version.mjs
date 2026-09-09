import { readWorkspaceVersion } from '../../../scripts/workspace-version.mjs'

export function withWorkspaceVersion(args, workspaceDirectory) {
  const commandIndex = args.findIndex((arg) => !arg.startsWith('-'))
  const [platform, command] = args.slice(commandIndex)
  if (platform !== 'android' || !['init', 'dev', 'build'].includes(command)) {
    return args
  }

  // Android does not inherit Cargo's version when Tauri's version is omitted.
  // Pass it before caller options so other --config overrides still work.
  const version = readWorkspaceVersion(workspaceDirectory, { locked: true })
  return [
    ...args.slice(0, commandIndex + 2),
    '--config', JSON.stringify({ version }),
    ...args.slice(commandIndex + 2),
  ]
}
