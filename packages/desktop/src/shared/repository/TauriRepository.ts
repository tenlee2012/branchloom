import { isTauri } from '@tauri-apps/api/core'
import type { BranchloomRepository, DuplicateCandidate, Snapshot } from '../domain/types'
import { BrowserPrototypeRepository } from './BrowserPrototypeRepository'
import {
  PROTOTYPE_STORAGE_KEY,
  RepositoryError,
  SNAPSHOT_PAYLOADS_STORAGE_KEY,
  parseSnapshotPayloads,
  type PrototypeStorage,
} from './storage'

export interface NormalizedStatePayload {
  stateJson: string
  snapshotPayloadsJson: string
}

export interface NativeStateSnapshot {
  revision: number
  state: NormalizedStatePayload | null
}

export interface NativeStateGateway {
  revision(): Promise<number>
  load(): Promise<NativeStateSnapshot>
  save(state: NormalizedStatePayload, expectedRevision: number): Promise<number>
  createManualSnapshot?(projectId: string, note: string): Promise<NativeManualSnapshotResult>
  listDuplicateCandidates?(projectId: string): Promise<DuplicateCandidate[]>
  applyMutation?(
    method: string,
    args: unknown[],
    expectedRevision: number,
  ): Promise<NativeMutationResult>
}

export interface NativeMutationResult {
  result: unknown
  revision: number
}

export interface NativeManualSnapshotResult {
  snapshot: Snapshot
  revision: number
}

export const NATIVE_STATE_REFRESHED_EVENT = 'branchloom:native-state-refreshed'
export const PROJECT_DATA_CHANGED_EVENT = 'branchloom:project-data-changed'
const refreshNativeStateSymbol = Symbol('refreshNativeState')

function notifyProjectDataChanged() {
  window.dispatchEvent(new Event(PROJECT_DATA_CHANGED_EVENT))
}

type RefreshableRepository = BranchloomRepository & {
  [refreshNativeStateSymbol]?: (force?: boolean) => Promise<boolean>
}

export async function refreshNativeRepository(
  repository: BranchloomRepository,
  force = false,
): Promise<boolean> {
  const refresh = (repository as RefreshableRepository)[refreshNativeStateSymbol]
  if (!refresh) return false
  return refresh(force)
}

export function usesManagedLocalStorage(repository: BranchloomRepository): boolean {
  return Boolean((repository as RefreshableRepository)[refreshNativeStateSymbol])
}

export function supportsProjectArchives(): boolean {
  return isTauri()
}

export async function exportProjectArchive(projectId: string, path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('export_project_archive', {
    input: { projectId, path, overwrite: false },
  })
}

export async function importProjectArchive(path: string, overwrite = false): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  const result = await invoke<{ projectId: string }>('import_project_archive', {
    input: { projectId: '', path, overwrite },
  })
  return result.projectId
}

export async function requestNativeRepositoryRefresh(
  repository: BranchloomRepository,
): Promise<void> {
  await refreshNativeRepository(repository, true)
  window.dispatchEvent(new Event(NATIVE_STATE_REFRESHED_EVENT))
}

export function startNativeRepositoryRefresh(
  repository: BranchloomRepository,
  intervalMilliseconds = 1_000,
): () => void {
  let refreshing = false
  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
      if (await refreshNativeRepository(repository)) {
        window.dispatchEvent(new Event(NATIVE_STATE_REFRESHED_EVENT))
      }
    } catch {
      // Polling is best effort; foreground reads and writes surface actionable storage errors.
    } finally {
      refreshing = false
    }
  }
  const onFocus = () => { void refresh() }
  const timer = window.setInterval(() => { void refresh() }, intervalMilliseconds)
  window.addEventListener('focus', onFocus)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('focus', onFocus)
  }
}

class MemoryStorage implements PrototypeStorage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  seed(state: NormalizedStatePayload) {
    this.values.set(PROTOTYPE_STORAGE_KEY, state.stateJson)
    this.values.set(SNAPSHOT_PAYLOADS_STORAGE_KEY, state.snapshotPayloadsJson)
  }

  snapshot() {
    return new Map(this.values)
  }

  restore(snapshot: ReadonlyMap<string, string>) {
    this.values = new Map(snapshot)
  }
}

const mutatingMethods = new Set<keyof BranchloomRepository>([
  'createProject',
  'updateProject',
  'deleteProject',
  'savePerson',
  'softDeletePerson',
  'saveOrganization',
  'deleteOrganization',
  'saveCareer',
  'saveOrganizationWithCareer',
  'deleteCareer',
  'savePersonTitle',
  'deletePersonTitle',
  'saveRelationship',
  'deleteRelationship',
  'savePersonWithRelationship',
  'saveEvent',
  'deleteEvent',
  'savePlace',
  'deletePlace',
  'saveSource',
  'deleteSource',
  'saveCitation',
  'saveCitationWithAttachmentLinks',
  'deleteCitation',
  'saveAttachment',
  'locateAttachment',
  'deleteAttachment',
  'saveAttachmentLink',
  'createSnapshot',
  'mergePeople',
  'cleanupProject',
  'restoreSnapshot',
  'resetDemo',
  'undo',
  'redo',
])

