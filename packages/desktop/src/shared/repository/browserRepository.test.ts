import { createApp, inject } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoState } from '../fixtures/demoState'
import { BrowserPrototypeRepository } from './BrowserPrototypeRepository'
import {
  PROTOTYPE_STORAGE_KEY,
  RECOVERY_STORAGE_PREFIX,
  RepositoryError,
  SNAPSHOT_PAYLOADS_STORAGE_KEY,
  SNAPSHOT_PAYLOADS_RECOVERY_STORAGE_PREFIX,
  TRANSACTION_RECOVERY_STORAGE_PREFIX,
  TRANSACTION_STORAGE_KEY,
  parsePrototypeState,
  parseSnapshotPayloads,
  type PrototypeStorage,
} from './storage'
import {
  branchloomRepositoryKey,
  provideBranchloomRepository,
} from './injection'

class MemoryStorage implements PrototypeStorage {
  private readonly values = new Map<string, string>()
  failSetWhen?: (key: string) => unknown
  failRemoveWhen?: (key: string) => unknown

  get length(): number { return this.values.size }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void {
    const failure = this.failRemoveWhen?.(key)
    if (failure) throw failure
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    const failure = this.failSetWhen?.(key)
    if (failure) throw failure
    this.values.set(String(key), String(value))
  }
}

