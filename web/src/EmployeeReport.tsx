import type { KeyboardEvent } from 'react'
import type { RunView, Task } from '../../shared/contract.ts'
import './employee-report.css'

export type ReportTab = 'current' | 'history'
export type EmployeeReportProps = {
  owner: string
  runs: RunView[]
  currentRunId: string
  tab: ReportTab
  onTabChange: (tab: ReportTab) => void
  now: number
}

const dateLabel = (value?: string | null) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

const runTimestamp = (run: RunView) => Math.max(...[run.last_report_at, run.ended_at].map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite), Number.NEGATIVE_INFINITY)

const isEditable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))

function taskElapsed(task: Task, now: number) {
  const start = task.started ? Date.parse(task.started) : Number.NaN
  const finish = task.finished ? Date.parse(task.finished) : Number.NaN
  if (!Number.isFinite(start)) return null
  const end = Number.isFinite(finish) ? finish : now
  if (!Number.isFinite(end) || end < start) return null
  return Math.floor((end - start) / 60_000)
}

function TaskReport({ task, now, headingLevel = 3 }: { task: Task; now: number; headingLevel?: 3 | 4 }) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4'
  const PhaseHeading = headingLevel === 3 ? 'h4' : 'h5'
  const elapsed = taskElapsed(task, now)
  const todos = task.todos ?? []
  const completed = todos.filter((todo) => todo.done).length
  const phases = new Map<string, typeof todos>()
  for (const todo of todos) {
    const phase = todo.phase || '할 일'
    if (!phases.has(phase)) phases.set(phase, [])
    phases.get(phase)!.push(todo)
  }
  const noteLines = task.note?.split(/\n| · /).map((line) => line.trim()).filter(Boolean) ?? []

  return <article className="employee-report__task">
    <header className="employee-report__task-heading">
      <Heading>{headingLevel === 3 ? '작업 · ' : ''}{task.title || '제목 미보고'}</Heading>
      <span className="employee-report__status" data-status={task.status}>상태 · {task.status ?? '미보고'}</span>
    </header>
    <p className="employee-report__task-id">작업 ID · {task.id}</p>
    <div className="employee-report__meta">
      <span>모델 · {task.model || '미보고'}</span>
      <span>노력 · {task.effort || '미보고'}</span>
      <span>시작 · {dateLabel(task.started) ?? '미보고'}</span>
      {dateLabel(task.finished) && <span>종료 · {dateLabel(task.finished)}</span>}
      <span>경과 시간 · {elapsed === null ? '미보고' : `${elapsed}분`}</span>
    </div>
    {todos.length > 0 && <>
      <div className="employee-report__progress">
        <span>TODO 진행 · {completed}/{todos.length}</span>
        <progress value={completed} max={todos.length} aria-label={`${task.title || task.id} TODO 진행`} />
      </div>
      {[...phases].map(([phase, items]) => <section className="employee-report__phase" key={phase} aria-label={`${phase} TODO`}>
        <PhaseHeading>{phase}<span>{items.filter((todo) => todo.done).length}/{items.length}</span></PhaseHeading>
        <ul className="employee-report__todos">{items.map((todo) => <li key={todo.id} className={todo.done ? 'employee-report__todo employee-report__todo--done' : 'employee-report__todo'}>
          <span className="employee-report__check" role="img" aria-label={todo.done ? '완료' : '미완료'}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="2" />{todo.done && <path d="m6 10 3 3 5-6" />}</svg></span>
          <div className="employee-report__todo-content">
            <span className="employee-report__todo-text">{todo.text || todo.id}</span>
            {todo.detail && <details><summary>상세 보기</summary><p className="employee-report__detail">{todo.detail}</p></details>}
          </div>
        </li>)}</ul>
      </section>)}
    </>}
    <div className="employee-report__note">{noteLines.length ? <><span className="employee-report__note-label">메모</span>{noteLines.map((line, index) => <p key={index}>{line}</p>)}</> : <p>메모 · 미보고</p>}</div>
  </article>
}

export function EmployeeReport({ owner, runs, currentRunId, tab, onTabChange, now }: EmployeeReportProps) {
  const currentRun = runs.find((run) => run.id === currentRunId)
  const currentTasks = currentRun?.state.tasks?.filter((task) => task.owner === owner) ?? []
  const history = runs
    .filter((run) => run.project_path === currentRun?.project_path && run.state.tasks?.some((task) => task.owner === owner))
    .map((run, index) => ({ run, index, timestamp: runTimestamp(run) }))
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index)
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || isEditable(event.target) || event.target instanceof Element && event.target.closest('summary, a, button:not([role="tab"])')) return
    if (event.repeat && (['KeyJ', 'KeyR'].includes(event.code) || ['j', 'r'].includes(event.key.toLowerCase()))) return
    let next: ReportTab | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = tab === 'current' ? 'history' : 'current'
    if (event.key === 'Home') next = 'current'
    if (event.key === 'End') next = 'history'
    if (event.key.toLowerCase() === 'j' || event.code === 'KeyJ') next = 'history'
    if (event.key.toLowerCase() === 'r' || event.code === 'KeyR') next = 'current'
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    onTabChange(next)
    document.getElementById(`employee-report-tab-${next}`)?.focus()
  }

  return <section className="employee-report" aria-label={`${owner} 업무 보고`} onKeyDown={keyDown}>
    <div role="tablist" aria-label="업무 보기">
      <button id="employee-report-tab-current" type="button" role="tab" aria-selected={tab === 'current'} aria-controls="employee-report-panel" tabIndex={tab === 'current' ? 0 : -1} onClick={() => onTabChange('current')}>현재 업무</button>
      <button id="employee-report-tab-history" type="button" role="tab" aria-selected={tab === 'history'} aria-controls="employee-report-panel" tabIndex={tab === 'history' ? 0 : -1} onClick={() => onTabChange('history')}>업무 기록</button>
    </div>
    <div id="employee-report-panel" role="tabpanel" aria-labelledby={`employee-report-tab-${tab}`} tabIndex={0}>
      {tab === 'current' ? <>
        <p>이번 실행에서 맡은 업무와 체크리스트입니다.</p>
        {currentTasks.length ? <ul className="employee-report__tasks">{currentTasks.map((task, index) => <li key={`${task.id}-${index}`}><TaskReport task={task} now={now} /></li>)}</ul> : <><p>현재 진행 중인 작업이 없습니다.</p><p>모델 · 미보고</p><p>노력 · 미보고</p></>}
      </> : <>
        <p>보고한 업무를 최근 순서로 모았습니다.</p>
        {history.length ? <ul className="employee-report__history">{history.map(({ run }) => {
          const tasks = run.state.tasks!.filter((task) => task.owner === owner)
          const updated = dateLabel(run.last_report_at)
          const ended = dateLabel(run.ended_at)
          return <li key={run.id}>
            <h3>{run.title || '실행 제목 미보고'}</h3>
            <p>실행 ID · {run.id} · 상태 · {run.ended_at ? '종료됨' : '진행 중'}</p>
            <p>최근 보고 · {updated ?? '미보고'}{ended ? ` · 종료 · ${ended}` : ''}</p>
            <ul className="employee-report__tasks">{tasks.map((task, index) => <li key={`${task.id}-${index}`}><TaskReport task={task} now={now} headingLevel={4} /></li>)}</ul>
          </li>
        })}</ul> : <p>이 직원에 대해 보고된 이전 업무가 없습니다.</p>}
      </>}
    </div>
  </section>
}
