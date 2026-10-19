import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore } from './store.ts'

describe('store', () => {
  let dir: string
  let db: ReturnType<typeof openStore>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'office-store-'))
    db = openStore(join(dir, 'store.db'))
    db.upsertProject('/workspace/first', true, 0)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('persists runs, document baselines, projects and answered asks across reopen', () => {
    const run = db.createRun('/workspace/first', { title: 'Work', tasks: [{ id: 'T' }] }, 1000)
    run.doc_path = 'plan.md'
    run.doc_baseline = '# Original'
    run.state.summary = 'Saved'
    run.last_report_at = new Date(2000).toISOString()
    run.ended_at = new Date(2000).toISOString()
    db.saveRun(run)
    const id = db.createAsk(run.id, 'Continue?', ['Yes', 'No'], 'Yes', 1000)
    expect(db.answerAsk(id, 'Yes')).toBe('answered')
    db.close()
    db = openStore(join(dir, 'store.db'))
    expect(db.getRun(run.id)).toEqual(run)
    expect(db.getAsk(id)).toMatchObject({ options: ['Yes', 'No'], recommended: 'Yes', answer: 'Yes', status: 'answered', created_at: new Date(1000).toISOString() })
    expect(db.snapshot(() => true).projects[0]).toMatchObject({ path: '/workspace/first', in_workspace: true })
    expect(db.listActiveRuns()).toEqual([])
    expect(db.snapshot(() => true).asks).toEqual([])
  })

  it('groups all history by project, sorts newest first with id tie-break, and returns detached state', () => {
    const first = db.createRun('/workspace/first', {}, 1)
    const second = db.createRun('/workspace/first', { title: 'Latest' }, 2)
    const tied = db.createRun('/workspace/first', {}, 2)
    first.ended_at = new Date(1).toISOString()
    db.saveRun(first)
    db.upsertProject('/workspace/second', false, 0)
    const other = db.createRun('/workspace/second', {}, 3)
    db.upsertProject('/workspace/second', true, 5)
    const snapshot = db.snapshot((run) => run.id === second.id)
    expect(snapshot.projects).toHaveLength(2)
    expect(snapshot.projects[0]!.runs.map((run) => run.id)).toEqual([second.id, tied.id].sort().concat(first.id))
    expect(snapshot.projects[0]!.runs.find((run) => run.id === second.id)).toMatchObject({ title: 'Latest', doc_accessible: true })
    expect(snapshot.projects[0]!.runs.find((run) => run.id === first.id)).toMatchObject({ title: 'first', ended_at: first.ended_at })
    expect(snapshot.projects[0]!.runs[0]).not.toHaveProperty('doc_baseline')
    expect(snapshot.projects[1]!.runs.map((run) => run.id)).toEqual([other.id])
    expect(snapshot.projects[1]!.in_workspace).toBe(true)
    expect(db.listActiveRuns().map((run) => run.id)).not.toContain(first.id)
    second.state.title = 'Unsaved'
    expect(db.getRun(second.id)!.state.title).toBe('Latest')
    expect(db.getRun('unknown')).toBeUndefined()
  })

  it('commits results and rolls back every project, run, baseline and ask mutation on failure', () => {
    const run = db.createRun('/workspace/first', {}, 0)
    const ask = db.createAsk(run.id, '?', ['Yes'], undefined, 0)
    const before = db.snapshot(() => false)
    expect(() => db.transaction(() => {
      db.upsertProject('/workspace/new', true, 1)
      db.createRun('/workspace/new', {}, 1)
      run.doc_baseline = 'changed'
      run.last_report_at = new Date(1).toISOString()
      db.saveRun(run)
      db.closeAsks(run.id)
      db.createAsk(run.id, 'new?', ['Yes'], undefined, 1)
      throw new Error('reject')
    })).toThrow('reject')
    expect(db.snapshot(() => false)).toEqual(before)
    expect(db.getRun(run.id)!.doc_baseline).toBeNull()
    expect(db.getAsk(ask)!.status).toBe('pending')
    expect(db.transaction(() => { db.answerAsk(ask, 'Yes'); return 42 })).toBe(42)
    expect(db.getAsk(ask)!.status).toBe('answered')
  })

  it('answers only pending asks with listed options and closes only selected pending asks of the run', () => {
    const run = db.createRun('/workspace/first', {}, 0)
    const other = db.createRun('/workspace/first', {}, 0)
    const makeAsk = (runId = run.id) => db.createAsk(runId, '?', ['Yes', 'No'], undefined, 0)
    const answered = makeAsk()
    const selected = makeAsk()
    const remaining = makeAsk()
    const foreign = makeAsk(other.id)
    expect(db.answerAsk('unknown', 'Yes')).toBe('not-found')
    expect(db.getAsk('unknown')).toBeUndefined()
    expect(db.answerAsk(answered, 'Maybe')).toBe('invalid-option')
    expect(db.getAsk(answered)!.status).toBe('pending')
    expect(db.answerAsk(answered, 'Yes')).toBe('answered')
    expect(db.answerAsk(answered, 'No')).toBe('not-pending')
    expect(db.closeAsks(run.id, [])).toEqual([])
    expect(db.closeAsks(run.id, [selected, selected, foreign, answered, 'unknown'])).toEqual([selected])
    expect(db.answerAsk(selected, 'Yes')).toBe('not-pending')
    expect(db.closeAsks(run.id)).toEqual([remaining])
    expect(db.closeAsks(run.id)).toEqual([])
    expect(db.snapshot(() => false).asks.map((ask) => ask.id)).toEqual([foreign])
    expect(db.getAsk(answered)!.answer).toBe('Yes')
    expect(db.getAsk(selected)).toMatchObject({ status: 'closed', answer: null })
  })
})
