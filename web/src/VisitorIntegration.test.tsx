// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskView, ProjectView, RunView, StateSnapshot } from '../../shared/contract.ts'
import App from './App.tsx'
import { getDoc, getState, subscribe } from './api.ts'
import { buildOffice, departmentOf, seatPosition } from './office.ts'
import roles from './roles.json' with { type: 'json' }
import { moveVisitor, roomGeometry, VISITOR_SPAWN, type Direction, type Point } from './visitor.ts'

vi.mock('./api.ts', () => ({ getState: vi.fn(), getDoc: vi.fn(), subscribe: vi.fn(() => vi.fn()), answerAsk: vi.fn() }))

const stamp = '2026-10-19T07:00:00.000Z'

function run(id: string, projectPath: string, title: string, date: string, options: { ended?: string | null; summary?: string; task?: RunView['state']['tasks'] } = {}): RunView {
  return {
    id,
    project_path: projectPath,
    title,
    doc_path: null,
    doc_accessible: false,
    state: { stage: options.ended ? '완료' : '구현', summary: options.summary ?? `${title} 요약`, tasks: options.task ?? [] },
    last_report_at: date,
    ended_at: options.ended ?? null,
  }
}

const alphaPath = '/workspace/alpha'
const betaPath = '/workspace/beta'
const alphaCurrent = run('alpha-current', alphaPath, 'Alpha 현재 run', '2026-10-19T07:40:00.000Z', {
  summary: 'alpha 현재 작업 요약',
  task: [{ id: 'alpha-task', owner: 'frontend-alpha', lane: 'build', status: '진행중', title: 'Alpha 작업', model: 'claude-sonnet', effort: 'medium', started: '2026-10-19T07:20:00.000Z' }],
})
const alphaOther = run('alpha-other', alphaPath, 'Alpha 다른 run', '2026-10-19T07:20:00.000Z')
const alphaEnded = run('alpha-ended', alphaPath, 'Alpha 과거 스냅샷', '2026-10-19T06:00:00.000Z', { ended: '2026-10-19T06:30:00.000Z', summary: 'Alpha 과거 기록 요약' })
const betaLatest = run('beta-latest', betaPath, 'Beta 최신 run', '2026-10-19T07:50:00.000Z', {
  summary: 'beta latest summary',
  task: [{ id: 'beta-task', owner: 'frontend-beta', lane: 'build', status: '진행중', title: 'Beta 화면 구현', model: 'claude-opus', effort: 'high', started: '2026-10-19T07:30:00.000Z' }],
})
const betaOlder = run('beta-older', betaPath, 'Beta 이전 run', '2026-10-19T07:30:00.000Z', {
  task: [{ id: 'beta-older-task', owner: 'backend-beta', lane: 'build', status: '진행중', title: 'Beta API 구현', model: 'claude-haiku', effort: 'low' }],
})
const betaEnded = run('beta-ended', betaPath, 'Beta 과거 run', '2026-10-19T06:10:00.000Z', { ended: '2026-10-19T06:40:00.000Z' })
const endedOnlyPath = '/workspace/ended-only'
const endedOnly = run('ended-only-run', endedOnlyPath, '종료된 프로젝트 run', '2026-10-19T06:20:00.000Z', { ended: '2026-10-19T06:50:00.000Z' })
const projects: ProjectView[] = [
  { path: alphaPath, name: 'Alpha 프로젝트', in_workspace: true, runs: [alphaCurrent, alphaOther, alphaEnded] },
  { path: betaPath, name: 'Beta 프로젝트', in_workspace: true, runs: [betaOlder, betaEnded, betaLatest] },
  { path: endedOnlyPath, name: '종료 전용 프로젝트', in_workspace: true, runs: [endedOnly] },
  { path: '/workspace/empty', name: '빈 프로젝트', in_workspace: true, runs: [] },
]
const asks: AskView[] = [
  { id: 'alpha-ask', run_id: alphaCurrent.id, question: 'Alpha 결재 질문', options: ['진행', '보류'], recommended: '진행', status: 'pending', answer: null },
  { id: 'beta-other-run-ask', run_id: betaOlder.id, question: 'Beta 다른 run 승인 질문', options: ['승인', '보류'], recommended: '승인', status: 'pending', answer: null },
]
const fixture: StateSnapshot = { projects, asks }
let stateChanged: (() => void) | undefined

const directionKeys: Record<Direction, { key: string; code: string }> = {
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
}

