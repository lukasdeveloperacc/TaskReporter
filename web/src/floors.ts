import type { ProjectView } from '../../shared/contract.ts'

export type OrderedFloor = { project: ProjectView; floorNumber: number }

/** Shared Lobby/elevator ordering: path, then name, ascending; top floor is highest. */
export function orderProjectFloors(projects: ProjectView[]): OrderedFloor[] {
  const ordered = projects.filter((project) => !project.hidden).sort((a, b) => a.path.localeCompare(b.path, 'ko') || a.name.localeCompare(b.name, 'ko'))
  return ordered.map((project, index) => ({ project, floorNumber: ordered.length - index }))
}
