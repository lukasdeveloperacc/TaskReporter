// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RunView, Task } from '../../shared/contract.ts'
import { buildOffice, characterFrame, departmentOf, diffScenes, layoutOffice, rankOf, seatPosition, type Department, type EmployeeView } from './office.ts'
import roles from './roles.json' with { type: 'json' }

const now = Date.parse('2026-10-19T12:00:00.000Z')
const makeRun = (patch: Partial<RunView> = {}): RunView => ({
  id: 'run-1', project_path: '/workspace/repo', title: 'Office', doc_path: null,
  doc_accessible: false, state: { stage: '구현', tasks: [] },
  last_report_at: new Date(now).toISOString(), ended_at: null, ...patch,
})
const task = (patch: Partial<Task> & Pick<Task, 'id'>): Task => ({ owner: 'frontend-1', lane: 'build', status: '대기중', ...patch })

const patch3 = (): RunView => makeRun({ state: { stage: '리뷰', tasks: [
  task({ id: 'BUILD-1', owner: 'frontend-1', status: '완료' }),
  task({ id: 'R1-K', owner: 'Karpathy Agent', lane: 'review', status: '완료' }),
  task({ id: 'R1-P', owner: 'Ponytail Agent', lane: 'review', status: '완료' }),
  task({ id: 'R1-I', owner: 'Impeccable Agent', lane: 'review', status: '완료' }),
  task({ id: 'R1-E', owner: 'E2E Agent', lane: 'review', status: '완료' }),
], reviews: [] } })
const patch4 = (): RunView => makeRun({ state: { stage: '수정', tasks: [
  task({ id: 'BUILD-1', owner: 'frontend-1', status: '완료' }),
  task({ id: 'R1-K', owner: 'Karpathy Agent', lane: 'review', status: '완료' }),
  task({ id: 'R1-P', owner: 'Ponytail Agent', lane: 'review', status: '완료' }),
  task({ id: 'R1-I', owner: 'Impeccable Agent', lane: 'review', status: '완료' }),
  task({ id: 'R1-E', owner: 'E2E Agent', lane: 'review', status: '완료' }),
  task({ id: 'FIX-1', owner: 'frontend-1', lane: 'fix', status: '대기중', after: ['R1-I'] }),
], reviews: [
  { round: 1, reviewer: 'Karpathy Agent', verdict: 'PASS' },
  { round: 1, reviewer: 'Ponytail Agent', verdict: 'PASS' },
  { round: 1, reviewer: 'Impeccable Agent', verdict: 'CHANGES_REQUIRED' },
  { round: 1, reviewer: 'E2E Agent', verdict: 'PASS' },
] } })

