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
    [{ tasks: [{ id: 'T', close_asks: [] }] }, 'task T: unknown fields: close_asks; allowed: id, title, owner, model, effort, lane, status, after, note'],
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
})
