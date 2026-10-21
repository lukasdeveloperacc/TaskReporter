import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AskView, ProgressData, StateSnapshot } from '../shared/contract.ts'

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
  db.exec(`
    PRAGMA foreign_keys = ON;
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
    close(): void { db.close() },
  }
}
