// @vitest-environment jsdom
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskView, RunView, Task } from '../../shared/contract.ts'
import { Office } from './Office.tsx'
import { buildOffice, departmentOf, seatPosition } from './office.ts'
import { roles } from '../../shared/office-roles.ts'
import { ELEVATOR_RECT, moveVisitor, roomGeometry, VISITOR_SPAWN, type Direction, type Point } from './visitor.ts'
import { moveWithinArea, nearestDoor, roomKeyAt } from './roomNavigation.ts'

const now = Date.parse('2026-10-19T12:00:00.000Z')
const stamp = new Date(now).toISOString()
const staleReport = new Date(now - 31 * 60_000).toISOString()

function makeRun(tasks: Task[], patch: Partial<RunView> = {}): RunView {
  return {
    id: 'visitor-staff-run',
    project_path: '/workspace/visitor-staff',
    title: '직원 살펴보기',
    doc_path: null,
    doc_accessible: false,
    state: { stage: '구현', summary: '실제 직원 정보', tasks },
    last_report_at: stamp,
    ended_at: null,
    ...patch,
  }
}

function OfficeHarness({ run, projectRuns = [run], asks = [] }: { run: RunView; projectRuns?: RunView[]; asks?: AskView[] }) {
  const [visitorEnabled, setVisitorEnabled] = useState(false)
  return <><button type="button" onClick={() => setVisitorEnabled((enabled) => !enabled)}>{visitorEnabled ? '둘러보기 끝내기' : '직접 둘러보기'}</button><Office run={run} projectRuns={projectRuns} asks={asks} now={now} onOpenAsk={() => {}} visitorEnabled={visitorEnabled} /></>
}

const directionKeys: Record<Direction, { key: string; code: string }> = {
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
}

type RouteStep = { type: 'move'; direction: Direction } | { type: 'door' }

function findRoute(start: Point, target: Point, overview = false): RouteStep[] {
  const geometry = roomGeometry(roles.departments)
  const key = (point: Point) => `${point.x},${point.y}`
  const startKey = key(start)
  const targetKey = key(target)
  const queue = [start]
  const previous = new Map<string, { key: string; step: RouteStep }>()
  const visited = new Set([startKey])
  const directions: Direction[] = ['up', 'down', 'left', 'right']

  for (let index = 0; index < queue.length && !visited.has(targetKey); index += 1) {
    const point = queue[index]
    for (const direction of directions) {
      const next = overview ? moveVisitor(point, direction, geometry) : moveWithinArea(point, direction, geometry)
      const nextKey = key(next)
      if (visited.has(nextKey)) continue
      visited.add(nextKey)
      previous.set(nextKey, { key: key(point), step: { type: 'move', direction } })
      queue.push(next)
    }
    if (!overview) {
      const door = nearestDoor(point, geometry)
      if (door) {
        const nextKey = key(door.destination)
        if (!visited.has(nextKey)) {
          visited.add(nextKey)
          previous.set(nextKey, { key: key(point), step: { type: 'door' } })
          queue.push(door.destination)
        }
      }
    }
  }

  if (!visited.has(targetKey)) throw new Error(`No visitor route from ${startKey} to ${targetKey}`)
  const route: RouteStep[] = []
  let cursor = targetKey
  while (cursor !== startKey) {
    const step = previous.get(cursor)!
    route.push(step.step)
    cursor = step.key
  }
  return route.reverse()
}

function employeePoint(run: RunView, owner: string): Point {
  const employee = buildOffice(run, now).employees.find((item) => item.name === owner)
  if (!employee) throw new Error(`Missing employee ${owner}`)
  const room = roles.departments.find((department) => department.key === departmentOf(owner, run.state.tasks?.find((task) => task.owner === owner && task.status === '진행중')?.lane))!
  const seat = seatPosition(room, employee.deskIndex)
  return { x: seat.x * 48, y: seat.y * 48 }
}

function characterFoot(): Point {
  const element = document.querySelector('[data-office-role="representative"]') as HTMLElement
  return { x: Number.parseFloat(element.style.left) + 26, y: Number.parseFloat(element.style.top) + 48 }
}

function moveAlong(map: HTMLElement, route: RouteStep[]) {
  for (const step of route) fireEvent.keyDown(map, step.type === 'door' ? { key: 'Enter', code: 'Enter' } : directionKeys[step.direction])
}

