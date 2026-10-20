// @vitest-environment jsdom
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunView, Task } from '../../shared/contract.ts'
import { Office } from './Office.tsx'
import { buildOffice, departmentOf, seatPosition } from './office.ts'
import roles from './roles.json' with { type: 'json' }
import { moveVisitor, roomGeometry, VISITOR_SPAWN, type Direction, type Point } from './visitor.ts'

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

function OfficeHarness({ run, projectRuns = [run] }: { run: RunView; projectRuns?: RunView[] }) {
  const [visitorEnabled, setVisitorEnabled] = useState(false)
  return <Office run={run} projectRuns={projectRuns} asks={[]} now={now} onOpenAsk={() => {}} visitorEnabled={visitorEnabled} onVisitorEnabledChange={setVisitorEnabled} />
}

const directionKeys: Record<Direction, { key: string; code: string }> = {
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
}

function findRoute(start: Point, target: Point): Direction[] {
  const geometry = roomGeometry(roles.departments)
  const key = (point: Point) => `${point.x},${point.y}`
  const startKey = key(start)
  const targetKey = key(target)
  const queue = [start]
  const previous = new Map<string, { key: string; direction: Direction }>()
  const visited = new Set([startKey])
  const directions: Direction[] = ['up', 'down', 'left', 'right']

  for (let index = 0; index < queue.length && !visited.has(targetKey); index += 1) {
    const point = queue[index]
    for (const direction of directions) {
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

function moveAlong(map: HTMLElement, route: Direction[]) {
  for (const direction of route) fireEvent.keyDown(map, directionKeys[direction])
}

function activeBackendTask(patch: Partial<Task> = {}): Task {
  return { id: 'BACKEND-LIVE', owner: 'backend-1', lane: 'build', status: '진행중', title: 'API 응답 연결', model: 'claude-sonnet', effort: 'high', started: new Date(now - 30 * 60_000).toISOString(), ...patch }
}

describe('real Office visitor staff inspection', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })

  it('inspects a real employee, follows refreshed coordinates and clears stale owner details safely', async () => {
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

    const inspector = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
    expect(inspector.textContent).toContain('backend-1 업무')
    expect(inspector.textContent).toContain('부서 · 백엔드팀')
    expect(inspector.textContent).toContain('작업 · API 응답 연결')
    expect(inspector.textContent).toContain('작업 ID · BACKEND-LIVE')
    expect(inspector.textContent).toContain('경과 시간 · 30분')
    expect(inspector.textContent).toContain('모델 · claude-sonnet')
    expect(inspector.textContent).toContain('노력 · high')

    const updated = makeRun([activeBackendTask({ title: 'API 응답 연결과 검증', model: 'gpt-6.1-codex', effort: 'medium', lane: 'plan' }), initial.state.tasks![1]])
    const newPoint = employeePoint(updated, 'backend-1')
    const employee = () => document.querySelector('[data-employee="backend-1"]') as HTMLElement
    const oldPosition = { left: employee().style.left, top: employee().style.top }
    rerender(<OfficeHarness run={updated} />)
    await waitFor(() => expect(screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).textContent).toContain('API 응답 연결과 검증'))
    expect(screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).textContent).toContain('모델 · gpt-6.1-codex')
    expect(screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).textContent).toContain('노력 · medium')
    expect({ left: employee().style.left, top: employee().style.top }).not.toEqual(oldPosition)
    expect(employee().style.left).toBe(`${newPoint.x - 26}px`)
    expect(employee().style.top).toBe(`${newPoint.y - 48}px`)

    fireEvent.click(withinInspectorButton())
    fireEvent.click(screen.getByRole('button', { name: '둘러보기 재개' }))
    const updatedRoute = findRoute(characterFoot(), newPoint)
    moveAlong(map, updatedRoute)
    await waitFor(() => expect(characterFoot()).toEqual(newPoint))
    fireEvent.keyDown(map, { key: 'Enter', code: 'Enter' })
    expect(await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })).toBeTruthy()

    const away = makeRun([activeBackendTask({ title: '최신 진행 기록', model: undefined, effort: undefined, lane: 'plan' })], { last_report_at: staleReport })
    rerender(<OfficeHarness run={away} />)
    await waitFor(() => expect(screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).textContent).toContain('상태 · 자리 비움'))
    expect(screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).textContent).toContain('모델 · 미보고')
    expect(screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).textContent).toContain('노력 · 미보고')

    const removed = makeRun([initial.state.tasks![1]], { last_report_at: stamp })
    rerender(<OfficeHarness run={removed} />)
    const unavailable = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
    expect(unavailable.textContent).toContain('직원을 찾을 수 없습니다')
    expect(unavailable.textContent).toContain('최신 보고에서 해당 직원이 사라졌습니다.')
    expect(unavailable.textContent).not.toContain('최신 진행 기록')

    const ended = makeRun([activeBackendTask({ title: '끝난 run의 이전 작업', lane: 'plan' })], { ended_at: stamp })
    rerender(<OfficeHarness run={ended} />)
    expect((await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })).textContent).toContain('직원을 찾을 수 없습니다')
    expect(screen.getByRole('button', { name: '둘러보기 끝내기' })).toBeTruthy()
  })

  it('shows no-current-task and missing metadata for an inspectable idle employee', async () => {
    const run = makeRun([{ id: 'BACKEND-DONE', owner: 'backend-2', lane: 'build', status: '완료', title: '완료된 작업' }])
    const previous = makeRun([{ id: 'BACKEND-OLD', owner: 'backend-2', lane: 'build', status: '완료', title: '이전 실행 업무' }], { id: 'visitor-staff-history', title: '이전 실행 보고', last_report_at: staleReport, ended_at: staleReport })
    render(<OfficeHarness run={run} projectRuns={[run, previous]} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    moveAlong(map, findRoute(VISITOR_SPAWN, employeePoint(run, 'backend-2')))
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(run, 'backend-2')))
    fireEvent.keyDown(map, { key: 'j', code: 'KeyJ' })
    const inspector = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
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
    fireEvent.click(screen.getByRole('button', { name: '둘러보기 재개' }))
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(screen.getByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeTruthy()
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const currentInspector = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
    expect(currentInspector.textContent).toContain('backend-2 업무')
    expect(currentInspector.textContent).toContain('상태 · 근무 중')
    expect(currentInspector.textContent).toContain('현재 진행 중인 작업이 없습니다.')
    expect(currentInspector.textContent).toContain('모델 · 미보고')
    expect(currentInspector.textContent).toContain('노력 · 미보고')
    fireEvent.keyDown(screen.getByRole('tab', { name: '현재 업무' }), { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: '직원 업무 살펴보기' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '둘러보기 재개' }))
    fireEvent.keyDown(map, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '직원 살펴보기 사무실' })).toBeNull()
  })

  it.each(['removed', 'ended'] as const)('keeps the report panel keyboard usable when its employee is %s in an open overview', async (disposition) => {
    const run = makeRun([activeBackendTask()])
    const { rerender } = render(<OfficeHarness run={run} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const map = screen.getByRole('region', { name: '직원 살펴보기 사무실 바닥' })
    await waitFor(() => expect(document.activeElement).toBe(map))
    moveAlong(map, findRoute(VISITOR_SPAWN, employeePoint(run, 'backend-1')))
    await waitFor(() => expect(characterFoot()).toEqual(employeePoint(run, 'backend-1')))
    fireEvent.keyDown(map, { key: 'e', code: 'KeyE' })
    const inspector = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
    const currentTab = within(inspector).getByRole('tab', { name: '현재 업무' })
    await waitFor(() => expect(document.activeElement).toBe(currentTab))

    const latest = disposition === 'removed' ? makeRun([], { id: run.id }) : { ...run, ended_at: stamp }
    rerender(<OfficeHarness run={latest} />)
    const unavailable = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
    expect(unavailable.textContent).toContain('직원을 찾을 수 없습니다')
    const close = within(unavailable).getByRole('button', { name: '닫기' })
    await waitFor(() => expect(document.activeElement).toBe(close))
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: '직원 업무 살펴보기' })).toBeNull()
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
    const inspector = await screen.findByRole('complementary', { name: '직원 업무 살펴보기' })
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
  return [...screen.getByRole('complementary', { name: '직원 업무 살펴보기' }).querySelectorAll('button')].find((button) => button.textContent === '닫기')!
}
