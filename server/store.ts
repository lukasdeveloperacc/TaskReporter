import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RETRO_CATEGORIES, RETRO_TASK_ID, STALE_MS, TODO_STALE_MS, type AskView, type CheckView, type ProgressData, type RetroItem, type RetroRow, type RetroSubmission, type RunRetro, type StateSnapshot } from '../shared/contract.ts'

export type RunRow = {
  id: string
  project_path: string
  doc_path: string | null
  doc_baseline: string | null
  state: ProgressData
  last_report_at: string
  ended_at: string | null
}
export type AskRow = AskView & { created_at: string }
type StoredRun = Omit<RunRow, 'state'> & { state: string; retro_at?: string | null }
type StoredAsk = Omit<AskRow, 'options'> & { options: string }

function runRow({ retro_at: _, ...row }: StoredRun): RunRow {
  return { ...row, state: JSON.parse(row.state) as ProgressData }
}
function askRow(row: StoredAsk): AskRow {
  return { ...row, options: JSON.parse(row.options) as string[] }
}

export function openStore(file: string) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY, name TEXT NOT NULL, in_workspace INTEGER NOT NULL, created_at TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL REFERENCES projects(path),
      doc_path TEXT, doc_baseline TEXT, state TEXT NOT NULL, last_report_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS asks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), question TEXT NOT NULL,
      options TEXT NOT NULL, recommended TEXT, status TEXT NOT NULL CHECK(status IN ('pending','answered','closed')),
      answer TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_clocks (
      run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, owner TEXT,
      observed_at INTEGER NOT NULL, replied_at INTEGER,
      PRIMARY KEY(run_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, owner TEXT,
      question TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','answered','closed')),
      answer TEXT, created_at TEXT NOT NULL, responded_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS checks_one_pending_task ON checks(run_id, task_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS retros (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), skill TEXT NOT NULL, skill_version TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN (${RETRO_CATEGORIES.map((category) => `'${category}'`).join(',')})),
      evidence TEXT NOT NULL, suggestion TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retros_skill_category ON retros(skill, category, created_at);
    CREATE TABLE IF NOT EXISTS todo_ticks (
      run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, todo_id TEXT NOT NULL,
      done_at TEXT NOT NULL, at_close INTEGER NOT NULL, PRIMARY KEY(run_id, task_id, todo_id)
    );
  `)
  if (!(db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).some((column) => column.name === 'hidden')) {
    db.exec('ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  }
  if (!(db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some((column) => column.name === 'retro_at')) {
    db.exec('ALTER TABLE runs ADD COLUMN retro_at TEXT')
  }
  if (!(db.prepare('PRAGMA table_info(task_clocks)').all() as { name: string }[]).some((column) => column.name === 'todo_changed_at')) {
    db.exec('ALTER TABLE task_clocks ADD COLUMN todo_changed_at INTEGER')
  }

  return {
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    upsertProject(path: string, inWorkspace: boolean, now: number): void {
      db.prepare(`INSERT INTO projects (path, name, in_workspace, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET name=excluded.name, in_workspace=excluded.in_workspace`)
        .run(path, basename(path), Number(inWorkspace), new Date(now).toISOString())
    },
    setProjectHidden(path: string, hidden: boolean): boolean {
      return db.prepare('UPDATE projects SET hidden=? WHERE path=?').run(Number(hidden), path).changes === 1
    },
    createRun(projectPath: string, state: ProgressData, now: number): RunRow {
      const run: RunRow = {
        id: randomUUID(), project_path: projectPath, state: structuredClone(state),
        doc_path: null, doc_baseline: null, last_report_at: new Date(now).toISOString(), ended_at: null,
      }
      db.prepare('INSERT INTO runs (id, project_path, doc_path, doc_baseline, state, last_report_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(run.id, run.project_path, null, null, JSON.stringify(state), run.last_report_at, null)
      return run
    },
    getRun(id: string): RunRow | undefined {
      const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id) as StoredRun | undefined
      return row && runRow(row)
    },
    saveRun(run: RunRow): void {
      db.prepare(`UPDATE runs SET state=?, doc_path=?, doc_baseline=?, last_report_at=?, ended_at=? WHERE id=?`)
        .run(JSON.stringify(run.state), run.doc_path, run.doc_baseline, run.last_report_at, run.ended_at, run.id)
    },
    listActiveRuns(): RunRow[] {
      return (db.prepare('SELECT * FROM runs WHERE ended_at IS NULL ORDER BY last_report_at DESC, id').all() as StoredRun[]).map(runRow)
    },
    listActiveRunsForProject(projectPath: string): RunRow[] {
      return (db.prepare('SELECT * FROM runs WHERE project_path=? AND ended_at IS NULL ORDER BY last_report_at DESC, id').all(projectPath) as StoredRun[]).map(runRow)
    },
    snapshot(docAccessible: (run: RunRow) => boolean): StateSnapshot {
      const projects = db.prepare('SELECT * FROM projects ORDER BY path').all() as {
        path: string; name: string; in_workspace: number; hidden: number; created_at: string
      }[]
      const runs = (db.prepare('SELECT * FROM runs ORDER BY last_report_at DESC, id').all() as StoredRun[]).map(runRow)
      return {
        projects: projects.map((project) => ({
          path: project.path, name: project.name, in_workspace: Boolean(project.in_workspace),
          hidden: Boolean(project.hidden),
          runs: runs.filter((run) => run.project_path === project.path).map((run) => ({
            id: run.id, project_path: run.project_path, title: run.state.title ?? project.name,
            doc_path: run.doc_path, doc_accessible: docAccessible(run), state: run.state,
            last_report_at: run.last_report_at, ended_at: run.ended_at,
          })),
        })),
        asks: (db.prepare("SELECT * FROM asks WHERE status='pending' ORDER BY created_at, id").all() as StoredAsk[])
          .map((row) => {
            const { created_at: _, ...ask } = askRow(row)
            return ask
          }),
      }
    },
    createAsk(runId: string, question: string, options: string[], recommended: string | undefined, now: number): string {
      const id = randomUUID()
      db.prepare("INSERT INTO asks VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)")
        .run(id, runId, question, JSON.stringify(options), recommended ?? null, new Date(now).toISOString())
      return id
    },
    asks(runId: string): AskRow[] {
      return (db.prepare("SELECT * FROM asks WHERE run_id=? AND status IN ('pending','answered') ORDER BY created_at, id").all(runId) as StoredAsk[]).map(askRow)
    },
    getAsk(id: string): AskRow | undefined {
      const row = db.prepare('SELECT * FROM asks WHERE id=?').get(id) as StoredAsk | undefined
      return row && askRow(row)
    },
    answerAsk(id: string, answer: string): 'answered' | 'not-found' | 'not-pending' | 'invalid-option' {
      const row = db.prepare('SELECT * FROM asks WHERE id=?').get(id) as StoredAsk | undefined
      if (!row) return 'not-found'
      if (row.status !== 'pending') return 'not-pending'
      if (!askRow(row).options.includes(answer)) return 'invalid-option'
      const result = db.prepare("UPDATE asks SET status='answered', answer=? WHERE id=? AND status='pending'").run(answer, id)
      return result.changes === 1 ? 'answered' : 'not-pending'
    },
    closeAsks(runId: string, ids?: string[]): string[] {
      if (ids === undefined) {
        return (db.prepare("UPDATE asks SET status='closed' WHERE run_id=? AND status='pending' RETURNING id")
          .all(runId) as { id: string }[]).map((row) => row.id)
      }
      const close = db.prepare("UPDATE asks SET status='closed' WHERE run_id=? AND id=? AND status='pending' RETURNING id")
      return ids.flatMap((id) => {
        const row = close.get(runId, id) as { id: string } | undefined
        return row ? [row.id] : []
      })
    },
    checks(runId: string, pendingOnly = false): CheckView[] {
      return db.prepare(`SELECT id, run_id, task_id, owner, question, status, answer, created_at, responded_at
        FROM checks WHERE run_id=? ${pendingOnly ? "AND status='pending'" : ''} ORDER BY created_at, id`).all(runId) as CheckView[]
    },
    check(id: string): CheckView | undefined {
      return db.prepare('SELECT id, run_id, task_id, owner, question, status, answer, created_at, responded_at FROM checks WHERE id=?').get(id) as CheckView | undefined
    },
    replyCheck(id: string, answer: string, now: number): void {
      const check = this.check(id)
      if (!check) throw new Error('unknown check_id for run')
      if (check.status === 'closed') throw new Error('check is closed')
      if (check.status === 'answered') {
        if (check.answer !== answer) throw new Error(`conflicting answer for check_id: ${id}`)
        return
      }
      db.prepare("UPDATE checks SET status='answered', answer=?, responded_at=? WHERE id=? AND status='pending'")
        .run(answer, new Date(now).toISOString(), id)
      db.prepare('UPDATE task_clocks SET observed_at=?, replied_at=? WHERE run_id=? AND task_id=?')
        .run(now, now, check.run_id, check.task_id)
    },
    reconcileChecks(runId: string, previous: ProgressData | undefined, state: ProgressData, stamp: number, reset: boolean): void {
      const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task]))
      const active = (state.tasks ?? []).filter((task) => task.status === '진행중')
      const ended = state.stage?.split(' ')[0] === '완료' || state.stage?.split(' ')[0] === '중단'
      for (const task of active) {
        const old = before.get(task.id)
        const owner = task.owner?.trim() || null
        const oldOwner = old?.owner?.trim() || null
        const priorClock = db.prepare('SELECT * FROM task_clocks WHERE run_id=? AND task_id=?').get(runId, task.id) as { owner: string | null; observed_at: number; replied_at: number | null; todo_changed_at: number | null } | undefined
        const kindChanged = old !== undefined && (old.kind ?? 'actor') !== (task.kind ?? 'actor')
        const transferred = kindChanged || (old !== undefined && oldOwner !== owner) || (priorClock !== undefined && priorClock.owner !== owner)
        if (transferred) db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND task_id=? AND status='pending'").run(runId, task.id)
        const meaningful = old !== undefined && (old.status !== task.status || old.owner !== task.owner || old.note !== task.note || JSON.stringify(old.todos ?? []) !== JSON.stringify(task.todos ?? []))
        const observed = reset || !priorClock || transferred || meaningful ? stamp : priorClock.observed_at
        const todosChanged = old !== undefined && JSON.stringify(old.todos ?? []) !== JSON.stringify(task.todos ?? [])
        // Any TODO edit counts, and becoming active starts a fresh window since inactive edits are not tracked.
        const todoChangedAt = reset || !priorClock || transferred || todosChanged || old?.status !== '진행중' || priorClock.todo_changed_at === null ? stamp : priorClock.todo_changed_at
        const repliedAt = transferred ? null : priorClock?.replied_at ?? null
        db.prepare(`INSERT INTO task_clocks(run_id, task_id, owner, observed_at, replied_at, todo_changed_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, task_id) DO UPDATE SET owner=excluded.owner,
          observed_at=excluded.observed_at, replied_at=excluded.replied_at, todo_changed_at=excluded.todo_changed_at`)
          .run(runId, task.id, owner, observed, repliedAt, todoChangedAt)
        const pending = db.prepare("SELECT id FROM checks WHERE run_id=? AND task_id=? AND status='pending'").get(runId, task.id)
        const missing = task.kind !== 'aggregate' && (!task.model?.trim() || !task.effort?.trim())
        const cooldown = !transferred && priorClock?.owner === owner && priorClock.replied_at !== null && stamp - priorClock.replied_at < STALE_MS
        const unfinished = (task.todos ?? []).filter((todo) => todo.done !== true)
        // Work moved (status/owner/note) but no TODO was ticked for a while: ask before the ticks pile up at the end.
        const workChanged = old !== undefined && (old.status !== task.status || old.owner !== task.owner || old.note !== task.note)
        const todoLag = unfinished.length > 0 && workChanged && stamp - todoChangedAt >= TODO_STALE_MS
        if (!ended && !pending && !cooldown && (missing || stamp - observed >= STALE_MS || todoLag)) {
          const missingFields = missing ? [!task.model?.trim() && 'model', !task.effort?.trim() && 'effort'].filter(Boolean).join(', ') : ''
          const todoList = unfinished.length ? `미완료 TODO: ${unfinished.map((todo) => `${todo.id} (${todo.text ?? todo.id})`).join('; ')}. get_run으로 최신 TODO를 확인하고 실제 끝난 항목만 done:true로 보고하세요.` : ''
          const metadata = missingFields ? `누락: ${missingFields}. host/runtime에서 실제 값을 확인해 같은 task id의 patch.tasks로 보고하세요. 확인 불가하면 이유를 설명하고 값을 비워 두세요(추측 금지).` : ''
          const question = [
            `${stamp - observed >= STALE_MS ? '30분째 변화 없음: ' : todoLag ? `${TODO_STALE_MS / 60_000}분째 TODO 체크 없음: ` : ''}현재 상태·막힌 점을 check_replies로 알려 주세요.`,
            [metadata, todoList].filter(Boolean).join(' '),
          ].filter(Boolean).join('\n')
          db.prepare("INSERT INTO checks VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)")
            .run(randomUUID(), runId, task.id, owner, question, new Date(stamp).toISOString())
        }
      }
      const activeIds = new Set(active.map((task) => task.id))
      for (const task of state.tasks ?? []) if (!activeIds.has(task.id)) {
        db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND task_id=? AND status='pending'").run(runId, task.id)
        const priorClock = db.prepare('SELECT owner FROM task_clocks WHERE run_id=? AND task_id=?').get(runId, task.id) as { owner: string | null } | undefined
        const owner = task.owner?.trim() || null
        if (priorClock && (priorClock.owner !== owner || (before.get(task.id)?.kind ?? 'actor') !== (task.kind ?? 'actor'))) {
          db.prepare('UPDATE task_clocks SET owner=?, observed_at=?, replied_at=NULL WHERE run_id=? AND task_id=?')
            .run(owner, stamp, runId, task.id)
        }
      }
      if (ended) {
        db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND task_id<>? AND status='pending'").run(runId, RETRO_TASK_ID)
      }
    },
    // Ticks live outside run.state so the merged state stays identical to progress.py.
    recordTodoTicks(runId: string, previous: ProgressData | undefined, state: ProgressData, now: number): void {
      const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task]))
      for (const task of state.tasks ?? []) {
        const old = before.get(task.id)
        const wasDone = new Set((old?.todos ?? []).filter((todo) => todo.done === true).map((todo) => todo.id))
        const closing = task.status === '완료' && old?.status !== '완료'
        for (const todo of task.todos ?? []) {
          if (todo.done === true && !wasDone.has(todo.id)) {
            db.prepare(`INSERT INTO todo_ticks VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, task_id, todo_id)
              DO UPDATE SET done_at=excluded.done_at, at_close=excluded.at_close`).run(runId, task.id, todo.id, new Date(now).toISOString(), Number(closing))
          } else if (todo.done !== true && wasDone.has(todo.id)) {
            db.prepare('DELETE FROM todo_ticks WHERE run_id=? AND task_id=? AND todo_id=?').run(runId, task.id, todo.id)
          }
        }
      }
    },
    todoTickStats(runId: string): { ticked: number; at_close: number } {
      return db.prepare('SELECT COUNT(*) AS ticked, COALESCE(SUM(at_close), 0) AS at_close FROM todo_ticks WHERE run_id=?').get(runId) as { ticked: number; at_close: number }
    },
    replaceRetro(runId: string, items: RetroItem[], now: number): void {
      const stamp = new Date(now).toISOString()
      const current = this.runRetro(runId)
      const same = current.submitted_at !== null && JSON.stringify(current.items) === JSON.stringify(items.map(({ suggestion, ...item }) => (suggestion === undefined ? item : { ...item, suggestion })))
      db.prepare("UPDATE checks SET status='answered', answer=?, responded_at=? WHERE run_id=? AND task_id=? AND status='pending'")
        .run(`retro ${items.length}건`, stamp, runId, RETRO_TASK_ID)
      if (same) return // a network retry keeps the original submission time
      db.prepare('DELETE FROM retros WHERE run_id=?').run(runId)
      const insert = db.prepare('INSERT INTO retros VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const item of items) insert.run(randomUUID(), runId, item.skill, item.skill_version, item.category, item.evidence, item.suggestion ?? null, stamp)
      db.prepare('UPDATE runs SET retro_at=? WHERE id=?').run(stamp, runId)
    },
    // Asks once per run for a missing retro when it ends; reopening closes the request without re-asking.
    syncRetroCheck(runId: string, ended: boolean, now: number, justEnded = true): void {
      if (!ended) {
        db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND task_id=? AND status='pending'").run(runId, RETRO_TASK_ID)
        return
      }
      if (!justEnded) return
      const submitted = (db.prepare('SELECT retro_at FROM runs WHERE id=?').get(runId) as { retro_at: string | null }).retro_at
      if (submitted || db.prepare('SELECT 1 FROM checks WHERE run_id=? AND task_id=?').get(runId, RETRO_TASK_ID)) return
      db.prepare("INSERT INTO checks VALUES (?, ?, ?, NULL, ?, 'pending', NULL, ?, NULL)").run(randomUUID(), runId, RETRO_TASK_ID,
        '회고를 보내 주세요: 스킬 지시·도구·프로세스에서 막힌 점 최대 3개를 report 최상위 retro로, 없으면 retro:[]로 보내세요(patch:{} 함께).',
        new Date(now).toISOString())
    },
    runRetro(runId: string): RunRetro {
      const run = db.prepare('SELECT retro_at FROM runs WHERE id=?').get(runId) as { retro_at: string | null } | undefined
      const rows = db.prepare('SELECT skill, skill_version, category, evidence, suggestion FROM retros WHERE run_id=? ORDER BY rowid').all(runId) as (RetroItem & { suggestion: string | null })[]
      return {
        submitted_at: run?.retro_at ?? null,
        items: rows.map(({ suggestion, ...item }) => (suggestion === null ? item : { ...item, suggestion })),
      }
    },
    retros(filter: { skill?: string; category?: string; since?: string; project_path?: string }, limit: number): RetroRow[] {
      const where: string[] = []
      const params: string[] = []
      if (filter.skill) { where.push('r.skill=?'); params.push(filter.skill) }
      if (filter.category) { where.push('r.category=?'); params.push(filter.category) }
      if (filter.since) { where.push('r.created_at>=?'); params.push(filter.since) }
      if (filter.project_path) { where.push('runs.project_path=?'); params.push(filter.project_path) }
      const rows = db.prepare(`SELECT r.run_id, runs.project_path, r.skill, r.skill_version, r.category, r.evidence, r.suggestion, r.created_at
        FROM retros r JOIN runs ON runs.id=r.run_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC, r.rowid LIMIT ?`).all(...params, limit) as (RetroRow & { suggestion: string | null })[]
      return rows.map(({ suggestion, ...row }) => (suggestion === null ? row : { ...row, suggestion }))
    },
    // Missing runs carry no skill, so this ignores skill/category filters.
    retroSubmission(filter: { since?: string; project_path?: string }, missingLimit: number): RetroSubmission {
      const where = ['ended_at IS NOT NULL']
      const params: string[] = []
      if (filter.since) { where.push('ended_at>=?'); params.push(filter.since) }
      if (filter.project_path) { where.push('project_path=?'); params.push(filter.project_path) }
      const clause = where.join(' AND ')
      const counts = db.prepare(`SELECT COUNT(*) AS ended_runs, COALESCE(SUM(retro_at IS NOT NULL), 0) AS submitted,
        COALESCE(SUM(retro_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retros WHERE retros.run_id=runs.id)), 0) AS empty
        FROM runs WHERE ${clause}`).get(...params) as { ended_runs: number; submitted: number; empty: number }
      const missing = db.prepare(`SELECT id, project_path, ended_at FROM runs WHERE ${clause} AND retro_at IS NULL
        ORDER BY ended_at DESC, id LIMIT ?`).all(...params, missingLimit) as { id: string; project_path: string; ended_at: string }[]
      return {
        ended_runs: counts.ended_runs, submitted: counts.submitted, empty: counts.empty,
        missing: counts.ended_runs - counts.submitted,
        recent_missing: missing.map(({ id, ...run }) => ({ run_id: id, ...run })),
      }
    },
    checkStats(runId: string): { answered: number; closed_unanswered: number; avg_reply_ms: number | null } {
      const rows = db.prepare('SELECT status, created_at, responded_at FROM checks WHERE run_id=? AND task_id<>?').all(runId, RETRO_TASK_ID) as
        { status: string; created_at: string; responded_at: string | null }[]
      const replied = rows.filter((row) => row.status === 'answered' && row.responded_at)
      const total = replied.reduce((sum, row) => sum + Date.parse(row.responded_at!) - Date.parse(row.created_at), 0)
      return {
        answered: replied.length,
        closed_unanswered: rows.filter((row) => row.status === 'closed').length,
        avg_reply_ms: replied.length ? Math.round(total / replied.length) : null,
      }
    },
    close(): void { db.close() },
  }
}
