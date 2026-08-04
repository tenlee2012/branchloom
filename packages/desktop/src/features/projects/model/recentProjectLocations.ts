import type { Project } from '../../../shared/domain/types'

export const RECENT_PROJECT_LOCATIONS_KEY = 'branchloom.prototype.recent-locations.v1'

export interface RecentProjectLocation {
  id: string
  projectId: string
  name: string
  location: string
  lastOpenedAt: string
}

export interface ResolvedRecentProject {
  id: string
  projectId: string
  name: string
  location: string
  lastOpenedAt: string
  status: 'available' | 'missing'
  project?: Project
}

interface RecentProjectLocationState {
  schemaVersion: 1
  items: RecentProjectLocation[]
}

interface RecentLocationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isRecentProjectLocation(value: unknown): value is RecentProjectLocation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.location === 'string' &&
    typeof candidate.lastOpenedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.lastOpenedAt))
  )
}

function openedAtEpoch(value: string): number {
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : Number.NEGATIVE_INFINITY
}

function normalizeLocations(locations: RecentProjectLocation[]): RecentProjectLocation[] {
  // Equal timestamps retain the first persisted occurrence before duplicate IDs/projects are removed.
  const newestFirst = locations
    .map((location, index) => ({ location, index }))
    .filter(({ location }) => isRecentProjectLocation(location))
    .sort(
      (left, right) =>
        openedAtEpoch(right.location.lastOpenedAt) -
          openedAtEpoch(left.location.lastOpenedAt) ||
        left.index - right.index,
    )
  const seenIds = new Set<string>()
  const seenProjectIds = new Set<string>()

  return newestFirst.flatMap(({ location }) => {
    if (seenIds.has(location.id) || seenProjectIds.has(location.projectId)) return []
    seenIds.add(location.id)
    seenProjectIds.add(location.projectId)
    return [{ ...location }]
  })
}

function defaultStorage(): RecentLocationStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export class BrowserRecentProjectLocations {
  constructor(private readonly storage = defaultStorage()) {}

  list(): RecentProjectLocation[] {
    if (!this.storage) return []
    try {
      const raw = this.storage.getItem(RECENT_PROJECT_LOCATIONS_KEY)
      if (!raw) return []
      const state = JSON.parse(raw) as Partial<RecentProjectLocationState>
      if (state.schemaVersion !== 1 || !Array.isArray(state.items)) return []
      return normalizeLocations(state.items.filter(isRecentProjectLocation))
    } catch {
      return []
    }
  }

  record(project: Project): void {
    const current = this.list().filter(({ projectId }) => projectId !== project.id)
    const next: RecentProjectLocation = {
      id: `recent-${project.id}`,
      projectId: project.id,
      name: project.name,
      location: '本机资料库',
      lastOpenedAt: new Date().toISOString(),
    }
    this.save([next, ...current])
  }

  remove(id: string): void {
    this.save(this.list().filter((item) => item.id !== id))
  }

  private save(items: RecentProjectLocation[]): void {
    if (!this.storage) return
    const state: RecentProjectLocationState = { schemaVersion: 1, items }
    this.storage.setItem(RECENT_PROJECT_LOCATIONS_KEY, JSON.stringify(state))
  }
}

export function resolveRecentProjects(
  projects: Project[],
  locations: RecentProjectLocation[],
): ResolvedRecentProject[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const normalizedLocations = normalizeLocations(locations)
  const rememberedProjectIds = new Set(normalizedLocations.map(({ projectId }) => projectId))
  const usedRecentIds = new Set(normalizedLocations.map(({ id }) => id))
  const remembered = normalizedLocations.map((location): ResolvedRecentProject => {
    const project = projectsById.get(location.projectId)
    if (!project) return { ...location, status: 'missing' }
    return {
      ...location,
      name: project.name,
      status: 'available',
      project,
    }
  })
  const repositoryProjects = projects
    .filter(({ id }) => !rememberedProjectIds.has(id))
    .map((project): ResolvedRecentProject => {
      const baseId = `recent-${project.id}`
      let id = baseId
      let suffix = 1
      while (usedRecentIds.has(id)) {
        id = `${baseId}-fallback-${suffix}`
        suffix += 1
      }
      usedRecentIds.add(id)
      return {
        id,
        projectId: project.id,
        name: project.name,
        location: '本机资料库',
        lastOpenedAt: project.updatedAt,
        status: 'available',
        project,
      }
    })

  return [...remembered, ...repositoryProjects].sort(
    (left, right) =>
      openedAtEpoch(right.lastOpenedAt) - openedAtEpoch(left.lastOpenedAt) ||
      left.id.localeCompare(right.id) ||
      left.projectId.localeCompare(right.projectId),
  )
}
