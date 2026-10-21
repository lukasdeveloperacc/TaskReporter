export const PORT = 4780
export const ASK_WAIT_MS = 295_000
export const STALE_MS = 1_800_000

export const STAGES = ['계획', '구현', '리뷰', '수정', '마무리', '완료', '중단'] as const
export const LANES = ['plan', 'build', 'review', 'fix', 'finish'] as const
export const STATUSES = ['대기중', '진행중', '완료', '중단'] as const
export const CLOSED = ['완료', '중단'] as const
export const REVIEWERS = ['Karpathy Agent', 'Ponytail Agent', 'Impeccable Agent', 'E2E Agent'] as const
export const SSE_EVENTS = { changed: 'changed', docChanged: 'doc-changed' } as const

export type Stage = (typeof STAGES)[number]
export type Lane = (typeof LANES)[number]
export type TaskStatus = (typeof STATUSES)[number]
export type AskStatus = 'pending' | 'answered' | 'closed'

export type Task = {
  id: string
  title?: string
  owner?: string
  lane?: Lane
  status?: TaskStatus
  after?: string[]
  model?: string
  effort?: string
  note?: string
  started?: string
  finished?: string
}

export type Decision = { title: string; body?: string }

export type Review = {
  round: number
  reviewer: string
  verdict?: string
  note?: string
}

export type ProgressData = {
  title?: string
  stage?: string
  summary?: string
  todo?: string
  blockers?: string
  tasks?: Task[]
  decisions?: Decision[]
  reviews?: Review[]
  updated?: string
}

export type Patch = Partial<Pick<ProgressData, 'title' | 'stage' | 'summary' | 'todo' | 'blockers'>> & {
  tasks?: Task[]
  decisions?: Decision[]
  reviews?: Review[]
}

export type RunView = {
  id: string
  project_path: string
  title: string
  doc_path: string | null
  doc_accessible: boolean
  state: ProgressData
  last_report_at: string
  ended_at: string | null
}

export type AskView = {
  id: string
  run_id: string
  question: string
  options: string[]
  recommended: string | null
  status: AskStatus
  answer: string | null
}

export type ProjectView = {
  path: string
  name: string
  in_workspace: boolean
  hidden?: boolean
  runs: RunView[]
}

export type StateSnapshot = { projects: ProjectView[]; asks: AskView[] }
export type DocChange = { path: string; diff: string }

export type ReportArgs = {
  project_path: string
  run_id?: string
  doc_path?: string
  title?: string
  patch: Patch
  close_ask_ids?: string[]
}

export type ReportResult = { run_id: string; doc_changes: DocChange[] }

export type AskArgs = {
  run_id: string
  question: string
  options: string[]
  recommended?: string
  ask_id?: string
}

export type AskResult =
  | { status: 'answered'; answer: string; ask_id: string }
  | { status: 'pending'; ask_id: string }

export function floorStatus(project: ProjectView, asks: AskView[], now: number): 'ask' | 'away' | 'on' | 'off' {
  const activeRuns = project.runs.filter((run) => run.ended_at === null)
  if (activeRuns.length === 0) return 'off'
  const activeRunIds = new Set(activeRuns.map((run) => run.id))
  if (asks.some((ask) => ask.status === 'pending' && activeRunIds.has(ask.run_id))) return 'ask'
  if (activeRuns.some((run) => now - Date.parse(run.last_report_at) > STALE_MS)) return 'away'
  return 'on'
}
