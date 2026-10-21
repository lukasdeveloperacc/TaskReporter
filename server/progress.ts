import {
  CLOSED,
  LANES,
  REVIEWERS,
  STAGES,
  STATUSES,
  type ProgressData,
} from '../shared/contract.ts'

const TEXT = ['title', 'stage', 'summary', 'todo', 'blockers'] as const
type Entry = Record<string, unknown>

function fail(message: string): never {
  throw new Error(message)
}

function isRecord(value: unknown): value is Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge<T extends object>(oldItems: T[], newItems: T[], key: (item: T) => unknown): T[] {
  const merged = [...oldItems]
  for (const item of newItems) {
    const index = merged.findIndex((old) => key(old) === key(item))
    if (index === -1) merged.push(item)
    else merged[index] = { ...merged[index], ...item } as T
  }
  return merged
}

function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
  return `${quote}${escaped.replaceAll(quote, `\\${quote}`)}${quote}`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function rejectUnknown(entry: Entry, allowed: string[], context: string) {
  const unknown = Object.keys(entry).filter((field) => !allowed.includes(field)).sort()
  if (unknown.length) fail(`${context}: unknown fields: ${unknown.join(', ')}; allowed: ${allowed.join(', ')}`)
}

export const INIT = (title: string): ProgressData => ({
  title,
  stage: '계획',
  summary: '',
  todo: '없음',
  blockers: '없음',
})

export function apply(data: ProgressData, patch: unknown, now: number): ProgressData {
  if (!isRecord(patch)) fail('input must be a JSON object')
  const next = structuredClone(data) as ProgressData
  const allowed = new Set<string>([...TEXT, 'tasks', 'decisions', 'reviews'])
  const unknown = Object.keys(patch).filter((field) => !allowed.has(field)).sort()
  if (unknown.length) {
    fail(`unknown fields: ${unknown.join(', ')}; allowed: ${TEXT.join(', ')}, tasks, decisions, reviews`)
  }
  for (const key of ['tasks', 'decisions', 'reviews'] as const) {
    if (key in patch && !Array.isArray(patch[key])) fail(`${key} must be a list`)
  }
  for (const field of TEXT) {
    if (field in patch) {
      if (typeof patch[field] !== 'string') fail(`${field} must be a string`)
      next[field] = patch[field]
    }
  }
  if ('stage' in patch && typeof patch.stage === 'string' && !STAGES.includes(patch.stage.split(' ')[0] as (typeof STAGES)[number])) {
    fail(`stage must start with one of ${STAGES.join(', ')}; detail may follow after a space, e.g. 수정 (2라운드)`)
  }

  const tasks = (patch.tasks ?? []) as unknown[]
  for (const rawTask of tasks) {
    if (!isRecord(rawTask) || typeof rawTask.id !== 'string' || !rawTask.id) fail('each task needs a string id')
    const task = rawTask
    rejectUnknown(task, ['id', 'title', 'owner', 'model', 'effort', 'lane', 'status', 'after', 'note'], `task ${task.id}`)
    if ('lane' in task && !LANES.includes(task.lane as (typeof LANES)[number])) {
      fail(`task ${task.id}: lane must be one of ${LANES.join(', ')}`)
    }
    if ('status' in task && !STATUSES.includes(task.status as (typeof STATUSES)[number])) {
      fail(`task ${task.id}: status must be one of ${STATUSES.join(', ')}`)
    }
    if ('after' in task && !isStringArray(task.after)) fail(`task ${task.id}: after must be a list of task ids`)
    for (const field of ['title', 'owner', 'note', 'model', 'effort']) {
      if (field in task && typeof task[field] !== 'string') fail(`task ${task.id}: ${field} must be a string`)
    }
  }
  const decisions = (patch.decisions ?? []) as unknown[]
  for (const decision of decisions) {
    if (!isRecord(decision) || typeof decision.title !== 'string') fail('each decision needs a string title')
    rejectUnknown(decision, ['title', 'body'], `decision ${decision.title}`)
  }
  const reviews = (patch.reviews ?? []) as unknown[]
  for (const review of reviews) {
    if (!isRecord(review) || typeof review.reviewer !== 'string' || typeof review.round !== 'number' || !Number.isInteger(review.round)) {
      fail('each review needs an integer round and a string reviewer')
    }
    rejectUnknown(review, ['round', 'reviewer', 'verdict', 'note'], `review ${review.round} ${review.reviewer}`)
    if (!REVIEWERS.includes(review.reviewer as (typeof REVIEWERS)[number])) {
      fail(`reviewer ${pythonRepr(review.reviewer)} must be exactly one of: ${REVIEWERS.join(', ')}`)
    }
  }

  const updatedAt = new Date(now).toISOString()
  const before = new Map((next.tasks ?? []).map((task) => [task.id, task.status]))
  const mergedTasks = merge(next.tasks ?? [], tasks as NonNullable<ProgressData['tasks']>, (task) => task.id)
  next.tasks = mergedTasks
  for (const task of mergedTasks) {
    task.lane ??= 'build'
    task.status ??= '대기중'
    task.title ??= task.id
    const was = before.get(task.id)
    if (task.status === '진행중' && was !== '진행중') {
      task.started = updatedAt
      delete task.finished
    } else if (CLOSED.includes(task.status as (typeof CLOSED)[number]) && !CLOSED.includes(was as (typeof CLOSED)[number])) {
      task.finished = updatedAt
    }
  }
  next.decisions = merge(next.decisions ?? [], decisions as NonNullable<ProgressData['decisions']>, (decision) => decision.title.trim())
  next.reviews = merge(next.reviews ?? [], reviews as NonNullable<ProgressData['reviews']>, (review) => `${review.round}\0${review.reviewer}`)

  const ids = new Set(mergedTasks.map((task) => task.id))
  const dangling = [...new Set(mergedTasks.flatMap((task) => task.after ?? []).filter((id) => !ids.has(id)))].sort()
  if (dangling.length) fail(`after refers to unknown task ids: ${dangling.join(', ')}`)

  const stillOpen = mergedTasks.filter((task) => !CLOSED.includes(task.status as (typeof CLOSED)[number])).map((task) => task.id)
  const finish = mergedTasks.filter((task) => task.lane === 'finish')
  const word = (next.stage ?? '').split(' ')[0]
  if (word === '완료' && stillOpen.length) {
    fail(`stage 완료 but tasks are still open: ${stillOpen.join(', ')}; set them to 완료 or 중단, or send the current stage instead (e.g. 수정)`)
  }
  const closing = finish.some((task) => CLOSED.includes(task.status as (typeof CLOSED)[number]) && task.status !== before.get(task.id))
  if (word !== '중단' && closing && finish.every((task) => CLOSED.includes(task.status as (typeof CLOSED)[number])) && finish.some((task) => task.status === '완료')) {
    if (stillOpen.length) {
      fail(`closing the finish task ends the run, but these tasks are still open: ${stillOpen.join(', ')}; set them to 완료 or 중단 first`)
    }
    if (word !== '완료') next.stage = '완료'
  }
  next.updated = updatedAt
  return next
}