describe('office roles and employees', () => {
  it('maps known and unknown owners, ranks, and stable character frames', () => {
    expect(departmentOf('backend-1')).toBe('백엔드팀')
    expect(departmentOf('Karpathy Agent')).toBe('감사팀')
    expect(departmentOf('reviewer-lead')).toBe('감사팀')
    expect(departmentOf('plan-architect')).toBe('회의실')
    expect(departmentOf('designer-1')).toBe('임시 자리')
    expect(departmentOf('Planner', 'plan')).toBe('회의실')
    expect(rankOf('claude-haiku-4')).toBe('신입사원')
    expect(rankOf('claude-sonnet')).toBe('대리')
    expect(rankOf('claude-opus')).toBe('과장')
    expect(rankOf('gpt-6-luna')).toBe('신입사원')
    expect(rankOf('gpt-6.1-sol')).toBe('대리')
    expect(characterFrame('backend-1')).toEqual(characterFrame('backend-1'))
  })

  it('creates reviewer characters from reviews without tasks', () => {
    const run = makeRun({ state: { reviews: [{ round: 1, reviewer: 'Karpathy Agent', verdict: 'PASS' }] } })
    expect(buildOffice(run, now).employees.find(({ name }) => name === 'Karpathy Agent')).toMatchObject({ department: '감사팀', state: 'idle' })
  })

  it('shows temporary owner labels, task elapsed time, away threshold, and ended staff', () => {
    const run = makeRun({ state: { tasks: [task({ id: 'T-1', owner: 'designer-1', status: '진행중', title: '화면 점검', started: new Date(now - 17 * 60_000).toISOString(), model: 'haiku' })] } })
    const employee = buildOffice(run, now).employees.find(({ name }) => name === 'designer-1')!
    expect(employee.department).toBe('임시 자리')
    expect(employee.rank).toBe('신입사원')
    expect(employee.task?.elapsedMin).toBe(17)
    expect(employee.state).toBe('typing')
    expect(buildOffice({ ...run, last_report_at: new Date(now - 29 * 60_000).toISOString() }, now).employees.find(({ name }) => name === 'designer-1')?.state).toBe('typing')
    expect(buildOffice({ ...run, last_report_at: new Date(now - 31 * 60_000).toISOString() }, now).employees.find(({ name }) => name === 'designer-1')?.state).toBe('away')
    expect(buildOffice({ ...run, ended_at: new Date(now).toISOString() }, now).employees.find(({ name }) => name === 'designer-1')?.state).toBe('gone')
  })

  it('keeps the reported model id separately from rank and leaves unknown models unranked', () => {
    const run = makeRun({ state: { tasks: [
      task({ id: 'C', owner: 'backend-1', status: '완료', model: 'claude-3-7-sonnet-20250219', effort: 'high' }),
      task({ id: 'X', owner: 'backend-2', status: '완료', model: 'gpt-5.3-codex' }),
      task({ id: 'N', owner: 'designer-1', status: '완료' }),
    ] } })
    const employees = buildOffice(run, now).employees
    expect(employees.find(({ name }) => name === 'backend-1')).toMatchObject({ model: 'claude-3-7-sonnet-20250219', effort: 'high', rank: '대리' })
    expect(employees.find(({ name }) => name === 'backend-2')).toMatchObject({ model: 'gpt-5.3-codex', rank: null })
    expect(employees.find(({ name }) => name === 'designer-1')).toMatchObject({ model: null, rank: null })
  })

  it('uses active-task metadata over idle metadata and retains stale active-task values', () => {
    const active = makeRun({ state: { tasks: [
      task({ id: 'OLD', owner: 'backend-1', status: '완료', model: 'claude-3-7-sonnet-20250219', effort: 'low' }),
      task({ id: 'NOW', owner: 'backend-1', status: '진행중', effort: 'high' }),
    ] } })
    expect(buildOffice(active, now).employees.find(({ name }) => name === 'backend-1')).toMatchObject({ model: null, effort: 'high', state: 'typing' })

    const stale = makeRun({ last_report_at: new Date(now - 31 * 60_000).toISOString(), state: { tasks: [
      task({ id: 'STALE', owner: 'frontend-1', status: '진행중', model: 'gpt-5.3-codex' }),
    ] } })
    expect(buildOffice(stale, now).employees.find(({ name }) => name === 'frontend-1')).toMatchObject({ model: 'gpt-5.3-codex', effort: null, state: 'away' })
  })
})

describe('office room layout', () => {
  const staff = (department: Department, count: number): EmployeeView[] => Array.from({ length: count }, (_, deskIndex) => ({
    name: `${department}-${deskIndex}`, department, deskIndex, model: null, rank: null, effort: null, frame: [0, 5], state: 'idle',
  }))

  it('preserves the original layout when rooms do not need extra seats', () => {
    expect(layoutOffice([])).toEqual(roles.departments)
    expect(layoutOffice(staff('회의실', 4))).toEqual(roles.departments)
  })

  it.each(roles.departments.map(({ key }) => key))('keeps every seat and its approach space inside a crowded %s', (key) => {
    const employees = staff(key, 25)
    const baseline = roles.departments.map((department) => ({ ...department }))
    const room = layoutOffice(employees).find((department) => department.key === key)!
    const original = roles.departments.find((department) => department.key === key)!
    expect(room.h).toBeGreaterThan(original.h)
    expect(room.x).toBe(original.x)
    expect(room.w).toBe(original.w)
    for (const employee of employees) {
      const seat = seatPosition(room, employee.deskIndex)
      expect(seat.x).toBeGreaterThan(room.x)
      expect(seat.x + 2).toBeLessThanOrEqual(room.x + room.w)
      expect(seat.y + 1.5).toBeLessThanOrEqual(room.y + room.h)
    }
    expect(roles.departments).toEqual(baseline)
  })

  it('grows the meeting room at its fifth seat and moves later rows together with their original gaps', () => {
    const layout = layoutOffice([...staff('회의실', 5), ...staff('백엔드팀', 9)])
    expect(layout[2]).toMatchObject({ y: 1, h: 9 })
    expect(layout.slice(3, 6).map(({ y }) => y)).toEqual([11, 11, 11])
    expect(layout.slice(6, 9).map(({ y }) => y)).toEqual([27, 27, 27])
    expect(layout[9].y).toBe(36)
    expect(layoutOffice([])).toEqual(roles.departments)
  })
})