function activeBackendTask(patch: Partial<Task> = {}): Task {
  return { id: 'BACKEND-LIVE', owner: 'backend-1', lane: 'build', status: '진행중', title: 'API 응답 연결', model: 'claude-sonnet', effort: 'high', started: new Date(now - 30 * 60_000).toISOString(), ...patch }
}

function reducedMotionForTest() {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
  return () => original ? Object.defineProperty(window, 'matchMedia', original) : Reflect.deleteProperty(window, 'matchMedia')
}

describe('real Office visitor staff inspection', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })

  it('enters a team through its door, inspects its staff, then exits to the corridor', async () => {
    const run = makeRun([activeBackendTask(), { id: 'FRONTEND-LIVE', owner: 'frontend-1', lane: 'build', status: '진행중', title: '컴포넌트 작업' }])
    run.state.reviews = [{ round: 1, reviewer: 'frontend-1', verdict: 'PASS' }]
    const ask: AskView = { id: 'ask-rep', run_id: run.id, question: '대표 결재', options: ['진행'], recommended: '진행', status: 'pending', answer: null }
    render(<OfficeHarness run={run} asks={[ask]} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    expect(document.querySelector('.office-scene--corridor')).toBeTruthy()
    expect(screen.getByRole('button', { name: '백엔드팀 방으로 이동' })).toBeTruthy()
    expect(document.querySelector('[data-employee="backend-1"]')).toBeNull()
    expect(document.querySelector('.office-stamp')).toBeNull()
    expect(document.querySelector('.office-ask')).toBeNull()
    expect(screen.getByRole('img', { name: '사무실 미니맵 · 현재 위치 복도' })).toBeTruthy()
    expect(document.querySelector('.room-minimap__room--target')).toBeNull()

    const target = employeePoint(run, 'backend-1')
    const route = findRoute(VISITOR_SPAWN, target)
    expect(route.some((step) => step.type === 'door')).toBe(true)
    moveAlong(map, route)
    await waitFor(() => expect(characterFoot()).toEqual(target))
    expect(document.querySelector('.office-scene--room')?.getAttribute('data-active-room')).toBe('백엔드팀')
    expect(document.querySelectorAll('.office-employee')).toHaveLength(1)
    expect(document.querySelector('[data-employee="frontend-1"]')).toBeNull()
    expect(document.querySelector('.office-stamp')).toBeNull()
    expect(document.querySelector('.office-ask')).toBeNull()
    expect(screen.getByRole('img', { name: '사무실 미니맵 · 현재 위치 백엔드팀' })).toBeTruthy()

    fireEvent.keyDown(map, { key: 'Enter', code: 'Enter' })
    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('backend-1 업무')
    fireEvent.keyDown(inspector, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull())

    moveAlong(map, findRoute(characterFoot(), VISITOR_SPAWN))
    await waitFor(() => expect(characterFoot()).toEqual(VISITOR_SPAWN))
    expect(document.querySelector('.office-scene--corridor')).toBeTruthy()
    expect(document.querySelector('[data-employee="backend-1"]')).toBeNull()
    expect(screen.getByRole('img', { name: '사무실 미니맵 · 현재 위치 복도' })).toBeTruthy()
  })

  it('lets J open nearby staff history at an exit and ignores repeated Enter on the map', async () => {
    const run = makeRun([
      activeBackendTask(),
      activeBackendTask({ id: 'BACKEND-2', owner: 'backend-2' }),
      activeBackendTask({ id: 'BACKEND-3', owner: 'backend-3' }),
      activeBackendTask({ id: 'BACKEND-4', owner: 'backend-4' }),
    ])
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    const exitThreshold = { x: 264, y: 696 }
    moveAlong(map, findRoute(VISITOR_SPAWN, exitThreshold))
    await waitFor(() => expect(characterFoot()).toEqual(exitThreshold))
    fireEvent.keyDown(map, { key: 'Enter', code: 'Enter', repeat: true })
    expect(characterFoot()).toEqual(exitThreshold)

    fireEvent.keyDown(map, { key: 'j', code: 'KeyJ' })
    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(within(inspector).getByRole('tab', { name: '업무 기록' }).getAttribute('aria-selected')).toBe('true')
    expect(characterFoot()).toEqual(exitThreshold)
    fireEvent.keyDown(inspector, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull())
    fireEvent.keyDown(map, { key: 'Enter', code: 'Enter' })
    expect(characterFoot()).toEqual({ x: 264, y: 744 })
  })

  it('keeps an open staff report while that employee moves between rooms', async () => {
    const initial = makeRun([
      activeBackendTask(),
      { id: 'BACKEND-IDLE', owner: 'backend-2', lane: 'build', status: '완료', title: '완료된 정리' },
    ])
    const { rerender } = render(<OfficeHarness run={initial} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    await waitFor(() => expect(document.activeElement).toBe(map))
    const route = findRoute(VISITOR_SPAWN, employeePoint(initial, 'backend-1'))
    moveAlong(map, route)
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(initial, 'backend-1')))
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })

    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('backend-1 업무')
    expect(inspector.textContent).toContain('부서 · 백엔드팀')
    expect(inspector.textContent).toContain('작업 · API 응답 연결')
    expect(inspector.textContent).toContain('작업 ID · BACKEND-LIVE')
    expect(inspector.textContent).toContain('경과 시간 · 30분')
    expect(inspector.textContent).toContain('모델 · claude-sonnet')
    expect(inspector.textContent).toContain('노력 · high')
    expect(inspector.getAttribute('aria-modal')).toBe('true')
    fireEvent.click(document.querySelector('.visitor-inspector-backdrop')!)
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' })).toBeTruthy()
    const currentTab = within(inspector).getByRole('tab', { name: '현재 업무' })
    const close = within(inspector).getByRole('button', { name: '닫기' })
    await waitFor(() => expect(document.activeElement).toBe(currentTab))
    fireEvent.keyDown(currentTab, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(currentTab)

    const updated = makeRun([activeBackendTask({ title: 'API 응답 연결과 검증', model: 'gpt-6.1-codex', effort: 'medium', lane: 'plan' }), initial.state.tasks![1]])
    const newPoint = employeePoint(updated, 'backend-1')
    const employee = () => document.querySelector('[data-employee="backend-1"]') as HTMLElement
    rerender(<OfficeHarness run={updated} />)
    await waitFor(() => expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('API 응답 연결과 검증'))
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('모델 · gpt-6.1-codex')
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('노력 · medium')
    expect(document.querySelector('[data-employee="backend-1"]')).toBeNull()

    fireEvent.click(withinInspectorButton())
    expect((screen.getByRole('button', { name: '위로 이동' }) as HTMLButtonElement).disabled).toBe(false)
    const updatedRoute = findRoute(characterFoot(), newPoint)
    moveAlong(map, updatedRoute)
    await waitFor(() => expect(characterFoot()).toEqual(newPoint))
    expect(employee().style.left).toBe(`${newPoint.x - 26}px`)
    expect(employee().style.top).toBe(`${newPoint.y - 48}px`)
    fireEvent.keyDown(map, { key: 'Enter', code: 'Enter' })
    expect(await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })).toBeTruthy()

    const away = makeRun([activeBackendTask({ title: '최신 진행 기록', model: undefined, effort: undefined, lane: 'plan' })], { last_report_at: staleReport })
    rerender(<OfficeHarness run={away} />)
    await waitFor(() => expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('상태 · 자리 비움'))
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('모델 · 미보고')
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('노력 · 미보고')

    const removed = makeRun([initial.state.tasks![1]], { last_report_at: stamp })
    rerender(<OfficeHarness run={removed} />)
    const unavailable = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(unavailable.textContent).toContain('직원을 찾을 수 없습니다')
    expect(unavailable.textContent).toContain('최신 보고에서 해당 직원이 사라졌습니다.')
    expect(unavailable.textContent).not.toContain('최신 진행 기록')

    const ended = makeRun([activeBackendTask({ title: '끝난 run의 이전 작업', lane: 'plan' })], { ended_at: stamp })
    rerender(<OfficeHarness run={ended} />)
    const endedInspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(endedInspector.textContent).toContain('backend-1 업무')
    expect(endedInspector.textContent).toContain('끝난 run의 이전 작업')
    expect(endedInspector.textContent).toContain('상태 · 업무 종료')
  })

  it('keeps completed assigned work and missing metadata visible for an inspectable idle employee', async () => {
    const run = makeRun([{ id: 'BACKEND-DONE', owner: 'backend-2', lane: 'build', status: '완료', title: '완료된 작업' }])
    const previous = makeRun([{ id: 'BACKEND-OLD', owner: 'backend-2', lane: 'build', status: '완료', title: '이전 실행 업무' }], { id: 'visitor-staff-history', title: '이전 실행 보고', last_report_at: staleReport, ended_at: staleReport })
    render(<OfficeHarness run={run} projectRuns={[run, previous]} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    moveAlong(map, findRoute(VISITOR_SPAWN, employeePoint(run, 'backend-2')))
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(run, 'backend-2')))
    fireEvent.keyDown(map, { key: 'j', code: 'KeyJ' })
    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(screen.getByRole('tab', { name: '업무 기록' }).getAttribute('aria-selected')).toBe('true')
    expect(inspector.textContent).toContain('이전 실행 업무')
    const historyTab = screen.getByRole('tab', { name: '업무 기록' })
    fireEvent.keyDown(historyTab, { key: 'r' })
    expect(screen.getByRole('tab', { name: '현재 업무' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: '현재 업무' }), { key: 'j' })
    expect(screen.getByRole('tab', { name: '업무 기록' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: '업무 기록' }), { key: 'r' })
    expect(screen.getByRole('tab', { name: '현재 업무' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(withinInspectorButton())
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(screen.getByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeTruthy()
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const currentInspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(currentInspector.textContent).toContain('backend-2 업무')
    expect(currentInspector.textContent).toContain('상태 · 완료 후 대기')
    expect(currentInspector.textContent).toContain('작업 · 완료된 작업')
    expect(currentInspector.textContent).toContain('상태 · 완료')
    expect(currentInspector.textContent).toContain('모델 · 미보고')
    expect(currentInspector.textContent).toContain('노력 · 미보고')
    fireEvent.keyDown(screen.getByRole('tab', { name: '현재 업무' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '위로 이동' }) as HTMLButtonElement).disabled).toBe(false)
    const beforeCloseMovement = characterFoot()
    fireEvent.keyDown(map, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(characterFoot()).not.toEqual(beforeCloseMovement)
    fireEvent.keyDown(map, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeNull()
  })

  it('uses Enter to advance current work to history, then closes and resumes map movement', async () => {
    const run = makeRun([activeBackendTask()])
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    moveAlong(map, findRoute(VISITOR_SPAWN, employeePoint(run, 'backend-1')))
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(run, 'backend-1')))
    fireEvent.keyDown(map, { key: 'Enter', code: 'Enter' })

    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('Enter 기록 → Enter 닫고 계속 · Esc 닫기')
    const current = within(inspector).getByRole('tab', { name: '현재 업무' })
    await waitFor(() => expect(document.activeElement).toBe(current))
    fireEvent.keyDown(current, { key: 'Enter', code: 'Enter' })
    const history = within(inspector).getByRole('tab', { name: '업무 기록' })
    expect(history.getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(history))

    fireEvent.keyDown(history, { key: 'Enter', code: 'Enter', repeat: true })
    fireEvent.keyDown(history, { key: 'Enter', code: 'Enter', ctrlKey: true })
    fireEvent.keyDown(history, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' })).toBeTruthy()
    fireEvent.keyDown(history, { key: 'Enter', code: 'Enter' })
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(map))

    const before = characterFoot()
    fireEvent.keyDown(map, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(characterFoot()).not.toEqual(before)
  })

  it.each(['removed', 'ended'] as const)('keeps the report panel keyboard usable when its employee is %s in an open overview', async (disposition) => {
    const run = makeRun([activeBackendTask()])
    const { rerender } = render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    await waitFor(() => expect(document.activeElement).toBe(map))
    moveAlong(map, findRoute(VISITOR_SPAWN, employeePoint(run, 'backend-1'), true))
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(run, 'backend-1')))
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    const currentTab = within(inspector).getByRole('tab', { name: '현재 업무' })
    await waitFor(() => expect(document.activeElement).toBe(currentTab))

    const latest = disposition === 'removed' ? makeRun([], { id: run.id }) : { ...run, ended_at: stamp }
    rerender(<OfficeHarness run={latest} />)
    const unavailable = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    if (disposition === 'removed') expect(unavailable.textContent).toContain('직원을 찾을 수 없습니다')
    else {
      expect(unavailable.textContent).toContain('backend-1 업무')
      expect(unavailable.textContent).toContain('상태 · 업무 종료')
    }
    const close = within(unavailable).getByRole('button', { name: '닫기' })
    await waitFor(() => expect(document.activeElement).toBe(disposition === 'removed' ? close : currentTab))
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeTruthy()
  })

  it('inspects an employee literally named elevator after walking to that employee', async () => {
    const run = makeRun([{ id: 'ELEVATOR-OWNER', owner: 'elevator', lane: 'build', status: '진행중', title: '승강기와 별개인 실제 작업', model: 'gpt-6.1-codex', effort: 'low' }])
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    const target = employeePoint(run, 'elevator')
    moveAlong(map, findRoute(VISITOR_SPAWN, target))
    await waitFor(() => expect(characterFoot()).toEqual(target))
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('elevator 업무')
    expect(inspector.textContent).toContain('작업 · 승강기와 별개인 실제 작업')
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
  })

  it('keeps staff positions immediate during visitor live updates and honors reduced motion for ordinary mode', async () => {
    const initial = makeRun([activeBackendTask({ lane: 'build' })])
    const { rerender } = render(<OfficeHarness run={initial} />)
    const employee = () => document.querySelector('[data-employee="backend-1"]') as HTMLElement
    const ordinaryBefore = { left: employee().style.left, top: employee().style.top }
    const ordinaryUpdate = makeRun([activeBackendTask({ lane: 'plan', title: '계획으로 이동' })])
    rerender(<OfficeHarness run={ordinaryUpdate} />)
    expect({ left: employee().style.left, top: employee().style.top }).not.toEqual(ordinaryBefore)
    expect(employee().classList.contains('office-employee--visitor')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(employee().classList.contains('office-employee--visitor')).toBe(true)
    const visitorBefore = { left: employee().style.left, top: employee().style.top }
    const visitorUpdate = makeRun([activeBackendTask({ lane: 'review', title: '리뷰로 이동' })])
    rerender(<OfficeHarness run={visitorUpdate} />)
    expect({ left: employee().style.left, top: employee().style.top }).not.toEqual(visitorBefore)
    expect(employee().classList.contains('office-employee--visitor')).toBe(true)

    // jsdom does not evaluate imported CSS rules. Assert the shipped stylesheet's
    // actual transition policy, including its reduced-motion override.
    const css = readFileSync('web/src/office.css', 'utf8')
    expect(css).toMatch(/\.office-employee\s*\{[^}]*transition:\s*left\s+900ms[^}]*top\s+900ms/s)
    expect(css).toMatch(/\.office-employee--visitor\s*\{\s*transition:\s*none;\s*\}/)
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.office-employee[^}]*transition:\s*none;/)
  })
})

