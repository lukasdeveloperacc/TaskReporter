import type { KeyboardEvent } from 'react'
import type { RunView, Task } from '../../shared/contract.ts'

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

function taskDates(task: Task) {
  const start = dateLabel(task.started)
  const finish = dateLabel(task.finished)
  if (!start && !finish) return null
  return <p>{start ? `시작 · ${start}` : '시작 · 미보고'}{finish ? ` · 종료 · ${finish}` : ''}</p>
}

export function EmployeeReport({ owner, runs, currentRunId, tab, onTabChange, now }: EmployeeReportProps) {
  const currentRun = runs.find((run) => run.id === currentRunId)
  const currentTasks = currentRun?.state.tasks?.filter((task) => task.owner === owner && task.status === '진행중') ?? []
  const history = runs
    .filter((run) => run.project_path === currentRun?.project_path && run.state.tasks?.some((task) => task.owner === owner))
    .map((run, index) => ({ run, index, timestamp: runTimestamp(run) }))
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index)
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || isEditable(event.target)) return
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

  return <section aria-label={`${owner} 업무 보고`} onKeyDown={keyDown}>
    <div role="tablist" aria-label="업무 보기">
      <button id="employee-report-tab-current" type="button" role="tab" aria-selected={tab === 'current'} aria-controls="employee-report-panel" tabIndex={tab === 'current' ? 0 : -1} onClick={() => onTabChange('current')}>현재 업무</button>
      <button id="employee-report-tab-history" type="button" role="tab" aria-selected={tab === 'history'} aria-controls="employee-report-panel" tabIndex={tab === 'history' ? 0 : -1} onClick={() => onTabChange('history')}>업무 기록</button>
    </div>
    <div id="employee-report-panel" role="tabpanel" aria-labelledby={`employee-report-tab-${tab}`} tabIndex={0}>
      {tab === 'current' ? <>
        <p>최근 보고된 진행 업무입니다.</p>
        {currentTasks.length ? <ul>{currentTasks.map((task, index) => {
          const elapsed = taskElapsed(task, now)
          return <li key={`${task.id}-${index}`}>
            <h3>작업 · {task.title || '미보고'}</h3>
            <p>작업 ID · {task.id}</p>
            <p>상태 · {task.status ?? '미보고'}</p>
            <p>모델 · {task.model || '미보고'}</p>
            <p>노력 · {task.effort || '미보고'}</p>
            {taskDates(task)}
            <p>경과 시간 · {elapsed === null ? '미보고' : `${elapsed}분`}</p>
            {task.note ? <p>메모 · {task.note}</p> : <p>메모 · 미보고</p>}
          </li>
        })}</ul> : <><p>현재 진행 중인 작업이 없습니다.</p><p>모델 · 미보고</p><p>노력 · 미보고</p></>}
      </> : <>
        <p>보고한 업무를 최근 순서로 모았습니다.</p>
        {history.length ? <ul>{history.map(({ run }) => {
          const tasks = run.state.tasks!.filter((task) => task.owner === owner)
          const updated = dateLabel(run.last_report_at)
          const ended = dateLabel(run.ended_at)
          return <li key={run.id}>
            <h3>{run.title || '실행 제목 미보고'}</h3>
            <p>실행 ID · {run.id} · 상태 · {run.ended_at ? '종료됨' : '진행 중'}</p>
            <p>최근 보고 · {updated ?? '미보고'}{ended ? ` · 종료 · ${ended}` : ''}</p>
            <ul>{tasks.map((task, index) => <li key={`${task.id}-${index}`}>
              <h4>{task.title || '제목 미보고'}</h4>
              <p>작업 ID · {task.id} · 상태 · {task.status ?? '미보고'}</p>
              <p>모델 · {task.model || '미보고'}</p>
              <p>노력 · {task.effort || '미보고'}</p>
              {taskDates(task)}
              <p>경과 시간 · {taskElapsed(task, now) === null ? '미보고' : `${taskElapsed(task, now)}분`}</p>
              {task.note ? <p>메모 · {task.note}</p> : <p>메모 · 미보고</p>}
            </li>)}</ul>
          </li>
        })}</ul> : <p>이 직원에 대해 보고된 이전 업무가 없습니다.</p>}
      </>}
    </div>
  </section>
}
