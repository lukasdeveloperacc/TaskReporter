import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, INIT } from './progress.ts'
import type { ProgressData } from '../shared/contract.ts'

const fixture = readFileSync(new URL('./fixtures/progress-example.md', import.meta.url), 'utf8')
const golden = JSON.parse(readFileSync(new URL('./fixtures/progress-example.expected.json', import.meta.url), 'utf8')) as ProgressData
const patches = [...fixture.matchAll(/```json\n(.*?)\n```/gs)].map((match) => JSON.parse(match[1]) as unknown)
const title = '외부 STT 가져오기 끊김 해결 + 외부 작업 판정 통일'

function withoutTimes(data: ProgressData): ProgressData {
  const copy = structuredClone(data)
  for (const task of copy.tasks ?? []) {
    delete task.started
    delete task.finished
  }
  delete copy.updated
  return copy
}

describe('progress apply', () => {
  it('merges an explicit task kind while keeping existing actor defaults and completion guards', () => {
    const original = apply({}, { tasks: [{ id: 'G', kind: 'aggregate', status: '진행중', todos: [{ id: 'approval' }] }, { id: 'A', status: '대기중' }] }, 1_000)
    expect(original.tasks?.[0].kind).toBe('aggregate')
    expect(original.tasks?.[1]).not.toHaveProperty('kind')
    expect(apply(original, { tasks: [{ id: 'G', note: 'waiting' }] }, 2_000).tasks?.[0].kind).toBe('aggregate')
    expect(apply(original, { tasks: [{ id: 'G', kind: 'actor' }] }, 2_000).tasks?.[0].kind).toBe('actor')
    expect(() => apply(original, { tasks: [{ id: 'G', status: '완료' }] }, 2_000)).toThrow('unfinished TODOs')
    expect(() => apply(original, { stage: '완료' }, 2_000)).toThrow('tasks are still open')
  })

  it('matches the progress.py golden after replaying every example checkpoint', () => {
    let state = apply({}, INIT(title), 1_792_382_400_000)
    for (const patch of patches) state = apply(state, patch, 1_792_382_400_000)
    expect(withoutTimes(state)).toEqual(golden)
    expect(state.stage).toBe('완료')
    expect(state.tasks).toHaveLength(17)
    expect(state.reviews).toHaveLength(8)
  })

  it.each([
    [{ extra: true }, 'unknown fields: extra; allowed: title, stage, summary, todo, blockers, tasks, decisions, reviews'],
    [{ tasks: [{ id: 'T', close_asks: [] }] }, 'task T: unknown fields: close_asks; allowed: id, kind, title, owner, model, effort, lane, status, after, note, todos'],
    [{ tasks: [{ id: 'T', kind: 'gate' }] }, 'task T: kind must be one of actor, aggregate'],
    [{ tasks: [{ id: 'T', kind: null }] }, 'task T: kind must be one of actor, aggregate'],
    [{ tasks: [{ id: 'T', started: 'forged' }] }, 'task T: unknown fields: started'],
    [{ decisions: [{ title: 'D', note: 'wrong field' }] }, 'decision D: unknown fields: note; allowed: title, body'],
    [{ reviews: [{ round: 1, reviewer: 'Karpathy Agent', status: 'PASS' }] }, 'review 1 Karpathy Agent: unknown fields: status; allowed: round, reviewer, verdict, note'],
    [{ tasks: [{ id: 'T', lane: 'unknown' }] }, 'task T: lane must be one of plan, build, review, fix, finish'],
    [{ reviews: [{ round: 1, reviewer: 'Mystery' }] }, "reviewer 'Mystery' must be exactly one of: Karpathy Agent, Ponytail Agent, Impeccable Agent, E2E Agent"],
    [{ tasks: [{ id: 'T', after: ['MISSING'] }] }, 'after refers to unknown task ids: MISSING'],
    [{ stage: '완료', tasks: [{ id: 'T', status: '진행중' }] }, 'stage 완료 but tasks are still open: EXISTING, T; set them to 완료 or 중단, or send the current stage instead (e.g. 수정)'],
  ])('rejects invalid patch %j without mutating the input', (patch, message) => {
    const original = { ...INIT('test'), tasks: [{ id: 'EXISTING', status: '진행중' as const, started: 'original' }] }
    const before = structuredClone(original)
    expect(() => apply(original, patch, 10)).toThrow(message)
    expect(original).toEqual(before)
  })

  it('merges todos by id within a task, preserving omitted fields, items and first appearance order', () => {
    const patch = { tasks: [{ id: 'FE', todos: [
      { id: 'FE-1', text: '설계', phase: '계획', detail: '초안', done: true },
      { id: 'FE-2', text: '구현', phase: '구현' },
    ] }, { id: 'BE', todos: [{ id: 'FE-1', text: '다른 작업', done: false }] }] }
    const original = structuredClone(patch)
    const initial = apply({}, patch, 1_000)
    const updated = apply(initial, { tasks: [
      { id: 'FE', todos: [{ id: 'FE-2', done: true }, { id: 'FE-3', done: true }, { id: 'FE-3', phase: '검증' }] },
      { id: 'FE', todos: [{ id: 'FE-1', done: false }, { id: 'FE-3', detail: '테스트' }] },
    ] }, 2_000)
    expect(updated.tasks?.[0].todos).toEqual([
      { id: 'FE-1', text: '설계', phase: '계획', detail: '초안', done: false },
      { id: 'FE-2', text: '구현', phase: '구현', done: true },
      { id: 'FE-3', text: 'FE-3', phase: '검증', detail: '테스트', done: true },
    ])
    expect(updated.tasks?.[1].todos).toEqual([{ id: 'FE-1', text: '다른 작업', done: false }])
    expect(apply(updated, { tasks: [{ id: 'FE', note: 'TODO 생략' }] }, 3_000).tasks?.[0].todos).toEqual(updated.tasks?.[0].todos)
    expect(apply(updated, { tasks: [{ id: 'FE', todos: [] }] }, 3_000).tasks?.[0].todos).toEqual(updated.tasks?.[0].todos)
    expect(apply({}, { tasks: [{ id: 'new', todos: [] }] }, 3_000).tasks?.[0].todos).toEqual([])
    expect(initial.tasks?.[0].todos).toEqual(patch.tasks[0].todos)
    expect(patch).toEqual(original)
  })

  it.each([
    [null, 'todos must be a list'],
    [{}, 'todos must be a list'],
    [[null], 'each todo needs a non-empty string id'],
    [[{ id: '' }], 'each todo needs a non-empty string id'],
    [[{ id: 1 }], 'each todo needs a non-empty string id'],
    [[{ id: 'todo', checked: true }], 'unknown fields: checked; allowed: id, text, phase, done, detail'],
    [[{ id: 'todo', text: null }], 'text must be a string'],
    [[{ id: 'todo', phase: 1 }], 'phase must be a string'],
    [[{ id: 'todo', detail: [] }], 'detail must be a string'],
    [[{ id: 'todo', done: 'true' }], 'done must be a boolean'],
  ])('rejects invalid todos %j atomically', (todos, error) => {
    const initial = apply({}, { tasks: [{ id: 'FE', todos: [{ id: 'FE-1', done: false }] }] }, 1_000)
    const before = structuredClone(initial)
    expect(() => apply(initial, { tasks: [{ id: 'FE', todos: [{ id: 'FE-1', done: true }] }, { id: 'BE', todos }] }, 2_000)).toThrow(error)
    expect(initial).toEqual(before)
  })

  it('stamps a task when it starts and preserves the timestamp on a repeated status', () => {
    const started = apply({}, { tasks: [{ id: 'T', status: '진행중' }] }, 1_000)
    expect(started.tasks?.[0].started).toBe(new Date(1_000).toISOString())
    const resent = apply(started, { tasks: [{ id: 'T', status: '진행중' }] }, 2_000)
    expect(resent.tasks?.[0].started).toBe(started.tasks?.[0].started)
  })

  it('stamps finished once when a task closes', () => {
    const started = apply({}, { tasks: [{ id: 'T', status: '진행중' }] }, 1_000)
    const closed = apply(started, { tasks: [{ id: 'T', status: '완료' }] }, 2_000)
    const repeated = apply(closed, { tasks: [{ id: 'T', status: '완료' }] }, 3_000)
    expect(closed.tasks?.[0].finished).toBe(new Date(2_000).toISOString())
    expect(repeated.tasks?.[0].finished).toBe(closed.tasks?.[0].finished)
  })

  it.each([
    [{ tasks: [{ id: 'T', status: '완료', todos: [{ id: 'OPEN', done: false }] }] }, 'task T: unfinished TODOs: OPEN'],
    [{ tasks: [{ id: 'T', status: '완료', todos: [{ id: 'OPEN' }] }] }, 'task T: unfinished TODOs: OPEN'],
  ])('rejects a completed task with unchecked TODOs %j', (patch, error) => {
    expect(() => apply({}, patch, 1_000)).toThrow(error)
  })

  it('rejects unchecked TODOs added to an existing completed task and accepts a same-patch repair', () => {
    const completed = apply({}, { tasks: [{ id: 'T', status: '완료', todos: [{ id: 'DONE', done: true }] }] }, 1_000)
    expect(() => apply(completed, { tasks: [{ id: 'T', todos: [{ id: 'NEW', text: 'New work' }] }] }, 2_000))
      .toThrow('task T: unfinished TODOs: NEW')
    const working = apply({}, { tasks: [{ id: 'T', status: '진행중', todos: [{ id: 'WORK', done: false }] }] }, 1_000)
    expect(apply(working, { tasks: [{ id: 'T', status: '완료', todos: [{ id: 'WORK', done: true }] }] }, 2_000).tasks)
      .toMatchObject([{ status: '완료', todos: [{ id: 'WORK', done: true }] }])
  })

  it('rejects explicit and automatic successful run completion with TODOs on interrupted tasks', () => {
    expect(() => apply({}, { stage: '완료', tasks: [
      { id: 'STOP', status: '중단', todos: [{ id: 'LEFT' }] },
    ] }, 1_000)).toThrow('run stage 완료 has unfinished TODOs: STOP: LEFT')
    expect(() => apply({}, { tasks: [
      { id: 'FINISH', lane: 'finish', status: '완료', todos: [{ id: 'DONE', done: true }] },
      { id: 'STOP', status: '중단', todos: [{ id: 'LEFT', text: 'left over' }] },
    ] }, 1_000)).toThrow('run stage 완료 has unfinished TODOs: STOP: LEFT')
  })

  it('allows non-successful run interruption with open TODOs but still rejects completed tasks with them', () => {
    expect(apply({}, { stage: '중단', tasks: [{ id: 'T', status: '진행중', todos: [{ id: 'LEFT' }] }] }, 1_000).stage).toBe('중단')
    expect(() => apply({}, { stage: '중단', tasks: [{ id: 'T', status: '완료', todos: [{ id: 'LEFT' }] }] }, 1_000))
      .toThrow('task T: unfinished TODOs: LEFT')
  })

  it('allows successful completion when there are no unfinished TODOs', () => {
    expect(apply({}, { stage: '완료', tasks: [
      { id: 'NO-TODOS', status: '완료' },
      { id: 'DONE', status: '중단', todos: [{ id: 'FINISHED', done: true }] },
    ] }, 1_000).stage).toBe('완료')
  })
})
