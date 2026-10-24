// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RunView, Task } from '../../shared/contract.ts'
import { EmployeeReport, type ReportTab } from './EmployeeReport.tsx'

const makeRun = (id: string, title: string, tasks: Task[], patch: Partial<RunView> = {}): RunView => ({
  id, title, project_path: '/project', doc_path: null, doc_accessible: false,
  state: { tasks }, last_report_at: '2026-10-18T10:00:00.000Z', ended_at: null, ...patch,
})

describe('EmployeeReport', () => {
  it.each([
    ['review-e2e', 'review', true],
    ['E2E Agent', 'review', false],
    ['unknown-planner', 'plan', false],
  ] as const)('explains placement for %s without inferring runtime liveness', (owner, lane, fallback) => {
    const run = makeRun('current', '현재 실행', [{ id: 'task', owner, lane, status: '완료' }])
    render(<EmployeeReport owner={owner} runs={[run]} currentRunId="current" tab="current" onTabChange={() => {}} now={0} />)
    expect(Boolean(screen.queryByText(/에 맞는 부서 규칙이 없습니다/))).toBe(fallback)
    expect(screen.getByText(/실행 ID · current · 마지막 보고/)).toBeTruthy()
    expect(screen.getByText('작업 상태는 마지막 보고 기준입니다. 실제 에이전트의 실행 여부와 다를 수 있습니다.')).toBeTruthy()
  })

  it('shows assigned work from planning through completion with reported fields and honest missing values', () => {
    const run = makeRun('current', '현재 실행', [
      { id: 'one', owner: 'staff-a', title: '진행 작업', status: '진행중', model: 'codex', effort: 'high', started: '2026-10-20T10:00:00Z' },
      { id: 'two', owner: 'staff-a', title: '완료 작업', status: '완료' },
      { id: 'planned', owner: 'staff-a', title: '계획 작업', status: '대기중' },
      { id: 'other', owner: 'staff-b', title: '다른 직원' },
    ])
    render(<EmployeeReport owner="staff-a" runs={[run]} currentRunId="current" tab="current" onTabChange={() => {}} now={Date.parse('2026-10-20T11:00:00Z')} />)
    expect(screen.getByText(/작업 · 진행 작업/)).toBeTruthy()
    expect(screen.getByText('작업 · 완료 작업')).toBeTruthy()
    expect(screen.getByText('작업 · 계획 작업')).toBeTruthy()
    expect(screen.queryByText('다른 직원')).toBeNull()
    expect(screen.getByText('작업 ID · one')).toBeTruthy()
    expect(screen.getByText('상태 · 진행중')).toBeTruthy()
    expect(screen.getByText('모델 · codex')).toBeTruthy()
    expect(screen.getByText('노력 · high')).toBeTruthy()
    expect(screen.getByText('경과 시간 · 60분')).toBeTruthy()
    expect(screen.getAllByText(/미보고/).length).toBeGreaterThan(0)
    expect(screen.getByText('이번 실행에서 맡은 업무와 체크리스트입니다.')).toBeTruthy()
  })

  it.each(['current', 'history'] as const)('groups Phase TODOs, shows completion and folded details, and splits notes in %s', (tab) => {
    const run = makeRun('current', '현재 실행', [{
      id: 'FE', owner: 'staff-a', title: '직원 체크리스트', status: '대기중',
      note: '계획 합의\n구현 시작 · 검증 예정',
      todos: [
        { id: 'FE-1', text: '요구사항 확인', phase: '계획', done: true },
        { id: 'FE-2', text: '체크리스트 구현', phase: '구현', detail: 'Phase별로 묶기\n작은 화면 확인' },
        { id: 'FE-3', text: '접근성 검토', phase: '계획' },
        { id: 'FE-4' },
      ],
    }])
    const onTabChange = vi.fn()
    const { container } = render(<EmployeeReport owner="staff-a" runs={[run]} currentRunId="current" tab={tab} onTabChange={onTabChange} now={0} />)
    expect(screen.getByText('TODO 진행 · 1/4')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '직원 체크리스트 TODO 진행' }).getAttribute('value')).toBe('1')
    const plan = screen.getByRole('region', { name: '계획 TODO' })
    expect(within(plan).getByText('요구사항 확인')).toBeTruthy()
    expect(within(plan).getByText('접근성 검토')).toBeTruthy()
    expect(within(plan).getByRole('img', { name: '완료' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '구현 TODO' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '할 일 TODO' })).getByText('FE-4')).toBeTruthy()
    expect(container.querySelector('.employee-report__todo--done')?.textContent).toContain('요구사항 확인')
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    fireEvent.click(screen.getByText('상세 보기'))
    expect(details.open).toBe(true)
    expect(screen.getByText(/Phase별로 묶기/).textContent).toBe('Phase별로 묶기\n작은 화면 확인')
    for (const line of ['계획 합의', '구현 시작', '검증 예정']) expect(screen.getByText(line).tagName).toBe('P')
    fireEvent.keyDown(screen.getByText('상세 보기'), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByText('상세 보기'), { key: 'j', code: 'KeyJ' })
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('marks only the first unfinished TODO of an active task as in progress', () => {
    const todos = [{ id: 'A-1', text: '조사', done: true }, { id: 'A-2', text: '구현' }, { id: 'A-3', text: '검증' }]
    const run = makeRun('current', '현재 실행', [
      { id: 'A', owner: 'staff-a', title: '진행 작업', status: '진행중', todos },
      { id: 'B', owner: 'staff-a', title: '대기 작업', status: '대기중', todos: [{ id: 'B-1', text: '대기 할 일' }] },
    ])
    render(<EmployeeReport owner="staff-a" runs={[run]} currentRunId="current" tab="current" onTabChange={() => {}} now={Date.parse('2026-10-20T11:00:00Z')} />)
    expect(screen.getAllByText('진행 중')).toHaveLength(1)
    const active = screen.getByText('구현').closest('li')!
    expect(active.className).toContain('employee-report__todo--active')
    expect(within(active).getByRole('img', { name: '진행 중' })).toBeTruthy()
    expect(screen.getByText('검증').closest('li')!.className).not.toContain('--active')
    expect(screen.getByText('대기 할 일').closest('li')!.className).not.toContain('--active')
    expect(within(screen.getByText('조사').closest('li')!).getByRole('img', { name: '완료' })).toBeTruthy()
  })

  it('sorts real prior runs by valid latest timestamp, includes ended runs and refreshes from props', () => {
    const recent = makeRun('recent', '최근 실행', [{ id: 'r', owner: 'staff-a', title: '최근 작업', status: '완료' }], { ended_at: '2026-10-19T12:00:00Z' })
    const invalid = makeRun('invalid', '날짜 없는 실행', [{ id: 'i', owner: 'staff-a', title: '날짜 작업' }], { last_report_at: 'bad-date' })
    const tie = makeRun('tie', '동일 시각 실행', [{ id: 't', owner: 'staff-a', title: '동시 작업' }], { last_report_at: recent.ended_at! })
    const unrelated = makeRun('unrelated', '다른 직원 실행', [{ id: 'x', owner: 'staff-b', title: '숨길 작업' }])
    const current = makeRun('current', '현재 실행', [])
    const props = { owner: 'staff-a', currentRunId: 'current', tab: 'history' as ReportTab, onTabChange: () => {}, now: Date.now() }
    const { rerender } = render(<EmployeeReport {...props} runs={[current, invalid, tie, unrelated, recent]} />)
    const titles = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(titles).toEqual(['동일 시각 실행', '최근 실행', '날짜 없는 실행'])
    expect(screen.queryByText('숨길 작업')).toBeNull()
    expect(screen.getByText(/실행 ID · recent · 상태 · 종료됨/)).toBeTruthy()
    const refreshed = makeRun('new', '새 실행', [{ id: 'n', owner: 'staff-a', title: '새 업무' }], { last_report_at: '2026-10-20T12:00:00Z' })
    rerender(<EmployeeReport {...props} runs={[current, refreshed, recent]} />)
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['새 실행', '최근 실행'])
  })

  it('keeps same-project task records from the current run in history and blocks mixed-project runs', () => {
    const current = makeRun('current', '현재 실행', [
      { id: 'active', owner: 'staff-a', title: '진행 중 기록', status: '진행중' },
      { id: 'done', owner: 'staff-a', title: '현재 실행 완료 기록', status: '완료' },
    ])
    const foreign = makeRun('foreign', '외부 프로젝트', [{ id: 'private', owner: 'staff-a', title: '다른 프로젝트 기록' }], { project_path: '/another-project' })
    render(<EmployeeReport owner="staff-a" runs={[current, foreign]} currentRunId="current" tab="history" onTabChange={() => {}} now={Date.now()} />)
    expect(screen.getByText('현재 실행 완료 기록')).toBeTruthy()
    expect(screen.getByText('진행 중 기록')).toBeTruthy()
    expect(screen.queryByText('다른 프로젝트 기록')).toBeNull()
  })

  it('supports tab arrow and Home/End/J/R shortcuts while ignoring modified, composing and editable keys', () => {
    const onTabChange = vi.fn()
    render(<EmployeeReport owner="staff-a" runs={[]} currentRunId="current" tab="current" onTabChange={onTabChange} now={0} />)
    const panel = screen.getByRole('tabpanel')
    fireEvent.keyDown(panel, { key: 'ArrowRight' })
    expect(onTabChange).toHaveBeenLastCalledWith('history')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '업무 기록' }))
    fireEvent.keyDown(panel, { key: 'Home' })
    expect(onTabChange).toHaveBeenLastCalledWith('current')
    fireEvent.keyDown(panel, { key: 'End' })
    expect(onTabChange).toHaveBeenLastCalledWith('history')
    fireEvent.keyDown(panel, { key: 'r' })
    expect(onTabChange).toHaveBeenLastCalledWith('current')
    fireEvent.keyDown(panel, { key: 'ㅓ', code: 'KeyJ' })
    expect(onTabChange).toHaveBeenLastCalledWith('history')
    const count = onTabChange.mock.calls.length
    fireEvent.keyDown(panel, { key: 'j', code: 'KeyJ', repeat: true })
    fireEvent.keyDown(panel, { key: 'j', ctrlKey: true })
    fireEvent.keyDown(panel, { key: 'j', isComposing: true })
    const input = document.createElement('input')
    panel.append(input)
    fireEvent.keyDown(input, { key: 'j' })
    expect(onTabChange).toHaveBeenCalledTimes(count)
  })
})
