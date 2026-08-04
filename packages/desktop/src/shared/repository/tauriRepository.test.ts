import { describe, expect, it, vi } from 'vitest'
import type {
  NativeStateGateway,
  NativeStateSnapshot,
  NormalizedStatePayload,
} from './TauriRepository'
import {
  createTauriRepository,
  PROJECT_DATA_CHANGED_EVENT,
  refreshNativeRepository,
  requestNativeRepositoryRefresh,
} from './TauriRepository'
import { createDemoState } from '../fixtures/demoState'
import { RepositoryError } from './storage'

class MemoryGateway implements NativeStateGateway {
  snapshot: NativeStateSnapshot = { revision: 0, state: null }
  failNextSave = false
  createManualSnapshot?: NativeStateGateway['createManualSnapshot']
  listDuplicateCandidates?: NativeStateGateway['listDuplicateCandidates']
  applyMutation?: NativeStateGateway['applyMutation']

  async revision() {
    return this.snapshot.revision
  }

  async load() {
    return structuredClone(this.snapshot)
  }

  async save(state: NormalizedStatePayload, expectedRevision: number) {
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('disk full')
    }
    if (expectedRevision !== this.snapshot.revision) throw new Error('revision conflict')
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      state: structuredClone(state),
    }
    return this.snapshot.revision
  }
}