function withinInspectorButton() {
  return [...screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).querySelectorAll('button')].find((button) => button.textContent === '닫기')!
}

describe('clicking staff to inspect work', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })
  it.each(['visitor overview', 'paused visitor overview'])('opens work from the character and bubble in %s', async (mode) => {
    const run = makeRun([activeBackendTask()])
    render(<OfficeHarness run={run} />)
    const visiting = mode.includes('visitor')
    if (visiting) fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    if (mode.includes('overview')) fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    if (mode.startsWith('paused')) fireEvent.keyDown(screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' }), { key: ' ', code: 'Space' })
    const employee = screen.getByRole('button', { name: 'backend-1 현재 업무 보기' })
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    for (const target of ['.office-person', '.office-bubble']) {
      fireEvent.click(employee.querySelector(target)!)
      const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' }, { timeout: 2000 })
      expect(inspector.textContent).toContain('backend-1 업무')
      expect(inspector.textContent).toContain('작업 · API 응답 연결')
      const currentTab = within(inspector).getByRole('tab', { name: '현재 업무' })
      expect(currentTab.getAttribute('aria-selected')).toBe('true')
      await waitFor(() => expect(document.activeElement).toBe(currentTab))
      expect(roomKeyAt(characterFoot(), roomGeometry(roles.departments))).toBe('백엔드팀')
      if (visiting) expect(characterFoot()).not.toEqual(VISITOR_SPAWN)
      fireEvent.click(within(inspector).getByRole('tab', { name: '업무 기록' }))
      fireEvent.click(within(inspector).getByRole('button', { name: '닫기' }))
      expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(visiting ? map : employee))
    }
    if (mode.startsWith('paused')) expect((screen.getByRole('button', { name: '위로 이동' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('blocks staff clicks during an external dialog but keeps ended staff inspectable', async () => {
    const run = makeRun([activeBackendTask()])
    const props = { run, asks: [], now, onOpenAsk: () => {} }
    const { rerender } = render(<Office {...props} visitorEnabled={false} interactionBlocked />)
    const employee = document.querySelector<HTMLButtonElement>('[data-employee="backend-1"]')!
    expect(employee.disabled).toBe(true)
    fireEvent.click(employee)
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    rerender(<Office {...props} run={{ ...run, ended_at: stamp }} visitorEnabled={false} />)
    expect(employee.disabled).toBe(false)
    fireEvent.click(employee)
    expect((await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })).textContent).toContain('상태 · 업무 종료')
  })
})

describe('walking to clicked staff', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

  it('moves before opening work and replaces the destination on another click', () => {
    const run = makeRun([activeBackendTask(), activeBackendTask({ id: 'FE', owner: 'frontend-1', title: '화면 구현' })])
    render(<OfficeHarness run={run} />)
    const start = characterFoot()
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    advance(200)
    expect(characterFoot()).not.toEqual(start)
    fireEvent.click(screen.getByRole('button', { name: 'frontend-1 현재 업무 보기' }))
    expect(screen.getByText('frontend-1에게 이동 중…')).toBeTruthy()
    advance(950)
    expect(roomKeyAt(characterFoot(), roomGeometry(roles.departments))).toBe('프론트엔드팀')
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('frontend-1 업무')
  })

  it('continues an active walk from the remapped visitor position after the layout grows', () => {
    const run = makeRun([activeBackendTask()])
    const { rerender } = render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    advance(200)
    const beforeGrowth = characterFoot()
    const plans = Array.from({ length: 12 }, (_, index) => activeBackendTask({ id: `P-${index}`, owner: `plan-${index}`, lane: 'plan' }))
    rerender(<Office run={makeRun([activeBackendTask(), ...plans])} asks={[]} now={now} onOpenAsk={() => {}} />)
    const remapped = characterFoot()
    expect(remapped.y).toBeGreaterThan(beforeGrowth.y)
    advance(48)
    const next = characterFoot()
    expect(Math.hypot(next.x - remapped.x, next.y - remapped.y)).toBeLessThanOrEqual(96)
    advance(1000)
    const backend = screen.getByRole('region', { name: '백엔드팀' }) as HTMLElement
    expect(characterFoot().y).toBeGreaterThan(Number.parseFloat(backend.style.top))
    expect(characterFoot().y).toBeLessThan(Number.parseFloat(backend.style.top) + Number.parseFloat(backend.style.height))
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('backend-1 업무')
  })

  it('walks to the elevator before opening one picker, ignoring repeated elevator clicks', () => {
    const run = makeRun([activeBackendTask()])
    render(<OfficeHarness run={run} />)
    const start = characterFoot()
    const elevator = screen.getByRole('button', { name: '엘리베이터 층간 이동' })
    fireEvent.click(elevator)
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    advance(200)
    expect(characterFoot()).not.toEqual(start)
    fireEvent.click(elevator)
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    advance(950)
    expect(screen.getAllByRole('dialog', { name: '다른 프로젝트 층 선택' })).toHaveLength(1)
    expect(screen.queryByText('엘리베이터로 이동 중…')).toBeNull()
  })

  it('cancels elevator arrival when another click selects an employee', () => {
    const run = makeRun([activeBackendTask()])
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '엘리베이터 층간 이동' }))
    advance(200)
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    advance(950)
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
  })

  it('keeps the map focused for manual cancellation and reports an unreachable elevator safely', () => {
    render(<OfficeHarness run={makeRun([activeBackendTask()])} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    fireEvent.click(screen.getByRole('button', { name: '엘리베이터 층간 이동' }))
    advance(16)
    expect(document.activeElement).toBe(map)
    fireEvent.keyDown(map, { key: 'ArrowLeft', code: 'ArrowLeft' })
    advance(950)
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()

    const originalX = ELEVATOR_RECT.x
    ELEVATOR_RECT.x = 1_000_000
    try {
      fireEvent.click(screen.getByRole('button', { name: '엘리베이터 층간 이동' }))
      expect(screen.getByText('엘리베이터까지 가는 길을 찾을 수 없습니다.')).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    } finally {
      ELEVATOR_RECT.x = originalX
    }
  })

  it('lets keyboard visitors inspect a gone employee without restoring its scene animation', async () => {
    const run = makeRun([activeBackendTask({ title: '종료한 직원의 기록' })], { ended_at: stamp })
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    const employee = screen.getByRole('button', { name: 'backend-1 현재 업무 보기' })
    expect(employee.getAttribute('data-state')).toBe('gone')
    expect((employee as HTMLButtonElement).disabled).toBe(false)
    moveAlong(map, findRoute(VISITOR_SPAWN, employeePoint(run, 'backend-1'), true))
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(run, 'backend-1')))
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const inspector = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('종료한 직원의 기록')
    expect(inspector.textContent).toContain('상태 · 업무 종료')
  })

  it.each(['blocked', 'removed', 'ended', 'changed run'] as const)('cancels arrival when %s', (reason) => {
    const run = makeRun([activeBackendTask()])
    const props = { run, asks: [], now, onOpenAsk: () => {} }
    const { rerender } = render(<Office {...props} visitorEnabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    advance(200)
    const updated = reason === 'removed' ? makeRun([])
      : reason === 'ended' ? { ...run, ended_at: stamp }
      : reason === 'changed run' ? { ...run, id: 'another-run' } : run
    rerender(<Office {...props} run={updated} visitorEnabled={false} interactionBlocked={reason === 'blocked'} />)
    advance(1000)
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    expect(screen.queryByText('backend-1에게 이동 중…')).toBeNull()
  })

  it('cancels automatic walking when the user moves manually', () => {
    render(<OfficeHarness run={makeRun([activeBackendTask()])} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    advance(200)
    fireEvent.keyDown(screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' }), { key: 'ArrowRight', code: 'ArrowRight' })
    const stopped = characterFoot()
    advance(1000)
    expect(characterFoot()).toEqual(stopped)
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
  })

  it('arrives inside the meeting room for staff seated near its bottom wall', () => {
    const run = makeRun(['Planner', 'Architect', 'Critic'].map((owner) => activeBackendTask({ id: owner, owner, lane: 'plan' })))
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: 'Critic 현재 업무 보기' }))
    advance(1000)
    expect(roomKeyAt(characterFoot(), roomGeometry(roles.departments))).toBe('회의실')
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' }).textContent).toContain('Critic 업무')
  })

  it('cancels on Escape without opening a report later', () => {
    render(<OfficeHarness run={makeRun([activeBackendTask()])} />)
    const employee = screen.getByRole('button', { name: 'backend-1 현재 업무 보기' })
    fireEvent.click(employee)
    advance(200)
    fireEvent.keyDown(employee, { key: 'Escape' })
    advance(1000)
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    expect(screen.queryByText('backend-1에게 이동 중…')).toBeNull()
  })

  it('skips animation for reduced motion and cleans up pending movement on unmount', () => {
    const run = makeRun([activeBackendTask()])
    const first = render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    first.unmount()
    advance(1000)
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: 'backend-1 현재 업무 보기' }))
    expect(roomKeyAt(characterFoot(), roomGeometry(roles.departments))).toBe('백엔드팀')
    expect(screen.getByRole('dialog', { name: '직원 업무 살펴보기' })).toBeTruthy()
  })
})