function routeTo(start: Point, target: Point): Direction[] {
  const geometry = roomGeometry(roles.departments)
  const key = (point: Point) => `${point.x},${point.y}`
  const startKey = key(start)
  const targetKey = key(target)
  const queue = [start]
  const previous = new Map<string, { key: string; direction: Direction }>()
  const visited = new Set([startKey])
  for (let index = 0; index < queue.length && !visited.has(targetKey); index += 1) {
    const point = queue[index]
    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const next = moveVisitor(point, direction, geometry)
      const nextKey = key(next)
      if (visited.has(nextKey)) continue
      visited.add(nextKey)
      previous.set(nextKey, { key: key(point), direction })
      queue.push(next)
    }
  }
  if (!visited.has(targetKey)) throw new Error(`No visitor route from ${startKey} to ${targetKey}`)
  const route: Direction[] = []
  let cursor = targetKey
  while (cursor !== startKey) {
    const step = previous.get(cursor)!
    route.push(step.direction)
    cursor = step.key
  }
  return route.reverse()
}

function employeePoint(runView: RunView, owner: string): Point {
  const employee = buildOffice(runView, Date.parse(stamp)).employees.find((item) => item.name === owner)
  if (!employee) throw new Error(`Missing employee ${owner}`)
  const task = runView.state.tasks?.find((item) => item.owner === owner && item.status === '진행중')
  const room = roles.departments.find((department) => department.key === departmentOf(owner, task?.lane))!
  const seat = seatPosition(room, employee.deskIndex)
  return { x: seat.x * 48, y: seat.y * 48 }
}

function visitorFoot(): Point {
  const element = document.querySelector('[data-office-role="representative"]') as HTMLElement
  return { x: Number.parseFloat(element.style.left) + 26, y: Number.parseFloat(element.style.top) + 48 }
}

function walkTo(map: HTMLElement, target: Point) {
  for (const direction of routeTo(VISITOR_SPAWN, target)) fireEvent.keyDown(map, directionKeys[direction])
}

