import type { BranchloomRepository } from '../shared/domain/types'

interface InitialRouteOptions {
  repository: Pick<BranchloomRepository, 'listProjects'>
  currentPath: string
  recentProjectIds?: string[]
}

export function selectInitialProject<T extends { id: string }>(
  projects: T[],
  recentProjectIds: string[] = [],
): T | undefined {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  for (const projectId of recentProjectIds) {
    const project = projectsById.get(projectId)
    if (project) return project
  }
  return projects[0]
}

export async function resolveInitialRoute({
  repository,
  currentPath,
  recentProjectIds,
}: InitialRouteOptions): Promise<string | undefined> {
  if (currentPath !== '/') return undefined

  const projects = await repository.listProjects()
  const recentProject = selectInitialProject(projects, recentProjectIds)
  if (!recentProject) return '/new'

  return `/project/${encodeURIComponent(recentProject.id)}/tree`
}