const options = (storage: PrototypeStorage) => ({
  storage,
  clock: () => new Date('2031-02-03T04:05:06.000Z'),
  idFactory: () => 'fixed-id',
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('BrowserPrototypeRepository browser persistence', () => {
  it('keeps ten-thousand-person list results paged and family queries bounded', async () => {
    const storage = new MemoryStorage()
    new BrowserPrototypeRepository(options(storage))
    const state = createDemoState()
    const template = state.people[0]!
    state.people = Array.from({ length: 10_000 }, (_, index) => {
      const suffix = String(index).padStart(5, '0')
      const personId = `person-scale-${suffix}`
      return {
        ...template,
        id: personId,
        names: [
          { value: `批量人物${suffix}`, type: 'personal' as const, primary: true },
          { value: `规模别名${suffix}`, type: 'alias' as const, primary: false },
        ],
        sourceIds: [],
        updatedAt: `2031-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }
    })
    state.relationships = []
    state.events = []
    state.citations = []
    state.attachmentLinks = []
    state.snapshots = []
    state.issues = []
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state))
    storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, '{}')

    const repository = new BrowserPrototypeRepository(options(storage))
    const page = await repository.listPeople('project-demo-family', {
      page: 100,
      pageSize: 50,
      sort: 'name',
    })
    expect(page).toMatchObject({ total: 10_000, page: 100, pageSize: 50 })
    expect(page.items).toHaveLength(50)

    const aliasResult = await repository.listPeople('project-demo-family', {
      page: 1,
      pageSize: 20,
      search: '  规模别名09999  ',
      sort: 'name',
    })
    expect(aliasResult.items.map(({ id }) => id)).toEqual(['person-scale-09999'])

    const family = await repository.getTreeFamilySlice(
      'project-demo-family',
      'person-scale-05000',
      { generationsUp: 8, generationsDown: 8 },
    )
    expect(family.people.map(({ id }) => id)).toEqual(['person-scale-05000'])
    expect(family.limits.returnedNodes).toBe(1)
  })

  it('initializes the current version-two state and fixed snapshot sidecar', () => {
    const storage = new MemoryStorage()
    new BrowserPrototypeRepository(options(storage))

    expect(JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY)!)).toEqual(createDemoState())
    const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    expect(Object.keys(payloads).sort()).toEqual(['snapshot-import', 'snapshot-manual', 'snapshot-merge'])
    expect([
      payloads['snapshot-import'],
      payloads['snapshot-merge'],
      payloads['snapshot-manual'],
    ].map((payload) => [
      payload.people.length,
      payload.relationships.length,
      payload.events.length,
    ])).toEqual([
      [10, 10, 6],
      [11, 12, 7],
      [12, 13, 8],
    ])
    expect(payloads['snapshot-import']).not.toEqual(payloads['snapshot-manual'])
    expect(storage.length).toBe(2)
    expect(new Set([storage.key(0), storage.key(1)])).toEqual(new Set([
      PROTOTYPE_STORAGE_KEY,
      SNAPSHOT_PAYLOADS_STORAGE_KEY,
    ]))
    expect(storage.key(2)).toBeNull()
  })

  it('rejects legacy name ids instead of upgrading them', () => {
    const legacy = createDemoState() as unknown as {
      people: Array<{ names: Array<Record<string, unknown>> }>
    }
    const name = legacy.people[0]!.names[0]!
    delete name.primary
    name.id = 'legacy-name-id'

    expect(() => parsePrototypeState(JSON.stringify(legacy)))
      .toThrow('本地资料格式不受支持或内容无效')
  })

  it('normalizes known nullable project optionals in main and snapshot state', () => {
    const state = createDemoState() as unknown as {
      projects: Array<Record<string, unknown>>
    }
    for (const key of ['coverUrl', 'defaultPersonId', 'lastBackupAt', 'backupSchedule']) {
      state.projects[0]![key] = null
    }

    const main = parsePrototypeState(JSON.stringify(state))
    const snapshots = parseSnapshotPayloads(JSON.stringify({ snapshot: state }))

    for (const project of [main.projects[0]!, snapshots.snapshot!.projects[0]!]) {
      expect(project.coverUrl).toBeUndefined()
      expect(project.defaultPersonId).toBeUndefined()
      expect(project.lastBackupAt).toBeUndefined()
      expect(project.backupSchedule).toBeUndefined()
    }
  })

  it.each([
    ['invalid JSON', '{not-json'],
    ['wrong schema', JSON.stringify({ ...createDemoState(), schemaVersion: 3 })],
    ['malformed nested entity', JSON.stringify({
      ...createDemoState(),
      people: [{ ...createDemoState().people[0], names: [{ type: 'personal', primary: true }] }],
    })],
  ])('preserves %s raw data under a safe recovery key and restores demo', (_name, raw) => {
    const storage = new MemoryStorage()
    storage.setItem(PROTOTYPE_STORAGE_KEY, raw)

    expect(() => new BrowserPrototypeRepository(options(storage))).not.toThrow()
    expect(JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY)!)).toEqual(createDemoState())
    const recoveryKey = [...Array(storage.length).keys()]
      .map((index) => storage.key(index))
      .find((key) => key?.startsWith(RECOVERY_STORAGE_PREFIX))
    expect(recoveryKey).toBe(`${RECOVERY_STORAGE_PREFIX}2031-02-03T04-05-06.000Z`)
    expect(storage.getItem(recoveryKey!)).toBe(raw)
  })

  it('does not crash when recovery preservation fails but exposes a failed main restore write', () => {
    const recoveryFailureStorage = new MemoryStorage()
    recoveryFailureStorage.setItem(PROTOTYPE_STORAGE_KEY, 'broken')
    recoveryFailureStorage.failSetWhen = (key) => key.startsWith(RECOVERY_STORAGE_PREFIX) ? new Error('quota') : undefined
    expect(() => new BrowserPrototypeRepository(options(recoveryFailureStorage))).not.toThrow()

    const allFailureStorage = new MemoryStorage()
    allFailureStorage.setItem(PROTOTYPE_STORAGE_KEY, 'broken')
    allFailureStorage.failSetWhen = () => new Error('disk unavailable')
    expect(() => new BrowserPrototypeRepository(options(allFailureStorage))).toThrowError(RepositoryError)
    try {
      new BrowserPrototypeRepository(options(allFailureStorage))
    } catch (error) {
      expect((error as RepositoryError).code).toBe('storage')
      expect((error as RepositoryError).cause).toBeInstanceOf(Error)
    }
  })

  it('keeps memory state unchanged when storage throws during a write', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    storage.failSetWhen = (key) => key === PROTOTYPE_STORAGE_KEY ? new Error('quota exceeded') : undefined

    await expect(repository.updateProject('project-demo-family', { name: 'must not stick' }))
      .rejects.toMatchObject({ code: 'storage' })
    expect((await repository.getProject('project-demo-family')).name).toBe('林家四代家庭档案')
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('supports one-shot failure injection without mutating state', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    const injected = new Error('prototype failure')
    repository.failNextWrite(injected)

    await expect(repository.updateProject('project-demo-family', { name: 'failed' }))
      .rejects.toMatchObject({ code: 'storage', cause: injected })
    expect((await repository.getProject('project-demo-family')).name).toBe('林家四代家庭档案')
    await expect(repository.updateProject('project-demo-family', { name: 'works next' })).resolves.toMatchObject({ name: 'works next' })
  })

  it('does not mutate history stacks when undo or redo persistence fails', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    await repository.updateProject('project-demo-family', { name: 'changed' })
    repository.failNextWrite(new Error('undo failed'))
    await expect(repository.undo()).rejects.toMatchObject({ code: 'storage' })
    expect(repository.getHistoryState()).toEqual({ canUndo: true, canRedo: false })
    expect((await repository.getProject('project-demo-family')).name).toBe('changed')

    await repository.undo()
    repository.failNextWrite(new Error('redo failed'))
    await expect(repository.redo()).rejects.toMatchObject({ code: 'storage' })
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: true })
  })

  it('keeps state unchanged when snapshot sidecar persistence fails', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    const before = await repository.listSnapshots('project-demo-family')
    storage.failSetWhen = (key) => key === SNAPSHOT_PAYLOADS_STORAGE_KEY ? new Error('sidecar quota') : undefined

    await expect(repository.createSnapshot('project-demo-family', 'manual', 'fail'))
      .rejects.toMatchObject({ code: 'storage' })
    expect(await repository.listSnapshots('project-demo-family')).toEqual(before)
    expect(JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY)!).snapshots).toEqual(before)
  })

  it('rolls back the snapshot sidecar when the following main-state write fails', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    storage.failSetWhen = (key) => key === PROTOTYPE_STORAGE_KEY ? new Error('main quota') : undefined

    await expect(repository.createSnapshot('project-demo-family', 'manual', 'must roll back'))
      .rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect(await repository.listSnapshots('project-demo-family')).toEqual(createDemoState().snapshots)
  })

  it('recovers deterministically from the pre-state when main write and rollback both fail', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    let mainFailed = false
    storage.failSetWhen = (key) => {
      if (key === PROTOTYPE_STORAGE_KEY && !mainFailed) {
        mainFailed = true
        return new Error('main write failed')
      }
      if (key === SNAPSHOT_PAYLOADS_STORAGE_KEY && mainFailed) return new Error('rollback failed')
      return undefined
    }

    await expect(repository.createSnapshot('project-demo-family', 'manual', '事务故障'))
      .rejects.toMatchObject({ code: 'storage' })
    expect(await repository.listSnapshots('project-demo-family')).toEqual(createDemoState().snapshots)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).not.toBe(beforePayloads)

    storage.failSetWhen = undefined
    const reopened = new BrowserPrototypeRepository(options(storage))
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect(await reopened.listSnapshots('project-demo-family')).toEqual(createDemoState().snapshots)
    const evidenceKey = [...Array(storage.length).keys()]
      .map((index) => storage.key(index))
      .find((key) => key?.startsWith(TRANSACTION_RECOVERY_STORAGE_PREFIX))
    expect(evidenceKey).toBeTruthy()
  })

  it('supersedes a committed journal whose marker removal failed before a later ordinary update', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    storage.failRemoveWhen = (key) => key === 'branchloom.prototype.v1.transaction' ? new Error('remove blocked') : undefined
    await repository.createSnapshot('project-demo-family', 'manual', '已提交但 marker 残留')
    expect(storage.getItem('branchloom.prototype.v1.transaction')).toContain('committed')

    storage.failRemoveWhen = undefined
    await repository.updateProject('project-demo-family', { name: 'journal 之后的新修改' })
    const reopened = new BrowserPrototypeRepository(options(storage))
    expect((await reopened.getProject('project-demo-family')).name).toBe('journal 之后的新修改')
    expect((await reopened.listSnapshots('project-demo-family')).some(({ note }) => note === '已提交但 marker 残留')).toBe(true)
  })

  it('supersedes a prepared residual journal before a later successful ordinary update', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    let mainFailed = false
    storage.failSetWhen = (key) => {
      if (key === PROTOTYPE_STORAGE_KEY && !mainFailed) { mainFailed = true; return new Error('main failed') }
      if (key === SNAPSHOT_PAYLOADS_STORAGE_KEY && mainFailed) return new Error('rollback failed')
      return undefined
    }
    await expect(repository.createSnapshot('project-demo-family', 'manual', '不应提交'))
      .rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem('branchloom.prototype.v1.transaction')).toContain('prepared')

    storage.failSetWhen = undefined
    await repository.updateProject('project-demo-family', { name: 'prepared 之后的新修改' })
    const reopened = new BrowserPrototypeRepository(options(storage))
    expect((await reopened.getProject('project-demo-family')).name).toBe('prepared 之后的新修改')
    expect((await reopened.listSnapshots('project-demo-family')).some(({ note }) => note === '不应提交')).toBe(false)
  })

  it('uses the in-memory logical pair as the pre-state when a transaction follows a dirty prepared journal', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    let firstMainFailed = false
    storage.failSetWhen = (key) => {
      if (key === PROTOTYPE_STORAGE_KEY && !firstMainFailed) {
        firstMainFailed = true
        return new Error('first main failed')
      }
      if (key === SNAPSHOT_PAYLOADS_STORAGE_KEY && firstMainFailed) return new Error('first rollback failed')
      return undefined
    }
    await expect(repository.createSnapshot('project-demo-family', 'manual', '绝不能复活的快照'))
      .rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem(TRANSACTION_STORAGE_KEY)).toContain('prepared')

    let secondMainFailed = false
    storage.failSetWhen = (key) => {
      if (key === PROTOTYPE_STORAGE_KEY && !secondMainFailed) {
        secondMainFailed = true
        return new Error('second main failed')
      }
      if (key === SNAPSHOT_PAYLOADS_STORAGE_KEY && secondMainFailed) return new Error('second rollback failed')
      return undefined
    }
    await expect(repository.updateProject('project-demo-family', { name: '第二笔也失败' }))
      .rejects.toMatchObject({ code: 'storage' })

    storage.failSetWhen = undefined
    const reopened = new BrowserPrototypeRepository(options(storage))
    expect((await reopened.getProject('project-demo-family')).name).toBe('林家四代家庭档案')
    expect((await reopened.listSnapshots('project-demo-family')).some(({ note }) => note === '绝不能复活的快照')).toBe(false)
    expect(Object.keys(JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)).sort())
      .toEqual(['snapshot-import', 'snapshot-manual', 'snapshot-merge'])
  })

  it('keeps a committed residual transaction as the logical pre-state when the next transaction fails', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    storage.failRemoveWhen = (key) => key === TRANSACTION_STORAGE_KEY ? new Error('marker retained') : undefined
    await repository.createSnapshot('project-demo-family', 'manual', '已提交快照')
    expect(storage.getItem(TRANSACTION_STORAGE_KEY)).toContain('committed')

    let mainFailed = false
    storage.failRemoveWhen = undefined
    storage.failSetWhen = (key) => {
      if (key === PROTOTYPE_STORAGE_KEY && !mainFailed) {
        mainFailed = true
        return new Error('next main failed')
      }
      if (key === SNAPSHOT_PAYLOADS_STORAGE_KEY && mainFailed) return new Error('next rollback failed')
      return undefined
    }
    await expect(repository.updateProject('project-demo-family', { name: '未提交名称' }))
      .rejects.toMatchObject({ code: 'storage' })

    storage.failSetWhen = undefined
    const reopened = new BrowserPrototypeRepository(options(storage))
    expect((await reopened.getProject('project-demo-family')).name).toBe('林家四代家庭档案')
    expect((await reopened.listSnapshots('project-demo-family')).some(({ note }) => note === '已提交快照')).toBe(true)
    expect(JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)['fixed-id']).toBeDefined()
  })

  it('keeps state and history unchanged when snapshot restore persistence fails', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    await repository.updateProject('project-demo-family', { name: 'current state' })
    repository.failNextWrite(new Error('restore failed'))

    await expect(repository.restoreSnapshot('snapshot-import')).rejects.toMatchObject({ code: 'storage' })
    expect((await repository.getProject('project-demo-family')).name).toBe('current state')
    expect(repository.getHistoryState()).toEqual({ canUndo: true, canRedo: false })
  })

  it('keeps state unchanged when reset persistence fails and resets exact state and sidecar on success', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    await repository.createProject({ name: 'extra', description: '' })
    repository.failNextWrite(new Error('reset failed'))

    await expect(repository.resetDemo()).rejects.toMatchObject({ code: 'storage' })
    expect(await repository.listProjects()).toHaveLength(2)

    await repository.resetDemo()
    expect(JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY)!)).toEqual(createDemoState())
    const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    expect(Object.keys(payloads).sort()).toEqual(['snapshot-import', 'snapshot-manual', 'snapshot-merge'])
    expect([
      payloads['snapshot-import'],
      payloads['snapshot-merge'],
      payloads['snapshot-manual'],
    ].map((payload) => [payload.people.length, payload.relationships.length, payload.events.length]))
      .toEqual([[10, 10, 6], [11, 12, 7], [12, 13, 8]])
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('rolls back the reset sidecar when the following main-state write fails', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    await repository.createSnapshot('project-demo-family', 'manual', 'extra snapshot')
    const beforeState = storage.getItem(PROTOTYPE_STORAGE_KEY)
    const beforePayloads = storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)
    storage.failSetWhen = (key) => key === PROTOTYPE_STORAGE_KEY ? new Error('main quota') : undefined

    await expect(repository.resetDemo()).rejects.toMatchObject({ code: 'storage' })
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(beforeState)
    expect(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)).toBe(beforePayloads)
    expect(await repository.listSnapshots('project-demo-family')).toHaveLength(4)
  })

  it('does not add snapshot metadata writes to ordinary undo history', async () => {
    const repository = new BrowserPrototypeRepository(options(new MemoryStorage()))

    await repository.createSnapshot('project-demo-family', 'manual', 'metadata only')
    expect(repository.getHistoryState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('keeps current snapshot metadata across undo, redo and restore', async () => {
    const repository = new BrowserPrototypeRepository(options(new MemoryStorage()))
    await repository.updateProject('project-demo-family', { name: 'ordinary change' })
    const snapshot = await repository.createSnapshot('project-demo-family', 'manual', 'survives history')
    const expectedIds = [...createDemoState().snapshots.map(({ id }) => id), snapshot.id]

    await repository.undo()
    expect((await repository.listSnapshots('project-demo-family')).map(({ id }) => id)).toEqual(expectedIds)
    await repository.redo()
    expect((await repository.listSnapshots('project-demo-family')).map(({ id }) => id)).toEqual(expectedIds)

    const later = await repository.createSnapshot('project-demo-family', 'manual', 'also survives restore')
    const restore = await repository.restoreSnapshot('snapshot-import')
    expect((await repository.listSnapshots('project-demo-family')).map(({ id }) => id))
      .toEqual([...expectedIds, later.id, restore.safetySnapshot.id])
  })

  it('rebuilds a valid sidecar when it omits any snapshot in the main state', () => {
    const storage = new MemoryStorage()
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(createDemoState()))
    storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, JSON.stringify({
      'snapshot-import': createDemoState(),
    }))

    new BrowserPrototypeRepository(options(storage))

    expect(Object.keys(JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)).sort())
      .toEqual(['snapshot-import', 'snapshot-manual', 'snapshot-merge'])
  })

  it('backs up a damaged sidecar and preserves each valid historical payload while repairing entries', () => {
    const storage = new MemoryStorage()
    new BrowserPrototypeRepository(options(storage))
    const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    payloads['snapshot-import'].projects[0].name = '保留的有效历史状态'
    payloads['snapshot-merge'].people[0].names = [{ type: 'personal', primary: true }]
    delete payloads['snapshot-manual']
    const damagedRaw = JSON.stringify(payloads)
    storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, damagedRaw)

    new BrowserPrototypeRepository(options(storage))

    const repaired = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    expect(repaired['snapshot-import'].projects[0].name).toBe('保留的有效历史状态')
    expect([
      repaired['snapshot-merge'].people.length,
      repaired['snapshot-merge'].relationships.length,
      repaired['snapshot-merge'].events.length,
    ]).toEqual([11, 12, 7])
    expect([
      repaired['snapshot-manual'].people.length,
      repaired['snapshot-manual'].relationships.length,
      repaired['snapshot-manual'].events.length,
    ]).toEqual([12, 13, 8])
    const recoveryKey = [...Array(storage.length).keys()]
      .map((index) => storage.key(index))
      .find((key) => key?.startsWith(SNAPSHOT_PAYLOADS_RECOVERY_STORAGE_PREFIX))
    expect(storage.getItem(recoveryKey!)).toBe(damagedRaw)
  })

  it('rebuilds a missing fixed demo payload canonically after restoring an older snapshot', async () => {
    const storage = new MemoryStorage()
    let repository = new BrowserPrototypeRepository(options(storage))
    await repository.restoreSnapshot('snapshot-import')
    const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    delete payloads['snapshot-manual']
    storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, JSON.stringify(payloads))

    repository = new BrowserPrototypeRepository(options(storage))
    await repository.restoreSnapshot('snapshot-manual')

    expect((await repository.listPeople('project-demo-family', {
      page: 1, pageSize: 50, sort: 'name',
    })).total).toBe(12)
    expect(await repository.listRelationships('project-demo-family')).toHaveLength(13)
    expect(await repository.listEvents('project-demo-family')).toHaveLength(8)
    expect((await repository.getPerson('person-xu-an')).id).toBe('person-xu-an')
  })

  it('marks a missing dynamic payload corrupt when current state cannot reconstruct its summary', async () => {
    const storage = new MemoryStorage()
    let repository = new BrowserPrototypeRepository(options(storage))
    const dynamic = await repository.createSnapshot('project-demo-family', 'manual', 'dynamic full state')
    await repository.restoreSnapshot('snapshot-import')
    const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    delete payloads[dynamic.id]
    storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, JSON.stringify(payloads))

    repository = new BrowserPrototypeRepository(options(storage))

    await expect(repository.restoreSnapshot(dynamic.id)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(repository.restoreSnapshot(dynamic.id)).rejects.toThrow(/cannot be reconstructed|unavailable/i)
    expect(Object.hasOwn(
      JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!),
      dynamic.id,
    )).toBe(false)
  })

  it('never substitutes current state for a missing dynamic payload with matching counts', async () => {
    const storage = new MemoryStorage()
    let repository = new BrowserPrototypeRepository(options(storage))
    await repository.updateProject('project-demo-family', { name: 'dynamic snapshot value' })
    const dynamic = await repository.createSnapshot('project-demo-family', 'manual', 'dynamic history')
    await repository.updateProject('project-demo-family', { name: 'later current value' })
    const payloads = JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!)
    delete payloads[dynamic.id]
    storage.setItem(SNAPSHOT_PAYLOADS_STORAGE_KEY, JSON.stringify(payloads))

    repository = new BrowserPrototypeRepository(options(storage))

    await expect(repository.restoreSnapshot(dynamic.id)).rejects.toMatchObject({ code: 'corrupt' })
    expect((await repository.getProject('project-demo-family')).name).toBe('later current value')
    expect(Object.hasOwn(
      JSON.parse(storage.getItem(SNAPSHOT_PAYLOADS_STORAGE_KEY)!),
      dynamic.id,
    )).toBe(false)
  })

  it('clones inputs before persistence and outputs before returning', async () => {
    const storage = new MemoryStorage()
    const repository = new BrowserPrototypeRepository(options(storage))
    const person = createDemoState().people[0]!
    person.id = 'clone-person'
    person.names[0]!.value = 'Original'
    const saved = await repository.savePerson(person)

    person.names[0]!.value = 'Mutated input'
    saved.names[0]!.value = 'Mutated output'
    expect((await repository.getPerson('clone-person')).names[0]!.value).toBe('Original')
  })

  it('throws a clear error without touching window during module import', async () => {
    vi.stubGlobal('window', undefined)
    const module = await import('./injection')

    expect(() => module.createDefaultRepository()).toThrowError(
      expect.objectContaining({ code: 'storage' }),
    )
    try {
      module.createDefaultRepository()
    } catch (error) {
      expect((error as RepositoryError).code).toBe('storage')
      expect((error as Error).message).toMatch(/browser|localStorage/i)
    }
  })

  it('provides a repository through the typed Vue injection key', () => {
    const repository = new BrowserPrototypeRepository(options(new MemoryStorage()))
    const app = createApp({})

    expect(provideBranchloomRepository(app, repository)).toBe(app)
    expect(app.runWithContext(() => inject(branchloomRepositoryKey))).toBe(repository)
  })
})
