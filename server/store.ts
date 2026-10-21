import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { STALE_MS, type AskView, type CheckView, type ProgressData, type StateSnapshot } from '../shared/contract.ts'

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
type StoredRun = Omit<RunRow, 'state'> & { state: string }
type StoredAsk = Omit<AskRow, 'options'> & { options: string }

function runRow(row: StoredRun): RunRow {
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
  `)
  if (!(db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).some((column) => column.name === 'hidden')) {
    db.exec('ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
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
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)')
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
        const priorClock = db.prepare('SELECT * FROM task_clocks WHERE run_id=? AND task_id=?').get(runId, task.id) as { owner: string | null; observed_at: number; replied_at: number | null } | undefined
        const transferred = (old !== undefined && oldOwner !== owner) || (priorClock !== undefined && priorClock.owner !== owner)
        if (transferred) db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND task_id=? AND status='pending'").run(runId, task.id)
        const meaningful = old !== undefined && (old.status !== task.status || old.owner !== task.owner || old.note !== task.note || JSON.stringify(old.todos ?? []) !== JSON.stringify(task.todos ?? []))
        const observed = reset || !priorClock || transferred || meaningful ? stamp : priorClock.observed_at
        const repliedAt = transferred ? null : priorClock?.replied_at ?? null
        db.prepare(`INSERT INTO task_clocks(run_id, task_id, owner, observed_at, replied_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, task_id) DO UPDATE SET owner=excluded.owner,
          observed_at=excluded.observed_at, replied_at=excluded.replied_at`)
          .run(runId, task.id, owner, observed, repliedAt)
        const pending = db.prepare("SELECT id FROM checks WHERE run_id=? AND task_id=? AND status='pending'").get(runId, task.id)
        const missing = !task.model?.trim() || !task.effort?.trim()
        const cooldown = !transferred && priorClock?.owner === owner && priorClock.replied_at !== null && stamp - priorClock.replied_at < STALE_MS
        if (!ended && !pending && (missing && !cooldown || stamp - observed >= STALE_MS && !cooldown)) {
          const missingFields = [!task.model?.trim() && 'model', !task.effort?.trim() && 'effort'].filter(Boolean).join(', ')
          const unfinished = (task.todos ?? []).filter((todo) => todo.done !== true)
          const todoList = unfinished.length ? ` Current unfinished TODOs: ${unfinished.map((todo) => `${todo.id} (${todo.text ?? todo.id})`).join('; ')}.` : ''
          const question = `Please explain this task's current status.${missingFields ? ` Currently missing: ${missingFields}.` : ''}${todoList} If model or effort is missing, discover actual values from host/runtime evidence and report confirmed values using patch.tasks with this same task id. If current TODOs remain incomplete, inspect the latest task TODOs, resolve the actual work, then report done:true only for completed items. Include a check_replies explanation for this check. If metadata is unavailable, explain why and leave values absent; do not guess.`
          db.prepare("INSERT INTO checks VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)")
            .run(randomUUID(), runId, task.id, owner, question, new Date(stamp).toISOString())
        }
      }
      const activeIds = new Set(active.map((task) => task.id))
      for (const task of state.tasks ?? []) if (!activeIds.has(task.id)) {
        db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND task_id=? AND status='pending'").run(runId, task.id)
        const priorClock = db.prepare('SELECT owner FROM task_clocks WHERE run_id=? AND task_id=?').get(runId, task.id) as { owner: string | null } | undefined
        const owner = task.owner?.trim() || null
        if (priorClock && priorClock.owner !== owner) {
          db.prepare('UPDATE task_clocks SET owner=?, observed_at=?, replied_at=NULL WHERE run_id=? AND task_id=?')
            .run(owner, stamp, runId, task.id)
        }
      }
      if (ended) {
        db.prepare("UPDATE checks SET status='closed' WHERE run_id=? AND status='pending'").run(runId)
      }
    },
    close(): void { db.close() },
  }
}
