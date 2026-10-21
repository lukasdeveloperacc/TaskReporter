import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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
    expect(db.asks(run.id)).toMatchObject([{ id, status: 'answered', answer: 'Yes' }])
    expect(db.asks('unknown')).toEqual([])
    expect(db.snapshot(() => true).asks).toEqual([])
  })

  it('adds hidden to a legacy database and preserves visibility across reopen and upsert', () => {
    db.close()
    const file = join(dir, 'legacy.db')
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, in_workspace INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL REFERENCES projects(path), doc_path TEXT, doc_baseline TEXT,
        state TEXT NOT NULL, last_report_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE asks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), question TEXT NOT NULL, options TEXT NOT NULL,
        recommended TEXT, status TEXT NOT NULL CHECK(status IN ('pending','answered','closed')), answer TEXT, created_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('/workspace/old', 'old', 1, '1970-01-01T00:00:00.000Z');
      INSERT INTO runs VALUES ('old-run', '/workspace/old', NULL, '# legacy baseline', '{"title":"Legacy","tasks":[{"id":"T","status":"진행중"}]}', '1970-01-01T00:00:00.000Z', NULL);
      INSERT INTO asks VALUES ('old-ask', 'old-run', 'Legacy?', '["Yes"]', NULL, 'pending', NULL, '1970-01-01T00:00:00.000Z');`)
    legacy.close()
    db = openStore(file)
    expect(db.snapshot(() => true).projects[0]).toMatchObject({ path: '/workspace/old', hidden: false })
    expect(db.getRun('old-run')).toMatchObject({ doc_baseline: '# legacy baseline', state: { title: 'Legacy' } })
    expect(db.getAsk('old-ask')).toMatchObject({ status: 'pending' })
    expect(db.setProjectHidden('/workspace/old', true)).toBe(true)
    db.upsertProject('/workspace/old', false, 1)
    db.close()
    db = openStore(file)
    expect(db.snapshot(() => true).projects[0]).toMatchObject({ path: '/workspace/old', hidden: true, in_workspace: false })
    db.reconcileChecks('old-run', undefined, db.getRun('old-run')!.state, 1_000, false)
    expect(db.checks('old-run', true)).toHaveLength(1)
    expect(db.setProjectHidden('/workspace/missing', true)).toBe(false)
  })

  it('persists check history and task cooldown clocks across database reopen', () => {
    const run = db.createRun('/workspace/first', { tasks: [{ id: 'T', status: '진행중' }] }, 1_000)
    const state = run.state
    db.reconcileChecks(run.id, undefined, state, 1_000, false)
    const check = db.checks(run.id, true)[0]!
    db.replyCheck(check.id, 'Unable to discover runtime metadata.', 2_000)
    db.close()
    db = openStore(join(dir, 'store.db'))
    expect(db.check(check.id)).toMatchObject({ status: 'answered', answer: 'Unable to discover runtime metadata.', responded_at: new Date(2_000).toISOString() })
    expect(db.checks(run.id)).toHaveLength(1)
  })

  it('keeps hidden projects, run history, and asks in snapshots', () => {
    const run = db.createRun('/workspace/first', {}, 0)
    const ask = db.createAsk(run.id, '?', ['Yes'], undefined, 0)
    db.setProjectHidden('/workspace/first', true)
    db.upsertProject('/workspace/first', true, 1)
    expect(db.snapshot(() => false)).toMatchObject({
      projects: [{ path: '/workspace/first', hidden: true, runs: [{ id: run.id }] }],
      asks: [{ id: ask, status: 'pending' }],
    })
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
      db.reconcileChecks(run.id, run.state, { tasks: [{ id: 'T', status: '진행중' }] }, 1, false)
      db.createAsk(run.id, 'new?', ['Yes'], undefined, 1)
      throw new Error('reject')
    })).toThrow('reject')
    expect(db.snapshot(() => false)).toEqual(before)
    expect(db.getRun(run.id)!.doc_baseline).toBeNull()
    expect(db.getAsk(ask)!.status).toBe('pending')
    expect(db.checks(run.id)).toEqual([])
    const inspection = new DatabaseSync(join(dir, 'store.db'))
    expect(inspection.prepare('SELECT count(*) AS count FROM task_clocks').get()).toEqual({ count: 0 })
    inspection.close()
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
    expect(db.asks(run.id).map((ask) => ask.id)).toEqual([answered])
    expect(db.asks(other.id).map((ask) => ask.id)).toEqual([foreign])
    expect(db.getAsk(answered)!.answer).toBe('Yes')
    expect(db.getAsk(selected)).toMatchObject({ status: 'closed', answer: null })
  })
})
