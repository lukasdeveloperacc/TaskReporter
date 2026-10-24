import roles from './roles.json' with { type: 'json' }
import type { Task } from './contract.ts'

export type Department = (typeof roles.departments)[number]['key']
export type DepartmentLayout = (typeof roles.departments)[number]
export type ActorAssignment = {
  task?: Task
  lastCompletedTask?: Task
  lane?: string
  model?: string
  effort?: string
}

export { roles }

function ownerDepartment(owner: string): Department | undefined {
  const mapping = roles.owners.find(({ match }) => match.endsWith('*') ? owner.startsWith(match.slice(0, -1)) : match === owner)
  return mapping?.department as Department | undefined
}

export function departmentOf(owner: string, lane?: string): Department {
  if (lane === 'plan') return '회의실'
  return ownerDepartment(owner) ?? '임시 자리'
}

export function resolveDepartment(owner?: string, lane?: string): {
  department: Department | null
  matched_by: 'lane' | 'owner' | 'fallback' | 'unassigned'
} {
  if (!owner) return { department: null, matched_by: 'unassigned' }
  if (lane === 'plan') return { department: '회의실', matched_by: 'lane' }
  const department = ownerDepartment(owner)
  return department
    ? { department, matched_by: 'owner' }
    : { department: '임시 자리', matched_by: 'fallback' }
}

function compareCompleted(a: Task, b: Task): number {
  const aTime = a.finished === undefined ? Number.NaN : Date.parse(a.finished)
  const bTime = b.finished === undefined ? Number.NaN : Date.parse(b.finished)
  const aValid = Number.isFinite(aTime)
  const bValid = Number.isFinite(bTime)
  if (aValid !== bValid) return aValid ? -1 : 1
  if (aValid && bValid && aTime !== bTime) return bTime - aTime
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function actorAssignments(tasks: Task[]): Map<string, ActorAssignment> {
  const assignments = new Map<string, ActorAssignment>([['leader', {}]])
  for (const task of tasks) {
    if (!task.owner) continue
    const current = assignments.get(task.owner) ?? {}
    if (task.status === '진행중') Object.assign(current, { task, lane: task.lane, model: task.model, effort: task.effort })
    else if (!current.task && (task.model !== undefined || task.effort !== undefined)) {
      Object.assign(current, { lane: task.lane, model: task.model, effort: task.effort })
    }
    if (task.status === '완료' && (!current.lastCompletedTask || compareCompleted(task, current.lastCompletedTask) < 0)) {
      current.lastCompletedTask = task
    }
    assignments.set(task.owner, current)
  }
  for (const assignment of assignments.values()) {
    if (!assignment.task && assignment.lastCompletedTask) assignment.lane = assignment.lastCompletedTask.lane
  }
  return assignments
}