type RuntimeMediaState = {
  projects?: Array<Record<string, unknown>>
  people?: Array<Record<string, unknown>>
  attachments?: Array<Record<string, unknown>>
}

function stripRuntimeMedia(state: RuntimeMediaState) {
  state.projects?.forEach((project) => { delete project.coverUrl })
  state.people?.forEach((person) => { delete person.avatarUrl })
  state.attachments?.forEach((attachment) => { delete attachment.previewUrl })
}

function normalizedStatePayload(storage: PrototypeStorage): NormalizedStatePayload {
  const stateJson = storage.getItem(PROTOTYPE_STORAGE_KEY)
  const snapshotPayloadsJson = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
  if (stateJson === null || snapshotPayloadsJson === null) {
    throw new RepositoryError('storage', '本地数据库状态不完整，无法安全保存')
  }
  const state = JSON.parse(stateJson) as RuntimeMediaState
  stripRuntimeMedia(state)
  const snapshotPayloads = JSON.parse(snapshotPayloadsJson) as Record<string, RuntimeMediaState>
  Object.values(snapshotPayloads).forEach(stripRuntimeMedia)
  return {
    stateJson: JSON.stringify(state),
    snapshotPayloadsJson: JSON.stringify(snapshotPayloads),
  }
}

function bytesDataUrl(bytes: number[], mimeType: string): string {
  let binary = ''
  const chunkSize = 16_384
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }
  return `data:${mimeType};base64,${window.btoa(binary)}`
}

async function hydrateRuntimeMedia(
  payload: NormalizedStatePayload,
  readAttachment: (projectId: string, contentHash: string) => Promise<number[]>,
): Promise<NormalizedStatePayload> {
  const state = JSON.parse(payload.stateJson) as {
    projects: Array<Record<string, unknown>>
    people: Array<Record<string, unknown>>
    attachments: Array<Record<string, unknown>>
    attachmentLinks: Array<Record<string, unknown>>
  }
  const attachments = new Map(state.attachments.map((attachment) => [attachment.id, attachment]))
  for (const link of state.attachmentLinks) {
    if (link.role !== 'avatar' && link.role !== 'cover' && link.role !== 'media') continue
    const attachment = attachments.get(link.attachmentId)
    if (!attachment || typeof attachment.contentHash !== 'string' || typeof attachment.projectId !== 'string') continue
    try {
      const bytes = await readAttachment(attachment.projectId, attachment.contentHash)
      const url = bytesDataUrl(bytes, typeof attachment.mimeType === 'string' ? attachment.mimeType : 'application/octet-stream')
      if (link.role === 'media') {
        attachment.previewUrl = url
      } else if (link.role === 'avatar') {
        const person = state.people.find(({ id }) => id === link.targetId)
        if (person) person.avatarUrl = url
      } else {
        const project = state.projects.find(({ id }) => id === link.targetId)
        if (project) project.coverUrl = url
      }
    } catch {
      attachment.missing = true
    }
  }
  return { ...payload, stateJson: JSON.stringify(state) }
}

export async function setLocalAttachment(
  projectId: string,
  targetType: 'project' | 'person',
  targetId: string,
  role: 'cover' | 'avatar',
  file: File,
): Promise<void> {
  await nativeDataRequest('set_local_attachment', '/attachment/set-local', {
    projectId,
    targetType,
    targetId,
    role,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
  })
}

export interface ImportedLocalAttachment {
  name: string
  mimeType: string
  size: number
  contentHash: string
  alreadyStored: boolean
}

export async function importLocalAttachment(
  projectId: string,
  file: File,
  expectedHash?: string,
): Promise<ImportedLocalAttachment> {
  return nativeDataRequest('import_attachment', '/attachment/import', {
    projectId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    expectedHash,
  })
}

export async function localAttachmentExists(
  projectId: string,
  contentHash: string,
): Promise<boolean> {
  return nativeDataRequest('attachment_exists', '/attachment/exists', { projectId, contentHash })
}

async function readLocalAttachment(projectId: string, contentHash: string): Promise<number[]> {
  return nativeDataRequest('read_attachment', '/attachment/read', { projectId, contentHash })
}

