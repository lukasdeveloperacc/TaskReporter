import { STALE_MS, type RunView, type Task } from '../../shared/contract.ts'
import { actorAssignments, departmentOf, type Department, type DepartmentLayout } from '../../shared/office-roles.ts'
import { roles } from '../../shared/office-roles.ts'
export type { Department, DepartmentLayout } from '../../shared/office-roles.ts'

export type EmployeeState = 'typing' | 'idle' | 'away' | 'gone'
export type EmployeeView = {
  name: string
  department: Department
  deskIndex: number
  model: string | null
  rank: string | null
  effort: string | null
  frame: [number, number]
  task?: { id: string; title: string; elapsedMin: number }
  lastCompletedTask?: { id: string; title: string }
  state: EmployeeState
  statusLabel: string
}
export type OfficeView = { employees: EmployeeView[] }
export const OFFICE_WIDTH = 1536
export const OFFICE_HEIGHT = 1600

export type Scene =
  | { type: 'walk'; who: string; to: 'desk' }
  | { type: 'deliver'; who: string; to: '감사팀' }
  | { type: 'stamp'; reviewer: string; round: number; verdict: string | undefined }
  | { type: 'return'; from: string; to: string[] }

export { departmentOf }

export function rankOf(model?: string): string | null {
  if (!model) return null
  return roles.ranks.find(({ match }) => model.toLowerCase().includes(match))?.rank ?? null
}

export function seatPosition(department: Pick<DepartmentLayout, 'x' | 'y' | 'w'>, deskIndex: number): { x: number; y: number } {
  const columns = Math.max(1, Math.floor((department.w - 1) / 4))
  return {
    x: department.x + 1 + (deskIndex % columns) * 4,
    y: department.y + 2 + Math.floor(deskIndex / columns) * 2.5,
  }
}

export function layoutOffice(employees: EmployeeView[]): DepartmentLayout[] {
  let offset = 0
  return [...new Set(roles.departments.map(({ y }) => y))].flatMap((y) => {
    const row = roles.departments.filter((department) => department.y === y)
    const expanded = row.map((department) => {
      const lastDesk = employees.reduce((last, employee) => employee.department === department.key ? Math.max(last, employee.deskIndex) : last, 0)
      const lastSeat = seatPosition(department, lastDesk)
      return { ...department, y: department.y + offset, h: Math.max(department.h, Math.ceil(lastSeat.y - department.y + 1.5)) }
    })
    offset += Math.max(...expanded.map((department, index) => department.h - row[index].h))
    return expanded
  })
}

export function characterFrame(name: string): [number, number] {
  let hash = 2166136261
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const index = (hash >>> 0) % 14
  return [index % 2, 5 + Math.floor(index / 2)]
}

const active = (run: RunView) => run.ended_at === null
const taskTitle = (task: Task) => task.title || task.id

export function buildOffice(run: RunView, now: number): OfficeView {
  const tasks = run.state.tasks ?? []
  const byName = actorAssignments(tasks)
  for (const review of run.state.reviews ?? []) byName.set(review.reviewer, byName.get(review.reviewer) ?? {})

  const deskCounts = new Map<Department, number>()
  return {
    employees: [...byName].map(([name, assignment]) => {
      const department = departmentOf(name, assignment.lane)
      const deskIndex = deskCounts.get(department) ?? 0
      deskCounts.set(department, deskIndex + 1)
      const startedAt = assignment.task?.started ? Date.parse(assignment.task.started) : Number.NaN
      const elapsed = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 60_000)) : 0
      const state: EmployeeState = !active(run) ? 'gone' : now - Date.parse(run.last_report_at) > STALE_MS ? 'away' : assignment.task ? 'typing' : 'idle'
      const ownedTasks = tasks.filter((task) => task.owner === name && task.kind !== 'aggregate')
      const waiting = ownedTasks.some((task) => task.status === '대기중')
      const idleLabel = waiting ? assignment.lastCompletedTask ? '다음 작업 대기' : '시작 대기'
        : assignment.lastCompletedTask ? '완료 후 대기'
        : ownedTasks.some((task) => task.status === '중단') ? '작업 중단' : '업무 미보고'
      return {
        name, department, deskIndex, model: assignment.model ?? null, rank: rankOf(assignment.model), effort: assignment.effort ?? null,
        frame: characterFrame(name),
        ...(assignment.task ? { task: { id: assignment.task.id, title: taskTitle(assignment.task), elapsedMin: elapsed } } : {}),
        ...(assignment.lastCompletedTask ? { lastCompletedTask: { id: assignment.lastCompletedTask.id, title: taskTitle(assignment.lastCompletedTask) } } : {}),
        state,
        statusLabel: state === 'typing' ? '작업 중' : state === 'away' ? '자리 비움' : state === 'gone' ? '업무 종료' : idleLabel,
      }
    }),
  }
}

const taskMap = (run: RunView) => new Map((run.state.tasks ?? []).filter((task) => task.kind !== 'aggregate').map((task) => [task.id, task]))
const reviewKey = (round: number, reviewer: string) => `${round}:${reviewer}`

export function diffScenes(prev: RunView | null, next: RunView): Scene[] {
  if (!prev) return []
  const beforeTasks = taskMap(prev)
  const afterTasks = taskMap(next)
  const scenes: Scene[] = []
  for (const [id, task] of afterTasks) {
    const prior = beforeTasks.get(id)
    if (task.status === '진행중' && prior?.status !== '진행중' && task.owner) scenes.push({ type: 'walk', who: task.owner, to: 'desk' })
    if (task.status === '완료' && prior?.status !== '완료' && task.owner && (task.lane === 'build' || task.lane === 'fix')) scenes.push({ type: 'deliver', who: task.owner, to: '감사팀' })
  }
  const beforeReviews = new Set((prev.state.reviews ?? []).map(({ round, reviewer }) => reviewKey(round, reviewer)))
  for (const review of next.state.reviews ?? []) {
    if (beforeReviews.has(reviewKey(review.round, review.reviewer))) continue
    scenes.push({ type: 'stamp', reviewer: review.reviewer, round: review.round, verdict: review.verdict })
    if (review.verdict !== 'CHANGES_REQUIRED') continue
    const reviewerTaskIds = new Set([...afterTasks.values()].filter((task) => task.owner === review.reviewer && task.lane === 'review').map((task) => task.id))
    const linkedFixOwners = [...afterTasks.values()].filter((task) => !beforeTasks.has(task.id) && task.lane === 'fix' && task.after?.some((id) => reviewerTaskIds.has(id))).map((task) => task.owner).filter((owner): owner is string => Boolean(owner))
    const buildOwners = [...afterTasks.values()].filter((task) => task.lane === 'build').map((task) => task.owner).filter((owner): owner is string => Boolean(owner))
    scenes.push({ type: 'return', from: review.reviewer, to: linkedFixOwners.length ? linkedFixOwners : buildOwners.length ? buildOwners : ['leader'] })
  }
  return scenes
}