describe('walking to selected rooms', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  const geometry = roomGeometry(roles.departments)

  it.each([false, true])('uses every room shortcut, map door, and room header to walk inside the selected room (overview: %s)', (overview) => {
    const restoreMotion = reducedMotionForTest()
    try {
      const run = makeRun([])
      const shortcuts = render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled />)
      if (overview) fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))

      for (const room of geometry.rooms) {
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${room.name}$`) }))
        expect(roomKeyAt(characterFoot(), geometry), `${room.name} shortcut`).toBe(room.key)
        expect((document.querySelector('.office-scene') as HTMLElement).dataset.activeRoom).toBe(room.key)
      }

      shortcuts.unmount()
      const doors = render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled />)
      if (overview) fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
      const map = screen.getByRole('region', { name: `${run.title} 사무실 바닥` })
      expect(characterFoot()).toEqual(VISITOR_SPAWN)
      for (const room of geometry.rooms) {
        fireEvent.click(within(map).getByRole('button', { name: `${room.name} 방으로 이동` }))
        expect(roomKeyAt(characterFoot(), geometry), `${room.name} map door`).toBe(room.key)
        expect((document.querySelector('.office-scene') as HTMLElement).dataset.activeRoom).toBe(room.key)
      }
      doors.unmount()

      const headers = render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled />)
      if (overview) fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
      const headerMap = screen.getByRole('region', { name: `${run.title} 사무실 바닥` })
      for (const room of geometry.rooms) {
        fireEvent.click(within(headerMap).getByRole('button', { name: `${room.name} 지도 구역` }))
        expect(roomKeyAt(characterFoot(), geometry), `${room.name} room header`).toBe(room.key)
        expect((document.querySelector('.office-scene') as HTMLElement).dataset.activeRoom).toBe(room.key)
      }
      headers.unmount()
    } finally {
      restoreMotion()
    }
  })

  it('starts browsing on a direct Office render without a start or end toggle', () => {
    render(<Office run={makeRun([])} asks={[]} now={now} onOpenAsk={() => {}} />)
    expect(characterFoot()).toEqual(VISITOR_SPAWN)
    expect(document.querySelector('.office-scene--corridor')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '직접 둘러보기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '둘러보기 끝내기' })).toBeNull()
  })

  it('retargets a room walk, then manual movement, pause, and Escape cancel it', () => {
    const run = makeRun([])
    render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled />)
    const map = screen.getByRole('region', { name: `${run.title} 사무실 바닥` })

    fireEvent.click(screen.getByRole('button', { name: /^백엔드팀$/ }))
    expect(screen.getByText('백엔드팀 방으로 이동 중…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^회의실$/ }))
    expect(screen.getByText('회의실 방으로 이동 중…')).toBeTruthy()

    advance(100)
    fireEvent.keyDown(map, { key: 'ArrowRight', code: 'ArrowRight' })
    expect(screen.queryByText(/방으로 이동 중/)).toBeNull()
    const manuallyMoved = characterFoot()
    advance(1000)
    expect(characterFoot()).toEqual(manuallyMoved)

    fireEvent.click(screen.getByRole('button', { name: '백엔드팀 방으로 이동' }))
    expect(screen.getByText('백엔드팀 방으로 이동 중…')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' }), { key: ' ', code: 'Space' })
    expect(screen.queryByText(/방으로 이동 중/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^회의실$/ }))
    expect(screen.getByText('회의실 방으로 이동 중…')).toBeTruthy()
    expect((screen.getByRole('button', { name: '위로 이동' }) as HTMLButtonElement).disabled).toBe(false)
    advance(1000)
    expect(roomKeyAt(characterFoot(), geometry)).toBe('회의실')
    fireEvent.click(screen.getByRole('button', { name: '백엔드팀 방으로 이동' }))
    expect(screen.getByText('백엔드팀 방으로 이동 중…')).toBeTruthy()
    fireEvent.keyDown(map, { key: 'Escape' })
    expect(screen.queryByText(/방으로 이동 중/)).toBeNull()
    advance(1000)
    expect(screen.queryByRole('dialog', { name: '직원 업무 살펴보기' })).toBeNull()
  })

  it.each(['room shortcut', 'compact direction control'])('cancels a room walk when Escape is pressed on a sibling %s', (focusedControl) => {
    const run = makeRun([])
    render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled />)
    fireEvent.click(screen.getByRole('button', { name: /^회의실$/ }))
    advance(100)
    const beforeEscape = characterFoot()
    const control = focusedControl === 'room shortcut'
      ? screen.getByRole('button', { name: /^백엔드팀$/ })
      : screen.getByRole('button', { name: '위로 이동' })
    control.focus()
    expect(document.activeElement).toBe(control)

    fireEvent.keyDown(control, { key: 'Escape' })
    advance(1000)

    expect(characterFoot()).toEqual(beforeEscape)
    expect(screen.queryByText('회의실 방으로 이동 중…')).toBeNull()
  })

  it('leaves modified, composing, and editable Escape events to their owners', () => {
    const run = makeRun([])
    render(<Office run={run} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled />)
    fireEvent.click(screen.getByRole('button', { name: /^회의실$/ }))
    const status = () => screen.getByText('회의실 방으로 이동 중…')
    const control = screen.getByRole('button', { name: /^백엔드팀$/ })
    control.focus()
    expect(fireEvent.keyDown(control, { key: 'Escape', altKey: true })).toBe(true)
    expect(status()).toBeTruthy()
    expect(fireEvent.keyDown(control, { key: 'Escape', isComposing: true })).toBe(true)
    expect(status()).toBeTruthy()

    const input = document.createElement('input')
    document.querySelector('.office-panel')?.append(input)
    input.focus()
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true)
    expect(status()).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('region', { name: `${run.title} 사무실 바닥` }), { key: 'Escape' })
    expect(screen.queryByText('회의실 방으로 이동 중…')).toBeNull()
  })

  it('reports an unreachable room route and restores the department geometry', () => {
    const backend = roles.departments.find(({ key }) => key === '백엔드팀')!
    const previousX = backend.x
    backend.x = -10_000
    try {
      render(<Office run={makeRun([])} asks={[]} now={now} onOpenAsk={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: /^백엔드팀$/ }))
      expect(screen.getByText('백엔드팀까지 가는 길을 찾을 수 없습니다.')).toBeTruthy()
      expect(roomKeyAt(characterFoot(), geometry)).toBeNull()
    } finally {
      backend.x = previousX
    }
  })
})