async function nativeDataRequest<T>(
  command: string,
  webPath: string,
  input: Record<string, unknown>,
): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(command, { input })
  }
  return webBridgeRequest<T>(webPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

async function webBridgeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/__branchloom${path}`, {
      cache: 'no-store',
      ...init,
    })
  } catch (error) {
    throw new RepositoryError(
      'storage',
      '无法连接本地数据服务，请通过 Branchloom 的 Web 启动命令打开页面',
      { cause: error },
    )
  }
  const body = await response.json().catch(() => null) as { error?: string } | T | null
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && body.error
      ? body.error
      : `本地数据服务请求失败（${response.status}）`
    throw new RepositoryError('storage', message)
  }
  return body as T
}

export async function createTauriRepository(
  gateway: NativeStateGateway,
): Promise<BranchloomRepository> {
  const storage = new MemoryStorage()
  const loaded = await gateway.load()
  let revision = loaded.revision
  if (loaded.state) storage.seed(loaded.state)

  const createDelegate = () => {
    try {
      const snapshotPayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
      if (snapshotPayloads !== null) parseSnapshotPayloads(snapshotPayloads)
      return new BrowserPrototypeRepository({ storage, invalidStatePolicy: 'throw' })
    } catch (error) {
      throw new RepositoryError(
        'corrupt',
        '本地资料格式不受当前版本支持；为了保护数据，应用已停止加载且不会写入',
        { cause: error },
      )
    }
  }

  let delegate = createDelegate()
  if (!loaded.state) {
    revision = await gateway.save(normalizedStatePayload(storage), revision)
  }

  function installSnapshot(snapshot: NativeStateSnapshot, force = false): boolean {
    if (!force && snapshot.revision === revision) return false
    if (!snapshot.state) {
      throw new RepositoryError('storage', '本地数据库中没有可刷新的项目状态')
    }
    storage.seed(snapshot.state)
    delegate = createDelegate()
    revision = snapshot.revision
    return true
  }

  return new Proxy({} as BranchloomRepository, {
    get(_target, property) {
      if (property === refreshNativeStateSymbol) {
        return async (force = false) => {
          if (!force && await gateway.revision() === revision) return false
          const current = await gateway.load()
          return installSnapshot(current, force)
        }
      }
      if (property === 'listDuplicateCandidates' && gateway.listDuplicateCandidates) {
        return gateway.listDuplicateCandidates.bind(gateway)
      }
      const member = Reflect.get(delegate, property)
      if (typeof member !== 'function') return member
      if (!mutatingMethods.has(property as keyof BranchloomRepository)) {
        return member.bind(delegate)
      }
      return async (...args: unknown[]) => {
        if (property === 'createSnapshot' && gateway.createManualSnapshot) {
          const [projectId, reason, note] = args as [string, Snapshot['reason'], string]
          if (reason === 'manual') {
            const result = await gateway.createManualSnapshot(projectId, note)
            installSnapshot(await gateway.load(), true)
            notifyProjectDataChanged()
            return result.snapshot
          }
        }
        if (gateway.applyMutation) {
          installSnapshot(await gateway.load())
          const outcome = await gateway.applyMutation(String(property), args, revision)
          revision = outcome.revision
          installSnapshot(await gateway.load(), true)
          notifyProjectDataChanged()
          return outcome.result
        }
        installSnapshot(await gateway.load())
        const before = storage.snapshot()
        const currentMember = Reflect.get(delegate, property)
        const result = await currentMember.apply(delegate, args)
        try {
          revision = await gateway.save(normalizedStatePayload(storage), revision)
        } catch (error) {
          storage.restore(before)
          delegate = createDelegate()
          throw new RepositoryError(
            'storage',
            '本地数据库写入失败，本次修改已撤销',
            { cause: error },
          )
        }
        notifyProjectDataChanged()
        return result
      }
    },
  })
}

export const tauriStateGateway: NativeStateGateway = {
  async revision() {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<number>('data_revision')
  },
  async load() {
    const { invoke } = await import('@tauri-apps/api/core')
    const snapshot = await invoke<NativeStateSnapshot>('load_normalized_state')
    if (snapshot.state) snapshot.state = await hydrateRuntimeMedia(snapshot.state, readLocalAttachment)
    return snapshot
  },
  async save(state, expectedRevision) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<number>('synchronize_normalized_state', {
      input: { ...state, expectedRevision },
    })
  },
  async createManualSnapshot(projectId, note) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<NativeManualSnapshotResult>('create_manual_snapshot', {
      input: { projectId, note },
    })
  },
  async listDuplicateCandidates(projectId) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<DuplicateCandidate[]>('list_duplicate_candidates', {
      input: { projectId },
    })
  },
  async applyMutation(method, args, expectedRevision) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<NativeMutationResult>('apply_desktop_mutation', {
      input: { method, args, expectedRevision },
    })
  },
}

export const webStateGateway: NativeStateGateway = {
  revision: () => webBridgeRequest<number>('/revision'),
  async load() {
    const snapshot = await webBridgeRequest<NativeStateSnapshot>('/state')
    if (snapshot.state) snapshot.state = await hydrateRuntimeMedia(snapshot.state, readLocalAttachment)
    return snapshot
  },
  save: (state, expectedRevision) => webBridgeRequest<number>('/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state, expectedRevision }),
  }),
  createManualSnapshot: (projectId, note) => webBridgeRequest<NativeManualSnapshotResult>(
    '/snapshot/create',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, note }),
    },
  ),
  listDuplicateCandidates: (projectId) => webBridgeRequest<DuplicateCandidate[]>(
    '/duplicates/list',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
  ),
  applyMutation: (method, args, expectedRevision) => webBridgeRequest<NativeMutationResult>(
    '/mutation/apply',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args, expectedRevision }),
    },
  ),
}