describe('TauriRepository', () => {
  it('seeds the native SQLite state and reloads committed edits', async () => {
    const gateway = new MemoryGateway()
    const first = await createTauriRepository(gateway)
    expect(gateway.snapshot.state).not.toBeNull()

    const created = await first.createProject({ name: '陈氏家谱', description: '本地档案' })
    const second = await createTauriRepository(gateway)

    await expect(second.getProject(created.id)).resolves.toMatchObject({
      name: '陈氏家谱',
      description: '本地档案',
    })
  })

  it('rolls back the in-memory mutation when the native write fails', async () => {
    const gateway = new MemoryGateway()
    const repository = await createTauriRepository(gateway)
    const before = await repository.listProjects()
    gateway.failNextSave = true

    await expect(repository.createProject({ name: '不应保留', description: '' }))
      .rejects.toEqual(expect.objectContaining<Partial<RepositoryError>>({
        code: 'storage',
        message: '本地数据库写入失败，本次修改已撤销',
      }))
    await expect(repository.listProjects()).resolves.toEqual(before)
  })

  it('notifies the UI only after a mutation is saved successfully', async () => {
    const gateway = new MemoryGateway()
    const repository = await createTauriRepository(gateway)
    const changed = vi.fn()
    window.addEventListener(PROJECT_DATA_CHANGED_EVENT, changed)

    try {
      await repository.createProject({ name: '成功保存', description: '' })
      expect(changed).toHaveBeenCalledOnce()

      gateway.failNextSave = true
      await expect(repository.createProject({ name: '保存失败', description: '' })).rejects.toThrow()
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener(PROJECT_DATA_CHANGED_EVENT, changed)
    }
  })

  it('does not write native state for read-only queries', async () => {
    const gateway = new MemoryGateway()
    const save = vi.spyOn(gateway, 'save')
    const repository = await createTauriRepository(gateway)
    save.mockClear()

    await repository.listProjects()
    repository.getHistoryState()

    expect(save).not.toHaveBeenCalled()
  })

  it('routes formal runtime mutations to the core without executing the prototype write path', async () => {
    const gateway = new MemoryGateway()
    const repository = await createTauriRepository(gateway)
    const save = vi.spyOn(gateway, 'save')
    save.mockClear()
    gateway.applyMutation = vi.fn(async (method, args, expectedRevision) => {
      expect(method).toBe('createProject')
      expect(args).toEqual([{ name: '核心项目', description: 'Rust 写入' }])
      expect(expectedRevision).toBe(gateway.snapshot.revision)
      const state = JSON.parse(gateway.snapshot.state!.stateJson) as ReturnType<typeof createDemoState>
      const project = {
        id: 'project-from-core',
        name: '核心项目',
        description: 'Rust 写入',
        createdAt: '2035-06-07T08:09:10Z',
        updatedAt: '2035-06-07T08:09:10Z',
        backupSchedule: 'weekly' as const,
      }
      state.projects.push(project)
      gateway.snapshot = {
        revision: expectedRevision + 1,
        state: {
          stateJson: JSON.stringify(state),
          snapshotPayloadsJson: gateway.snapshot.state!.snapshotPayloadsJson,
        },
      }
      return { result: project, revision: gateway.snapshot.revision }
    })

    await expect(repository.createProject({ name: '核心项目', description: 'Rust 写入' }))
      .resolves.toMatchObject({ id: 'project-from-core' })
    expect(gateway.applyMutation).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
  })

  it('delegates duplicate candidate analysis to the read-only core gateway', async () => {
    const gateway = new MemoryGateway()
    gateway.listDuplicateCandidates = vi.fn(async () => [{
      leftPersonId: 'person-a',
      rightPersonId: 'person-b',
      score: 44,
      reasons: ['本名相同：林晨'],
      conflicts: [],
    }])
    const repository = await createTauriRepository(gateway)
    const save = vi.spyOn(gateway, 'save')
    save.mockClear()

    await expect(repository.listDuplicateCandidates('project-demo-family')).resolves.toEqual([{
      leftPersonId: 'person-a',
      rightPersonId: 'person-b',
      score: 44,
      reasons: ['本名相同：林晨'],
      conflicts: [],
    }])
    expect(gateway.listDuplicateCandidates).toHaveBeenCalledWith('project-demo-family')
    expect(save).not.toHaveBeenCalled()
  })

  it('uses the core snapshot command and refreshes the repository afterward', async () => {
    const gateway = new MemoryGateway()
    const repository = await createTauriRepository(gateway)
    const save = vi.spyOn(gateway, 'save')
    save.mockClear()
    gateway.createManualSnapshot = vi.fn(async (projectId, note) => {
      const state = JSON.parse(gateway.snapshot.state!.stateJson) as ReturnType<typeof createDemoState>
      const snapshot = {
        id: 'snapshot-native',
        projectId,
        createdAt: '2035-06-07T08:09:10Z',
        reason: 'manual' as const,
        note: note.trim(),
        summary: { people: 12, relationships: 13, events: 8 },
      }
      state.snapshots.push(snapshot)
      const payloads = JSON.parse(gateway.snapshot.state!.snapshotPayloadsJson) as Record<string, unknown>
      payloads[snapshot.id] = structuredClone(state)
      gateway.snapshot = {
        revision: gateway.snapshot.revision + 1,
        state: {
          stateJson: JSON.stringify(state),
          snapshotPayloadsJson: JSON.stringify(payloads),
        },
      }
      return { snapshot, revision: gateway.snapshot.revision }
    })

    const created = await repository.createSnapshot('project-demo-family', 'manual', '  核心快照  ')

    expect(gateway.createManualSnapshot).toHaveBeenCalledWith('project-demo-family', '  核心快照  ')
    expect(save).not.toHaveBeenCalled()
    expect(created).toMatchObject({ id: 'snapshot-native', note: '核心快照' })
    await expect(repository.listSnapshots('project-demo-family')).resolves.toContainEqual(created)
  })

  it('never persists runtime avatar, cover, or preview URLs', async () => {
    const gateway = new MemoryGateway()
    const repository = await createTauriRepository(gateway)
    const person = await repository.getPerson('person-lin-hai')
    const project = await repository.getProject(person.projectId)
    const attachment = (await repository.listAttachments(person.projectId))[0]!

    await repository.savePerson({ ...person, avatarUrl: 'data:image/png;base64,avatar' })
    await repository.updateProject(project.id, { coverUrl: 'data:image/png;base64,cover' })
    await repository.saveAttachment({ ...attachment, previewUrl: 'data:image/png;base64,preview' })

    const state = JSON.parse(gateway.snapshot.state!.stateJson) as ReturnType<typeof createDemoState>
    expect(state.people.find(({ id }) => id === person.id)?.avatarUrl).toBeUndefined()
    expect(state.projects.find(({ id }) => id === project.id)?.coverUrl).toBeUndefined()
    expect(state.attachments.find(({ id }) => id === attachment.id)?.previewUrl).toBeUndefined()
  })

  it('rejects an unsupported native state without replacing or saving it', async () => {
    const gateway = new MemoryGateway()
    const state = createDemoState()
    state.projects.push({
      ...state.projects[0]!,
      id: 'project-zhao-song',
      name: '赵宋王朝',
      description: '必须保留的项目',
    })
    const legacy = state as unknown as {
      people: Array<{ names: Array<Record<string, unknown>> }>
    }
    const name = legacy.people[0]!.names[0]!
    delete name.primary
    name.id = 'legacy-name-id'
    const original = JSON.stringify(state)
    gateway.snapshot = {
      revision: 12,
      state: {
        stateJson: original,
        snapshotPayloadsJson: '{}',
      },
    }
    const save = vi.spyOn(gateway, 'save')

    await expect(createTauriRepository(gateway)).rejects.toMatchObject({
      code: 'corrupt',
      message: '本地资料格式不受当前版本支持；为了保护数据，应用已停止加载且不会写入',
    })
    expect(save).not.toHaveBeenCalled()
    expect(gateway.snapshot.state?.stateJson).toBe(original)
    expect(gateway.snapshot.state?.stateJson).toContain('赵宋王朝')
  })

  it('opens native state with known nullable project optionals without writing it back', async () => {
    const gateway = new MemoryGateway()
    const state = createDemoState() as unknown as {
      projects: Array<Record<string, unknown>>
    }
    for (const key of ['coverUrl', 'defaultPersonId', 'lastBackupAt', 'backupSchedule']) {
      state.projects[0]![key] = null
    }
    const original = JSON.stringify(state)
    gateway.snapshot = {
      revision: 12,
      state: {
        stateJson: original,
        snapshotPayloadsJson: JSON.stringify({ snapshot: state }),
      },
    }
    const save = vi.spyOn(gateway, 'save')

    const repository = await createTauriRepository(gateway)

    const project = await repository.getProject('project-demo-family')
    expect(project.id).toBe('project-demo-family')
    for (const key of ['coverUrl', 'defaultPersonId', 'lastBackupAt', 'backupSchedule']) {
      expect(project).not.toHaveProperty(key)
    }
    expect(save).not.toHaveBeenCalled()
    expect(gateway.snapshot.state?.stateJson).toBe(original)
  })

  it('loads the canonical CLI person shape without the retired sourceIds field', async () => {
    const gateway = new MemoryGateway()
    const state = createDemoState()
    const person = state.people[0]!
    delete person.sourceIds
    person.birth = { start: '0939', precision: 'exact' } as typeof person.birth
    state.snapshots = []
    gateway.snapshot = {
      revision: 12,
      state: {
        stateJson: JSON.stringify(state),
        snapshotPayloadsJson: '{}',
      },
    }
    const save = vi.spyOn(gateway, 'save')

    const repository = await createTauriRepository(gateway)

    await expect(repository.getPerson(person.id)).resolves.toMatchObject({
      id: person.id,
      names: person.names,
      birth: { display: '0939', start: '0939', precision: 'exact' },
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects an unsupported native snapshot sidecar without saving it', async () => {
    const gateway = new MemoryGateway()
    await createTauriRepository(gateway)
    gateway.snapshot.revision += 1
    gateway.snapshot.state!.snapshotPayloadsJson = JSON.stringify({
      legacy: { ...createDemoState(), schemaVersion: 1 },
    })
    const original = structuredClone(gateway.snapshot.state)
    const save = vi.spyOn(gateway, 'save')

    await expect(createTauriRepository(gateway)).rejects.toMatchObject({ code: 'corrupt' })
    expect(save).not.toHaveBeenCalled()
    expect(gateway.snapshot.state).toEqual(original)
  })

  it('refreshes from the latest revision before each mutation', async () => {
    const gateway = new MemoryGateway()
    const first = await createTauriRepository(gateway)
    const second = await createTauriRepository(gateway)

    const external = await first.createProject({ name: '外部新增', description: '' })
    const local = await second.createProject({ name: '本地新增', description: '' })

    const reloaded = await createTauriRepository(gateway)
    await expect(reloaded.getProject(external.id)).resolves.toMatchObject({ name: '外部新增' })
    await expect(reloaded.getProject(local.id)).resolves.toMatchObject({ name: '本地新增' })
  })

  it('refreshes its delegate after native synchronization changes SQLite state', async () => {
    const gateway = new MemoryGateway()
    const visible = await createTauriRepository(gateway)
    const external = await createTauriRepository(gateway)
    const created = await external.createProject({ name: '远端同步项目', description: '' })

    await expect(visible.getProject(created.id)).rejects.toThrow('Project')
    await expect(refreshNativeRepository(visible)).resolves.toBe(true)
    await expect(visible.getProject(created.id)).resolves.toMatchObject({
      name: '远端同步项目',
    })
  })

  it('manually reloads native data and notifies the UI even when the revision is unchanged', async () => {
    const gateway = new MemoryGateway()
    const repository = await createTauriRepository(gateway)
    const state = JSON.parse(gateway.snapshot.state!.stateJson) as ReturnType<typeof createDemoState>
    state.projects.push({
      ...state.projects[0]!,
      id: 'project-cli-write',
      name: 'CLI 新增项目',
    })
    gateway.snapshot.state!.stateJson = JSON.stringify(state)
    const refreshed = vi.fn()
    window.addEventListener('branchloom:native-state-refreshed', refreshed)

    try {
      await requestNativeRepositoryRefresh(repository)

      await expect(repository.getProject('project-cli-write')).resolves.toMatchObject({
        name: 'CLI 新增项目',
      })
      expect(refreshed).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('branchloom:native-state-refreshed', refreshed)
    }
  })
})