describe('visitor elevator App integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    vi.mocked(getState).mockResolvedValue(fixture)
    vi.mocked(getDoc).mockResolvedValue({ path: '', text: '' })
    vi.mocked(subscribe).mockImplementation((onChanged) => {
      stateChanged = onChanged
      return vi.fn()
    })
    window.location.hash = `#/run/${alphaCurrent.id}`
  })

  it('walks through the real Office elevator, selects a destination project and keeps run-scoped data correct', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Alpha 프로젝트' })).toBeTruthy()
    const journal = screen.getByRole('complementary', { name: '프로젝트 기록과 문서' })
    fireEvent.click(within(journal).getByRole('button', { name: /Alpha 과거 스냅샷/ }))
    expect(screen.getByRole('dialog', { name: 'Alpha 과거 스냅샷' })).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: /대표실 결재 대기/ }))
    expect(screen.getByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '결재 창 닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: 'Alpha 현재 run 사무실 바닥' })
    const representative = () => document.querySelector('[data-office-role="representative"]') as HTMLElement
    expect(representative().style.left).toBe('142px')
    fireEvent.keyDown(map, { key: 'ArrowRight', code: 'ArrowRight' })
    await waitFor(() => expect(representative().style.left).toBe('166px'))

    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const picker = await screen.findByRole('dialog', { name: '다른 프로젝트 층 선택' })
    const emptyFloor = within(picker).getByRole('button', { name: /빈 프로젝트/ }) as HTMLButtonElement
    const endedFloor = within(picker).getByRole('button', { name: /종료 전용 프로젝트/ }) as HTMLButtonElement
    expect(emptyFloor.disabled).toBe(true)
    expect(endedFloor.disabled).toBe(false)
    fireEvent.click(within(picker).getByRole('button', { name: /Beta 프로젝트/ }))

    await waitFor(() => expect(window.location.hash).toBe(`#/run/${betaLatest.id}`))
    expect(await screen.findByRole('heading', { name: 'Beta 프로젝트' })).toBeTruthy()
    expect(screen.getByText('beta latest summary')).toBeTruthy()
    expect(screen.getByText('모델 · claude-opus')).toBeTruthy()
    expect(screen.getByText('노력 · high')).toBeTruthy()
    expect(screen.getByRole('button', { name: '둘러보기 끝내기' })).toBeTruthy()
    expect(representative().style.left).toBe('142px')
    expect(representative().style.top).toBe('1392px')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Beta 최신 run 사무실 바닥' })))

    expect(screen.queryByRole('dialog', { name: 'Alpha 과거 스냅샷' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeNull()
    expect(document.querySelector('.ask-ticket')?.textContent).toContain('Beta 다른 run 승인 질문')
    expect(document.querySelector('.office-ask')).toBeNull()

    const runPicker = screen.getByRole('combobox', { name: '진행 중 run' })
    fireEvent.change(runPicker, { target: { value: betaOlder.id } })
    await waitFor(() => expect(window.location.hash).toBe(`#/run/${betaOlder.id}`))
    expect(await screen.findByText('Beta API 구현')).toBeTruthy()
    expect(document.querySelector('.office-ask')?.textContent).toContain('Beta 다른 run 승인 질문')
    expect(document.querySelector('.ask-ticket')?.textContent).toContain('Beta 다른 run 승인 질문')

    fireEvent.change(screen.getByRole('combobox', { name: '진행 중 run' }), { target: { value: betaLatest.id } })
    await waitFor(() => expect(window.location.hash).toBe(`#/run/${betaLatest.id}`))
    await waitFor(() => expect(document.querySelector('.office-ask')).toBeNull())
    expect(screen.getByRole('button', { name: '둘러보기 끝내기' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Beta 다른 run 승인 질문/ }))
    expect(screen.getByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeTruthy()
    window.location.hash = `#/run/${alphaCurrent.id}`
    await waitFor(() => expect(window.location.hash).toBe(`#/run/${alphaCurrent.id}`))
    expect(await screen.findByText('alpha 현재 작업 요약')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeNull()
    expect(screen.getByRole('button', { name: '둘러보기 끝내기' })).toBeTruthy()
    expect(representative().style.left).toBe('142px')
    expect(representative().style.top).toBe('1392px')

    window.history.back()
    await waitFor(() => expect(window.location.hash).toBe(`#/run/${betaLatest.id}`))
    expect(await screen.findByText('beta latest summary')).toBeTruthy()
    expect(screen.getByRole('button', { name: '둘러보기 끝내기' })).toBeTruthy()
    expect(representative().style.left).toBe('142px')
    expect(representative().style.top).toBe('1392px')

    const latestMap = screen.getByRole('region', { name: 'Beta 최신 run 사무실 바닥' })
    fireEvent.keyDown(latestMap, { key: 'e', code: 'KeyE' })
    expect(await screen.findByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeTruthy()
    window.location.hash = `#/run/${betaOlder.id}`
    await waitFor(() => expect(window.location.hash).toBe(`#/run/${betaOlder.id}`))
    expect(await screen.findByText('Beta API 구현')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    expect(screen.getByRole('button', { name: '둘러보기 끝내기' })).toBeTruthy()
    expect(representative().style.left).toBe('142px')
    expect(representative().style.top).toBe('1392px')
  })

  it('disables an elevator destination when a live snapshot empties it before selection', async () => {
    render(<App />)
    const visitorButton = await screen.findByRole('button', { name: '직접 둘러보기' })
    fireEvent.click(visitorButton)
    const map = screen.getByRole('region', { name: 'Alpha 현재 run 사무실 바닥' })
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const picker = await screen.findByRole('dialog', { name: '다른 프로젝트 층 선택' })
    await waitFor(() => expect(stateChanged).toBeTypeOf('function'))

    const emptiedFixture: StateSnapshot = {
      ...fixture,
      projects: fixture.projects.map((project) => project.path === betaPath ? { ...project, runs: [] } : project),
    }
    vi.mocked(getState).mockResolvedValue(emptiedFixture)
    await act(async () => {
      stateChanged?.()
      await Promise.resolve()
    })

    const noReportFloor = await within(picker).findByRole('button', { name: /Beta 프로젝트.*보고 없음/ }) as HTMLButtonElement
    await waitFor(() => expect(noReportFloor.disabled).toBe(true))
    expect(window.location.hash).toBe(`#/run/${alphaCurrent.id}`)
    expect(screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeTruthy()
  })

  it('moves from real staff inspection through overview into the real approval dialog without restoring stale Office focus', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: 'Alpha 현재 run 사무실 바닥' })
    const staffTarget = employeePoint(alphaCurrent, 'frontend-alpha')
    walkTo(map, staffTarget)
    await waitFor(() => expect(visitorFoot()).toEqual(staffTarget))
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const inspector = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('frontend-alpha 업무')
    const currentReportTab = within(inspector).getByRole('tab', { name: '현재 업무' })
    await waitFor(() => expect(document.activeElement).toBe(currentReportTab))

    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(await screen.findByRole('dialog', { name: 'Alpha 현재 run 사무실' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '직원 업무 살펴보기' })).toBeNull()

    fireEvent.click(document.querySelector('.ask-ticket') as HTMLButtonElement)
    const approval = await screen.findByRole('dialog', { name: '대표님의 결정이 필요합니다' })
    expect(approval.textContent).toContain('Alpha 결재 질문')
    await waitFor(() => expect(document.activeElement).toBe(within(approval).getByRole('button', { name: /진행/ })))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Alpha 현재 run 사무실' })).toBeNull())
    expect(screen.queryByRole('complementary', { name: '직원 업무 살펴보기' })).toBeNull()

    fireEvent.click(within(approval).getByRole('button', { name: '결재 창 닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeNull())
    await waitFor(() => expect(document.activeElement).not.toBe(currentReportTab))
    expect(screen.queryByRole('complementary', { name: '직원 업무 살펴보기' })).toBeNull()
    expect(screen.getByRole('button', { name: '둘러보기 재개' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '둘러보기 재개' }))
    await waitFor(() => expect(document.activeElement).toBe(map))
  })
})