describe('office scene changes', () => {
  it('walks when work starts and delivers only completed build/fix tasks', () => {
    const prev = makeRun({ state: { tasks: [task({ id: 'B', status: '대기중' }), task({ id: 'P', lane: 'plan', status: '진행중' }), task({ id: 'R', lane: 'review', status: '진행중' })] } })
    const next = makeRun({ state: { tasks: [task({ id: 'B', status: '진행중' }), task({ id: 'P', lane: 'plan', status: '완료' }), task({ id: 'R', lane: 'review', status: '완료' })] } })
    expect(diffScenes(prev, next)).toEqual([{ type: 'walk', who: 'frontend-1', to: 'desk' }])
    const buildBefore = makeRun({ state: { tasks: [task({ id: 'B', status: '진행중' })] } })
    const buildAfter = makeRun({ state: { tasks: [task({ id: 'B', status: '완료' })] } })
    expect(diffScenes(buildBefore, buildAfter)).toContainEqual({ type: 'deliver', who: 'frontend-1', to: '감사팀' })
    const fixBefore = makeRun({ state: { tasks: [task({ id: 'F', lane: 'fix', status: '진행중' })] } })
    expect(diffScenes(fixBefore, makeRun({ state: { tasks: [task({ id: 'F', lane: 'fix', status: '완료' })] } }))).toContainEqual({ type: 'deliver', who: 'frontend-1', to: '감사팀' })
  })

  it('stamps patch-4 reviews and returns the R1-I rejection to its linked fix owner', () => {
    const scenes = diffScenes(patch3(), patch4())
    expect(scenes.filter(({ type }) => type === 'stamp')).toEqual([
      { type: 'stamp', reviewer: 'Karpathy Agent', round: 1, verdict: 'PASS' },
      { type: 'stamp', reviewer: 'Ponytail Agent', round: 1, verdict: 'PASS' },
      { type: 'stamp', reviewer: 'Impeccable Agent', round: 1, verdict: 'CHANGES_REQUIRED' },
      { type: 'stamp', reviewer: 'E2E Agent', round: 1, verdict: 'PASS' },
    ])
    expect(scenes).toContainEqual({ type: 'return', from: 'Impeccable Agent', to: ['frontend-1'] })
  })

  it('links an R2 rejection to its R2 fix task even when an R1 reviewer task appears first', () => {
    const prev = makeRun({ state: { tasks: [
      task({ id: 'BUILD-1', status: '완료' }),
      task({ id: 'R1-I', owner: 'Impeccable Agent', lane: 'review', status: '완료' }),
      task({ id: 'R2-I', owner: 'Impeccable Agent', lane: 'review', status: '완료' }),
      task({ id: 'BACKEND-1', owner: 'backend-1', status: '완료' }),
    ], reviews: [{ round: 1, reviewer: 'Impeccable Agent', verdict: 'PASS' }] } })
    const next = makeRun({ state: { tasks: [
      task({ id: 'BUILD-1', status: '완료' }),
      task({ id: 'R1-I', owner: 'Impeccable Agent', lane: 'review', status: '완료' }),
      task({ id: 'R2-I', owner: 'Impeccable Agent', lane: 'review', status: '완료' }),
      task({ id: 'BACKEND-1', owner: 'backend-1', status: '완료' }),
      task({ id: 'FIX-2', owner: 'frontend-2', lane: 'fix', status: '대기중', after: ['R2-I'] }),
    ], reviews: [
      { round: 1, reviewer: 'Impeccable Agent', verdict: 'PASS' },
      { round: 2, reviewer: 'Impeccable Agent', verdict: 'CHANGES_REQUIRED' },
    ] } })
    expect(diffScenes(prev, next)).toContainEqual({ type: 'return', from: 'Impeccable Agent', to: ['frontend-2'] })
  })
})
