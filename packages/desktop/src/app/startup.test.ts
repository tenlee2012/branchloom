import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../shared/domain/types'
import { resolveInitialRoute } from './startup'

const recentProject: Project = {
  id: 'project-demo-family',
  name: '林家四代家庭档案',
  description: '本地档案',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-18T09:30:00.000Z',
}

const lastOpenedProject: Project = {
  id: 'project-last-opened',
  name: '上次打开的家谱',
  description: '',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
}

describe('application startup route', () => {
  it('restores the most recent project workspace from the root route', async () => {
    const repository = {
      listProjects: vi.fn().mockResolvedValue([recentProject]),
    }

    await expect(resolveInitialRoute({
      repository,
      currentPath: '/',
    })).resolves.toBe('/project/project-demo-family/tree')
  })

  it('prefers the last opened project over the most recently modified project', async () => {
    const repository = {
      listProjects: vi.fn().mockResolvedValue([recentProject, lastOpenedProject]),
    }

    await expect(resolveInitialRoute({
      repository,
      currentPath: '/',
      recentProjectIds: [lastOpenedProject.id],
    })).resolves.toBe('/project/project-last-opened/tree')
  })

  it('falls back when the remembered project no longer exists', async () => {
    const repository = {
      listProjects: vi.fn().mockResolvedValue([recentProject]),
    }

    await expect(resolveInitialRoute({
      repository,
      currentPath: '/',
      recentProjectIds: ['project-deleted'],
    })).resolves.toBe('/project/project-demo-family/tree')
  })

  it('preserves an explicit deep link', async () => {
    const repository = {
      listProjects: vi.fn().mockResolvedValue([recentProject]),
    }

    await expect(resolveInitialRoute({
      repository,
      currentPath: '/project/project-demo-family/people',
    })).resolves.toBeUndefined()
    expect(repository.listProjects).not.toHaveBeenCalled()
  })

  it('opens project creation when there are no projects', async () => {
    const repository = {
      listProjects: vi.fn().mockResolvedValue([]),
    }

    await expect(resolveInitialRoute({
      repository,
      currentPath: '/',
    })).resolves.toBe('/new')
  })
})
