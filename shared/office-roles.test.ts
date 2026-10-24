import { describe, expect, it } from 'vitest'
import { actorAssignments, departmentOf, resolveDepartment } from './office-roles.ts'
import type { Task } from './contract.ts'

const task = (patch: Partial<Task> & Pick<Task, 'id'>): Task => ({ owner: 'backend-1', ...patch })

describe('shared office roles', () => {
  it('does not seat aggregate tasks or let them override actual actor settings', () => {
    const assignments = actorAssignments([
      task({ id: 'actor', status: '진행중', model: 'actual', effort: 'high' }),
      task({ id: 'gate', kind: 'aggregate', status: '진행중', lane: 'plan' }),
      task({ id: 'done-gate', kind: 'aggregate', status: '완료', owner: 'aggregate-only' }),
    ])
    expect(assignments.get('backend-1')).toMatchObject({ task: { id: 'actor' }, model: 'actual', effort: 'high' })
    expect(assignments.get('backend-1')?.lastCompletedTask).toBeUndefined()
    expect(assignments.has('aggregate-only')).toBe(false)
  })

  it('preserves plan lane precedence and exact/prefix owner matching', () => {
    expect(departmentOf('backend-1')).toBe('백엔드팀')
    expect(departmentOf('backend-1', 'plan')).toBe('회의실')
    expect(departmentOf('', 'plan')).toBe('회의실')
    expect(resolveDepartment('leader')).toEqual({ department: '부장석', matched_by: 'owner' })
    expect(resolveDepartment('backend-worker')).toEqual({ department: '백엔드팀', matched_by: 'owner' })
    expect(resolveDepartment('reviewer-lead')).toEqual({ department: '감사팀', matched_by: 'owner' })
    expect(resolveDepartment('unknown')).toEqual({ department: '임시 자리', matched_by: 'fallback' })
    expect(resolveDepartment()).toEqual({ department: null, matched_by: 'unassigned' })
    expect(resolveDepartment('', 'plan')).toEqual({ department: null, matched_by: 'unassigned' })
    expect(resolveDepartment('backend-1', 'plan')).toEqual({ department: '회의실', matched_by: 'lane' })
  })

  it('selects the last input active task and preserves its undefined metadata overwrite', () => {
    const assignments = actorAssignments([
      task({ id: 'prior', status: '완료', model: 'old', effort: 'low', lane: 'plan' }),
      task({ id: 'active-1', status: '진행중', lane: 'review', model: 'model-1', effort: 'high' }),
      task({ id: 'active-2', status: '진행중', lane: undefined, model: undefined, effort: undefined }),
    ])
    expect(assignments.get('backend-1')).toMatchObject({
      task: { id: 'active-2' }, lastCompletedTask: { id: 'prior' },
      model: undefined, effort: undefined, lane: undefined,
    })
  })

  it('preserves metadata fallback when there is no active task', () => {
    expect(actorAssignments([
      task({ id: 'metadata', status: '대기중', lane: 'review', model: 'm', effort: 'e' }),
      task({ id: 'no-metadata', status: '대기중', lane: 'build' }),
    ]).get('backend-1')).toMatchObject({ lane: 'review', model: 'm', effort: 'e' })
    expect(actorAssignments([
      task({ id: 'completed', status: '완료', lane: 'plan', model: 'm', effort: 'e', finished: '2026-10-01T00:00:00Z' }),
    ]).get('backend-1')).toMatchObject({
      lastCompletedTask: { id: 'completed' }, lane: 'plan', model: 'm', effort: 'e',
    })
  })

  it('selects newest valid completion, then task ID; invalid and missing dates sort after valid dates', () => {
    const assignments = actorAssignments([
      task({ id: 'z-valid-tie', status: '완료', finished: '2026-10-02T00:00:00Z', lane: 'review' }),
      task({ id: 'b-invalid', status: '완료', finished: 'bad', lane: 'build' }),
      task({ id: 'a-valid-tie', status: '완료', finished: '2026-10-02T00:00:00Z', lane: 'fix' }),
      task({ id: 'newest', status: '완료', finished: '2026-10-03T00:00:00Z', lane: 'plan' }),
      task({ id: 'not-completed', status: '중단', finished: '2026-10-04T00:00:00Z', lane: 'build' }),
    ])
    expect(assignments.get('backend-1')?.lastCompletedTask?.id).toBe('newest')
    expect(assignments.get('backend-1')?.lane).toBe('plan')
    expect(actorAssignments([
      task({ id: 'z-valid', status: '완료', finished: '2026-10-02T00:00:00Z' }),
      task({ id: 'a-valid', status: '완료', finished: '2026-10-02T00:00:00Z' }),
    ]).get('backend-1')?.lastCompletedTask?.id).toBe('a-valid')
    expect(actorAssignments([
      task({ id: 'a-valid', status: '완료', finished: '2026-10-02T00:00:00Z' }),
      task({ id: 'z-valid', status: '완료', finished: '2026-10-02T00:00:00Z' }),
    ]).get('backend-1')?.lastCompletedTask?.id).toBe('a-valid')
    expect(actorAssignments([
      task({ id: 'z-invalid', status: '완료', finished: 'invalid' }),
      task({ id: 'b-missing', status: '완료' }),
      task({ id: 'a-invalid', status: '완료', finished: 'invalid' }),
    ]).get('backend-1')?.lastCompletedTask?.id).toBe('a-invalid')
  })

  it('includes the leader assignment even when there are no tasks', () => {
    expect(actorAssignments([]).has('leader')).toBe(true)
  })
})
